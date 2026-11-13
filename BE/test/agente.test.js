/**
 * Pruebas del agente sin red ni MySQL.
 *   npm test          (o: node --test test/agente.test.js)
 *
 * - global.fetch se sustituye por un guion de respuestas de OpenAI.
 * - ../models se sustituye por dobles en memoria (Proveedor, Factura, FacturaItem).
 * - MemoriaAgente simula MySQL apagado → se verifica el respaldo en RAM
 *   (y, al final, que vuelve a MySQL cuando este responde).
 *
 * Escenarios del agente:
 *  (a) el modelo pide más detalle y luego guarda el comprobante
 *  (b) la regla automática reintenta en "high" (y solo una vez)
 *  (c) una pregunta de seguimiento usa la memoria de la sesión
 * Comprobante v4.4 (Costa Rica):
 *  - validarFactura sin advertencias con un comprobante correcto
 *  - clave incompleta + total que no cuadra → reintento en "high" con la lista de inconsistencias
 *  - guardar_factura rechaza un duplicado por clave
 *  - parsearImporte con convenciones de Costa Rica
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

// --- Entorno controlado (dotenv no sobrescribe variables ya definidas) ---
process.env.OPENAI_API_KEY = 'sk-test';
process.env.OPENAI_VISION_MODEL = 'gpt-4o';
process.env.AGENTE_MAX_PASOS = '8';
process.env.AGENTE_UMBRAL_CONFIANZA = '0.7';
process.env.AGENTE_MAX_RECUERDOS = '10';
process.env.PROVEEDORES_API_URL = '';
process.env.MEMORIA_REINTENTO_MS = '600000'; // sin reintentos de MySQL hasta la última prueba

// ------------------------------------------------------------------
// Dobles de los modelos Sequelize
// ------------------------------------------------------------------
function crearDb() {
  const tablas = { proveedores: [], facturas: [], items: [] };
  const ids = { p: 1, f: 1, i: 1 };
  const estado = { mysqlCaido: false };
  const comprobar = () => {
    if (estado.mysqlCaido) {
      const e = new Error('connect ECONNREFUSED 127.0.0.1:3306');
      e.name = 'SequelizeConnectionRefusedError';
      throw e;
    }
  };
  // Igualdad simple sobre claves con valores primitivos (ignora operadores Op.*)
  const coincide = (fila, where = {}) =>
    Object.entries(where).every(([k, v]) => (v !== null && typeof v === 'object') || fila[k] === v);
  // Simula una instancia de Sequelize: atributos, toJSON() y update()
  const instancia = (fila, extra = () => ({})) => {
    const obj = { ...fila };
    obj.toJSON = () => ({ ...fila, ...extra() });
    obj.update = async (cambios) => {
      Object.assign(fila, cambios);
      Object.assign(obj, cambios);
      return obj;
    };
    return obj;
  };

  const Proveedor = {
    async findOrCreate({ where, defaults }) {
      comprobar();
      const existente = tablas.proveedores.find((p) => coincide(p, where));
      if (existente) return [instancia(existente), false];
      const nuevo = { id: ids.p++, verificado: false, ...defaults };
      tablas.proveedores.push(nuevo);
      return [instancia(nuevo), true];
    },
    async findOne({ where }) {
      comprobar();
      const p = tablas.proveedores.find((x) => coincide(x, where));
      return p ? instancia(p) : null;
    },
  };
  const Factura = {
    async findOne({ where }) {
      comprobar();
      const f = tablas.facturas.find((x) => coincide(x, where));
      return f ? instancia(f) : null;
    },
    async create(datos) {
      comprobar();
      const f = { id: ids.f++, ...datos };
      tablas.facturas.push(f);
      return instancia(f);
    },
    async findAll({ where }) {
      comprobar();
      return tablas.facturas
        .filter((f) => coincide(f, where))
        .map((f) => instancia(f, () => ({ proveedor: tablas.proveedores.find((p) => p.id === f.proveedor_id) })));
    },
  };
  const FacturaItem = {
    async bulkCreate(filas) {
      comprobar();
      for (const fila of filas) tablas.items.push({ id: ids.i++, ...fila });
      return filas;
    },
  };
  // MySQL "apagado" para la memoria: obliga a usar el respaldo en RAM
  const fallo = async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:3306');
  };
  const MemoriaAgente = { create: fallo, findAll: fallo, destroy: fallo, bulkCreate: fallo };
  const sequelize = { transaction: async (fn) => (comprobar(), fn({})) };

  return { tablas, estado, sequelize, Proveedor, Factura, FacturaItem, MemoriaAgente };
}

const fakeDb = crearDb();
const rutaModelos = require.resolve(path.join(__dirname, '..', 'models'));
const moduloFalso = new Module(rutaModelos, module);
moduloFalso.filename = rutaModelos;
moduloFalso.loaded = true;
moduloFalso.exports = fakeDb;
require.cache[rutaModelos] = moduloFalso;

const { ejecutarAgente, SYSTEM_PROMPT } = require('../services/visionService');
const { ejecutarTool, parsearImporte } = require('../services/agentTools');
const {
  validarFactura,
  normalizarFactura,
  aplicarCorrecciones,
  parsearCantidad,
  normalizarFechaTexto,
} = require('../services/esquemaFactura');
const imagenZoom = require('../services/imagenZoom');

// sharp real (si está instalado) solo para la prueba de integración; el resto usa
// un doble o "sin sharp" para que las pruebas sean deterministas.
let sharpReal = null;
try {
  sharpReal = require('sharp');
} catch {
  /* sin sharp: esa prueba se omite */
}
imagenZoom._establecerSharp(null);

// Igual con tesseract.js: real solo en la prueba de integración
const ocrService = require('../services/ocrService');
const { reconciliarConClaveOcr } = require('../services/esquemaFactura');
let tesseractReal = null;
try {
  tesseractReal = require('tesseract.js');
} catch {
  /* sin tesseract.js: esa prueba se omite */
}
ocrService._establecerTesseract(null);
const memoria = require('../services/memoryService');

// ------------------------------------------------------------------
// fetch simulado: cada llamada consume la siguiente respuesta del guion
// ------------------------------------------------------------------
let guion = [];
let peticiones = [];
global.fetch = async (url, opciones) => {
  assert.equal(url, 'https://api.openai.com/v1/chat/completions', 'solo se espera tráfico hacia OpenAI');
  const body = JSON.parse(opciones.body);
  peticiones.push(body);
  const siguiente = guion.shift();
  if (!siguiente) throw new Error(`fetch inesperado (petición ${peticiones.length})`);
  const message = typeof siguiente === 'function' ? siguiente(body) : siguiente;
  return { ok: true, status: 200, json: async () => ({ choices: [{ message }] }), text: async () => '' };
};
function prepararGuion(respuestas) {
  guion = [...respuestas];
  peticiones = [];
}

const toolCall = (id, name, args) => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});
const respuestaFinal = (obj) => ({ role: 'assistant', content: JSON.stringify(obj) });

/** Devuelve los detail de todas las imágenes presentes en una petición. */
const detailsEnPeticion = (body) =>
  body.messages
    .filter((m) => Array.isArray(m.content))
    .flatMap((m) => m.content.filter((p) => p.type === 'image_url').map((p) => p.image_url.detail));

// ------------------------------------------------------------------
// Comprobante v4.4 de ejemplo (las cuentas cuadran)
// ------------------------------------------------------------------
const IMAGEN = Buffer.from('imagen-de-prueba');
const CONSECUTIVO = '00100001010000000123'; // sucursal 001, terminal 00001, tipo 01 (FE), número 0000000123
// 506 + DDMMAA + identificación (12) + consecutivo (20) + situación (1) + código de seguridad (8)
const CLAVE = `506150325003101123456${CONSECUTIVO}112345678`;

const FACTURA = {
  tipo_documento: 'Factura Electrónica',
  version: '4.4',
  clave: CLAVE,
  numero_consecutivo: CONSECUTIVO,
  fecha_emision: '2025-03-15T10:30:00-06:00',
  codigo_actividad_emisor: '721001',
  proveedor_sistemas: '3101999999',
  condicion_venta: 'Contado',
  plazo_credito_dias: null,
  emisor: {
    nombre: 'Suministros Tico S.A.',
    nombre_comercial: 'SumiTico',
    tipo_identificacion: 'Jurídica',
    identificacion: '3-101-123456',
    codigo_actividad: '721001',
    ubicacion: { provincia: 'San José', canton: 'Central', distrito: 'Carmen', barrio: null, otras_senas: 'Av. 2, calle 5' },
    telefono: '2222-3333',
    correo: 'ventas@sumitico.example',
  },
  receptor: { nombre: 'Cliente Demo', tipo_identificacion: 'Física', identificacion: '1-0234-0567', correo: 'cliente@example.com' },
  detalle: [
    {
      numero_linea: 1,
      codigo_cabys: '4321000000000',
      codigo_comercial: 'TON-01',
      cantidad: 2,
      unidad_medida: 'Unid',
      detalle: 'Tóner para impresora',
      precio_unitario: 10000,
      monto_total: 20000,
      descuentos: [{ monto: 1000, naturaleza: 'Promoción' }],
      subtotal: 19000,
      base_imponible: 19000,
      impuestos: [{ codigo: '01', codigo_tarifa: '08', tarifa: 13, monto: 2470, exoneracion: null }],
      impuesto_neto: 2470,
      monto_total_linea: 21470,
    },
    {
      numero_linea: 2,
      codigo_cabys: '8399000000000',
      codigo_comercial: 'SRV-INST',
      cantidad: 1,
      unidad_medida: 'Sp',
      detalle: 'Instalación',
      precio_unitario: 5000,
      monto_total: 5000,
      descuentos: [],
      subtotal: 5000,
      base_imponible: 5000,
      impuestos: [{ codigo: '01', codigo_tarifa: '08', tarifa: 13, monto: 650, exoneracion: null }],
      impuesto_neto: 650,
      monto_total_linea: 5650,
    },
  ],
  otros_cargos: [],
  resumen: {
    moneda: 'CRC',
    tipo_cambio: 1,
    total_serv_gravados: 5000,
    total_serv_exentos: 0,
    total_serv_exonerado: 0,
    total_serv_no_sujeto: 0,
    total_mercancias_gravadas: 20000,
    total_mercancias_exentas: 0,
    total_merc_exonerada: 0,
    total_merc_no_sujeta: 0,
    total_gravado: 25000,
    total_exento: 0,
    total_exonerado: 0,
    total_no_sujeto: 0,
    total_venta: 25000,
    total_descuentos: 1000,
    total_venta_neta: 24000,
    desglose_impuesto: [{ codigo: '01', codigo_tarifa: '08', tarifa: 13, total: 3120 }],
    total_impuesto: 3120,
    total_iva_devuelto: 0,
    total_otros_cargos: 0,
    medios_pago: [{ tipo: 'SINPE Móvil', total: 27120 }],
    total_comprobante: 27120,
  },
  informacion_referencia: [],
  estado_hacienda: 'Aceptado',
  leyendas: ['Autorizada mediante resolución DGT-R-033-2019'],
  otros: null,
};

// La misma factura, pero con importes en texto y tarifa en fracción, como podría mandarlos el modelo
const FACTURA_CON_TEXTOS = structuredClone(FACTURA);
FACTURA_CON_TEXTOS.detalle[0].precio_unitario = '10.000';
FACTURA_CON_TEXTOS.detalle[0].impuestos[0].tarifa = 0.13;
FACTURA_CON_TEXTOS.resumen.total_comprobante = '27.120,00';
FACTURA_CON_TEXTOS.resumen.total_impuesto = '₡3.120';

let sesionA = null;

// ------------------------------------------------------------------
// Pruebas originales (adaptadas al comprobante v4.4)
// ------------------------------------------------------------------
test('parsearImporte convierte formatos europeos y anglosajones', () => {
  assert.equal(parsearImporte('1.234,50'), 1234.5);
  assert.equal(parsearImporte('1,234.50'), 1234.5);
  assert.equal(parsearImporte('$ 1 234,50'), 1234.5);
  assert.equal(parsearImporte('12,5'), 12.5);
  assert.equal(parsearImporte('1.234.567'), 1234567);
  assert.equal(parsearImporte(99.9), 99.9);
  assert.equal(parsearImporte('n/a'), null);
});

test('(a) el modelo pide más detalle y luego guarda el comprobante', async () => {
  prepararGuion([
    toolCall('call_1', 'solicitar_mayor_detalle', { motivo: 'La clave y los totales se ven borrosos' }),
    (body) => {
      // Tras la tool, la MISMA imagen debe llegar en high y la copia low debe haberse retirado
      assert.equal(body.messages.at(-1).role, 'user');
      assert.equal(body.messages.at(-2).role, 'tool', 'la imagen high va después del mensaje tool');
      assert.deepEqual(detailsEnPeticion(body), ['high']);
      return toolCall('call_2', 'guardar_factura', { ...FACTURA_CON_TEXTOS, confianza: 0.94 });
    },
    respuestaFinal({
      estado: 'completado',
      calidad_imagen: 'buena',
      confianza: 0.94,
      campos_ilegibles: [],
      datosEstructurados: FACTURA,
      respuesta: `Factura ${CONSECUTIVO} guardada correctamente.`,
    }),
  ]);

  const r = await ejecutarAgente({ imagen: IMAGEN, mimeType: 'image/png', instruccion: 'Procesa esta factura' });
  sesionA = r.sessionId;

  // Primera petición: detail low, tools en "auto", system prompt del agente
  assert.deepEqual(detailsEnPeticion(peticiones[0]), ['low']);
  assert.equal(peticiones[0].tool_choice, 'auto');
  assert.ok(peticiones[0].messages[0].content.startsWith(SYSTEM_PROMPT));
  assert.ok(SYSTEM_PROMPT.startsWith('Eres un agente especialista en análisis y extracción de información visual'));
  assert.equal(peticiones.length, 3);

  // Resultado
  assert.match(r.sessionId, /^[0-9a-f-]{36}$/);
  assert.equal(r.sesionNueva, true);
  assert.equal(r.estado, 'completado');
  assert.equal(r.detailFinal, 'high');
  assert.equal(r.reintentoAutomatico, false);
  assert.equal(r.facturaGuardadaId, 1);
  assert.deepEqual(r.advertencias, []);
  assert.equal(r.datosEstructurados.numero_consecutivo, CONSECUTIVO);
  assert.equal(r.datosEstructurados.emisor.identificacion, '3101123456', 'cédula sin guiones');
  const herramientas = r.pasos.filter((p) => p.tipo === 'herramienta').map((p) => p.herramienta);
  assert.deepEqual(herramientas, ['solicitar_mayor_detalle', 'guardar_factura']);
  assert.ok(r.pasos.some((p) => p.tipo === 'mayor_detalle' && p.origen === 'modelo'));

  // Lo guardado en la "BD": importes convertidos, cédula normalizada, sesión enlazada
  const [f] = fakeDb.tablas.facturas;
  assert.equal(f.clave, CLAVE);
  assert.equal(f.total_comprobante, 27120);
  assert.equal(f.total_impuesto, 3120);
  assert.equal(f.total_venta_neta, 24000);
  assert.equal(f.fecha_emision.toISOString(), '2025-03-15T16:30:00.000Z');
  assert.equal(f.receptor_identificacion, '102340567');
  assert.equal(f.session_id, sesionA);
  assert.deepEqual(f.advertencias, []);
  assert.equal(fakeDb.tablas.proveedores[0].identificacion, '3101123456');
  assert.equal(fakeDb.tablas.proveedores[0].codigo_actividad, '721001');
  assert.equal(fakeDb.tablas.items.length, 2);
  assert.equal(fakeDb.tablas.items[0].precio_unitario, 10000, '"10.000" son diez mil');
  assert.equal(fakeDb.tablas.items[0].tarifa_iva, 13, '0.13 → 13 %');
  assert.equal(fakeDb.tablas.items[0].monto_descuento, 1000);

  // Memoria: MySQL "caído" → RAM; solo texto, sin base64
  assert.equal(memoria.getModo(), 'ram');
  const recuerdos = await memoria.cargar(sesionA);
  assert.deepEqual(recuerdos.map((x) => x.rol), ['user', 'resumen', 'assistant']);
  assert.ok(!JSON.stringify(recuerdos).includes('base64'));
  const resumen = recuerdos[1].contenido;
  assert.match(resumen, /Factura Electrónica 00100001010000000123/);
  assert.match(resumen, /cédula 3101123456/);
  assert.match(resumen, /receptor Cliente Demo/);
  assert.match(resumen, /2 línea/);
  assert.ok(resumen.includes(`clave ${CLAVE}`));
});

test('(a-bis) un duplicado por consecutivo + emisor se rechaza como resultado de la tool', async () => {
  const r = await ejecutarTool('guardar_factura', { ...FACTURA, clave: null }, { sessionId: sesionA });
  assert.equal(r.ok, false);
  assert.equal(r.duplicada, true);
  assert.equal(r.motivo_duplicado, 'consecutivo_emisor');
  assert.equal(fakeDb.tablas.facturas.length, 1);
});

test('(b) la regla automática reintenta en high cuando la confianza es baja', async () => {
  prepararGuion([
    respuestaFinal({
      estado: 'completado',
      calidad_imagen: 'regular',
      confianza: 0.45,
      campos_ilegibles: ['total_comprobante'],
      datosEstructurados: { ...FACTURA, resumen: { ...FACTURA.resumen, total_comprobante: null } },
      respuesta: 'No pude leer el total.',
    }),
    (body) => {
      assert.deepEqual(detailsEnPeticion(body), ['high']);
      assert.match(body.messages.at(-1).content[0].text, /Revisión automática/);
      return respuestaFinal({
        estado: 'completado',
        calidad_imagen: 'buena',
        confianza: 0.91,
        campos_ilegibles: [],
        datosEstructurados: FACTURA,
        respuesta: 'Ahora sí se lee el total: ₡27 120,00.',
      });
    },
  ]);

  const r = await ejecutarAgente({ imagen: IMAGEN, instruccion: 'Solo léela, no la guardes' });
  assert.equal(peticiones.length, 2);
  assert.deepEqual(detailsEnPeticion(peticiones[0]), ['low']);
  assert.equal(r.reintentoAutomatico, true);
  assert.equal(r.detailFinal, 'high');
  assert.equal(r.confianza, 0.91);
  assert.equal(r.facturaGuardadaId, null);
  assert.deepEqual(r.advertencias, []);
  assert.ok(r.pasos.some((p) => p.tipo === 'reintento_automatico' && /confianza 0.45/.test(p.motivo)));
});

test('(b-bis) el reintento automático ocurre una sola vez', async () => {
  const dudosa = respuestaFinal({
    estado: 'completado',
    calidad_imagen: 'mala',
    confianza: 0.3,
    campos_ilegibles: ['total_comprobante'],
    datosEstructurados: null,
    respuesta: 'Imagen muy borrosa.',
  });
  prepararGuion([dudosa, dudosa]);
  const r = await ejecutarAgente({ imagen: IMAGEN });
  assert.equal(peticiones.length, 2);
  assert.equal(r.confianza, 0.3);
  assert.equal(r.pasos.filter((p) => p.tipo === 'reintento_automatico').length, 1);
});

test('(c) una pregunta de seguimiento usa la memoria de la sesión', async () => {
  prepararGuion([
    (body) => {
      const system = body.messages[0].content;
      assert.match(system, /Memoria de la sesión/);
      assert.ok(system.includes(CONSECUTIVO), 'el resumen del comprobante de (a) está en el system prompt');
      // Sin imagen no se ofrecen las tools de control
      const nombres = body.tools.map((t) => t.function.name);
      assert.ok(!nombres.includes('solicitar_mayor_detalle'));
      assert.ok(nombres.includes('buscar_factura'));
      return toolCall('call_3', 'buscar_factura', { solo_sesion_actual: true });
    },
    (body) => {
      const resultado = JSON.parse(body.messages.at(-1).content);
      assert.equal(resultado.ok, true);
      assert.deepEqual(resultado.totales_por_moneda, {
        CRC: { cantidad: 1, total_comprobante: 27120, total_impuesto: 3120 },
      });
      return respuestaFinal({
        estado: 'completado',
        calidad_imagen: null,
        confianza: 1,
        campos_ilegibles: [],
        datosEstructurados: null,
        respuesta: 'Las facturas que me pasaste suman ₡27 120,00 (IVA ₡3 120,00) en 1 comprobante.',
      });
    },
  ]);

  const r = await ejecutarAgente({ sessionId: sesionA, instruccion: '¿Cuánto suman las facturas que te pasé?' });
  assert.equal(r.sessionId, sesionA);
  assert.equal(r.sesionNueva, false);
  assert.equal(r.memoria.recuerdosUsados, 3);
  assert.equal(r.detailFinal, null);
  assert.match(r.respuesta, /27 120,00/);

  const recuerdos = await memoria.cargar(sesionA);
  assert.equal(recuerdos.length, 5);
  assert.equal(recuerdos.at(-1).rol, 'assistant');
});

test('si MySQL está apagado la tool devuelve el error en vez de lanzarlo', async () => {
  fakeDb.estado.mysqlCaido = true;
  try {
    const r = await ejecutarTool('buscar_factura', { numero_consecutivo: '001' }, {});
    assert.equal(r.ok, false);
    assert.match(r.error, /Base de datos no disponible/);
  } finally {
    fakeDb.estado.mysqlCaido = false;
  }
});

test('borrar la memoria de la sesión', async () => {
  const eliminados = await memoria.borrar(sesionA);
  assert.equal(eliminados, 5);
  assert.deepEqual(await memoria.cargar(sesionA), []);
});

// ------------------------------------------------------------------
// Pruebas nuevas: comprobante electrónico v4.4
// ------------------------------------------------------------------
test('(v4.4-a) validarFactura no da advertencias con un comprobante v4.4 correcto', () => {
  assert.deepEqual(validarFactura(FACTURA), { valida: true, advertencias: [] });
  // Los códigos con guiones/espacios se limpian antes de validar
  const conGuiones = { ...FACTURA, numero_consecutivo: '001-00001-01-0000000123', clave: CLAVE.replace(/(\d{10})/g, '$1 ').trim() };
  assert.deepEqual(validarFactura(conGuiones), { valida: true, advertencias: [] });
  // Y la versión con importes en texto también cuadra
  assert.deepEqual(validarFactura(FACTURA_CON_TEXTOS).advertencias, []);
});

test('(v4.4-b) clave incompleta y total sin cuadrar disparan el reintento en high', async () => {
  const conErrores = {
    ...FACTURA,
    clave: CLAVE.slice(0, 49),
    resumen: { ...FACTURA.resumen, total_comprobante: 30000 },
  };
  let textoReintento = '';
  prepararGuion([
    // El modelo está "seguro" (0.95, calidad buena): el reintento lo provoca solo la validación
    respuestaFinal({
      estado: 'completado',
      calidad_imagen: 'buena',
      confianza: 0.95,
      campos_ilegibles: [],
      datosEstructurados: conErrores,
      respuesta: 'Listo.',
    }),
    (body) => {
      assert.deepEqual(detailsEnPeticion(body), ['high']);
      textoReintento = body.messages.at(-1).content[0].text;
      return respuestaFinal({
        estado: 'completado',
        calidad_imagen: 'buena',
        confianza: 0.97,
        campos_ilegibles: [],
        datosEstructurados: FACTURA,
        respuesta: 'Corregido: la clave tiene 50 dígitos y el total es ₡27 120,00.',
      });
    },
  ]);

  const r = await ejecutarAgente({ imagen: IMAGEN, instruccion: 'No la guardes' });
  assert.equal(peticiones.length, 2);
  assert.equal(r.reintentoAutomatico, true);
  assert.equal(r.detailFinal, 'high');
  assert.deepEqual(r.advertencias, []);

  // El modelo recibió la lista concreta de inconsistencias
  assert.match(textoReintento, /inconsistencias/);
  assert.match(textoReintento, /La clave debe tener 50 dígitos y tiene 49/);
  assert.match(textoReintento, /total_comprobante = 30000/);

  const reintento = r.pasos.find((p) => p.tipo === 'reintento_automatico');
  assert.match(reintento.motivo, /inconsistencia/);
  assert.ok(reintento.advertencias.length >= 2);
});

test('(v4.4-c) guardar_factura rechaza un duplicado por clave', async () => {
  const proveedoresAntes = fakeDb.tablas.proveedores.length;
  // Mismo comprobante (misma clave) aunque cambien el consecutivo y la cédula del emisor
  const r = await ejecutarTool('guardar_factura', {
    ...FACTURA,
    numero_consecutivo: '00100001010000000999',
    emisor: { ...FACTURA.emisor, identificacion: '3101999888' },
  });
  assert.equal(r.ok, false);
  assert.equal(r.duplicada, true);
  assert.equal(r.motivo_duplicado, 'clave');
  assert.equal(r.factura_id_existente, 1);
  assert.equal(fakeDb.tablas.facturas.length, 1);
  assert.equal(fakeDb.tablas.proveedores.length, proveedoresAntes, 'no crea proveedores para un duplicado');
});

test('(v4.4-d) parsearImporte: "1.234" son miles en Costa Rica', () => {
  assert.equal(parsearImporte('1.234'), 1234);
  assert.equal(parsearImporte('1.234,50'), 1234.5);
  assert.equal(parsearImporte('₡27.120,00'), 27120);
  assert.equal(parsearImporte('12.5'), 12.5);
  assert.equal(parsearImporte('0.130'), 0.13, 'parte entera 0: es decimal');
});

// ------------------------------------------------------------------
// Pruebas nuevas: lectura de facturas reales de Costa Rica
// ------------------------------------------------------------------

/** FACTURA con los campos de línea como texto impreso (lo que ahora devuelve el modelo). */
function facturaConLineasImpresas() {
  const f = structuredClone(FACTURA);
  Object.assign(f.detalle[0], {
    cantidad: '2,000',
    precio_unitario: '10.000,00',
    monto_total: '20.000,00',
    subtotal: '19.000,00',
    impuesto_neto: '2.470,00',
    monto_total_linea: '21.470,00',
  });
  Object.assign(f.detalle[1], {
    cantidad: '1,000',
    precio_unitario: '5.000,00',
    monto_total: '5.000,00',
    subtotal: '5.000,00',
    impuesto_neto: '650,00',
    monto_total_linea: '5.650,00',
  });
  return f;
}

test('(cr-1) montos y cantidades con el formato de Costa Rica', () => {
  // Montos: punto = miles, coma = decimal
  assert.equal(parsearImporte('32.500,00'), 32500);
  assert.equal(parsearImporte('2.400,00'), 2400);
  assert.equal(parsearImporte('₡ 1.234.567,89'), 1234567.89);
  assert.equal(parsearImporte('0,500'), 0.5, 'antes daba 500');
  // Cantidades: coma = decimal (normalmente con 3 decimales)
  assert.equal(parsearCantidad('2,000'), 2, 'dos unidades, no dos mil');
  assert.equal(parsearCantidad('1,500'), 1.5);
  assert.equal(parsearCantidad('10'), 10);
  assert.equal(parsearCantidad('1.000,500'), 1000.5);
  assert.equal(parsearCantidad(3), 3);
  assert.equal(parsearCantidad(''), null);
  // El prompt explica la regla
  assert.ok(SYSTEM_PROMPT.includes('"2,000" = 2'));
  assert.ok(SYSTEM_PROMPT.includes('"32.500,00" = 32500'));
});

test('(cr-2) normalizarFactura convierte los campos de línea copiados como texto impreso', () => {
  const f = normalizarFactura(facturaConLineasImpresas());
  assert.deepEqual(
    f.detalle.map((l) => [l.cantidad, l.precio_unitario, l.monto_total, l.subtotal, l.impuesto_neto, l.monto_total_linea]),
    [
      [2, 10000, 20000, 19000, 2470, 21470],
      [1, 5000, 5000, 5000, 650, 5650],
    ]
  );
  assert.deepEqual(validarFactura(facturaConLineasImpresas()).advertencias, []);
});

test('(cr-3) aviso de posible confusión de separadores', () => {
  const f = structuredClone(FACTURA);
  // "2.000" leído como dos mil, con un precio con decimales
  Object.assign(f.detalle[0], { cantidad: '2.000', precio_unitario: '16.250,50' });
  const { advertencias } = validarFactura(f);
  assert.ok(advertencias.some((a) => /Línea 1: posible confusión de separadores/.test(a)), advertencias.join('\n'));
  // Sin decimales en el precio no se avisa (puede ser una compra grande real)
  const g = structuredClone(FACTURA);
  Object.assign(g.detalle[0], { cantidad: 2000, precio_unitario: 10, monto_total: 20000 });
  assert.ok(!validarFactura(g).advertencias.some((a) => /confusión de separadores/.test(a)));
});

test('(cr-4) validación cruzada de la clave: fecha, identificación y consecutivo', () => {
  // Fecha 16/03/25 (en vez de 15/03/25), cédula con dígitos cambiados y consecutivo distinto
  const claveMala = `506160325003101123465${'00100001010000000124'}112345678`;
  assert.equal(claveMala.length, 50);
  const { advertencias } = validarFactura({ ...FACTURA, clave: claveMala });
  assert.equal(advertencias.length, 3, advertencias.join('\n'));
  assert.ok(advertencias.some((a) => a.includes('es "160325" pero se esperaba "150325"')));
  assert.ok(advertencias.some((a) => a.includes('es "003101123465" pero se esperaba "003101123456"')));
  assert.ok(advertencias.some((a) => a.includes(`es "00100001010000000124" pero se esperaba "${CONSECUTIVO}"`)));
});

test('(cr-5) fechas DD/MM/AAAA → AAAA-MM-DDTHH:mm:ss sin zona horaria', () => {
  assert.equal(normalizarFechaTexto('15/03/2025 10:30'), '2025-03-15T10:30:00');
  assert.equal(normalizarFechaTexto('05/01/2025'), '2025-01-05T00:00:00');
  assert.equal(normalizarFechaTexto('15/03/2025 02:15 p. m.'), '2025-03-15T14:15:00');
  assert.equal(normalizarFechaTexto('2025-03-15T10:30:00-06:00'), '2025-03-15T10:30:00', 'conserva la hora impresa');
  assert.equal(normalizarFactura({ ...FACTURA, fecha_emision: '15/03/2025 10:30' }).fecha_emision, '2025-03-15T10:30:00');
  // La fecha DD/MM/AAAA cuadra con la clave (150325)
  assert.deepEqual(validarFactura({ ...FACTURA, fecha_emision: '15/03/2025 10:30' }).advertencias, []);
  assert.ok(SYSTEM_PROMPT.includes('DD/MM/AAAA'));
});

test('(cr-6) no se inventan datos: contado sin plazo y secciones "no aplica" vacías', () => {
  const f = normalizarFactura({
    ...FACTURA,
    condicion_venta: 'Contado',
    plazo_credito_dias: 30,
    otros_cargos: [{ tipo_documento: 'No aplica', detalle: 'No aplica', porcentaje: null, monto: null }],
    informacion_referencia: 'No aplica',
  });
  assert.equal(f.plazo_credito_dias, null);
  assert.deepEqual(f.otros_cargos, []);
  assert.deepEqual(f.informacion_referencia, []);
  // A crédito se conserva el plazo; el correo y el teléfono no se tocan
  const g = normalizarFactura({ ...FACTURA, condicion_venta: 'Crédito', plazo_credito_dias: '30' });
  assert.equal(g.plazo_credito_dias, 30);
  assert.equal(g.emisor.correo, FACTURA.emisor.correo);
  assert.equal(g.emisor.telefono, FACTURA.emisor.telefono);
});

test('(cr-7) si tras el reintento en high la validación sigue fallando, hay UN paso de verificación', async () => {
  // Identificación del emisor mal leída dentro de la clave (…123465 en vez de …123456)
  const claveIdMala = `506150325003101123465${CONSECUTIVO}112345678`;
  const respuesta = (datos, confianza) =>
    respuestaFinal({
      estado: 'completado',
      calidad_imagen: 'buena',
      confianza,
      campos_ilegibles: [],
      datosEstructurados: datos,
      respuesta: 'Listo.',
    });
  let textoVerificacion = '';
  prepararGuion([
    respuesta({ ...FACTURA, clave: CLAVE.slice(0, 49) }, 0.9), // low: clave incompleta → reintento
    respuesta({ ...FACTURA, clave: claveIdMala }, 0.9), //         high: aún no cuadra → verificación
    (body) => {
      assert.deepEqual(detailsEnPeticion(body), ['high']);
      textoVerificacion = body.messages.at(-1).content[0].text;
      return respuesta(FACTURA, 0.96); //                         verificación: corregido
    },
  ]);

  const r = await ejecutarAgente({ imagen: IMAGEN, instruccion: 'No la guardes' });
  assert.equal(peticiones.length, 3);
  assert.equal(r.reintentoAutomatico, true);
  assert.equal(r.verificacion, true);
  assert.deepEqual(r.advertencias, []);
  assert.deepEqual(
    r.pasos.filter((p) => ['reintento_automatico', 'verificacion'].includes(p.tipo)).map((p) => p.tipo),
    ['reintento_automatico', 'verificacion']
  );
  const verificacion = r.pasos.find((p) => p.tipo === 'verificacion');
  assert.equal(verificacion.advertencias.length, 1);
  // El modelo recibió la lista exacta, con el valor esperado, y la orden de releer solo esos campos
  assert.match(textoVerificacion, /^Verificación final/);
  assert.ok(textoVerificacion.includes('se esperaba "003101123456"'));
  assert.match(textoVerificacion, /relee SOLO los campos implicados/);
});

test('(cr-8) la verificación ocurre una sola vez y devuelve las advertencias que persistan', async () => {
  const mala = respuestaFinal({
    estado: 'completado',
    calidad_imagen: 'buena',
    confianza: 0.9,
    campos_ilegibles: [],
    datosEstructurados: { ...FACTURA, resumen: { ...FACTURA.resumen, total_comprobante: 30000 } },
    respuesta: 'Listo.',
  });
  prepararGuion([mala, mala, mala]);
  const r = await ejecutarAgente({ imagen: IMAGEN, instruccion: 'No la guardes' });
  assert.equal(peticiones.length, 3, 'low + reintento high + verificación, sin un cuarto intento');
  assert.equal(r.verificacion, true);
  assert.ok(r.advertencias.some((a) => /total_comprobante = 30000/.test(a)));
  assert.equal(r.pasos.filter((p) => p.tipo === 'verificacion').length, 1);
});

// ------------------------------------------------------------------
// Pruebas nuevas: ampliar_zona y corrección determinista de la fecha
// ------------------------------------------------------------------

/**
 * Doble de sharp: simula una imagen de 1800×1892 y devuelve como "recorte"
 * un Buffer con la región extraída, para poder comprobarla.
 */
function crearSharpFalso({ ancho = 1800, alto = 1892 } = {}) {
  const llamadas = [];
  const sharp = (entrada) => {
    const op = { entrada, ops: [] };
    llamadas.push(op);
    const cadena = {
      rotate: () => (op.ops.push(['rotate']), cadena),
      extract: (r) => (op.ops.push(['extract', r]), cadena),
      resize: (r) => (op.ops.push(['resize', r]), cadena),
      jpeg: (o) => (op.ops.push(['jpeg', o]), cadena),
      // Preprocesado para OCR
      grayscale: () => (op.ops.push(['grayscale']), cadena),
      normalise: () => (op.ops.push(['normalise']), cadena),
      linear: (a, b) => (op.ops.push(['linear', [a, b]]), cadena),
      sharpen: () => (op.ops.push(['sharpen']), cadena),
      png: () => (op.ops.push(['png']), cadena),
      async toBuffer(opciones) {
        if (opciones?.resolveWithObject) return { data: Buffer.from('original-orientada'), info: { width: ancho, height: alto } };
        const e = op.ops.find(([nombre]) => nombre === 'extract')[1];
        return Buffer.from(`recorte-${e.left}-${e.top}-${e.width}-${e.height}`);
      },
    };
    return cadena;
  };
  sharp.llamadas = llamadas;
  return sharp;
}

/** Imágenes (url + detail) del último mensaje de usuario de una petición. */
const imagenesUltimoMensaje = (body) =>
  body.messages.at(-1).content.filter((p) => p.type === 'image_url').map((p) => p.image_url);
const decodificar = (dataUrl) => Buffer.from(dataUrl.split(',')[1], 'base64').toString();

const llamadasTools = (...llamadas) => ({
  role: 'assistant',
  content: null,
  tool_calls: llamadas.map(([name, args], i) => ({
    id: `call_z${i}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  })),
});
const finalBueno = (datos = FACTURA) =>
  respuestaFinal({
    estado: 'completado',
    calidad_imagen: 'buena',
    confianza: 0.95,
    campos_ilegibles: [],
    datosEstructurados: datos,
    respuesta: 'Listo.',
  });

test('(zoom-a) el modelo llama ampliar_zona y el siguiente mensaje lleva el recorte en high', async () => {
  const sharp = crearSharpFalso();
  imagenZoom._establecerSharp(sharp);
  try {
    let recorte = null;
    prepararGuion([
      toolCall('call_z', 'ampliar_zona', {
        zona: 'personalizada',
        motivo: 'Leer la clave dígito por dígito',
        recuadro: { x: 10, y: 5, ancho: 80, alto: 10 },
      }),
      (body) => {
        // Orden: assistant(tool_calls) → tool → user(recorte)
        assert.equal(body.messages.at(-2).role, 'tool');
        assert.equal(body.messages.at(-1).role, 'user');
        const resultadoTool = JSON.parse(body.messages.at(-2).content);
        assert.equal(resultadoTool.ok, true);
        assert.ok(!body.messages.at(-2).content.includes('base64'), 'el resultado de la tool no lleva la imagen');
        [recorte] = imagenesUltimoMensaje(body);
        // La imagen completa en low sigue en el historial; el recorte llega en high
        assert.deepEqual(detailsEnPeticion(body), ['low', 'high']);
        return finalBueno();
      },
    ]);

    const r = await ejecutarAgente({ imagen: IMAGEN, instruccion: 'No la guardes' });

    assert.equal(recorte.detail, 'high');
    assert.match(recorte.url, /^data:image\/jpeg;base64,/);
    // 10/5/80/10 % de 1800×1892 → left 180, top 95, 1440×189
    assert.equal(decodificar(recorte.url), 'recorte-180-95-1440-189');
    // Ampliado a 1500 px de ancho como mínimo
    const resize = sharp.llamadas[1].ops.find(([n]) => n === 'resize')[1];
    assert.deepEqual([resize.width, resize.height], [1500, 197]);

    assert.equal(r.ampliaciones, 1);
    const [ampliacion] = r.pasos.filter((p) => p.tipo === 'ampliacion');
    assert.equal(ampliacion.ok, true);
    assert.equal(ampliacion.origen, 'modelo');
    assert.equal(ampliacion.zona, 'personalizada');
    assert.equal(ampliacion.motivo, 'Leer la clave dígito por dígito');
    assert.deepEqual(ampliacion.tamano, { ancho: 1500, alto: 197 });
  } finally {
    imagenZoom._establecerSharp(null);
  }
});

test('(zoom-b) se respeta el máximo de 4 ampliaciones por análisis', async () => {
  imagenZoom._establecerSharp(crearSharpFalso());
  try {
    prepararGuion([
      // 5 ampliaciones en el mismo paso: la quinta se rechaza
      llamadasTools(
        ['ampliar_zona', { zona: 'encabezado', motivo: '1' }],
        ['ampliar_zona', { zona: 'clave', motivo: '2' }],
        ['ampliar_zona', { zona: 'emisor', motivo: '3' }],
        ['ampliar_zona', { zona: 'receptor', motivo: '4' }],
        ['ampliar_zona', { zona: 'detalle', motivo: '5' }]
      ),
      (body) => {
        assert.equal(imagenesUltimoMensaje(body).length, 4, 'solo 4 recortes');
        const resultados = body.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content));
        assert.deepEqual(resultados.map((x) => x.ok), [true, true, true, true, false]);
        assert.match(resultados[4].error, /máximo de 4 ampliaciones/);
        // Un sexto intento en otro paso también se rechaza
        return toolCall('call_z6', 'ampliar_zona', { zona: 'resumen', motivo: '6' });
      },
      (body) => {
        assert.match(JSON.parse(body.messages.at(-1).content).error, /máximo de 4 ampliaciones/);
        assert.equal(body.messages.at(-1).role, 'tool', 'sin recortes nuevos');
        return finalBueno();
      },
    ]);

    const r = await ejecutarAgente({ imagen: IMAGEN, instruccion: 'No la guardes' });
    assert.equal(peticiones.length, 3);
    assert.equal(r.ampliaciones, 4);
    const ampliaciones = r.pasos.filter((p) => p.tipo === 'ampliacion');
    assert.equal(ampliaciones.filter((p) => p.ok).length, 4);
    assert.equal(ampliaciones.filter((p) => !p.ok).length, 2);
    assert.deepEqual(ampliaciones.filter((p) => p.ok).map((p) => p.zona), ['encabezado', 'clave', 'emisor', 'receptor']);
  } finally {
    imagenZoom._establecerSharp(null);
  }
});

test('(zoom-c) 2026-12-11 con la clave 506121126… se corrige a 2026-11-12', async () => {
  const clave2026 = `506121126003101123456${CONSECUTIVO}112345678`;
  const datos = { ...FACTURA, clave: clave2026, fecha_emision: '2026-12-11T09:15:00' };

  // Corrección determinista: nota, no advertencia
  const { factura, notas } = aplicarCorrecciones(datos);
  assert.equal(factura.fecha_emision, '2026-11-12T09:15:00');
  assert.equal(notas.length, 1);
  assert.match(notas[0], /fecha corregida según la clave/i);
  const v = validarFactura(datos);
  assert.deepEqual(v.advertencias, []);
  assert.match(v.notas[0], /2026-12-11T09:15:00 → 2026-11-12T09:15:00/);

  // Si el resto de la clave NO valida, no se corrige: queda como advertencia
  const claveIdMala = `506121126003101123465${CONSECUTIVO}112345678`;
  const sinCorregir = validarFactura({ ...datos, clave: claveIdMala });
  assert.equal(sinCorregir.notas, undefined);
  assert.ok(sinCorregir.advertencias.some((a) => a.includes('se esperaba "111226"')));
  // Si invertir día y mes no da exactamente la fecha de la clave, tampoco
  assert.equal(aplicarCorrecciones({ ...datos, fecha_emision: '2026-12-10T09:15:00' }).notas.length, 0);

  // A través del agente: los datos llegan corregidos y sin reintentos
  prepararGuion([finalBueno(datos)]);
  const r = await ejecutarAgente({ imagen: IMAGEN, instruccion: 'No la guardes' });
  assert.equal(peticiones.length, 1);
  assert.equal(r.datosEstructurados.fecha_emision, '2026-11-12T09:15:00');
  assert.deepEqual(r.advertencias, []);
  assert.equal(r.notas.length, 1);
  assert.equal(r.reintentoAutomatico, false);
});

test('(zoom-d) sin sharp, ampliar_zona devuelve un error controlado y el agente sigue', async () => {
  imagenZoom._establecerSharp(null);
  const directo = await imagenZoom.ampliarZona(IMAGEN, { zona: 'clave' });
  assert.equal(directo.ok, false);
  assert.match(directo.error, /sharp no está instalada/);

  prepararGuion([
    toolCall('call_z', 'ampliar_zona', { zona: 'clave', motivo: 'Leer la clave' }),
    (body) => {
      const resultado = JSON.parse(body.messages.at(-1).content);
      assert.equal(body.messages.at(-1).role, 'tool');
      assert.equal(resultado.ok, false);
      assert.match(resultado.error, /sharp no está instalada/);
      assert.deepEqual(detailsEnPeticion(body), ['low'], 'no se agrega ninguna imagen');
      return finalBueno();
    },
  ]);
  const r = await ejecutarAgente({ imagen: IMAGEN, instruccion: 'No la guardes' });
  assert.equal(r.estado, 'completado');
  assert.equal(r.ampliaciones, 0);
  const [ampliacion] = r.pasos.filter((p) => p.tipo === 'ampliacion');
  assert.equal(ampliacion.ok, false);
  assert.equal(ampliacion.zona, 'clave');
});

test('(zoom-e) la verificación amplía el encabezado y la clave si las advertencias los mencionan', async () => {
  imagenZoom._establecerSharp(crearSharpFalso());
  try {
    const claveIdMala = `506150325003101123465${CONSECUTIVO}112345678`;
    let imagenesVerificacion = [];
    let textoVerificacion = '';
    prepararGuion([
      finalBueno({ ...FACTURA, clave: CLAVE.slice(0, 49) }), // low → reintento automático
      finalBueno({ ...FACTURA, clave: claveIdMala }), //          high → verificación
      (body) => {
        imagenesVerificacion = imagenesUltimoMensaje(body);
        textoVerificacion = body.messages.at(-1).content.map((p) => p.text || '').join('\n');
        return finalBueno();
      },
    ]);

    const r = await ejecutarAgente({ imagen: IMAGEN, instruccion: 'No la guardes' });
    assert.equal(peticiones.length, 3);
    // Imagen completa en high + recortes del encabezado y de la clave
    assert.equal(imagenesVerificacion.length, 3);
    assert.ok(imagenesVerificacion.every((i) => i.detail === 'high'));
    assert.match(textoVerificacion, /Verificación final/);
    assert.match(textoVerificacion, /se esperaba "003101123456"/);
    assert.match(textoVerificacion, /Ampliación de la zona "encabezado"/);
    assert.match(textoVerificacion, /Ampliación de la zona "clave"/);

    const verificacion = r.pasos.find((p) => p.tipo === 'verificacion');
    assert.deepEqual(verificacion.ampliaciones, ['encabezado', 'clave']);
    assert.deepEqual(
      r.pasos.filter((p) => p.tipo === 'ampliacion').map((p) => [p.origen, p.zona, p.ok]),
      [['verificacion', 'encabezado', true], ['verificacion', 'clave', true]]
    );
    assert.deepEqual(r.advertencias, []);
  } finally {
    imagenZoom._establecerSharp(null);
  }
});

test('(zoom-f) con sharp real: recorta y amplía a 1500 px de ancho', { skip: !sharpReal && 'sharp no está instalada' }, async () => {
  imagenZoom._establecerSharp(sharpReal);
  try {
    const original = await sharpReal({
      create: { width: 1800, height: 1892, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .png()
      .toBuffer();
    const z = await imagenZoom.ampliarZona(original, {
      zona: 'personalizada',
      recuadro: { x: 0, y: 0, ancho: 40, alto: 10 },
    });
    assert.equal(z.ok, true, z.error);
    assert.deepEqual(z.region, { left: 0, top: 0, width: 720, height: 189 });
    const meta = await sharpReal(Buffer.from(z.dataUrl.split(',')[1], 'base64')).metadata();
    assert.equal(meta.format, 'jpeg');
    assert.equal(meta.width, 1500);
    assert.equal(meta.height, 394);
  } finally {
    imagenZoom._establecerSharp(null);
  }
});

// ------------------------------------------------------------------
// Pruebas nuevas: OCR (leer_digitos_ocr) y reconciliación con la clave
// ------------------------------------------------------------------

// Clave real del caso: 506 | 121126 | 003101999999 | 00100001010000000457 | 1 | 12345678
const CLAVE_OCR = '50612112600310199999900100001010000000457112345678';
const CONSECUTIVO_OCR = '00100001010000000457';
// Lo que leyó gpt-4o: se comió un 9 de "999999", metió un 0 extra y truncó el consecutivo
// (cinco 9 en vez de seis + un 0 extra: sigue teniendo 50 dígitos, pero desplazados)
const CLAVE_MODELO = `50612112600310199999${'0'}${'00100001010000000457112345678'}`;
const FACTURA_OCR = {
  ...FACTURA,
  emisor: { ...FACTURA.emisor, identificacion: '3-101-999999' },
  clave: CLAVE_OCR,
  numero_consecutivo: CONSECUTIVO_OCR,
  fecha_emision: '2026-11-12T10:00:00',
};

/**
 * Doble de tesseract.js: un worker que "lee" el texto indicado.
 * `texto` puede ser un string fijo o una función (imagen) => string.
 */
function crearTesseractFalso(texto) {
  const estado = { workersCreados: 0, imagenes: [], terminados: 0 };
  return {
    estado,
    async createWorker() {
      estado.workersCreados += 1;
      return {
        setParameters: async () => {},
        recognize: async (imagen) => {
          estado.imagenes.push(imagen);
          return { data: { text: typeof texto === 'function' ? texto(imagen) : texto } };
        },
        terminate: async () => {
          estado.terminados += 1;
        },
      };
    },
  };
}

test('(ocr-a) el modelo lee mal el consecutivo y la reconciliación lo corrige desde la clave del OCR', async () => {
  assert.equal(CLAVE_MODELO.length, 50);
  const sharp = crearSharpFalso();
  const tesseract = crearTesseractFalso(
    `Clave numérica: ${CLAVE_OCR.replace(/(\d{10})/g, '$1 ').trim()}\nConsecutivo: ${CONSECUTIVO_OCR}\nFecha: 12/11/2026 10:00\n`
  );
  imagenZoom._establecerSharp(sharp);
  ocrService._establecerTesseract(tesseract);
  try {
    let resultadosOcr = [];
    prepararGuion([
      llamadasTools(
        ['leer_digitos_ocr', { zona: 'clave', campo: 'clave' }],
        ['leer_digitos_ocr', { zona: 'encabezado', campo: 'consecutivo' }]
      ),
      (body) => {
        resultadosOcr = body.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content));
        // El modelo "ignora" el OCR y responde con su lectura defectuosa
        return finalBueno({ ...FACTURA_OCR, clave: CLAVE_MODELO, numero_consecutivo: '00100001010000000045' });
      },
    ]);

    const r = await ejecutarAgente({ imagen: IMAGEN, instruccion: 'No la guardes' });

    // Resultado de la tool: texto crudo, grupos por línea y candidatos
    const [deClave, deConsecutivo] = resultadosOcr;
    assert.equal(deClave.ok, true);
    assert.deepEqual(deClave.candidato, { valor: CLAVE_OCR, longitud: 50 });
    assert.match(deClave.texto, /Clave numérica/);
    assert.deepEqual(deClave.lineas[0].grupos, [{ digitos: CLAVE_OCR, longitud: 50 }], 'los espacios dentro del número se quitan');
    assert.deepEqual(deConsecutivo.candidato, { valor: CONSECUTIVO_OCR, longitud: 20 });

    // Un solo worker para todas las lecturas: las 2 del modelo + las 2 automáticas
    // (emisor y receptor; la de la clave no, porque el modelo ya la pidió).
    // Recorte en grises, con contraste y ≥ 2000 px.
    assert.equal(tesseract.estado.workersCreados, 1);
    assert.equal(tesseract.estado.imagenes.length, 4);
    const ops = sharp.llamadas[1].ops.map(([n]) => n);
    assert.ok(['grayscale', 'normalise', 'linear', 'png'].every((o) => ops.includes(o)), ops.join(','));
    assert.ok(sharp.llamadas[1].ops.find(([n]) => n === 'resize')[1].width >= 2000);

    // Reconciliación determinista
    assert.equal(r.datosEstructurados.clave, CLAVE_OCR);
    assert.equal(r.datosEstructurados.numero_consecutivo, CONSECUTIVO_OCR);
    assert.ok(r.notas.some((n) => /consecutivo tomado de la clave \(OCR\)/i.test(n)), r.notas.join('\n'));
    assert.ok(r.notas.some((n) => /Clave tomada del OCR/.test(n)));
    assert.ok(r.notas.some((n) => /3101999999 confirmada por la clave/.test(n)));
    assert.deepEqual(r.advertencias, [], 'las correcciones van en notas, no en advertencias');
    assert.equal(peticiones.length, 2, 'sin reintentos: tras reconciliar, los datos validan');
    assert.equal(r.claveOcr, CLAVE_OCR);
    assert.equal(r.lecturasOcr, 4);

    // Traza
    const pasosOcr = r.pasos.filter((p) => p.tipo === 'ocr' && p.origen === 'modelo');
    assert.deepEqual(
      pasosOcr.map((p) => [p.zona, p.campo, p.candidato]),
      [['clave', 'clave', CLAVE_OCR], ['encabezado', 'consecutivo', CONSECUTIVO_OCR]]
    );
    assert.deepEqual(
      r.pasos.filter((p) => p.tipo === 'ocr' && p.origen === 'automatico').map((p) => p.zona),
      ['emisor', 'receptor']
    );
    assert.ok(r.pasos.some((p) => p.tipo === 'reconciliacion' && p.notas.length >= 2));
  } finally {
    imagenZoom._establecerSharp(null);
    ocrService._establecerTesseract(null);
  }
});

test('(ocr-b) con la clave del OCR, la fecha invertida se corrige aunque la cédula no valide', async () => {
  const datos = {
    ...FACTURA_OCR,
    fecha_emision: '2026-12-11T10:00:00', // día y mes invertidos
    emisor: { ...FACTURA_OCR.emisor, identificacion: '3-101-999998' }, // no coincide con la clave
  };

  // Sin OCR, la corrección de la fecha exige que la cédula valide: no se corrige
  assert.equal(aplicarCorrecciones(datos).factura.fecha_emision, '2026-12-11T10:00:00');

  // Con la clave del OCR sí se corrige; la cédula NO se confirma
  const { factura, notas } = reconciliarConClaveOcr(datos, [CLAVE_OCR]);
  assert.equal(factura.fecha_emision, '2026-11-12T10:00:00');
  assert.ok(notas.some((n) => /Fecha corregida según la clave \(OCR\)/.test(n)));
  assert.ok(!notas.some((n) => /confirmada/.test(n)));
  // La advertencia de la cédula se mantiene; la de la fecha desaparece
  const { advertencias } = validarFactura(factura);
  assert.equal(advertencias.length, 1, advertencias.join('\n'));
  assert.match(advertencias[0], /se esperaba "003101999998"/);

  // guardar_factura también reconcilia si el análisis tiene una clave del OCR
  const g = await ejecutarTool('guardar_factura', datos, { sessionId: 'ocr-b', clavesOcr: [CLAVE_OCR] });
  assert.equal(g.ok, true, g.error);
  assert.ok(g.notas.some((n) => /Fecha corregida según la clave \(OCR\)/.test(n)));
  const guardada = fakeDb.tablas.facturas.find((f) => f.id === g.factura_id);
  assert.equal(guardada.fecha_emision.toISOString(), '2026-11-12T16:00:00.000Z');
  assert.equal(guardada.advertencias.length, 1);

  // Una "clave" del OCR estructuralmente inválida (mes 13) no se usa
  const invalida = `506121326${CLAVE_OCR.slice(9)}`;
  assert.deepEqual(reconciliarConClaveOcr(datos, [invalida]).notas, []);
});

test('(ocr-c) sin tesseract.js, leer_digitos_ocr devuelve un error controlado y el agente sigue', async () => {
  const sharp = crearSharpFalso();
  imagenZoom._establecerSharp(sharp);
  ocrService._establecerTesseract(null);
  try {
    const directo = await ocrService.leerDigitos(Buffer.from('x'), 'clave');
    assert.equal(directo.ok, false);
    assert.match(directo.error, /tesseract\.js no está instalado/);

    prepararGuion([
      toolCall('call_ocr', 'leer_digitos_ocr', { zona: 'clave', campo: 'clave' }),
      (body) => {
        const resultado = JSON.parse(body.messages.at(-1).content);
        assert.equal(resultado.ok, false);
        assert.match(resultado.error, /tesseract\.js no está instalado/);
        return finalBueno();
      },
    ]);
    const r = await ejecutarAgente({ imagen: IMAGEN, instruccion: 'No la guardes' });
    assert.equal(r.estado, 'completado');
    assert.equal(r.lecturasOcr, 0);
    assert.equal(sharp.llamadas.length, 0, 'no se recorta la imagen si no se puede leer');
    const [paso] = r.pasos.filter((p) => p.tipo === 'ocr');
    assert.deepEqual([paso.zona, paso.campo, paso.ok], ['clave', 'clave', false]);
    assert.equal(r.claveOcr, null);
  } finally {
    imagenZoom._establecerSharp(null);
  }
});

test('(ocr-e) analizarLineas y buscarCandidatos', () => {
  const lineas = ocrService.analizarLineas(
    'Clave: 506 1211 26003101 999999 0010000101 0000000457 1 12345678\nFecha 12/11/2026  Folio 001-00001-01-0000000457\n'
  );
  assert.deepEqual(lineas[0].grupos, [{ digitos: CLAVE_OCR, longitud: 50 }]);
  // "/" separa: la fecha no se pega al consecutivo; los guiones dentro del número sí se quitan
  assert.deepEqual(lineas[1].grupos.map((g) => g.digitos), ['12', '11', '2026', CONSECUTIVO_OCR]);
  assert.deepEqual(ocrService.buscarCandidatos(lineas, 'clave'), [CLAVE_OCR]);
  assert.deepEqual(ocrService.buscarCandidatos(lineas, 'consecutivo'), [CONSECUTIVO_OCR]);
});

test(
  '(ocr-d) Tesseract real lee la clave 506121126003101999999… de una imagen generada',
  { skip: (!tesseractReal || !sharpReal) && 'tesseract.js o sharp no están instalados', timeout: 120000 },
  async () => {
    imagenZoom._establecerSharp(sharpReal);
    ocrService._establecerTesseract(undefined); // el real
    try {
      // Imagen tipo factura con la clave y el consecutivo impresos
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="600">
        <rect width="100%" height="100%" fill="white"/>
        <text x="40" y="80" font-family="Arial, Helvetica, sans-serif" font-size="36" font-weight="bold" fill="black">FACTURA ELECTRÓNICA</text>
        <text x="40" y="250" font-family="Arial, Helvetica, sans-serif" font-size="28" fill="black">Clave numérica: ${CLAVE_OCR}</text>
        <text x="40" y="310" font-family="Arial, Helvetica, sans-serif" font-size="28" fill="black">Consecutivo: ${CONSECUTIVO_OCR}</text>
      </svg>`;
      const imagenFactura = await sharpReal(Buffer.from(svg)).png().toBuffer();

      prepararGuion([
        toolCall('call_ocr', 'leer_digitos_ocr', {
          zona: 'personalizada',
          campo: 'clave',
          recuadro: { x: 0, y: 30, ancho: 100, alto: 30 },
        }),
        (body) => {
          const resultado = JSON.parse(body.messages.at(-1).content);
          assert.equal(resultado.ok, true, resultado.error);
          assert.deepEqual(resultado.candidato, { valor: CLAVE_OCR, longitud: 50 }, resultado.texto);
          return finalBueno({ ...FACTURA_OCR, clave: CLAVE_MODELO, numero_consecutivo: '00100001010000000045' });
        },
      ]);
      const r = await ejecutarAgente({ imagen: imagenFactura, mimeType: 'image/png', instruccion: 'No la guardes' });
      assert.equal(r.claveOcr, CLAVE_OCR);
      assert.equal(r.datosEstructurados.clave, CLAVE_OCR);
      assert.equal(r.datosEstructurados.numero_consecutivo, CONSECUTIVO_OCR);
      assert.deepEqual(r.advertencias, []);
    } finally {
      await ocrService.terminarOcr(); // cierra el worker real para que el proceso termine
      ocrService._establecerTesseract(null);
      imagenZoom._establecerSharp(null);
    }
  }
);

// ------------------------------------------------------------------
// Pruebas nuevas: OCR obligatorio por código (sin depender del modelo)
// ------------------------------------------------------------------

/**
 * Deduce la zona de un recorte del sharp falso ("recorte-left-top-width-height") comparándolo
 * con las ZONAS de imagenZoom sobre la imagen falsa de 1800×1892.
 */
function zonaDelRecorte(imagen) {
  const [left, top, width] = String(imagen).split('-').slice(1, 4).map(Number);
  return Object.entries(imagenZoom.ZONAS).find(
    ([, z]) =>
      Math.round((z.x / 100) * 1800) === left &&
      Math.round((z.y / 100) * 1892) === top &&
      Math.min(Math.round((z.ancho / 100) * 1800), 1800 - left) === width
  )?.[0];
}

/** Ejecuta el agente con un sharp falso y un Tesseract que responde según la zona. */
async function agenteConOcrPorZona(textosPorZona, respuestasModelo) {
  const tesseract = crearTesseractFalso((imagen) => textosPorZona[zonaDelRecorte(imagen)] || '');
  imagenZoom._establecerSharp(crearSharpFalso());
  ocrService._establecerTesseract(tesseract);
  try {
    prepararGuion(respuestasModelo);
    const r = await ejecutarAgente({ imagen: IMAGEN, instruccion: 'No la guardes' });
    return { r, tesseract };
  } finally {
    imagenZoom._establecerSharp(null);
    ocrService._establecerTesseract(null);
  }
}

const zonasOcrAutomatico = (r) => r.pasos.filter((p) => p.tipo === 'ocr' && p.origen === 'automatico').map((p) => p.zona);

test('(auto-a) el modelo no llama al OCR: el código lo ejecuta en "clave" y corrige la clave', async () => {
  // Las zonas deben ser distintas para que el doble sepa cuál se está leyendo
  assert.equal(new Set(['clave', 'encabezado', 'emisor', 'receptor'].map((z) => JSON.stringify(imagenZoom.ZONAS[z]))).size, 4);

  const { r } = await agenteConOcrPorZona(
    { clave: `Clave numérica: ${CLAVE_OCR}` },
    [finalBueno({ ...FACTURA_OCR, clave: CLAVE_MODELO, numero_consecutivo: '00100001010000000045' })]
  );

  assert.equal(peticiones.length, 1, 'el modelo respondió directamente, sin herramientas');
  assert.ok(!r.pasos.some((p) => p.tipo === 'ocr' && p.origen === 'modelo'));
  // Encontró la clave en "clave": no hace falta "encabezado"
  assert.deepEqual(zonasOcrAutomatico(r), ['clave', 'emisor', 'receptor']);
  const ocrClave = r.pasos.find((p) => p.tipo === 'ocr' && p.zona === 'clave');
  assert.deepEqual([ocrClave.origen, ocrClave.campo, ocrClave.candidato], ['automatico', 'clave', CLAVE_OCR]);

  assert.equal(r.claveOcr, CLAVE_OCR);
  assert.equal(r.datosEstructurados.clave, CLAVE_OCR);
  assert.equal(r.datosEstructurados.numero_consecutivo, CONSECUTIVO_OCR);
  assert.ok(r.notas.some((n) => /Clave tomada del OCR/.test(n)));
  assert.ok(r.notas.some((n) => /consecutivo tomado de la clave \(OCR\)/i.test(n)));
  assert.deepEqual(r.advertencias, []);
});

test('(auto-a2) si en "clave" no hay 50 dígitos, el OCR automático prueba en "encabezado"', async () => {
  const { r } = await agenteConOcrPorZona(
    { clave: 'Clave numérica: (ilegible)', encabezado: `FACTURA ELECTRÓNICA\nClave: ${CLAVE_OCR}` },
    [finalBueno({ ...FACTURA_OCR, clave: CLAVE_MODELO })]
  );
  assert.deepEqual(zonasOcrAutomatico(r), ['clave', 'encabezado', 'emisor', 'receptor']);
  assert.equal(r.datosEstructurados.clave, CLAVE_OCR);
});

test('(auto-b) la actividad 410801 del modelo se corrige a 410001 desde el OCR del receptor', async () => {
  const { r } = await agenteConOcrPorZona(
    {
      clave: `Clave numérica: ${CLAVE_OCR}`,
      emisor: 'Suministros Tico S.A.\nCédula Jurídica: 3-101-999999\nActividad Económica: 721001',
      receptor: 'Receptor: Cliente Demo\nCédula Física: 1-0234-0567\nActividad Económica: 410001 Construcción',
    },
    [finalBueno({ ...FACTURA_OCR, receptor: { ...FACTURA_OCR.receptor, codigo_actividad: '410801' } })]
  );

  assert.equal(r.datosEstructurados.receptor.codigo_actividad, '410001');
  assert.ok(r.notas.some((n) => /actividad del receptor tomada del OCR: 410001 \(el modelo había leído 410801\)/i.test(n)), r.notas.join('\n'));
  // El emisor coincide con el OCR: no se toca ni se anota
  assert.equal(r.datosEstructurados.emisor.codigo_actividad, '721001');
  assert.ok(!r.notas.some((n) => /Actividad del emisor/.test(n)));
  assert.ok(!r.notas.some((n) => /Identificación del (emisor|receptor) tomada/.test(n)), 'las cédulas coinciden');
  assert.deepEqual(r.advertencias, []);
  // La traza muestra lo encontrado en la zona
  const ocrReceptor = r.pasos.find((p) => p.tipo === 'ocr' && p.zona === 'receptor');
  assert.deepEqual(ocrReceptor.encontrado, { actividad: '410001', identificacion: '102340567' });
  assert.deepEqual(r.ocrZonas.receptor, { actividad: '410001', identificacion: '102340567' });
});

test('(auto-c) si el OCR no encuentra "Actividad", no se cambia nada', async () => {
  const { r } = await agenteConOcrPorZona(
    {
      clave: `Clave numérica: ${CLAVE_OCR}`,
      receptor: 'Receptor: Cliente Demo\nCédula Física: 1-0234-0567\nCorreo: cliente@example.com',
    },
    [finalBueno({ ...FACTURA_OCR, receptor: { ...FACTURA_OCR.receptor, codigo_actividad: '410801' } })]
  );
  assert.equal(r.datosEstructurados.receptor.codigo_actividad, '410801', 'se deja el valor del modelo');
  assert.ok(!r.notas.some((n) => /Actividad/.test(n)));
  assert.deepEqual(r.advertencias, [], 'y sin advertencia');

  // Extractores: solo números completos de 6 dígitos, en la misma línea que la etiqueta
  assert.equal(ocrService.extraerActividad('Actividad: 41001'), null, 'incompleto: no se adivina');
  assert.equal(ocrService.extraerActividad('Actividad: 4100011'), null);
  assert.equal(ocrService.extraerActividad('Actividad\n410001'), null);
  assert.equal(ocrService.extraerActividad('Código de actividad económica 410001 Construcción'), '410001');
  assert.equal(ocrService.extraerCedula('Cédula Jurídica: 3-101-999999 Tel. 2222-3333'), '3101999999');
  assert.equal(ocrService.extraerCedula('Cedula: 1-0234-0567'), '102340567');
  assert.equal(ocrService.extraerCedula('Cédula: 1-234'), null);
});

test('(auto-d) la cédula del emisor leída por OCR no se impone a la clave', () => {
  const { reconciliarZonasOcr } = require('../services/esquemaFactura');
  // El modelo leyó la cédula que confirma la clave; el OCR de la zona leyó otra: manda la clave
  const r1 = reconciliarZonasOcr(FACTURA_OCR, { emisor: { identificacion: '3101999989' } }, [CLAVE_OCR]);
  assert.equal(r1.factura.emisor.identificacion, '3101999999');
  assert.deepEqual(r1.notas, []);
  // El modelo se equivocó y el OCR de la zona coincide con la clave: se usa el OCR
  const r2 = reconciliarZonasOcr(
    { ...FACTURA_OCR, emisor: { ...FACTURA_OCR.emisor, identificacion: '3-101-999989' } },
    { emisor: { identificacion: '3101999999' } },
    [CLAVE_OCR]
  );
  assert.equal(r2.factura.emisor.identificacion, '3101999999');
  assert.match(r2.notas[0], /Identificación del emisor tomada del OCR/);
});

// ------------------------------------------------------------------
// Pruebas nuevas: generación INVERSA (texto → factura FWD)
// ------------------------------------------------------------------
const generador = require('../services/generadorFactura');

// 12/11/2026 09:30:00 en Costa Rica (UTC-6) y código de seguridad fijo
const OPCIONES_GEN = { ahora: new Date('2026-11-12T15:30:00Z'), codigoSeguridad: '87654321' };
const TEXTO_EJEMPLO =
  'Factúrale a Ana Mora, cédula 1-2345-6789, el bootcamp Full Stack módulo 1 por 350 mil con IVA 2% ' +
  'y un kit de bienvenida de 12 mil con IVA 13%, pagó por SINPE';
const EXTRACCION_EJEMPLO = {
  estado: 'completo',
  faltantes: [],
  pregunta: null,
  receptor: { nombre: 'Ana Mora', tipo_identificacion: 'Física', identificacion: '1-2345-6789', correo: null },
  lineas: [
    { descripcion: 'Bootcamp Full Stack – Módulo 1', cantidad: 1, unidad: null, tipo: 'servicio', precio_unitario: 350000, tarifa_iva: 2 },
    { descripcion: 'Kit de bienvenida', cantidad: 1, unidad: null, tipo: 'producto', precio_unitario: 12000, tarifa_iva: 13 },
  ],
  condicion_venta: null,
  plazo_credito_dias: null,
  medios_pago: [{ tipo: 'SINPE', monto: null }],
  moneda: null,
  tipo_cambio: null,
  fecha: null,
};
const respuestaJSON = (obj) => ({ role: 'assistant', content: JSON.stringify(obj) });
const facturasFWD = () => {
  const fwd = fakeDb.tablas.proveedores.find((p) => p.identificacion === generador.EMISOR.identificacion);
  return fwd ? fakeDb.tablas.facturas.filter((f) => f.proveedor_id === fwd.id) : [];
};

let generadaA = null;

test('(gen-a) el texto de ejemplo genera 2 líneas: 357.000,00 + 13.560,00 = 370.560,00, sin advertencias', async () => {
  prepararGuion([
    (body) => {
      // Solo texto (sin imágenes), JSON y la orden de no calcular
      assert.deepEqual(body.response_format, { type: 'json_object' });
      assert.equal(typeof body.messages[1].content, 'string');
      assert.match(body.messages[0].content, /NO calcules montos/);
      assert.match(body.messages[0].content, /2026-11-12T09:30:00/);
      assert.equal(body.messages[1].content, TEXTO_EJEMPLO);
      return respuestaJSON(EXTRACCION_EJEMPLO);
    },
  ]);
  const r = await generador.generarFactura({ texto: TEXTO_EJEMPLO }, OPCIONES_GEN);
  generadaA = r;
  const f = r.datosEstructurados;

  assert.equal(r.estado, 'generada');
  assert.equal(f.detalle.length, 2);
  assert.deepEqual(f.detalle.map((l) => l.monto_total_linea), [357000, 13560]);
  assert.deepEqual(
    [...f.detalle.map((l) => l.monto_total_linea), f.resumen.total_comprobante].map(generador.formatearMontoCR),
    ['357.000,00', '13.560,00', '370.560,00']
  );
  assert.deepEqual(f.detalle.map((l) => [l.unidad_medida, l.impuesto_neto]), [['Sp', 7000], ['Unid', 1560]]);
  assert.deepEqual(f.resumen.desglose_impuesto, [
    { codigo: '01', codigo_tarifa: '03', tarifa: 2, total: 7000 },
    { codigo: '01', codigo_tarifa: '08', tarifa: 13, total: 1560 },
  ]);
  assert.equal(f.resumen.total_serv_gravados, 350000);
  assert.equal(f.resumen.total_mercancias_gravadas, 12000);
  assert.equal(f.resumen.total_venta_neta, 362000);
  assert.equal(f.resumen.total_impuesto, 8560);
  assert.deepEqual(f.resumen.medios_pago, [{ tipo: 'SINPE Móvil', total: 370560 }]);
  assert.equal(f.fecha_emision, '2026-11-12T09:30:00');
  assert.equal(f.condicion_venta, 'Contado');
  assert.equal(f.emisor.nombre, 'FWD Costa Rica S.A.');
  assert.deepEqual([f.receptor.nombre, f.receptor.identificacion], ['Ana Mora', '123456789']);
  assert.deepEqual(validarFactura(f), { valida: true, advertencias: [] });

  // Guardada con origen "generada"
  assert.equal(r.guardada, true);
  const guardada = fakeDb.tablas.facturas.find((x) => x.id === r.facturaGuardadaId);
  assert.equal(guardada.origen, 'generada');
  assert.equal(guardada.total_comprobante, 370560);
});

test('(gen-b) la clave mide 50 dígitos y contiene la fecha, la cédula y el consecutivo', () => {
  const f = generadaA.datosEstructurados;
  assert.match(f.clave, /^\d{50}$/);
  assert.equal(f.clave.slice(0, 3), '506');
  assert.equal(f.clave.slice(3, 9), '121126', 'DDMMAA de 12/11/2026');
  assert.equal(f.clave.slice(9, 21), '003101555555', 'cédula del emisor rellena a 12');
  assert.equal(f.clave.slice(21, 41), f.numero_consecutivo);
  assert.equal(f.clave.slice(41), '187654321', 'situación 1 + código de seguridad');
  assert.match(f.numero_consecutivo, /^0010000101\d{10}$/);
});

test('(gen-c) el consecutivo se incrementa con la siguiente factura (según la tabla facturas)', async () => {
  const anterior = Number(generadaA.datosEstructurados.numero_consecutivo.slice(10));
  prepararGuion([respuestaJSON(EXTRACCION_EJEMPLO)]);
  const r2 = await generador.generarFactura({ texto: TEXTO_EJEMPLO }, OPCIONES_GEN);
  assert.equal(Number(r2.datosEstructurados.numero_consecutivo.slice(10)), anterior + 1);

  // Si la tabla ya tiene un consecutivo mayor del emisor, se continúa desde ahí
  const fwd = fakeDb.tablas.proveedores.find((p) => p.identificacion === generador.EMISOR.identificacion);
  fakeDb.tablas.facturas.push({ id: 900, proveedor_id: fwd.id, numero_consecutivo: '00100001010000000041' });
  prepararGuion([respuestaJSON(EXTRACCION_EJEMPLO)]);
  const r3 = await generador.generarFactura({ texto: TEXTO_EJEMPLO }, OPCIONES_GEN);
  assert.equal(r3.datosEstructurados.numero_consecutivo, '00100001010000000042');
  assert.equal(new Set(facturasFWD().map((f) => f.numero_consecutivo)).size, facturasFWD().length, 'sin repetidos');
});

test('(gen-d) sin precio responde "faltan_datos" y la segunda llamada con el mismo sessionId la completa', async () => {
  // 1) "genereme una factura por una computadora": falta el receptor y el precio
  prepararGuion([
    respuestaJSON({
      estado: 'faltan_datos',
      faltantes: ['receptor', 'precio'],
      pregunta: '¿A quién le facturo la computadora (nombre y cédula) y cuál es su precio?',
      receptor: null,
      lineas: [{ descripcion: 'Computadora', cantidad: 1, tipo: 'producto', precio_unitario: null }],
      medios_pago: [],
    }),
  ]);
  const p1 = await generador.generarFactura({ texto: 'Genereme una factura por una computadora' }, OPCIONES_GEN);
  assert.equal(p1.estado, 'faltan_datos');
  assert.equal(p1.pregunta, '¿A quién le facturo la computadora (nombre y cédula) y cuál es su precio?');
  assert.ok(p1.faltantes.includes('el nombre del receptor'));
  assert.ok(p1.faltantes.includes('el precio de "Computadora"'));
  assert.equal(p1.datosEstructurados, undefined);

  // 2) La respuesta del usuario, con el mismo sessionId, completa el borrador
  prepararGuion([
    (body) => {
      const usuario = body.messages[1].content;
      assert.match(usuario, /BORRADOR anterior/);
      assert.match(usuario, /Computadora/);
      assert.match(usuario, /Carlos Rojas/);
      // El modelo solo devuelve lo nuevo; tipo y cantidad salen del borrador
      return respuestaJSON({
        estado: 'completo',
        receptor: { nombre: 'Carlos Rojas', identificacion: '1-1111-1111' },
        lineas: [{ descripcion: 'Computadora', precio_unitario: 450000 }],
        medios_pago: [],
      });
    },
  ]);
  const p2 = await generador.generarFactura(
    { texto: 'Para Carlos Rojas, cédula 1-1111-1111, cuesta 450 mil', sessionId: p1.sessionId },
    OPCIONES_GEN
  );
  assert.equal(p2.estado, 'generada');
  assert.equal(p2.sessionId, p1.sessionId);
  const f = p2.datosEstructurados;
  assert.deepEqual([f.receptor.nombre, f.receptor.identificacion, f.receptor.tipo_identificacion], ['Carlos Rojas', '111111111', 'Física']);
  assert.equal(f.detalle[0].unidad_medida, 'Unid');
  assert.equal(f.resumen.total_comprobante, 508500, '450.000 + IVA 13 %');
  assert.ok(p2.supuestos.some((s) => /IVA 13 %/.test(s)), 'el IVA por defecto se informa');
  assert.deepEqual(validarFactura(f).advertencias, []);

  // 3) Ya no hay borrador pendiente: un pedido nuevo en la sesión empieza de cero
  prepararGuion([
    (body) => {
      assert.doesNotMatch(body.messages[1].content, /BORRADOR/);
      return respuestaJSON(EXTRACCION_EJEMPLO);
    },
  ]);
  await generador.generarFactura({ texto: TEXTO_EJEMPLO, sessionId: p1.sessionId }, OPCIONES_GEN);
});

test('(gen-e) el modelo no puede cambiar los totales: se usa el calculado', async () => {
  const tramposa = structuredClone(EXTRACCION_EJEMPLO);
  Object.assign(tramposa.lineas[0], { monto_total: 1, subtotal: 5, impuesto_neto: 99, monto_total_linea: 1 });
  Object.assign(tramposa, { total_comprobante: 1, total_impuesto: 0, resumen: { total_comprobante: 1, total_impuesto: 0 } });
  prepararGuion([respuestaJSON(tramposa)]);
  const r = await generador.generarFactura({ texto: TEXTO_EJEMPLO }, OPCIONES_GEN);
  assert.deepEqual(r.datosEstructurados.detalle.map((l) => l.monto_total_linea), [357000, 13560]);
  assert.equal(r.datosEstructurados.resumen.total_impuesto, 8560);
  assert.equal(r.datosEstructurados.resumen.total_comprobante, 370560);
});

test('(gen-f) lo obligatorio lo decide el código aunque el modelo diga "completo"', async () => {
  const incompleta = structuredClone(EXTRACCION_EJEMPLO);
  incompleta.lineas[1].precio_unitario = null;
  incompleta.receptor.identificacion = null;
  prepararGuion([respuestaJSON(incompleta)]); // estado "completo" (falso)
  const r = await generador.generarFactura({ texto: 'algo' }, OPCIONES_GEN);
  assert.equal(r.estado, 'faltan_datos');
  assert.deepEqual(r.faltantes, ['la cédula (identificación) del receptor', 'el precio de "Kit de bienvenida"']);
  assert.match(r.pregunta, /me falta la cédula .* y el precio de "Kit de bienvenida"\. ¿Me lo indicás\?/);
});

// ------------------------------------------------------------------
// Pendiente corregido: la memoria vuelve a MySQL
// ------------------------------------------------------------------
test('la memoria vuelve a MySQL cuando responde y le pasa lo guardado en RAM', async () => {
  assert.equal(memoria.getModo(), 'ram');
  await memoria.guardar('sesion-reconexion', 'user', 'Recuerdo guardado mientras MySQL estaba caído');

  // MySQL "vuelve": la memoria del doble pasa a funcionar
  const filasBd = [];
  let id = 1;
  const M = fakeDb.MemoriaAgente;
  M.bulkCreate = async (filas) => filas.forEach((f) => filasBd.push({ id: id++, ...f }));
  M.create = async (fila) => {
    const x = { id: id++, ...fila };
    filasBd.push(x);
    return { toJSON: () => x };
  };
  M.findAll = async ({ where, limit }) =>
    filasBd
      .filter((f) => f.session_id === where.session_id)
      .sort((a, b) => b.id - a.id)
      .slice(0, limit)
      .map((f) => ({ toJSON: () => f }));

  process.env.MEMORIA_REINTENTO_MS = '0'; // reintentar ya
  try {
    const recuerdos = await memoria.cargar('sesion-reconexion');
    assert.equal(memoria.getModo(), 'mysql');
    assert.deepEqual(recuerdos.map((r) => r.contenido), ['Recuerdo guardado mientras MySQL estaba caído']);
    assert.ok(filasBd.length >= 1, 'lo de RAM se volcó a MySQL');
  } finally {
    process.env.MEMORIA_REINTENTO_MS = '600000';
  }
});
