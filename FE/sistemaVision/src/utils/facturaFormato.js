/**
 * Utilidades de formato para la factura imprimible (convenciones de Costa Rica)
 * y comparación entre la factura generada y la leída por el agente de visión.
 */

const esNumero = (v) => typeof v === 'number' && Number.isFinite(v);

/** Monto con punto de miles y coma decimal: 370560 → "370.560,00". */
export function montoCR(n) {
  if (!esNumero(n)) return '—';
  const [entero, decimales] = Math.abs(n).toFixed(2).split('.');
  return `${n < 0 ? '-' : ''}${entero.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${decimales}`;
}

const SIMBOLOS = { CRC: '₡', USD: '$', EUR: '€' };

/** Monto con símbolo de la moneda: "₡370.560,00". */
export function dineroCR(n, moneda = 'CRC') {
  const simbolo = SIMBOLOS[moneda];
  return simbolo ? `${simbolo}${montoCR(n)}` : `${montoCR(n)} ${moneda}`;
}

/** Cantidad con coma decimal y 3 decimales, como en los comprobantes: 1 → "1,000". */
export function cantidadCR(n) {
  if (!esNumero(n)) return '—';
  return n.toFixed(3).replace('.', ',');
}

/**
 * "AAAA-MM-DDTHH:mm:ss" → "DD/MM/AAAA HH:mm:ss", leyendo el texto
 * (sin new Date: no hay conversión de zona horaria).
 */
export function fechaCR(v) {
  const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return v || '—';
  const [, a, mes, d, hh = '00', mi = '00', ss = '00'] = m;
  return `${d}/${mes}/${a} ${hh}:${mi}:${ss}`;
}

/** Cédula con guiones según su tipo: 3101555555 → "3-101-555555"; 123456789 → "1-2345-6789". */
export function cedulaCR(id, tipo) {
  const s = String(id || '');
  if (/^\d{10}$/.test(s) && (tipo === 'Jurídica' || s.startsWith('3'))) return `${s[0]}-${s.slice(1, 4)}-${s.slice(4)}`;
  if (/^\d{9}$/.test(s)) return `${s[0]}-${s.slice(1, 5)}-${s.slice(5)}`;
  return s || '—';
}

/** Ubicación en una línea: "San José, Montes de Oca, San Pedro". */
export function ubicacionCR(u) {
  if (!u || typeof u !== 'object') return '';
  return [u.provincia, u.canton, u.distrito, u.barrio, u.otras_senas].filter(Boolean).join(', ');
}

// ------------------------------------------------------------------
// Comparación generada vs. leída por el agente de visión
// ------------------------------------------------------------------
const soloDigitos = (v) => String(v ?? '').replace(/\D/g, '');
const textoPlano = (v) =>
  String(v ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
const mismoNumero = (a, b) => esNumero(a) && esNumero(b) && Math.abs(a - b) <= 0.01;

/**
 * Lista de campos en los que difieren la factura generada y la leída.
 * @returns {{ campo: string, generado: string, leido: string }[]}
 */
export function compararFacturas(generada, leida) {
  const diferencias = [];
  if (!leida) return [{ campo: 'factura', generado: 'datos generados', leido: 'el agente no devolvió datos' }];

  const comparar = (campo, a, b, tipo = 'texto') => {
    const iguales =
      tipo === 'numero' ? mismoNumero(a, b) : tipo === 'digitos' ? soloDigitos(a) === soloDigitos(b) : textoPlano(a) === textoPlano(b);
    if (!iguales) diferencias.push({ campo, generado: String(a ?? '—'), leido: String(b ?? '—') });
  };

  comparar('Clave', generada.clave, leida.clave, 'digitos');
  comparar('Consecutivo', generada.numero_consecutivo, leida.numero_consecutivo, 'digitos');
  comparar('Fecha de emisión', String(generada.fecha_emision).slice(0, 16), String(leida.fecha_emision ?? '').slice(0, 16));
  comparar('Condición de venta', generada.condicion_venta, leida.condicion_venta);
  comparar('Cédula del emisor', generada.emisor?.identificacion, leida.emisor?.identificacion, 'digitos');
  comparar('Actividad del emisor', generada.emisor?.codigo_actividad, leida.emisor?.codigo_actividad, 'digitos');
  comparar('Receptor', generada.receptor?.nombre, leida.receptor?.nombre);
  comparar('Cédula del receptor', generada.receptor?.identificacion, leida.receptor?.identificacion, 'digitos');
  if (generada.receptor?.correo) comparar('Correo del receptor', generada.receptor.correo, leida.receptor?.correo);

  const gl = generada.detalle || [];
  const ll = leida.detalle || [];
  comparar('Número de líneas', gl.length, ll.length, 'numero');
  gl.forEach((l, i) => {
    const otra = ll[i] || {};
    comparar(`Línea ${i + 1}: cantidad`, l.cantidad, otra.cantidad, 'numero');
    comparar(`Línea ${i + 1}: precio unitario`, l.precio_unitario, otra.precio_unitario, 'numero');
    comparar(`Línea ${i + 1}: total línea`, l.monto_total_linea, otra.monto_total_linea, 'numero');
    if (l.codigo_cabys) comparar(`Línea ${i + 1}: CABYS`, l.codigo_cabys, otra.codigo_cabys, 'digitos');
  });

  const gr = generada.resumen || {};
  const lr = leida.resumen || {};
  comparar('Total venta neta', gr.total_venta_neta, lr.total_venta_neta, 'numero');
  comparar('Total impuesto', gr.total_impuesto, lr.total_impuesto, 'numero');
  comparar('Total comprobante', gr.total_comprobante, lr.total_comprobante, 'numero');
  comparar('Medio de pago', gr.medios_pago?.[0]?.tipo, lr.medios_pago?.[0]?.tipo);
  return diferencias;
}
