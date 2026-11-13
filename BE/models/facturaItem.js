'use strict';

/**
 * Línea de detalle de un comprobante v4.4.
 * - impuestos (JSON) conserva cada impuesto con su exoneración.
 * - tarifa_iva se guarda aparte (porcentaje del IVA, código 01) para filtrar/agrupar.
 */
module.exports = (sequelize, DataTypes) => {
  const decimal = () => ({ type: DataTypes.DECIMAL(18, 5), allowNull: true });

  const FacturaItem = sequelize.define(
    'FacturaItem',
    {
      numero_linea: { type: DataTypes.INTEGER, allowNull: true },
      codigo_cabys: { type: DataTypes.STRING(13), allowNull: true },
      codigo_comercial: { type: DataTypes.STRING(100), allowNull: true },
      cantidad: decimal(),
      unidad_medida: { type: DataTypes.STRING(20), allowNull: true },
      detalle: { type: DataTypes.STRING(1000), allowNull: true },
      precio_unitario: decimal(),
      monto_total: decimal(),
      descuentos: { type: DataTypes.JSON, allowNull: true },
      monto_descuento: decimal(),
      subtotal: decimal(),
      base_imponible: decimal(),
      impuestos: { type: DataTypes.JSON, allowNull: true },
      tarifa_iva: { type: DataTypes.DECIMAL(6, 2), allowNull: true },
      impuesto_neto: decimal(),
      monto_total_linea: decimal(),
    },
    {
      tableName: 'factura_items',
      underscored: true,
    }
  );

  FacturaItem.associate = (models) => {
    FacturaItem.belongsTo(models.Factura, { as: 'factura', foreignKey: 'factura_id', onDelete: 'CASCADE' });
  };

  return FacturaItem;
};
