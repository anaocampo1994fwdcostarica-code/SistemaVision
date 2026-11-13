/**
 * migracionLegado.js
 * ------------------------------------------------------------------
 * Prepara las tablas creadas por la versión anterior (nif_rfc, numero_factura,
 * total...) ANTES de sequelize.sync({ alter: true }).
 *
 * ¿Por qué? sync({ alter }) no sabe renombrar: borraría la columna antigua
 * (perdiendo datos) y crearía la nueva vacía. Además, al borrar numero_factura,
 * MySQL dejaría el índice único (proveedor_id, numero_factura) reducido a
 * UNIQUE(proveedor_id): ¡una sola factura por proveedor!
 *
 * Solo se ejecuta con DB_SYNC_ALTER=true y es idempotente: si las columnas
 * ya tienen el nombre nuevo, no hace nada.
 * ------------------------------------------------------------------
 */

// [tabla, columna antigua, columna nueva]
const RENOMBRES = [
  ['proveedores', 'nif_rfc', 'identificacion'],
  ['facturas', 'numero_factura', 'numero_consecutivo'],
  ['facturas', 'receptor_nif_rfc', 'receptor_identificacion'],
  ['facturas', 'subtotal', 'total_venta_neta'],
  ['facturas', 'impuestos', 'total_impuesto'],
  ['facturas', 'total', 'total_comprobante'],
  ['factura_items', 'descripcion', 'detalle'],
  ['factura_items', 'importe', 'monto_total_linea'],
];

// Índices de la versión anterior que ya no corresponden
const INDICES_ANTIGUOS = [
  ['facturas', 'facturas_proveedor_numero_unico'],
  ['proveedores', 'nif_rfc'],
];

async function describirTabla(qi, tabla) {
  try {
    return await qi.describeTable(tabla);
  } catch {
    return null; // la tabla no existe todavía: sync la creará
  }
}

/**
 * @param {import('sequelize').Sequelize} sequelize
 * @returns {Promise<string[]>} cambios aplicados (para el log)
 */
async function migrarEsquemaLegado(sequelize) {
  const qi = sequelize.getQueryInterface();
  const cambios = [];

  // 1) Quitar índices antiguos antes de tocar sus columnas
  for (const [tabla, indice] of INDICES_ANTIGUOS) {
    if (!(await describirTabla(qi, tabla))) continue;
    const indices = await qi.showIndex(tabla);
    if (indices.some((i) => i.name === indice)) {
      await qi.removeIndex(tabla, indice);
      cambios.push(`índice ${tabla}.${indice} eliminado`);
    }
  }

  // 2) Renombrar columnas conservando los datos
  for (const [tabla, antigua, nueva] of RENOMBRES) {
    const columnas = await describirTabla(qi, tabla);
    if (columnas && columnas[antigua] && !columnas[nueva]) {
      await qi.renameColumn(tabla, antigua, nueva);
      cambios.push(`${tabla}.${antigua} → ${nueva}`);
    }
  }

  return cambios;
}

module.exports = { migrarEsquemaLegado };
