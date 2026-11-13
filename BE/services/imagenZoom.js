/**
 * imagenZoom.js
 * ------------------------------------------------------------------
 * Recorta y amplía una región de la imagen ORIGINAL para la tool ampliar_zona.
 *
 * ¿Por qué? Con detail "high", gpt-4o reduce la imagen a ~768 px en su lado
 * corto: una factura de 1800×1892 se ve a menos de la mitad y los dígitos
 * pequeños (clave, consecutivo, cédulas, CABYS, correos) se confunden.
 * Recortando solo la zona y ampliándola (ancho mínimo 1500 px), esa zona
 * recibe todo el presupuesto de resolución del modelo.
 *
 * Usa la librería sharp. Si no está instalada, ampliarZona() devuelve
 * { ok: false, error } en lugar de lanzar, y el agente sigue funcionando.
 * ------------------------------------------------------------------
 */
const fs = require('fs');
const path = require('path');

// Atajos con porcentajes (0-100) de un comprobante típico de Hacienda.
// Ajustados con márgenes amplios para que cada zona no corte su contenido
// (medidos sobre factura_prueba_v44.png: clave en 25-31 % de alto,
// receptor en 32-46 %, detalle en 47-64 %, resumen en 64-91 %).
// El modelo debe preferir "personalizada" cuando sepa dónde está el dato.
const ZONAS = {
  encabezado: { x: 0, y: 0, ancho: 100, alto: 34 },
  clave: { x: 0, y: 20, ancho: 100, alto: 16 },
  emisor: { x: 0, y: 0, ancho: 65, alto: 26 },
  receptor: { x: 0, y: 29, ancho: 100, alto: 21 },
  detalle: { x: 0, y: 44, ancho: 100, alto: 24 },
  resumen: { x: 0, y: 62, ancho: 100, alto: 38 },
};
const NOMBRES_ZONAS = [...Object.keys(ZONAS), 'personalizada'];

const LADO_MAXIMO = 2048; // OpenAI no usa más resolución que esto
const FACTOR_MAXIMO = 4; // no ampliar más de 4× (solo se inventarían píxeles)

// --- Carga diferida de sharp (inyectable en pruebas) ---
let sharpCargado; // undefined = no intentado; null = no disponible
function obtenerSharp() {
  if (sharpCargado === undefined) {
    try {
      sharpCargado = require('sharp');
    } catch {
      sharpCargado = null;
    }
  }
  return sharpCargado;
}

/**
 * Solo para pruebas: sustituye sharp por un doble (objeto/función),
 * null para simular que no está instalada, o undefined para volver a la real.
 */
function _establecerSharp(modulo) {
  sharpCargado = modulo;
}

const sharpDisponible = () => !!obtenerSharp();

/** Convierte la imagen de entrada (Buffer, data URI, ruta o URL http) en Buffer. */
async function obtenerBuffer(imagen) {
  if (Buffer.isBuffer(imagen)) return imagen;
  if (typeof imagen !== 'string' || !imagen.trim()) throw new Error('No hay imagen para recortar.');
  const s = imagen.trim();
  const dataUri = s.match(/^data:[^;]+;base64,(.*)$/s);
  if (dataUri) return Buffer.from(dataUri[1], 'base64');
  if (/^https?:/.test(s)) {
    const resp = await fetch(s, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error(`No se pudo descargar la imagen (${resp.status}).`);
    return Buffer.from(await resp.arrayBuffer());
  }
  return fs.readFileSync(path.resolve(s));
}

const acotar = (v, min, max) => Math.min(Math.max(v, min), max);

/** Recuadro en porcentajes (0-100) a partir de la zona o del recuadro personalizado. */
function resolverRecuadro({ zona, recuadro } = {}) {
  if (zona && zona !== 'personalizada') {
    if (!ZONAS[zona]) return { error: `Zona desconocida "${zona}". Usa: ${NOMBRES_ZONAS.join(', ')}.` };
    return { recuadro: { ...ZONAS[zona] } };
  }
  const r = recuadro || {};
  const nums = ['x', 'y', 'ancho', 'alto'].map((k) => Number(r[k]));
  if (nums.some((n) => !Number.isFinite(n))) {
    return { error: 'Para la zona "personalizada" indica recuadro { x, y, ancho, alto } en porcentajes (0-100).' };
  }
  let [x, y, ancho, alto] = nums;
  x = acotar(x, 0, 99);
  y = acotar(y, 0, 99);
  ancho = acotar(ancho, 1, 100 - x);
  alto = acotar(alto, 1, 100 - y);
  return { recuadro: { x, y, ancho, alto } };
}

/**
 * Recorta y amplía una zona.
 * @param {Buffer|string} imagen - imagen original
 * @param {{ zona?: string, recuadro?: {x,y,ancho,alto} }} solicitud
 * @param {object} [opciones]
 * @param {number} [opciones.anchoMinimo=1500] - ancho mínimo del recorte ampliado
 * @param {number} [opciones.ladoMaximo=2048] - lado mayor máximo (OpenAI no usa más; el OCR sí)
 * @param {number} [opciones.factorMaximo=4] - ampliación máxima
 * @param {boolean} [opciones.paraOcr=false] - escala de grises + más contraste + enfoque, en PNG
 * @returns {Promise<{ ok: true, dataUrl, buffer, zona, recuadro, region, tamano } | { ok: false, error }>}
 */
async function ampliarZona(imagen, solicitud = {}, opciones = {}) {
  const sharp = obtenerSharp();
  if (!sharp) {
    return {
      ok: false,
      error: 'La librería sharp no está instalada (npm install sharp): no se puede ampliar la imagen. Continúa con la imagen completa.',
    };
  }
  const { recuadro, error } = resolverRecuadro(solicitud);
  if (error) return { ok: false, error };

  const anchoMinimo = opciones.anchoMinimo || 1500;
  const ladoMaximo = opciones.ladoMaximo || LADO_MAXIMO;
  const factorMaximo = opciones.factorMaximo || FACTOR_MAXIMO;
  try {
    const original = await obtenerBuffer(imagen);
    // rotate() sin argumentos aplica la orientación EXIF (fotos de celular)
    const { data, info } = await sharp(original).rotate().toBuffer({ resolveWithObject: true });

    const left = Math.round((recuadro.x / 100) * info.width);
    const top = Math.round((recuadro.y / 100) * info.height);
    const width = Math.max(1, Math.min(Math.round((recuadro.ancho / 100) * info.width), info.width - left));
    const height = Math.max(1, Math.min(Math.round((recuadro.alto / 100) * info.height), info.height - top));

    // Escala: al menos anchoMinimo de ancho, sin pasar de factorMaximo ni de ladoMaximo en el lado mayor
    let escala = Math.max(1, anchoMinimo / width);
    escala = Math.min(escala, factorMaximo, ladoMaximo / Math.max(width, height));
    const anchoFinal = Math.max(1, Math.round(width * escala));
    const altoFinal = Math.max(1, Math.round(height * escala));

    let canal = sharp(data)
      .extract({ left, top, width, height })
      .resize({ width: anchoFinal, height: altoFinal, kernel: 'lanczos3' });
    if (opciones.paraOcr) {
      // Preprocesado para Tesseract: grises, estirar el contraste (normalise), un poco más
      // de contraste lineal y enfoque. PNG para no meter artefactos de JPEG en los dígitos.
      canal = canal.grayscale().normalise().linear(1.3, -30).sharpen().png();
    } else {
      canal = canal.jpeg({ quality: 92 });
    }
    const recorte = await canal.toBuffer();
    const mime = opciones.paraOcr ? 'image/png' : 'image/jpeg';

    return {
      ok: true,
      dataUrl: `data:${mime};base64,${recorte.toString('base64')}`,
      buffer: recorte,
      zona: solicitud.zona || 'personalizada',
      recuadro,
      region: { left, top, width, height },
      tamano: { ancho: anchoFinal, alto: altoFinal },
    };
  } catch (e) {
    return { ok: false, error: `No se pudo ampliar la zona: ${e.message}` };
  }
}

module.exports = { ZONAS, NOMBRES_ZONAS, ampliarZona, resolverRecuadro, sharpDisponible, _establecerSharp };
