/**
 * Configuración de Sequelize leída desde el .env (sustituye a config.json).
 * Variables: DB_USER, DB_PASSWORD, DB_NAME, DB_HOST, DB_PORT y DB_LOGGING.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const base = {
  username: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || null,
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number.parseInt(process.env.DB_PORT, 10) || 3306,
  dialect: 'mysql',
  logging: process.env.DB_LOGGING === 'true' ? console.log : false,
};

module.exports = {
  development: { ...base, database: process.env.DB_NAME || 'database_development' },
  test: { ...base, database: process.env.DB_NAME_TEST || 'database_test' },
  production: { ...base, database: process.env.DB_NAME || 'database_production' },
};
