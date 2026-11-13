const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { construirPromptFactura } = require('./promptFacturaImagen');
const { leerDigitos } = require('./ocrService');

const ROOT = path.join(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'generadas');
const LOGO = path.join(ROOT, '..', 'FE', 'sistemaVision', 'public', 'fwd-logo.png');

async function generarImagenFactura(factura, { intento = 1 } = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('Falta configurar OPENAI_API_KEY para generar la imagen de la factura.');
  const logo = await fs.readFile(LOGO);
  const form = new FormData();
  form.append('model', process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2');
  form.append('image[]', new Blob([logo], { type: 'image/png' }), 'fwd-logo.png');
  form.append('prompt', construirPromptFactura(factura) + (intento > 1 ? '\nCorrige exactamente cualquier diferencia detectada en el intento anterior.' : ''));
  form.append('size', '1024x1536');
  form.append('quality', 'high');
  form.append('output_format', 'png');
  const response = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`Error de OpenAI Images (${response.status}): ${(await response.text()).slice(0, 500)}`);
  const data = await response.json();
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new Error('La respuesta de gpt-image-2 no contiene b64_json.');
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  await fs.writeFile(path.join(OUTPUT_DIR, `${id}.png`), Buffer.from(b64, 'base64'));
  return { id, url: `/api/facturas/generadas/${id}.png`, path: path.join(OUTPUT_DIR, `${id}.png`), uso: data.usage || null };
}

async function verificarImagenFactura(factura, imagen) {
  const diferencias = [];
  const clave = await leerDigitos(await fs.readFile(imagen.path), 'clave');
  const consecutivo = await leerDigitos(await fs.readFile(imagen.path), 'consecutivo');
  if (clave.ok && clave.candidato?.valor && clave.candidato.valor !== factura.clave) diferencias.push({ campo: 'clave', esperado: factura.clave, leido: clave.candidato.valor });
  if (consecutivo.ok && consecutivo.candidato?.valor && consecutivo.candidato.valor !== factura.numero_consecutivo) diferencias.push({ campo: 'consecutivo', esperado: factura.numero_consecutivo, leido: consecutivo.candidato.valor });
  return { estado: diferencias.length ? 'con_diferencias' : 'verificada', diferencias, ocr: { clave, consecutivo } };
}

module.exports = { generarImagenFactura, verificarImagenFactura, OUTPUT_DIR };
