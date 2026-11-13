const { formatearMonto } = require('./facturaFormatoLocal');

function valor(v) { return v === null || v === undefined ? '—' : String(v); }

/** Prompt visual estricto: la imagen es presentación; los valores vienen del objeto validado. */
function construirPromptFactura(factura) {
  const r = factura.resumen || {};
  const lineas = (factura.detalle || []).map((l) =>
    `${l.numero_linea} | ${valor(l.codigo_cabys)} | ${valor(l.detalle)} | ${l.cantidad} | ${valor(l.unidad_medida)} | ${formatearMonto(l.precio_unitario)} | ${formatearMonto((l.monto_total || 0) - (l.subtotal || 0))} | ${formatearMonto(l.subtotal)} | ${valor(l.impuestos?.[0]?.tarifa)}% | ${formatearMonto(l.impuesto_neto)} | ${formatearMonto(l.monto_total_linea)}`
  ).join('\n');
  return `Diseña una imagen vertical de una factura electrónica empresarial de Costa Rica, formato carta, fondo blanco, sobria, elegante, moderna y profesional. Usa EXACTAMENTE el logo de la imagen 1, sin redibujarlo, recolorearlo ni deformarlo.

Identidad FWD Costa Rica del BrandBook: paleta azul #0A6CB9, morado #662D91, turquesa #20BEC6, amarillo #FFCB05, naranja #F7901E y rojo #E20613; títulos sans serif condensada y gruesa, cuerpo sans serif limpia estilo Figtree, acentos discretos de triángulos superpuestos. Incluye el eslogan “Avancemos hacia el futuro juntos.” en itálica.

No uses una franja roja superior. Como es un documento de demostración, identifica claramente al pie, en una leyenda sobria y no decorativa: “DOCUMENTO DE DEMOSTRACIÓN · SIN VALIDEZ FISCAL · NO EMITIDO NI VALIDADO POR HACIENDA”. No agregues QR, sellos, firmas ni datos no incluidos.

Estructura: logo y emisor; banda “FACTURA ELECTRÓNICA · Versión 4.4”; consecutivo, fecha, condición y moneda; clave en tipografía monoespaciada; receptor; tabla de líneas; impuestos; resumen; total del comprobante; medio de pago; leyenda legal y aviso de demostración al pie. Usa espacios generosos, reglas finas, tablas legibles y jerarquía clara.

Copia cada carácter, número y signo exactamente. No calcules, redondees, corrijas, traduzcas ni inventes ningún dato. Todos los montos deben mostrarse en formato es-CR (punto de miles y coma decimal).
Datos validados que debes representar:
Emisor: ${valor(factura.emisor?.nombre)} · ID ${valor(factura.emisor?.identificacion)} · ${valor(factura.emisor?.correo)}
Receptor: ${valor(factura.receptor?.nombre)} · ID ${valor(factura.receptor?.identificacion)} · ${valor(factura.receptor?.correo)}
Clave: ${valor(factura.clave)}
Consecutivo: ${valor(factura.numero_consecutivo)}
Fecha: ${valor(factura.fecha_emision)}
Condición: ${valor(factura.condicion_venta)} · Moneda: ${valor(r.moneda)}
Líneas:\n${lineas}
Total venta neta: ${formatearMonto(r.total_venta_neta)} · Impuestos: ${formatearMonto(r.total_impuesto)} · Total comprobante: ${formatearMonto(r.total_comprobante)}
Medios de pago: ${(r.medios_pago || []).map((m) => `${m.tipo}: ${formatearMonto(m.total)}`).join(' · ')}`;
}

module.exports = { construirPromptFactura };
