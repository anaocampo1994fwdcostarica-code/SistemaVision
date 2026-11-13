'use strict';

const { CAMPOS_TOTALES } = require('../services/esquemaFactura');

/**
 * Comprobante electrónico v4.4 (Hacienda, Costa Rica).
 * - clave única (50 dígitos). Además, (proveedor_id, numero_consecutivo) es único.
 * - Los totales del resumen son DECIMAL(18,5), como en el XML de Hacienda.
 * - Las estructuras repetibles (medios de pago, desglose, referencias...) van en JSON.
 * - session_id enlaza la factura con la sesión del agente que la guardó.
 * - datos_crudos conserva el JSON tal como lo entregó el modelo (sin imagen).
 */
module.exports = (sequelize, DataTypes) => {
  const decimal = () => ({ type: DataTypes.DECIMAL(18, 5), allowNull: true });
  const totales = Object.fromEntries(CAMPOS_TOTALES.map((c) => [c, decimal()]));

  const Factura = sequelize.define(
    'Factura',
    {
      // --- Encabezado ---
      tipo_documento: { type: DataTypes.STRING(60), allowNull: true },
      version: { type: DataTypes.STRING(10), allowNull: true },
      clave: { type: DataTypes.STRING(50), allowNull: true },
      numero_consecutivo: { type: DataTypes.STRING(20), allowNull: true },
      fecha_emision: { type: DataTypes.DATE, allowNull: true },
      codigo_actividad_emisor: { type: DataTypes.STRING(10), allowNull: true },
      proveedor_sistemas: { type: DataTypes.STRING(40), allowNull: true },
      condicion_venta: { type: DataTypes.STRING(60), allowNull: true },
      plazo_credito_dias: { type: DataTypes.INTEGER, allowNull: true },

      // --- Receptor ---
      receptor_nombre: { type: DataTypes.STRING(255), allowNull: true },
      receptor_nombre_comercial: { type: DataTypes.STRING(255), allowNull: true },
      receptor_tipo_identificacion: { type: DataTypes.STRING(40), allowNull: true },
      receptor_identificacion: { type: DataTypes.STRING(20), allowNull: true },
      receptor_codigo_actividad: { type: DataTypes.STRING(10), allowNull: true },
      receptor_ubicacion: { type: DataTypes.JSON, allowNull: true },
      receptor_telefono: { type: DataTypes.STRING(30), allowNull: true },
      receptor_correo: { type: DataTypes.STRING(160), allowNull: true },

      // --- Resumen ---
      moneda: { type: DataTypes.STRING(10), allowNull: true },
      tipo_cambio: decimal(),
      ...totales,
      medios_pago: { type: DataTypes.JSON, allowNull: true },
      desglose_impuesto: { type: DataTypes.JSON, allowNull: true },
      resumen: { type: DataTypes.JSON, allowNull: true },

      // --- Otros bloques ---
      otros_cargos: { type: DataTypes.JSON, allowNull: true },
      informacion_referencia: { type: DataTypes.JSON, allowNull: true },
      leyendas: { type: DataTypes.JSON, allowNull: true },
      estado_hacienda: { type: DataTypes.STRING(40), allowNull: true },
      advertencias: { type: DataTypes.JSON, allowNull: true },

      // --- Agente ---
      // "analizada" (leída de una imagen) o "generada" (creada desde texto por generadorFactura)
      origen: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'analizada' },
      confianza: { type: DataTypes.FLOAT, allowNull: true },
      session_id: { type: DataTypes.STRING(64), allowNull: true },
      datos_crudos: { type: DataTypes.JSON, allowNull: true },
    },
    {
      tableName: 'facturas',
      underscored: true,
      indexes: [
        { unique: true, fields: ['clave'], name: 'facturas_clave_unica' },
        { unique: true, fields: ['proveedor_id', 'numero_consecutivo'], name: 'facturas_proveedor_consecutivo_unico' },
        { fields: ['session_id'], name: 'facturas_session_id' },
      ],
    }
  );

  Factura.associate = (models) => {
    Factura.belongsTo(models.Proveedor, { as: 'proveedor', foreignKey: 'proveedor_id' });
    Factura.hasMany(models.FacturaItem, { as: 'items', foreignKey: 'factura_id', onDelete: 'CASCADE' });
  };

  return Factura;
};
