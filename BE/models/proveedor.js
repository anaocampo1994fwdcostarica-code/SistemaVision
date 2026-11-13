'use strict';

/**
 * Proveedor (emisor de comprobantes).
 * - identificacion es única (cédula física/jurídica, DIMEX, NITE...). El índice
 *   tiene nombre explícito para que sync({ alter: true }) no lo duplique.
 * - datos_externos guarda la respuesta del servicio externo (p. ej. Hacienda /fe/ae).
 */
module.exports = (sequelize, DataTypes) => {
  const Proveedor = sequelize.define(
    'Proveedor',
    {
      nombre: { type: DataTypes.STRING(255), allowNull: false },
      nombre_comercial: { type: DataTypes.STRING(255), allowNull: true },
      tipo_identificacion: { type: DataTypes.STRING(40), allowNull: true },
      identificacion: { type: DataTypes.STRING(20), allowNull: true },
      codigo_actividad: { type: DataTypes.STRING(10), allowNull: true },
      ubicacion: { type: DataTypes.JSON, allowNull: true },
      direccion: { type: DataTypes.STRING(500), allowNull: true },
      telefono: { type: DataTypes.STRING(30), allowNull: true },
      correo: { type: DataTypes.STRING(160), allowNull: true },
      verificado: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      datos_externos: { type: DataTypes.JSON, allowNull: true },
    },
    {
      tableName: 'proveedores',
      underscored: true,
      indexes: [{ unique: true, fields: ['identificacion'], name: 'proveedores_identificacion_unica' }],
    }
  );

  Proveedor.associate = (models) => {
    // Un proveedor emite muchas facturas
    Proveedor.hasMany(models.Factura, { as: 'facturas', foreignKey: 'proveedor_id' });
  };

  return Proveedor;
};
