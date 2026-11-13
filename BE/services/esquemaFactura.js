/**
 * esquemaFactura.js
 * ------------------------------------------------------------------
 * Estructura de un comprobante electrónico v4.4 de Hacienda (Costa Rica).
 *
 * - ESTRUCTURA_TEXTO: la forma de datosEstructurados, para el SYSTEM_PROMPT.
 * - FACTURA_JSON_SCHEMA: JSON Schema de los parámetros de la tool guardar_factura.
 * - normalizarFactura(f): limpia códigos (sin guiones), convierte importes a número,
 *   pasa la tarifa de IVA a porcentaje y adapta el formato antiguo (numero_factura, items...).
 * - validarFactura(f): revisa formatos y que las cuentas cuadren (tolerancia ±1).
 * ------------------------------------------------------------------
 */

const TOLERANCIA = 1;

const TIPOS_DOCUMENTO = [
  'Factura Electrónica',
  'Tiquete Electrónico',
  'Nota de Crédito Electrónica',
  'Nota de Débito Electrónica',
  'Factura Electrónica de Compra',
  'Factura Electrónica de Exportación',
  'Recibo Electrónico de Pago',
];

// Posiciones 9-10 del consecutivo (después de sucursal y terminal)
const CODIGOS_TIPO_DOCUMENTO = {
  '01': 'Factura Electrónica',
  '02': 'Nota de Débito Electrónica',
  '03': 'Nota de Crédito Electrónica',
  '04': 'Tiquete Electrónico',
  '08': 'Factura Electrónica de Compra',
  '09': 'Factura Electrónica de Exportación',
  '10': 'Recibo Electrónico de Pago',
};

const TIPOS_IDENTIFICACION = ['Física', 'Jurídica', 'DIMEX', 'NITE', 'Extranjero no domiciliado', 'No contribuyente'];
const MEDIOS_PAGO = ['Efectivo', 'Tarjeta', 'Cheque', 'Transferencia', 'SINPE Móvil', 'Plataforma digital', 'otro'];

// Totales del resumen (todos numéricos). Los modelos Sequelize también usan esta lista.
const CAMPOS_TOTALES = [
  'total_serv_gravados',
  'total_serv_exentos',
  'total_serv_exonerado',
  'total_serv_no_sujeto',
  'total_mercancias_gravadas',
  'total_mercancias_exentas',
  'total_merc_exonerada',
  'total_merc_no_sujeta',
  'total_gravado',
  'total_exento',
  'total_exonerado',
  'total_no_sujeto',
  'total_venta',
  'total_descuentos',
  'total_venta_neta',
  'total_impuesto',
  'total_iva_devuelto',
  'total_otros_cargos',
  'total_comprobante',
];

const CAMPOS_NUMERICOS_LINEA = [
  'cantidad',
  'precio_unitario',
  'monto_total',
  'subtotal',
  'base_imponible',
  'impuesto_neto',
  'monto_total_linea',
];

// ------------------------------------------------------------------
// Texto para el SYSTEM_PROMPT
// ------------------------------------------------------------------
const PERSONA = `{
    "nombre": "", "nombre_comercial": "",
    "tipo_identificacion": "${TIPOS_IDENTIFICACION.join(' | ')}",
    "identificacion": "solo dígitos/letras, sin guiones",
    "codigo_actividad": "",
    "ubicacion": { "provincia": "", "canton": "", "distrito": "", "barrio": "", "otras_senas": "" },
    "telefono": "", "correo": ""
  }`;

const ESTRUCTURA_TEXTO = `{
  "tipo_documento": "${TIPOS_DOCUMENTO.join(' | ')}",
  "version": "4.4",
  "clave": "50 dígitos sin guiones: 506 | DDMMAA | identificación del emisor (12) | consecutivo (20) | situación (1) | código de seguridad (8)",
  "numero_consecutivo": "20 dígitos sin guiones: sucursal (3) | terminal (5) | tipo de documento (2) | número (10)",
  "fecha_emision": "AAAA-MM-DDTHH:mm:ss (impresa como DD/MM/AAAA; sin zona horaria), p. ej. 2025-03-15T10:30:00",
  "codigo_actividad_emisor": "", "proveedor_sistemas": "",
  "condicion_venta": "Contado | Crédito | ...", "plazo_credito_dias": "número de días, o null si es de contado o no aparece",
  "emisor": ${PERSONA},
  "receptor": ${PERSONA},
  "detalle": [{
    "numero_linea": 1, "codigo_cabys": "13 dígitos", "codigo_comercial": "",
    "cantidad": "TEXTO tal como está impreso, p. ej. \\"2,000\\"",
    "unidad_medida": "Unid | Sp | kg | ...", "detalle": "descripción",
    "precio_unitario": "TEXTO impreso, p. ej. \\"16.250,00\\"", "monto_total": "TEXTO impreso",
    "descuentos": [{ "monto": 0, "naturaleza": "" }],
    "subtotal": "TEXTO impreso", "base_imponible": 0,
    "impuestos": [{
      "codigo": "01", "codigo_tarifa": "08", "tarifa": 13, "monto": 0,
      "exoneracion": { "tipo_documento": "", "numero_documento": "", "institucion": "", "fecha": "", "porcentaje": 0, "monto": 0 } | null
    }],
    "impuesto_neto": "TEXTO impreso", "monto_total_linea": "TEXTO impreso"
  }],
  "otros_cargos": [{ "tipo_documento": "", "detalle": "", "porcentaje": 0, "monto": 0 }],
  "resumen": {
    "moneda": "CRC | USD | ...", "tipo_cambio": 1,
${CAMPOS_TOTALES.filter((c) => !['total_impuesto', 'total_iva_devuelto', 'total_otros_cargos', 'total_comprobante'].includes(c))
  .map((c) => `    "${c}": 0,`)
  .join('\n')}
    "desglose_impuesto": [{ "codigo": "01", "codigo_tarifa": "08", "tarifa": 13, "total": 0 }],
    "total_impuesto": 0, "total_iva_devuelto": 0, "total_otros_cargos": 0,
    "medios_pago": [{ "tipo": "${MEDIOS_PAGO.join(' | ')}", "total": 0 }],
    "total_comprobante": 0
  },
  "informacion_referencia": [{ "tipo_documento": "", "numero": "", "fecha": "", "codigo": "", "razon": "" }],
  "estado_hacienda": "Aceptado | Rechazado | ... (si aparece impreso)",
  "leyendas": ["textos legales o notas visibles"],
  "otros": "cualquier otra información visible que no encaje arriba"
}`;

// ------------------------------------------------------------------
// JSON Schema (parámetros de guardar_factura)
// ------------------------------------------------------------------
const str = { type: ['string', 'null'] };
const num = { type: ['number', 'string', 'null'] };
// Campos de línea que se piden como texto impreso y se convierten en el código
const impreso = (ejemplo) => ({
  type: ['string', 'number', 'null'],
  description: `Texto tal como aparece impreso (p. ej. "${ejemplo}"); el backend lo convierte`,
});
const enumStr = (valores) => ({ type: ['string', 'null'], description: valores.join(' | ') });

const esquemaPersona = {
  type: ['object', 'null'],
  properties: {
    nombre: str,
    nombre_comercial: str,
    tipo_identificacion: enumStr(TIPOS_IDENTIFICACION),
    identificacion: str,
    codigo_actividad: str,
    ubicacion: {
      type: ['object', 'null'],
      properties: { provincia: str, canton: str, distrito: str, barrio: str, otras_senas: str },
    },
    telefono: str,
    correo: str,
  },
};

const FACTURA_JSON_SCHEMA = {
  type: 'object',
  properties: {
    tipo_documento: enumStr(TIPOS_DOCUMENTO),
    version: str,
    clave: { type: ['string', 'null'], description: '50 dígitos sin guiones' },
    numero_consecutivo: { type: ['string', 'null'], description: '20 dígitos sin guiones' },
    fecha_emision: { type: ['string', 'null'], description: 'AAAA-MM-DDTHH:mm:ss, sin zona horaria' },
    codigo_actividad_emisor: str,
    proveedor_sistemas: str,
    condicion_venta: str,
    plazo_credito_dias: { type: ['integer', 'string', 'null'], description: 'null si la venta es de contado' },
    emisor: esquemaPersona,
    receptor: esquemaPersona,
    detalle: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          numero_linea: { type: ['integer', 'null'] },
          codigo_cabys: { type: ['string', 'null'], description: '13 dígitos' },
          codigo_comercial: str,
          cantidad: impreso('2,000'),
          unidad_medida: str,
          detalle: str,
          precio_unitario: impreso('16.250,00'),
          monto_total: impreso('32.500,00'),
          descuentos: {
            type: 'array',
            items: { type: 'object', properties: { monto: num, naturaleza: str } },
          },
          subtotal: impreso('32.500,00'),
          base_imponible: num,
          impuestos: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                codigo: str,
                codigo_tarifa: str,
                tarifa: { type: ['number', 'string', 'null'], description: 'Porcentaje, p. ej. 13' },
                monto: num,
                exoneracion: {
                  type: ['object', 'null'],
                  properties: {
                    tipo_documento: str,
                    numero_documento: str,
                    institucion: str,
                    fecha: str,
                    porcentaje: num,
                    monto: num,
                  },
                },
              },
            },
          },
          impuesto_neto: impreso('4.225,00'),
          monto_total_linea: impreso('36.725,00'),
        },
      },
    },
    otros_cargos: {
      type: 'array',
      items: { type: 'object', properties: { tipo_documento: str, detalle: str, porcentaje: num, monto: num } },
    },
    resumen: {
      type: 'object',
      properties: {
        moneda: str,
        tipo_cambio: num,
        ...Object.fromEntries(CAMPOS_TOTALES.map((c) => [c, num])),
        desglose_impuesto: {
          type: 'array',
          items: { type: 'object', properties: { codigo: str, codigo_tarifa: str, tarifa: num, total: num } },
        },
        medios_pago: {
          type: 'array',
          items: { type: 'object', properties: { tipo: enumStr(MEDIOS_PAGO), total: num } },
        },
      },
    },
    informacion_referencia: {
      type: 'array',
      items: {
        type: 'object',
        properties: { tipo_documento: str, numero: str, fecha: str, codigo: str, razon: str },
      },
    },
    estado_hacienda: str,
    leyendas: { type: 'array', items: { type: 'string' } },
    otros: { type: ['string', 'object', 'null'] },
  },
  required: ['emisor', 'resumen'],
};

// ------------------------------------------------------------------
// Normalización
// ------------------------------------------------------------------

/**
 * Núcleo común: convierte un número escrito con las convenciones de Costa Rica
 * (punto = miles, coma = decimal).
 *   "32.500,00"  → 32500
 *   "2,000"      → 2        (una sola coma: SIEMPRE decimal)
 *   "1,500"      → 1.5
 *   "1.234"      → 1234     (un solo punto + exactamente 3 dígitos = miles)
 *   "0.130"      → 0.13     (parte entera 0: es decimal)
 *   "12.5"       → 12.5     (punto con 1-2 dígitos: decimal)
 *   "1.234.567"  → 1234567
 *   "1,234.50"   → 1234.5   (si hay ambos, el último es el decimal)
 *   "1,234,567"  → 1234567  (varias comas: miles)
 */
function parsearNumeroCR(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;

  let s = String(valor).trim();
  const negativo = /^\(.*\)$/.test(s) || /^-/.test(s.replace(/[^\d\-.,]/g, ''));
  s = s.replace(/[^\d.,]/g, ''); // quita símbolos (₡, $), espacios y letras
  if (!s || !/\d/.test(s)) return null;

  const ultimaComa = s.lastIndexOf(',');
  const ultimoPunto = s.lastIndexOf('.');

  if (ultimaComa !== -1 && ultimoPunto !== -1) {
    // Hay ambos: el que aparece último es el separador decimal
    if (ultimaComa > ultimoPunto) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (ultimaComa !== -1) {
    // Una sola coma es decimal (Costa Rica); varias comas solo pueden ser miles
    const comas = (s.match(/,/g) || []).length;
    s = comas > 1 ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (ultimoPunto !== -1) {
    const puntos = (s.match(/\./g) || []).length;
    // Varios puntos, o un solo punto con exactamente 3 dígitos detrás (y parte entera ≠ 0) → miles
    if (puntos > 1 || /^[1-9]\d{0,2}\.\d{3}$/.test(s)) s = s.replace(/\./g, '');
  }

  const n = Number.parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return negativo ? -n : n;
}

/**
 * Montos (precios, subtotales, impuestos, totales): "32.500,00" → 32500, "₡2.400,00" → 2400.
 * Los números (tipo number) se devuelven tal cual. Devuelve null si no se puede interpretar.
 */
function parsearImporte(valor) {
  return parsearNumeroCR(valor);
}

/**
 * Cantidades: en los comprobantes de Costa Rica la coma es decimal y suelen
 * imprimirse con 3 decimales. "2,000" → 2, "1,500" → 1.5, "10" → 10, "1.000,500" → 1000.5.
 */
function parsearCantidad(valor) {
  return parsearNumeroCR(valor);
}

/**
 * Fecha como texto local "AAAA-MM-DDTHH:mm:ss", SIN conversión de zona horaria.
 * Acepta lo impreso en Costa Rica ("15/03/2025 10:30") y AAAA-MM-DD[THH:mm[:ss]][zona]
 * (la zona se descarta: se conserva la hora tal como está impresa).
 */
function normalizarFechaTexto(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const s = String(valor).trim();
  const dos = (x) => String(x).padStart(2, '0');
  let m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(a\.?\s*m\.?|p\.?\s*m\.?)?)?/i);
  if (m) {
    const [, d, mes, a, hh = '0', mi = '0', ss = '0', ampm] = m;
    let hora = Number(hh);
    if (ampm && /p/i.test(ampm) && hora < 12) hora += 12;
    if (ampm && /a/i.test(ampm) && hora === 12) hora = 0;
    const anio = a.length === 2 ? `20${a}` : a;
    return `${anio}-${dos(mes)}-${dos(d)}T${dos(hora)}:${dos(mi)}:${dos(ss)}`;
  }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const [, a, mes, d, hh = '0', mi = '0', ss = '0'] = m;
    return `${a}-${dos(mes)}-${dos(d)}T${dos(hh)}:${dos(mi)}:${dos(ss)}`;
  }
  return s; // formato desconocido: se conserva tal cual (no se inventa)
}

/** Fecha en formato DDMMAA (como en la clave) a partir de "AAAA-MM-DD..." o "DD/MM/AAAA". */
function fechaDDMMAA(valor) {
  const t = normalizarFechaTexto(valor);
  const m = t && t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}${m[2]}${m[1].slice(2)}` : null;
}

/** Tarifa de IVA como porcentaje: 0.13 → 13. */
function parsearTarifa(valor) {
  const n = parsearImporte(valor);
  if (n === null) return null;
  return n > 0 && n < 1 ? Math.round(n * 10000) / 100 : n;
}

/** Quita espacios, guiones y puntos (clave, consecutivo, CABYS, cédulas). */
function limpiarCodigo(valor) {
  if (valor === null || valor === undefined) return null;
  const s = String(valor).replace(/[\s.\-–]/g, '');
  return s || null;
}

const esObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const comoArray = (v) => (Array.isArray(v) ? v : []);

const esContado = (condicion) => /contado/i.test(String(condicion ?? '')) || String(condicion ?? '').trim() === '01';

const NO_APLICA = /^\s*(no\s+aplica|n\/?a|ninguno|ninguna|sin\s+\w+|-+)\s*$/i;
const valorVacio = (v) => v === null || v === undefined || (typeof v === 'string' && (!v.trim() || NO_APLICA.test(v)));

/**
 * Secciones opcionales (otros_cargos, informacion_referencia): si no existen o dicen
 * "no aplica", quedan como []. Se descartan las entradas que no son objetos o que
 * tienen todos sus valores vacíos / "no aplica".
 */
function seccionAplicable(v) {
  return comoArray(v).filter((e) => esObjeto(e) && !Object.values(e).every(valorVacio));
}

function normalizarPersona(p) {
  if (p === null || p === undefined) return null;
  const persona = typeof p === 'string' ? { nombre: p } : { ...p };
  // Formato antiguo: nif_rfc → identificacion
  if (persona.identificacion == null && persona.nif_rfc != null) persona.identificacion = persona.nif_rfc;
  delete persona.nif_rfc;
  persona.identificacion = limpiarCodigo(persona.identificacion);
  // Formato antiguo: direccion → ubicacion.otras_senas
  if (!esObjeto(persona.ubicacion) && persona.direccion) persona.ubicacion = { otras_senas: persona.direccion };
  return persona;
}

/**
 * Devuelve una copia normalizada del comprobante. Es idempotente.
 * Acepta también el formato antiguo (numero_factura, items, total, nif_rfc...).
 */
function normalizarFactura(entrada) {
  if (!esObjeto(entrada)) return null;
  const f = structuredClone(entrada);

  // --- Compatibilidad con el formato anterior ---
  if (f.numero_consecutivo == null && f.numero_factura != null) f.numero_consecutivo = f.numero_factura;
  if (f.detalle == null && Array.isArray(f.items)) {
    f.detalle = f.items.map((i) => ({
      ...i,
      detalle: i.detalle ?? i.descripcion ?? i.concepto ?? null,
      monto_total_linea: i.monto_total_linea ?? i.importe ?? null,
    }));
  }
  f.resumen = esObjeto(f.resumen) ? { ...f.resumen } : {};
  const legado = { moneda: 'moneda', subtotal: 'total_venta_neta', impuestos: 'total_impuesto', total: 'total_comprobante' };
  for (const [antiguo, nuevo] of Object.entries(legado)) {
    if (f.resumen[nuevo] == null && f[antiguo] != null) f.resumen[nuevo] = f[antiguo];
  }
  for (const k of ['numero_factura', 'items', ...Object.keys(legado)]) delete f[k];

  // --- Encabezado ---
  f.clave = limpiarCodigo(f.clave);
  f.numero_consecutivo = limpiarCodigo(f.numero_consecutivo);
  if ('fecha_emision' in f) f.fecha_emision = normalizarFechaTexto(f.fecha_emision);
  if (f.plazo_credito_dias != null) {
    const dias = Number.parseInt(f.plazo_credito_dias, 10);
    f.plazo_credito_dias = Number.isFinite(dias) ? dias : null;
  }
  // Venta de contado (texto "Contado" o código 01): no hay plazo de crédito
  if (esContado(f.condicion_venta)) f.plazo_credito_dias = null;
  // Si falta el tipo, se deduce del consecutivo
  if (!f.tipo_documento && /^\d{20}$/.test(f.numero_consecutivo || '')) {
    f.tipo_documento = CODIGOS_TIPO_DOCUMENTO[f.numero_consecutivo.slice(8, 10)] || null;
  }

  f.emisor = normalizarPersona(f.emisor);
  f.receptor = normalizarPersona(f.receptor);

  // --- Detalle ---
  f.detalle = comoArray(f.detalle).map((linea, idx) => {
    const l = { ...linea };
    l.numero_linea = Number.parseInt(l.numero_linea, 10) || idx + 1;
    l.codigo_cabys = limpiarCodigo(l.codigo_cabys);
    // El modelo copia estos campos como texto impreso; aquí se convierten:
    // la cantidad con parsearCantidad (coma decimal) y el resto como montos.
    for (const c of CAMPOS_NUMERICOS_LINEA) {
      if (c in l) l[c] = c === 'cantidad' ? parsearCantidad(l[c]) : parsearImporte(l[c]);
    }
    l.descuentos = comoArray(l.descuentos).map((d) => ({ ...d, monto: parsearImporte(d?.monto) }));
    l.impuestos = comoArray(l.impuestos).map((imp) => ({
      ...imp,
      tarifa: parsearTarifa(imp?.tarifa),
      monto: parsearImporte(imp?.monto),
      exoneracion: esObjeto(imp?.exoneracion)
        ? {
            ...imp.exoneracion,
            porcentaje: parsearImporte(imp.exoneracion.porcentaje),
            monto: parsearImporte(imp.exoneracion.monto),
          }
        : null,
    }));
    return l;
  });

  f.otros_cargos = seccionAplicable(f.otros_cargos).map((o) => ({
    ...o,
    porcentaje: parsearImporte(o?.porcentaje),
    monto: parsearImporte(o?.monto),
  }));

  // --- Resumen ---
  const r = f.resumen;
  if (r.moneda) r.moneda = String(r.moneda).trim().toUpperCase().replace('₡', 'CRC').slice(0, 10);
  if ('tipo_cambio' in r) r.tipo_cambio = parsearImporte(r.tipo_cambio);
  for (const c of CAMPOS_TOTALES) if (c in r) r[c] = parsearImporte(r[c]);
  r.desglose_impuesto = comoArray(r.desglose_impuesto).map((d) => ({
    ...d,
    tarifa: parsearTarifa(d?.tarifa),
    total: parsearImporte(d?.total),
  }));
  r.medios_pago = comoArray(r.medios_pago).map((m) => (typeof m === 'string' ? { tipo: m, total: null } : { ...m, total: parsearImporte(m?.total) }));

  f.informacion_referencia = seccionAplicable(f.informacion_referencia).map((ref) =>
    ref.fecha ? { ...ref, fecha: normalizarFechaTexto(ref.fecha) } : ref
  );
  f.leyendas = comoArray(f.leyendas).map(String);
  return f;
}

// ------------------------------------------------------------------
// Correcciones deterministas (no son errores: se corrigen y se anotan)
// ------------------------------------------------------------------

/**
 * Si la fecha de emisión con día y mes invertidos coincide EXACTAMENTE con el DDMMAA
 * de la clave, y el resto de la clave valida (506, identificación del emisor y
 * consecutivo), corrige la fecha. Ej.: 2026-12-11 con clave 506121126… → 2026-11-12.
 */
function corregirFechaSegunClave(f) {
  const sinCambios = { factura: f, notas: [] };
  if (!f || !/^\d{50}$/.test(f.clave || '') || !f.clave.startsWith('506')) return sinCambios;

  const fechaClave = f.clave.slice(3, 9);
  const texto = normalizarFechaTexto(f.fecha_emision);
  const m = texto && texto.match(/^(\d{4})-(\d{2})-(\d{2})(.*)$/);
  if (!m || fechaDDMMAA(texto) === fechaClave) return sinCambios;

  // El resto de la clave debe validar; si no, la clave tampoco es fiable
  const id = f.emisor?.identificacion;
  if (id && /^\d{1,12}$/.test(id) && f.clave.slice(9, 21) !== id.padStart(12, '0')) return sinCambios;
  if (/^\d{20}$/.test(f.numero_consecutivo || '') && f.clave.slice(21, 41) !== f.numero_consecutivo) return sinCambios;

  const [, anio, mes, dia, resto] = m;
  const invertida = `${mes}${dia}${anio.slice(2)}`; // DDMMAA con día y mes intercambiados
  if (invertida !== fechaClave || Number(dia) < 1 || Number(dia) > 12) return sinCambios;

  const corregida = `${anio}-${dia}-${mes}${resto}`;
  return {
    factura: { ...f, fecha_emision: corregida },
    notas: [`Fecha corregida según la clave: ${texto} → ${corregida} (día y mes estaban invertidos).`],
  };
}

/**
 * ¿Es una clave estructuralmente válida? (no depende de lo que leyó el modelo)
 * 50 dígitos, empieza por 506, DDMMAA con día 01-31 y mes 01-12, tipo de documento
 * del consecutivo conocido y situación 1-3.
 */
function claveEstructuralmenteValida(clave) {
  if (!/^\d{50}$/.test(clave || '') || !clave.startsWith('506')) return false;
  const dia = Number(clave.slice(3, 5));
  const mes = Number(clave.slice(5, 7));
  const tipo = clave.slice(21, 41).slice(8, 10);
  const situacion = clave[41];
  return dia >= 1 && dia <= 31 && mes >= 1 && mes <= 12 && !!CODIGOS_TIPO_DOCUMENTO[tipo] && '123'.includes(situacion);
}

/**
 * Reconciliación determinista con la clave leída por OCR (más fiable que el modelo
 * para secuencias largas de dígitos repetidos). Si hay una clave válida de 50 dígitos:
 *  - la clave del modelo se sustituye por la del OCR;
 *  - el consecutivo se toma de clave[21..41] si no coincide;
 *  - la fecha se corrige si con día y mes invertidos coincide con clave[3..9]
 *    (aquí SIN exigir que la cédula y el consecutivo validen);
 *  - la identificación del emisor rellena a 12 dígitos que coincide con clave[9..21]
 *    se anota como confirmación; si no coincide, validarFactura deja la advertencia.
 * Todo va en "notas", no en "advertencias".
 * @param {object} entrada - datosEstructurados
 * @param {string[]} clavesOcr - claves de 50 dígitos encontradas por el OCR
 * @returns {{ factura: object, notas: string[] }}
 */
function reconciliarConClaveOcr(entrada, clavesOcr = []) {
  const f = normalizarFactura(entrada);
  const validas = [...new Set(clavesOcr || [])].filter(claveEstructuralmenteValida);
  if (!f || !validas.length) return { factura: f, notas: [] };

  const idEmisor = f.emisor?.identificacion;
  const idRelleno = idEmisor && /^\d{1,12}$/.test(idEmisor) ? idEmisor.padStart(12, '0') : null;
  // Si el OCR encontró varias, se prefiere la que coincide con la cédula del emisor
  const clave = validas.find((c) => idRelleno && c.slice(9, 21) === idRelleno) || validas[0];
  const notas = [];

  if (f.clave !== clave) {
    notas.push(`Clave tomada del OCR: ${clave}${f.clave ? ` (el modelo había leído ${f.clave})` : ''}.`);
    f.clave = clave;
  }

  const consecutivo = clave.slice(21, 41);
  if (f.numero_consecutivo !== consecutivo) {
    notas.push(
      `Consecutivo tomado de la clave (OCR): ${consecutivo}` +
        `${f.numero_consecutivo ? ` (el modelo había leído ${f.numero_consecutivo})` : ''}.`
    );
    f.numero_consecutivo = consecutivo;
  }
  if (!f.tipo_documento) f.tipo_documento = CODIGOS_TIPO_DOCUMENTO[consecutivo.slice(8, 10)] || null;

  const fechaClave = clave.slice(3, 9);
  const texto = normalizarFechaTexto(f.fecha_emision);
  const m = texto && texto.match(/^(\d{4})-(\d{2})-(\d{2})(.*)$/);
  if (m && fechaDDMMAA(texto) !== fechaClave) {
    const [, anio, mes, dia, resto] = m;
    if (`${mes}${dia}${anio.slice(2)}` === fechaClave && Number(dia) >= 1 && Number(dia) <= 12) {
      const corregida = `${anio}-${dia}-${mes}${resto}`;
      notas.push(`Fecha corregida según la clave (OCR): ${texto} → ${corregida} (día y mes estaban invertidos).`);
      f.fecha_emision = corregida;
    }
  }

  if (idRelleno && clave.slice(9, 21) === idRelleno) {
    notas.push(`Identificación del emisor ${idEmisor} confirmada por la clave (OCR).`);
  }

  return { factura: f, notas };
}

/**
 * Reconciliación con el OCR de las zonas "emisor" y "receptor".
 * - Actividad: si el OCR encontró un número completo de 6 dígitos tras "Actividad" y no
 *   coincide con el del modelo, se usa el del OCR (nota "Actividad del receptor tomada del OCR").
 * - Identificación: igual con la que sigue a "Cédula" (9-12 dígitos). Para el emisor, si hay
 *   una clave del OCR válida, ella decide: no se cambia una cédula que la clave confirma, ni
 *   se pone una que la clave contradice.
 * - Si el OCR no encontró la etiqueta, se deja el valor del modelo sin advertencia.
 * @param {object} entrada - datosEstructurados
 * @param {{ emisor?: {actividad, identificacion}, receptor?: {actividad, identificacion} }} zonas
 * @param {string[]} [clavesOcr]
 * @returns {{ factura: object, notas: string[] }}
 */
function reconciliarZonasOcr(entrada, zonas = {}, clavesOcr = []) {
  const f = normalizarFactura(entrada);
  if (!f) return { factura: f, notas: [] };
  const notas = [];
  const claveValida = (clavesOcr || []).find(claveEstructuralmenteValida);
  const idClave = claveValida ? claveValida.slice(9, 21) : null;
  const relleno = (id) => (id && /^\d{1,12}$/.test(id) ? id.padStart(12, '0') : null);

  for (const rol of ['emisor', 'receptor']) {
    const z = zonas?.[rol];
    const persona = f[rol];
    if (!z || !persona) continue; // sin OCR de la zona o sin esa persona en el comprobante

    // --- Código de actividad ---
    if (z.actividad && /^\d{6}$/.test(z.actividad)) {
      const actual = limpiarCodigo(persona.codigo_actividad ?? (rol === 'emisor' ? f.codigo_actividad_emisor : null));
      if (actual !== z.actividad) {
        notas.push(`Actividad del ${rol} tomada del OCR: ${z.actividad}${actual ? ` (el modelo había leído ${actual})` : ''}.`);
        persona.codigo_actividad = z.actividad;
        if (rol === 'emisor' && (!f.codigo_actividad_emisor || limpiarCodigo(f.codigo_actividad_emisor) === actual)) {
          f.codigo_actividad_emisor = z.actividad;
        }
      }
    }

    // --- Identificación ---
    if (z.identificacion && /^\d{9,12}$/.test(z.identificacion) && persona.identificacion !== z.identificacion) {
      const actual = persona.identificacion;
      const decideLaClave = rol === 'emisor' && idClave;
      const claveConfirmaModelo = decideLaClave && relleno(actual) === idClave;
      const claveContradiceOcr = decideLaClave && relleno(z.identificacion) !== idClave;
      if (!claveConfirmaModelo && !claveContradiceOcr) {
        notas.push(
          `Identificación del ${rol} tomada del OCR: ${z.identificacion}${actual ? ` (el modelo había leído ${actual})` : ''}.`
        );
        persona.identificacion = z.identificacion;
      }
    }
  }
  return { factura: f, notas };
}

/** Aplica todas las correcciones deterministas. @returns {{ factura: object, notas: string[] }} */
function aplicarCorrecciones(entrada) {
  const f = normalizarFactura(entrada);
  if (!f) return { factura: null, notas: [] };
  return corregirFechaSegunClave(f);
}

// ------------------------------------------------------------------
// Validación
// ------------------------------------------------------------------
const esNumero = (v) => typeof v === 'number' && Number.isFinite(v);
const fmt = (n) => (Math.round(n * 100) / 100).toString();
const descuadra = (a, b) => Math.abs(a - b) > TOLERANCIA;

/**
 * Revisa formatos y cuentas del comprobante (tolerancia ±1).
 * Solo compara cuando los valores necesarios están presentes: un campo
 * ausente no es una inconsistencia (va en campos_ilegibles).
 * @returns {{ valida: boolean, advertencias: string[] }}
 */
function validarFactura(entrada) {
  // Primero las correcciones deterministas (p. ej. fecha con día/mes invertidos):
  // lo que se corrige va en "notas", no en "advertencias".
  const { factura: f, notas } = aplicarCorrecciones(entrada);
  if (!f) return { valida: false, advertencias: ['No hay datos de factura para validar.'] };
  const adv = [];

  // --- Formatos ---
  if (f.clave != null && !/^\d{50}$/.test(f.clave)) {
    adv.push(`La clave debe tener 50 dígitos y tiene ${f.clave.length} caracteres${/\D/.test(f.clave) ? ' (con caracteres no numéricos)' : ''}.`);
  }
  if (f.numero_consecutivo != null && !/^\d{20}$/.test(f.numero_consecutivo)) {
    adv.push(`El consecutivo debe tener 20 dígitos y tiene ${f.numero_consecutivo.length} caracteres.`);
  }
  // Validación cruzada de la clave:
  // 506 (país) + DDMMAA (fecha) + identificación del emisor (12) + consecutivo (20) + situación (1) + seguridad (8)
  if (/^\d{50}$/.test(f.clave || '')) {
    if (!f.clave.startsWith('506')) {
      adv.push(`La clave debe empezar por el código de país "506" y empieza por "${f.clave.slice(0, 3)}".`);
    }

    const fechaClave = f.clave.slice(3, 9);
    const fechaEsperada = fechaDDMMAA(f.fecha_emision);
    if (fechaEsperada && fechaClave !== fechaEsperada) {
      adv.push(
        `La fecha de la clave (posiciones 4 a 9) es "${fechaClave}" pero se esperaba "${fechaEsperada}" ` +
          `según fecha_emision (${f.fecha_emision}).`
      );
    }

    const idClave = f.clave.slice(9, 21);
    const id = f.emisor?.identificacion;
    if (id && /^\d{1,12}$/.test(id)) {
      const idEsperado = id.padStart(12, '0');
      if (idClave !== idEsperado) {
        adv.push(
          `La identificación de la clave (posiciones 10 a 21) es "${idClave}" pero se esperaba "${idEsperado}" ` +
            `(identificación del emisor ${id} rellena con ceros a 12 dígitos).`
        );
      }
    }

    if (/^\d{20}$/.test(f.numero_consecutivo || '')) {
      const consecutivoClave = f.clave.slice(21, 41);
      if (consecutivoClave !== f.numero_consecutivo) {
        adv.push(
          `El consecutivo de la clave (posiciones 22 a 41) es "${consecutivoClave}" pero se esperaba ` +
            `"${f.numero_consecutivo}" (numero_consecutivo).`
        );
      }
    }
  }
  if (/^\d{20}$/.test(f.numero_consecutivo || '') && f.tipo_documento) {
    const segunConsecutivo = CODIGOS_TIPO_DOCUMENTO[f.numero_consecutivo.slice(8, 10)];
    if (segunConsecutivo && segunConsecutivo !== f.tipo_documento) {
      adv.push(`El consecutivo indica "${segunConsecutivo}" pero tipo_documento es "${f.tipo_documento}".`);
    }
  }

  // --- Líneas ---
  for (const l of f.detalle) {
    const n = l.numero_linea;
    if (l.codigo_cabys != null && !/^\d{13}$/.test(l.codigo_cabys)) {
      adv.push(`Línea ${n}: el CABYS "${l.codigo_cabys}" debe tener 13 dígitos.`);
    }
    // "2,000" (dos unidades) leído como 2000: cantidad entera enorme con un precio con decimales
    if (
      esNumero(l.precio_unitario) && !Number.isInteger(l.precio_unitario) &&
      esNumero(l.cantidad) && Number.isInteger(l.cantidad) && l.cantidad >= 1000
    ) {
      adv.push(
        `Línea ${n}: posible confusión de separadores: cantidad ${l.cantidad} (entera ≥ 1000) con precio_unitario ` +
          `${fmt(l.precio_unitario)} con decimales. En Costa Rica la coma de la cantidad es decimal ("2,000" = 2).`
      );
    }
    if (esNumero(l.cantidad) && esNumero(l.precio_unitario) && esNumero(l.monto_total)) {
      const calculado = l.cantidad * l.precio_unitario;
      if (descuadra(calculado, l.monto_total)) {
        adv.push(`Línea ${n}: cantidad × precio_unitario = ${fmt(calculado)} y monto_total = ${fmt(l.monto_total)}.`);
      }
    }
    if (esNumero(l.subtotal) && esNumero(l.monto_total_linea)) {
      const calculado = l.subtotal + (esNumero(l.impuesto_neto) ? l.impuesto_neto : 0);
      if (descuadra(calculado, l.monto_total_linea)) {
        adv.push(`Línea ${n}: subtotal + impuesto_neto = ${fmt(calculado)} y monto_total_linea = ${fmt(l.monto_total_linea)}.`);
      }
    }
  }

  // --- Resumen ---
  const r = f.resumen || {};
  const val = (c) => (esNumero(r[c]) ? r[c] : 0);

  if (esNumero(r.total_venta) && esNumero(r.total_venta_neta)) {
    const calculado = r.total_venta - val('total_descuentos');
    if (descuadra(calculado, r.total_venta_neta)) {
      adv.push(`total_venta − total_descuentos = ${fmt(calculado)} y total_venta_neta = ${fmt(r.total_venta_neta)}.`);
    }
  }
  if (esNumero(r.total_venta_neta) && esNumero(r.total_comprobante)) {
    const calculado = r.total_venta_neta + val('total_impuesto') + val('total_otros_cargos') - val('total_iva_devuelto');
    if (descuadra(calculado, r.total_comprobante)) {
      adv.push(
        `total_venta_neta + total_impuesto + total_otros_cargos − total_iva_devuelto = ${fmt(calculado)} ` +
          `y total_comprobante = ${fmt(r.total_comprobante)}.`
      );
    }
  }
  if (f.detalle.length && f.detalle.every((l) => esNumero(l.monto_total_linea)) && esNumero(r.total_venta_neta)) {
    const sumaLineas = f.detalle.reduce((s, l) => s + l.monto_total_linea, 0);
    const esperado = r.total_venta_neta + val('total_impuesto');
    if (descuadra(sumaLineas, esperado)) {
      adv.push(`La suma de las líneas (${fmt(sumaLineas)}) no coincide con total_venta_neta + total_impuesto (${fmt(esperado)}).`);
    }
  }
  const medios = r.medios_pago || [];
  if (medios.length && medios.every((m) => esNumero(m.total)) && esNumero(r.total_comprobante)) {
    const sumaMedios = medios.reduce((s, m) => s + m.total, 0);
    if (descuadra(sumaMedios, r.total_comprobante)) {
      adv.push(`La suma de medios_pago (${fmt(sumaMedios)}) no coincide con total_comprobante (${fmt(r.total_comprobante)}).`);
    }
  }

  // "notas" solo aparece cuando hubo alguna corrección (mantiene la forma { valida, advertencias })
  return { valida: adv.length === 0, advertencias: adv, ...(notas.length ? { notas } : {}) };
}

/** Monto con formato es-CR (p. ej. "27 120,50"). */
function formatearMonto(n, moneda) {
  if (!esNumero(n)) return '—';
  const texto = new Intl.NumberFormat('es-CR', { minimumFractionDigits: 2, maximumFractionDigits: 5 }).format(n);
  return moneda ? `${texto} ${moneda}` : texto;
}

module.exports = {
  TOLERANCIA,
  TIPOS_DOCUMENTO,
  TIPOS_IDENTIFICACION,
  MEDIOS_PAGO,
  CODIGOS_TIPO_DOCUMENTO,
  CAMPOS_TOTALES,
  ESTRUCTURA_TEXTO,
  FACTURA_JSON_SCHEMA,
  parsearImporte,
  parsearCantidad,
  parsearTarifa,
  normalizarFechaTexto,
  fechaDDMMAA,
  limpiarCodigo,
  normalizarFactura,
  aplicarCorrecciones,
  claveEstructuralmenteValida,
  reconciliarConClaveOcr,
  reconciliarZonasOcr,
  validarFactura,
  formatearMonto,
};
