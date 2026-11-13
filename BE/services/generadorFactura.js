/**
 * generadorFactura.js
 * ------------------------------------------------------------------
 * Funcionalidad INVERSA al agente de visión: texto en lenguaje natural →
 * comprobante electrónico v4.4 de FWD Costa Rica (datosEstructurados).
 *
 * Reparto de responsabilidades:
 *  - El MODELO solo EXTRAE lo que el usuario dijo (receptor, líneas, condición,
 *    medios de pago...). No calcula montos: cualquier total que devuelva se ignora.
 *  - El CÓDIGO calcula todo (redondeo a 2 decimales), asigna el consecutivo
 *    siguiente según la tabla facturas, arma la clave de 50 dígitos, valida con
 *    validarFactura (debe salir SIN advertencias) y guarda con origen "generada".
 *  - Si falta algo obligatorio, responde "faltan_datos" con una pregunta y guarda
 *    un BORRADOR en la memoria del sessionId; la siguiente respuesta lo completa.
 *
 * El documento es de PRUEBA: el sistema no firma el XML ni lo envía a Hacienda.
 * ------------------------------------------------------------------
 */
const crypto = require('crypto');
const { Op } = require('sequelize');

const EMISOR = require('../config/emisor.json');
const memoria = require('./memoryService');
const { ejecutarTool } = require('./agentTools');
const { llamarOpenAI } = require('./visionService');
const { generarImagenFactura, verificarImagenFactura } = require('./imagenFactura');
const {
  parsearImporte,
  parsearCantidad,
  parsearTarifa,
  limpiarCodigo,
  normalizarFechaTexto,
  fechaDDMMAA,
  validarFactura,
} = require('./esquemaFactura');

// Los modelos se cargan de forma diferida (y se sustituyen por dobles en las pruebas)
let db = null;
function modelos() {
  if (!db) db = require('../models');
  return db;
}

// Sucursal 001 + terminal 00001 + tipo 01 (Factura Electrónica)
const PREFIJO_CONSECUTIVO = '0010000101';

// Tarifa de IVA (%) → código de tarifa de Hacienda
const CODIGOS_TARIFA = { 13: '08', 4: '04', 2: '03', 1: '02', 0: '01' };

const MEDIOS_PAGO = {
  sinpe: 'SINPE Móvil',
  efectivo: 'Efectivo',
  tarjeta: 'Tarjeta',
  transferencia: 'Transferencia',
  cheque: 'Cheque',
  plataforma: 'Plataforma digital',
};

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const vacio = (v) => v === null || v === undefined || (typeof v === 'string' && !v.trim());
const texto = (v) => (vacio(v) ? null : String(v).trim());

/** Monto con punto de miles y coma decimal ("370.560,00"), como se imprime en Costa Rica. */
function formatearMontoCR(n) {
  const [entero, decimales] = Math.abs(n).toFixed(2).split('.');
  return `${n < 0 ? '-' : ''}${entero.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${decimales}`;
}

/** Fecha y hora actuales de Costa Rica como "AAAA-MM-DDTHH:mm:ss" (sin zona horaria). */
function ahoraCostaRica(base = new Date()) {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Costa_Rica',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(base)
      .map((p) => [p.type, p.value])
  );
  return `${partes.year}-${partes.month}-${partes.day}T${partes.hour}:${partes.minute}:${partes.second}`;
}

// ------------------------------------------------------------------
// 1) Extracción con el modelo (solo lo que dijo el usuario)
// ------------------------------------------------------------------
const PROMPT_EXTRACCION = `Eres un asistente que EXTRAE los datos para una factura electrónica de Costa Rica a partir de lo que escribe el usuario. El emisor siempre es FWD Costa Rica: no lo extraigas.

Reglas:
- Extrae ÚNICAMENTE lo que el usuario dijo. No inventes receptores, cédulas, correos, precios, CABYS ni tarifas: lo que no se dijo va en null.
- NO calcules montos: no sumes, no apliques impuestos ni descuentos y no devuelvas subtotales ni totales. El sistema calcula todo.
- Convierte a número las cantidades de dinero dichas en palabras: "350 mil" = 350000; "12 mil" = 12000; "1,5 millones" = 1500000; "₡45.000" = 45000.
- En cada línea indica "tipo": "servicio" (cursos, bootcamps, asesorías, mantenimiento, suscripciones...) o "producto" (bienes físicos: computadoras, camisetas, kits...).
- La tarifa de IVA va como porcentaje (13, 4, 2, 1 o 0) y solo si el usuario la dijo; si no, null.
- La identificación se copia tal cual (puede llevar guiones).
- Medios de pago: "SINPE Móvil", "Efectivo", "Tarjeta", "Transferencia", "Cheque", "Plataforma digital" u "otro"; "monto" solo si el usuario dijo cuánto se pagó con cada uno.
- Si recibes un BORRADOR anterior, combínalo con la nueva respuesta del usuario y devuelve la extracción COMPLETA actualizada.
- Si falta el receptor (nombre e identificación) o el precio de alguna línea, usa "estado": "faltan_datos", lista lo que falta en "faltantes" y escribe en "pregunta" una pregunta breve y cercana, con voseo costarricense (por ejemplo "¿Me indicás...?").

Responde ÚNICAMENTE con un objeto JSON:
{
  "estado": "completo" | "faltan_datos",
  "faltantes": ["..."],
  "pregunta": "..." | null,
  "receptor": { "nombre": "", "tipo_identificacion": "Física | Jurídica | DIMEX | NITE" , "identificacion": "", "correo": "" } | null,
  "lineas": [{ "descripcion": "", "cantidad": 1, "unidad": "Sp | Unid | null", "tipo": "servicio | producto", "precio_unitario": 0, "descuento_monto": null, "descuento_porcentaje": null, "tarifa_iva": null, "codigo_cabys": null }],
  "condicion_venta": "Contado | Crédito | null",
  "plazo_credito_dias": null,
  "medios_pago": [{ "tipo": "", "monto": null }],
  "moneda": "CRC | USD | null",
  "tipo_cambio": null,
  "fecha": "DD/MM/AAAA o null"
}`;

function parsearJSON(contenido) {
  try {
    return JSON.parse(String(contenido || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, ''));
  } catch {
    return null;
  }
}

function normalizarMedio(tipo) {
  if (vacio(tipo)) return null;
  const s = String(tipo).toLowerCase();
  const clave = Object.keys(MEDIOS_PAGO).find((k) => s.includes(k));
  return clave ? MEDIOS_PAGO[clave] : 'otro';
}

/**
 * Se queda SOLO con los campos que el modelo puede aportar (lista blanca).
 * Así, cualquier total, subtotal o impuesto que devuelva el modelo se descarta.
 */
function normalizarExtraccion(json) {
  const j = json && typeof json === 'object' ? json : {};
  const r = j.receptor && typeof j.receptor === 'object' ? j.receptor : null;
  return {
    estadoModelo: j.estado === 'faltan_datos' ? 'faltan_datos' : 'completo',
    preguntaModelo: texto(j.pregunta),
    receptor: r
      ? {
          nombre: texto(r.nombre),
          tipo_identificacion: texto(r.tipo_identificacion),
          identificacion: limpiarCodigo(r.identificacion),
          correo: texto(r.correo),
        }
      : null,
    lineas: (Array.isArray(j.lineas) ? j.lineas : []).map((l) => ({
      descripcion: texto(l?.descripcion),
      cantidad: parsearCantidad(l?.cantidad),
      unidad: texto(l?.unidad),
      tipo: ['servicio', 'producto'].includes(l?.tipo) ? l.tipo : null,
      precio_unitario: parsearImporte(l?.precio_unitario),
      descuento_monto: parsearImporte(l?.descuento_monto),
      descuento_porcentaje: parsearImporte(l?.descuento_porcentaje),
      tarifa_iva: parsearTarifa(l?.tarifa_iva),
      codigo_cabys: limpiarCodigo(l?.codigo_cabys),
    })),
    condicion_venta: texto(j.condicion_venta),
    plazo_credito_dias: Number.isFinite(Number.parseInt(j.plazo_credito_dias, 10)) ? Number.parseInt(j.plazo_credito_dias, 10) : null,
    medios_pago: (Array.isArray(j.medios_pago) ? j.medios_pago : [])
      .map((m) => ({ tipo: normalizarMedio(m?.tipo), monto: parsearImporte(m?.monto) }))
      .filter((m) => m.tipo),
    moneda: texto(j.moneda)?.toUpperCase().replace('₡', 'CRC') ?? null,
    tipo_cambio: parsearImporte(j.tipo_cambio),
    fecha: texto(j.fecha),
  };
}

/** Combina el borrador guardado en memoria con la nueva extracción (lo nuevo manda). */
function fusionar(borrador, nuevo) {
  if (!borrador) return nuevo;
  const elegir = (a, b) => (vacio(b) ? a : b);
  const receptor =
    borrador.receptor || nuevo.receptor
      ? Object.fromEntries(
          ['nombre', 'tipo_identificacion', 'identificacion', 'correo'].map((k) => [
            k,
            elegir(borrador.receptor?.[k] ?? null, nuevo.receptor?.[k] ?? null),
          ])
        )
      : null;
  const lineas = nuevo.lineas.length
    ? nuevo.lineas.map((l, i) => {
        const previa = borrador.lineas?.[i] || {};
        return Object.fromEntries(Object.keys(l).map((k) => [k, elegir(previa[k] ?? null, l[k])]));
      })
    : borrador.lineas || [];
  return {
    ...nuevo,
    receptor,
    lineas,
    condicion_venta: elegir(borrador.condicion_venta, nuevo.condicion_venta),
    plazo_credito_dias: elegir(borrador.plazo_credito_dias, nuevo.plazo_credito_dias),
    medios_pago: nuevo.medios_pago.length ? nuevo.medios_pago : borrador.medios_pago || [],
    moneda: elegir(borrador.moneda, nuevo.moneda),
    tipo_cambio: elegir(borrador.tipo_cambio, nuevo.tipo_cambio),
    fecha: elegir(borrador.fecha, nuevo.fecha),
  };
}

const esCredito = (condicion) => /cr[eé]dito/i.test(condicion || '');

/** Lo obligatorio lo decide el CÓDIGO (aunque el modelo diga "completo"). */
function calcularFaltantes(ext) {
  const faltan = [];
  if (!ext.receptor?.nombre) faltan.push('el nombre del receptor');
  if (!ext.receptor?.identificacion) faltan.push('la cédula (identificación) del receptor');
  else if (!/^\d{9,12}$/.test(ext.receptor.identificacion)) {
    faltan.push('una identificación válida del receptor (9 a 12 dígitos)');
  }
  if (!ext.lineas.length) faltan.push('qué se factura (al menos una línea)');
  ext.lineas.forEach((l, i) => {
    const nombre = l.descripcion ? `"${l.descripcion}"` : `la línea ${i + 1}`;
    if (!l.descripcion) faltan.push(`la descripción de la línea ${i + 1}`);
    if (!(l.precio_unitario > 0)) faltan.push(`el precio de ${nombre}`);
    if (l.cantidad !== null && !(l.cantidad > 0)) faltan.push(`una cantidad válida para ${nombre}`);
    if (l.tarifa_iva !== null && CODIGOS_TARIFA[l.tarifa_iva] === undefined) {
      faltan.push(`una tarifa de IVA válida (13, 4, 2, 1 o 0 %) para ${nombre}`);
    }
  });
  if (esCredito(ext.condicion_venta) && !(ext.plazo_credito_dias > 0)) faltan.push('el plazo del crédito en días');
  if (ext.moneda && ext.moneda !== 'CRC' && !(ext.tipo_cambio > 0)) faltan.push(`el tipo de cambio de ${ext.moneda}`);
  if (ext.medios_pago.length > 1 && ext.medios_pago.some((m) => !(m.monto > 0))) {
    faltan.push('cuánto se pagó con cada medio de pago');
  }
  return faltan;
}

function construirPregunta(faltantes) {
  const lista =
    faltantes.length > 1 ? `${faltantes.slice(0, -1).join(', ')} y ${faltantes.at(-1)}` : faltantes[0];
  return `Para generar la factura me falta ${lista}. ¿Me lo indicás?`;
}

// ------------------------------------------------------------------
// 2) Cálculo (100 % en código)
// ------------------------------------------------------------------

function tipoIdentificacionPorLongitud(id) {
  if (/^\d{9}$/.test(id)) return 'Física';
  if (/^\d{10}$/.test(id)) return 'Jurídica';
  if (/^\d{11,12}$/.test(id)) return 'DIMEX';
  return null;
}

/**
 * Construye datosEstructurados v4.4 con todos los montos calculados.
 * @param {object} ext - extracción normalizada (y completa)
 * @param {{ consecutivo: string, fecha: string, codigoSeguridad: string }} params
 * @returns {{ factura: object, supuestos: string[] }}
 */
function construirFactura(ext, { consecutivo, fecha, codigoSeguridad }) {
  const supuestos = [];

  const detalle = ext.lineas.map((l, i) => {
    const unidad = ['Sp', 'Unid'].includes(l.unidad) ? l.unidad : l.tipo === 'servicio' ? 'Sp' : 'Unid';
    if (!['Sp', 'Unid'].includes(l.unidad) && !l.tipo) supuestos.push(`Línea ${i + 1}: se tomó como producto (unidad "Unid").`);
    const cantidad = l.cantidad > 0 ? l.cantidad : 1;
    if (!(l.cantidad > 0)) supuestos.push(`Línea ${i + 1}: cantidad 1 (no se indicó).`);
    const tarifa = l.tarifa_iva ?? 13;
    if (l.tarifa_iva === null) supuestos.push(`Línea ${i + 1}: IVA 13 % (tarifa general; no se indicó).`);

    const montoTotal = r2(cantidad * l.precio_unitario);
    const descuento = r2(
      l.descuento_monto > 0 ? l.descuento_monto : l.descuento_porcentaje > 0 ? (montoTotal * l.descuento_porcentaje) / 100 : 0
    );
    const subtotal = r2(montoTotal - descuento);
    const impuesto = r2((subtotal * tarifa) / 100);
    return {
      numero_linea: i + 1,
      codigo_cabys: l.codigo_cabys || null,
      codigo_comercial: null,
      cantidad,
      unidad_medida: unidad,
      detalle: l.descripcion,
      precio_unitario: r2(l.precio_unitario),
      monto_total: montoTotal,
      descuentos: descuento > 0 ? [{ monto: descuento, naturaleza: 'Descuento comercial' }] : [],
      subtotal,
      base_imponible: subtotal,
      impuestos: [{ codigo: '01', codigo_tarifa: CODIGOS_TARIFA[tarifa], tarifa, monto: impuesto, exoneracion: null }],
      impuesto_neto: impuesto,
      monto_total_linea: r2(subtotal + impuesto),
    };
  });
  if (detalle.some((l) => !l.codigo_cabys)) {
    supuestos.push('Sin código CABYS en las líneas donde no se indicó (no se inventa).');
  }

  // --- Resumen ---
  const suma = (filtro, campo) => r2(detalle.filter(filtro).reduce((s, l) => s + l[campo], 0));
  const esServicio = (l) => l.unidad_medida === 'Sp';
  const gravada = (l) => l.impuestos[0].tarifa > 0;
  const resumen = {
    moneda: ext.moneda || 'CRC',
    tipo_cambio: ext.moneda && ext.moneda !== 'CRC' ? ext.tipo_cambio : 1,
    total_serv_gravados: suma((l) => esServicio(l) && gravada(l), 'monto_total'),
    total_serv_exentos: suma((l) => esServicio(l) && !gravada(l), 'monto_total'),
    total_serv_exonerado: 0,
    total_serv_no_sujeto: 0,
    total_mercancias_gravadas: suma((l) => !esServicio(l) && gravada(l), 'monto_total'),
    total_mercancias_exentas: suma((l) => !esServicio(l) && !gravada(l), 'monto_total'),
    total_merc_exonerada: 0,
    total_merc_no_sujeta: 0,
  };
  resumen.total_gravado = r2(resumen.total_serv_gravados + resumen.total_mercancias_gravadas);
  resumen.total_exento = r2(resumen.total_serv_exentos + resumen.total_mercancias_exentas);
  resumen.total_exonerado = 0;
  resumen.total_no_sujeto = 0;
  resumen.total_venta = r2(resumen.total_gravado + resumen.total_exento);
  resumen.total_descuentos = r2(detalle.reduce((s, l) => s + (l.monto_total - l.subtotal), 0));
  resumen.total_venta_neta = r2(resumen.total_venta - resumen.total_descuentos);

  const porTarifa = new Map();
  for (const l of detalle) {
    const imp = l.impuestos[0];
    const actual = porTarifa.get(imp.codigo_tarifa) || { codigo: '01', codigo_tarifa: imp.codigo_tarifa, tarifa: imp.tarifa, total: 0 };
    actual.total = r2(actual.total + imp.monto);
    porTarifa.set(imp.codigo_tarifa, actual);
  }
  resumen.desglose_impuesto = [...porTarifa.values()].sort((a, b) => a.tarifa - b.tarifa);
  resumen.total_impuesto = r2(detalle.reduce((s, l) => s + l.impuesto_neto, 0));
  resumen.total_iva_devuelto = 0;
  resumen.total_otros_cargos = 0;
  resumen.total_comprobante = r2(resumen.total_venta_neta + resumen.total_impuesto);

  // Medios de pago: por el total, salvo que el usuario haya repartido montos
  let medios = ext.medios_pago;
  if (!medios.length) {
    medios = [{ tipo: 'Efectivo', monto: null }];
    supuestos.push('Medio de pago: Efectivo (no se indicó).');
  }
  resumen.medios_pago =
    medios.length === 1
      ? [{ tipo: medios[0].tipo, total: resumen.total_comprobante }]
      : medios.map((m) => ({ tipo: m.tipo, total: r2(m.monto) }));

  // --- Encabezado y clave ---
  // Clave: 506 + DDMMAA + cédula del emisor (12) + consecutivo (20) + situación "1" + seguridad (8)
  const clave = `506${fechaDDMMAA(fecha)}${EMISOR.identificacion.padStart(12, '0')}${consecutivo}1${codigoSeguridad}`;
  if (!/^\d{50}$/.test(clave)) throw new Error(`Error interno: la clave generada mide ${clave.length} dígitos.`);

  const condicion = ext.condicion_venta || 'Contado';
  if (!ext.condicion_venta) supuestos.push('Condición de venta: Contado (no se indicó).');
  const receptor = ext.receptor;

  const factura = {
    tipo_documento: 'Factura Electrónica',
    version: '4.4',
    clave,
    numero_consecutivo: consecutivo,
    fecha_emision: fecha,
    codigo_actividad_emisor: EMISOR.codigo_actividad,
    proveedor_sistemas: EMISOR.proveedor_sistemas,
    condicion_venta: condicion,
    plazo_credito_dias: esCredito(condicion) ? ext.plazo_credito_dias : null,
    emisor: {
      nombre: EMISOR.nombre,
      nombre_comercial: EMISOR.nombre_comercial,
      tipo_identificacion: EMISOR.tipo_identificacion,
      identificacion: EMISOR.identificacion,
      codigo_actividad: EMISOR.codigo_actividad,
      ubicacion: EMISOR.ubicacion,
      telefono: EMISOR.telefono,
      correo: EMISOR.correo,
    },
    receptor: {
      nombre: receptor.nombre,
      nombre_comercial: null,
      tipo_identificacion: receptor.tipo_identificacion || tipoIdentificacionPorLongitud(receptor.identificacion),
      identificacion: receptor.identificacion,
      codigo_actividad: null,
      ubicacion: null,
      telefono: null,
      correo: receptor.correo,
    },
    detalle,
    otros_cargos: [],
    resumen,
    informacion_referencia: [],
    estado_hacienda: null,
    leyendas: ['Emitida conforme a la normativa de comprobantes electrónicos de la Dirección General de Tributación.'],
    otros: 'Documento de prueba generado por SistemaVision: sin validez fiscal (no firmado ni enviado a Hacienda).',
  };
  return { factura, supuestos };
}

// ------------------------------------------------------------------
// 3) Consecutivo (siguiente libre del emisor según la tabla facturas)
// ------------------------------------------------------------------
let ultimoConsecutivoRam = 0; // respaldo si MySQL no responde (y para no repetir en este proceso)

async function siguienteConsecutivo() {
  const avisos = [];
  let maximo = 0;
  try {
    const { Proveedor, Factura } = modelos();
    const proveedor = await Proveedor.findOne({ where: { identificacion: EMISOR.identificacion } });
    if (proveedor) {
      const filas = await Factura.findAll({
        where: { proveedor_id: proveedor.id, numero_consecutivo: { [Op.like]: `${PREFIJO_CONSECUTIVO}%` } },
        attributes: ['numero_consecutivo'],
        order: [['numero_consecutivo', 'DESC']],
        limit: 1,
      });
      for (const f of filas) {
        const c = String(f.numero_consecutivo || '');
        if (c.startsWith(PREFIJO_CONSECUTIVO) && /^\d{20}$/.test(c)) maximo = Math.max(maximo, Number(c.slice(10)));
      }
    }
  } catch (error) {
    avisos.push(`MySQL no disponible (${error.message}): el consecutivo es provisional y la factura no se guardó.`);
  }
  const numero = Math.max(maximo, ultimoConsecutivoRam) + 1;
  ultimoConsecutivoRam = numero;
  return { consecutivo: `${PREFIJO_CONSECUTIVO}${String(numero).padStart(10, '0')}`, avisos };
}

/** Borrador pendiente de esta sesión (el último, si no se generó una factura después). */
async function buscarBorrador(sessionId) {
  const recuerdos = await memoria.cargar(sessionId, 30).catch(() => []);
  for (let i = recuerdos.length - 1; i >= 0; i--) {
    const tipo = recuerdos[i].metadata?.tipo;
    if (tipo === 'factura_generada') return null;
    if (tipo === 'borrador_factura') return recuerdos[i].metadata.borrador || null;
  }
  return null;
}

// ------------------------------------------------------------------
// API pública
// ------------------------------------------------------------------

/**
 * Genera una factura a partir de texto libre.
 * @param {{ texto: string, sessionId?: string }} params
 * @param {{ ahora?: Date, codigoSeguridad?: string }} [opciones] - inyectables en pruebas
 * @returns {Promise<object>} { estado: "generada" | "faltan_datos", ... }
 */
async function generarFactura({ texto: textoUsuario, sessionId } = {}, opciones = {}) {
  const pedido = typeof textoUsuario === 'string' ? textoUsuario.trim() : '';
  if (!pedido) throw new Error('Escribí qué querés facturar.');

  const sid = sessionId || memoria.nuevaSesion();
  const hoy = ahoraCostaRica(opciones.ahora);
  const borrador = await buscarBorrador(sid);

  // --- Extracción (modelo, solo texto) ---
  const mensajes = [
    { role: 'system', content: `${PROMPT_EXTRACCION}\n\nFecha y hora actuales en Costa Rica: ${hoy}.` },
    {
      role: 'user',
      content: borrador
        ? `BORRADOR anterior (datos que el usuario ya dio):\n${JSON.stringify(borrador)}\n\nNueva respuesta del usuario: ${pedido}`
        : pedido,
    },
  ];
  const mensaje = await llamarOpenAI({
    model: process.env.OPENAI_TEXT_MODEL || process.env.OPENAI_VISION_MODEL || 'gpt-4o',
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: mensajes,
  });
  const extraido = normalizarExtraccion(parsearJSON(mensaje.content));
  const ext = fusionar(borrador, extraido);

  /** Responde "faltan_datos" y guarda el borrador en la memoria de la sesión. */
  async function pedirDatos(faltantes, pregunta) {
    const { estadoModelo, preguntaModelo, ...borradorNuevo } = ext; // eslint-disable-line no-unused-vars
    await memoria.guardar(sid, 'user', `[Generar factura] ${pedido}`);
    await memoria.guardar(sid, 'assistant', pregunta, { tipo: 'borrador_factura', borrador: borradorNuevo, faltantes });
    return { estado: 'faltan_datos', sessionId: sid, faltantes, pregunta, borrador: borradorNuevo };
  }

  // --- ¿Falta algo obligatorio? (lo decide el código, aunque el modelo diga "completo") ---
  const faltantes = calcularFaltantes(ext);
  if (faltantes.length) {
    const pregunta =
      extraido.estadoModelo === 'faltan_datos' && extraido.preguntaModelo ? extraido.preguntaModelo : construirPregunta(faltantes);
    return pedirDatos(faltantes, pregunta);
  }

  // --- Fecha, consecutivo y cálculo ---
  let fecha = hoy;
  if (ext.fecha) {
    const f = normalizarFechaTexto(ext.fecha);
    // Si el usuario dio solo el día, se conserva la hora actual
    fecha = /^\d{4}-\d{2}-\d{2}T00:00:00$/.test(f) ? `${f.slice(0, 10)}${hoy.slice(10)}` : f;
  }

  let intento = 0;
  let resultado;
  while (true) {
    intento += 1;
    const { consecutivo, avisos } = await siguienteConsecutivo();
    const codigoSeguridad = opciones.codigoSeguridad || String(crypto.randomInt(0, 100000000)).padStart(8, '0');
    const { factura, supuestos } = construirFactura(ext, { consecutivo, fecha, codigoSeguridad });

    // Montos por medio de pago dados por el usuario que no suman el total: es un dato
    // del usuario (no un error del código), así que se le pregunta.
    const r = factura.resumen;
    const sumaMedios = r2(r.medios_pago.reduce((s, m) => s + m.total, 0));
    if (Math.abs(sumaMedios - r.total_comprobante) > 1) {
      return pedirDatos(
        ['montos de los medios de pago que sumen el total'],
        `Los montos de los medios de pago suman ₡${formatearMontoCR(sumaMedios)}, pero el total de la factura es ` +
          `₡${formatearMontoCR(r.total_comprobante)}. ¿Cuánto se pagó con cada medio?`
      );
    }

    // La factura generada DEBE validar sin advertencias: si no, es un error del código
    const { advertencias } = validarFactura(factura);
    if (advertencias.length) {
      throw new Error(`Error interno: la factura generada no pasa la validación: ${advertencias.join(' | ')}`);
    }

    // --- Representación visual (los datos ya están calculados y validados) ---
    // Los tests unitarios no llaman servicios externos; en producción se genera la imagen.
    let imagenGenerada = null;
    let verificacionImagen = null;
    const entornoPruebas = process.env.NODE_ENV === 'test' || process.argv.some((arg) => arg.includes('--test') || arg.endsWith('test/agente.test.js'));
    if (!entornoPruebas && process.env.GENERADOR_GENERAR_IMAGEN === 'true') {
      imagenGenerada = await generarImagenFactura(factura, { intento });
      verificacionImagen = await verificarImagenFactura(factura, imagenGenerada);
    }

    // --- Guardado (origen "generada") ---
    let guardado = { ok: false };
    if (!avisos.length) {
      guardado = await ejecutarTool('guardar_factura', { ...factura, confianza: 1 }, { sessionId: sid, origen: 'generada' });
      // Otro proceso tomó el mismo consecutivo: se recalcula (máx. 3 intentos)
      if (!guardado.ok && guardado.duplicada && intento < 3) continue;
      if (!guardado.ok) avisos.push(`No se guardó en la base de datos: ${guardado.error}`);
    }
    resultado = { factura, supuestos, avisos, imagenGenerada, verificacionImagen, facturaGuardadaId: guardado.ok ? guardado.factura_id : null };
    break;
  }

  const { factura } = resultado;
  const r = factura.resumen;
  const respuesta =
    `Factura ${factura.numero_consecutivo} para ${factura.receptor.nombre} generada: ` +
    `${factura.detalle.length} línea(s), IVA ₡${formatearMontoCR(r.total_impuesto)}, total ₡${formatearMontoCR(r.total_comprobante)}.`;

  // --- Memoria: pedido, resumen y respuesta (cierra el borrador) ---
  try {
    await memoria.guardar(sid, 'user', `[Generar factura] ${pedido}`);
    await memoria.guardar(
      sid,
      'resumen',
      memoria.resumirFactura(factura, { facturaGuardadaId: resultado.facturaGuardadaId }),
      { facturaGuardadaId: resultado.facturaGuardadaId, origen: 'generada' }
    );
    await memoria.guardar(sid, 'assistant', respuesta, {
      tipo: 'factura_generada',
      facturaGuardadaId: resultado.facturaGuardadaId,
      numero_consecutivo: factura.numero_consecutivo,
    });
  } catch (error) {
    console.warn(`[generador] No se pudo guardar la memoria: ${error.message}`);
  }

  return {
    estado: 'generada',
    sessionId: sid,
    datosEstructurados: factura,
    facturaGuardadaId: resultado.facturaGuardadaId,
    guardada: !!resultado.facturaGuardadaId,
    supuestos: resultado.supuestos,
    avisos: resultado.avisos,
    imagen: resultado.imagenGenerada ? { url: resultado.imagenGenerada.url, uso: resultado.imagenGenerada.uso } : null,
    verificacionImagen: resultado.verificacionImagen,
    advertencias: [],
    respuesta,
  };
}

module.exports = {
  generarFactura,
  // Exportadas para pruebas
  PROMPT_EXTRACCION,
  normalizarExtraccion,
  calcularFaltantes,
  construirFactura,
  formatearMontoCR,
  ahoraCostaRica,
  EMISOR,
};
