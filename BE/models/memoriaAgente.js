'use strict';

/**
 * Memoria conversacional del agente.
 * Solo se guarda TEXTO (instrucciones, resúmenes y respuestas); nunca la imagen.
 * - rol 'user'      : lo que pidió el usuario.
 * - rol 'assistant' : lo que respondió el agente.
 * - rol 'resumen'   : resumen compacto de una factura analizada.
 */
module.exports = (sequelize, DataTypes) => {
  const MemoriaAgente = sequelize.define(
    'MemoriaAgente',
    {
      session_id: { type: DataTypes.STRING(64), allowNull: false },
      rol: { type: DataTypes.ENUM('user', 'assistant', 'resumen'), allowNull: false },
      contenido: { type: DataTypes.TEXT, allowNull: false },
      metadata: { type: DataTypes.JSON, allowNull: true },
    },
    {
      tableName: 'memoria_agente',
      underscored: true,
      indexes: [{ fields: ['session_id'] }],
    }
  );

  return MemoriaAgente;
};
