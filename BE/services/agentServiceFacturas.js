const fs = require('fs');
const path = require('path');
require('dotenv').config();

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_VISION_MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4o';

/**
 * Convierte una entrada de imagen (URL, data URI, ruta local o Buffer)
 * al formato esperado por la API de visión de OpenAI.
 *
 * @param {string|Buffer} imagenInput - URL, data URI, ruta de archivo o Buffer.
 * @param {string} [mimeType='image/jpeg'] - MIME type si se pasa un Buffer.
 * @returns {string} URL o data URI lista para `image_url.url`.
 */
function resolverUrlImagen(imagenInput, mimeType = 'image/jpeg') {
  if (Buffer.isBuffer(imagenInput)) {
    return `data:${mimeType};base64,${imagenInput.toString('base64')}`;
  }

  if (typeof imagenInput !== 'string' || !imagenInput.trim()) {
    throw new Error('Se requiere una imagen válida (URL, ruta local, data URI o Buffer).');
  }

  const input = imagenInput.trim();
  if (input.startsWith('http://') || input.startsWith('https://') || input.startsWith('data:')) {
    return input;
  }

  const absPath = path.resolve(input);
  const ext = path.extname(absPath).toLowerCase();
  const mimeMap = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  };
  const detectedMime = mimeMap[ext] || mimeType;
  const base64 = fs.readFileSync(absPath).toString('base64');

  return `data:${detectedMime};base64,${base64}`;
}

/**
 * Analiza la imagen de una factura utilizando un modelo de visión de OpenAI
 * y devuelve los datos estructurados en JSON.
 *
 * @param {string|Buffer} imagenInput - URL, data URI, ruta local o Buffer de la factura.
 * @param {Object} [opciones]
 * @param {string} [opciones.model] - Modelo de OpenAI a utilizar.
 * @param {string} [opciones.prompt] - Instrucciones personalizadas de extracción.
 * @param {string} [opciones.mimeType] - MIME type si imagenInput es un Buffer.
 * @param {'low'|'high'|'auto'} [opciones.detail='high'] - Nivel de detalle visual.
 * @returns {Promise<Object>} Datos extraídos de la factura.
 */
async function analizarFactura(imagenInput, opciones = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('Falta configurar OPENAI_API_KEY en el archivo .env');
  }

  const model = opciones.model || DEFAULT_VISION_MODEL;
  const detail = opciones.detail || 'high';
  const imageUrl = resolverUrlImagen(imagenInput, opciones.mimeType);

  const promptSistema =
    'Eres un agente especialista en lectura y extracción de datos de facturas y comprobantes. ' +
    'Responde únicamente con un objeto JSON válido.';

  const promptUsuario =
    opciones.prompt ||
    'Extrae la información de esta factura en formato JSON con los siguientes campos cuando estén presentes: ' +
      'emisor (nombre, nif_rfc, direccion), receptor (nombre, nif_rfc), numero_factura, fecha_emision, ' +
      'moneda, subtotal, impuestos, total, y items (array con descripcion, cantidad, precio_unitario, importe). ' +
      'Si algún campo no es visible, usa null.';

  const response = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: promptSistema },
        {
          role: 'user',
          content: [
            { type: 'text', text: promptUsuario },
            {
              type: 'image_url',
              image_url: {
                url: imageUrl,
                detail,
              },
            },
          ],
        },
      ],
      temperature: 0,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Error de OpenAI (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error('La respuesta de OpenAI no contiene contenido.');
  }

  return JSON.parse(content);
}

module.exports = {
  analizarFactura,
};

