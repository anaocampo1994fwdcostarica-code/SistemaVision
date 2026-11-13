/**
 * ocrService.js
 * ------------------------------------------------------------------
 * Lectura de dígitos con Tesseract (tesseract.js) para la tool leer_digitos_ocr.
 *
 * ¿Por qué? gpt-4o cuenta mal las secuencias largas de dígitos repetidos
 * ("999999", "0000000457") aunque la zona esté ampliada: es una limitación
 * del modelo, no de resolución. Un OCR clásico no "resume" los dígitos.
 *
 * - Un ÚNICO worker de Tesseract para todo el proceso: se crea la primera vez
 *   y se cierra con terminarOcr() al apagar el servidor.
 * - Timeout de 20 s por lectura (OCR_TIMEOUT_MS). Si se agota, el worker se
 *   descarta y se crea otro en la siguiente lectura.
 * - Si tesseract.js no está instalado o falla, devuelve { ok: false, error }:
 *   el agente sigue funcionando sin OCR.
 * ------------------------------------------------------------------
 */
const fs = require('fs');
const path = require('path');

// --- Carga diferida de tesseract.js (inyectable en pruebas) ---
let tesseractCargado; // undefined = no intentado; null = no disponible
function obtenerTesseract() {
  if (tesseractCargado === undefined) {
    try {
      tesseractCargado = require('tesseract.js');
    } catch {
      tesseractCargado = null;
    }
  }
  return tesseractCargado;
}

let workerPromesa = null; // Promise<Worker> compartida

/**
 * Solo para pruebas: sustituye tesseract.js por un doble, null para simular que
 * no está instalado, o undefined para volver al real. Descarta el worker actual.
 */
function _establecerTesseract(modulo) {
  tesseractCargado = modulo;
  workerPromesa = null;
}

const idioma = () => (['spa', 'eng'].includes(process.env.OCR_IDIOMA) ? process.env.OCR_IDIOMA : 'eng');
const timeoutMs = () => Number.parseInt(process.env.OCR_TIMEOUT_MS, 10) || 20000;

/** Devuelve el worker compartido, creándolo la primera vez. */
function obtenerWorker() {
  if (!workerPromesa) {
    const Tesseract = obtenerTesseract();
    if (!Tesseract) throw new Error('tesseract.js no está instalado (npm install tesseract.js).');
    workerPromesa = (async () => {
      // Los datos del idioma (~4 MB para "eng") se descargan una vez y se guardan aquí.
      // tesseract.js no crea el directorio: si no existe, la escritura falla en silencio
      // y volvería a descargarlos en cada arranque.
      const cachePath = process.env.OCR_CACHE_PATH || path.join(__dirname, '..', '.cache', 'tesseract');
      try {
        fs.mkdirSync(cachePath, { recursive: true });
      } catch {
        /* sin caché: se descargará en cada arranque */
      }
      const worker = await Tesseract.createWorker(idioma(), 1, { cachePath });
      if (typeof worker.setParameters === 'function') {
        await worker.setParameters({
          tessedit_pageseg_mode: '6', // un bloque de texto uniforme
          preserve_interword_spaces: '1',
        });
      }
      return worker;
    })();
    // Si la creación falla, la próxima llamada lo vuelve a intentar
    workerPromesa.catch(() => {
      workerPromesa = null;
    });
  }
  return workerPromesa;
}

/** Cierra el worker (al apagar el servidor o al terminar las pruebas). */
async function terminarOcr() {
  const promesa = workerPromesa;
  workerPromesa = null;
  if (!promesa) return;
  try {
    const worker = await promesa;
    await worker.terminate();
  } catch {
    /* ya estaba caído */
  }
}

function conTimeout(promesa, ms) {
  let temporizador;
  const limite = new Promise((_, rechazar) => {
    temporizador = setTimeout(() => rechazar(new Error(`El OCR superó el tiempo máximo de ${ms / 1000} s.`)), ms);
  });
  return Promise.race([promesa, limite]).finally(() => clearTimeout(temporizador));
}

// ------------------------------------------------------------------
// Análisis del texto
// ------------------------------------------------------------------

/**
 * Por cada línea, los grupos de dígitos (solo dígitos: se quitan espacios y guiones
 * DENTRO de un número, p. ej. "506 1211 26" → "506121126"). Un grupo se corta
 * con letras, ":" o "/" (así "12/11/2026" no se pega al consecutivo).
 */
function analizarLineas(texto) {
  return String(texto || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((linea) => {
      const grupos = (linea.match(/\d(?:[\d\s\-–.]*\d)?/g) || [])
        .map((g) => g.replace(/\D/g, ''))
        .filter(Boolean)
        .map((digitos) => ({ digitos, longitud: digitos.length }));
      return { texto: linea, grupos };
    });
}

const CRITERIOS = {
  clave: (d) => d.length === 50 && d.startsWith('506'),
  consecutivo: (d) => d.length === 20,
};

/**
 * Candidatos para "clave" (50 dígitos que empiezan por 506) o "consecutivo" (20 dígitos).
 * Primero se buscan grupos exactos; si no hay, se prueba con todos los dígitos de la
 * línea juntos (por si el OCR separó el número con otro carácter).
 */
function buscarCandidatos(lineas, campo) {
  const cumple = CRITERIOS[campo];
  if (!cumple) return [];
  const candidatos = new Set();
  for (const l of lineas) for (const g of l.grupos) if (cumple(g.digitos)) candidatos.add(g.digitos);
  if (!candidatos.size) {
    for (const l of lineas) {
      const todos = l.grupos.map((g) => g.digitos).join('');
      if (cumple(todos)) candidatos.add(todos);
    }
  }
  return [...candidatos];
}

/**
 * Lee el texto de una imagen (ya recortada y preprocesada) y busca los dígitos.
 * @param {Buffer} imagen
 * @param {string} campo - clave | consecutivo | identificacion | actividad | cabys | otro
 * @returns {Promise<{ ok: true, texto, lineas, candidato, candidatos, candidatosClave } | { ok: false, error }>}
 */
async function leerDigitos(imagen, campo = 'otro') {
  if (!obtenerTesseract()) {
    return {
      ok: false,
      error: 'tesseract.js no está instalado (npm install tesseract.js): no se puede leer con OCR. Continúa con tu propia lectura.',
    };
  }
  try {
    const worker = await obtenerWorker();
    const { data } = await conTimeout(worker.recognize(imagen), timeoutMs());
    const texto = String(data?.text || '');
    const lineas = analizarLineas(texto);
    const candidatos = buscarCandidatos(lineas, campo);
    return {
      ok: true,
      campo,
      texto: texto.slice(0, 2000),
      lineas,
      candidato: candidatos[0] ? { valor: candidatos[0], longitud: candidatos[0].length } : null,
      candidatos,
      // Cualquier lectura puede traer la clave completa (p. ej. al leer el encabezado)
      candidatosClave: buscarCandidatos(lineas, 'clave'),
    };
  } catch (e) {
    // Un worker colgado o roto se descarta para que la próxima lectura cree otro
    await terminarOcr();
    return { ok: false, error: `El OCR falló: ${e.message}` };
  }
}

/**
 * Código de actividad: el número de EXACTAMENTE 6 dígitos que sigue a "Actividad"
 * en la misma línea ("Actividad económica: 410001"). Si el número está incompleto
 * (5 dígitos) o tiene más de 6, devuelve null: no se adivina.
 */
function extraerActividad(texto) {
  const m = String(texto || '').match(/Actividad[^\d\n]{0,60}?(\d{6})(?!\d)/i);
  return m ? m[1] : null;
}

/**
 * Identificación: la que sigue a "Cédula" en la misma línea ("Cédula Jurídica: 3-101-999999").
 * Tolera que el OCR pierda la tilde ("Cedula", "Cédula"). Se quitan los guiones y se
 * acepta solo si tiene 9-12 dígitos (física, jurídica, DIMEX, NITE).
 */
function extraerCedula(texto) {
  const m = String(texto || '').match(/C\S?dula[^\d\n]{0,40}?(\d[\d-]{7,15}\d)(?![\d-])/i);
  if (!m) return null;
  const digitos = m[1].replace(/\D/g, '');
  return /^\d{9,12}$/.test(digitos) ? digitos : null;
}

/** ¿Está tesseract.js disponible? (para no recortar la imagen si no se va a poder leer) */
const ocrDisponible = () => !!obtenerTesseract();

module.exports = {
  leerDigitos,
  analizarLineas,
  buscarCandidatos,
  extraerActividad,
  extraerCedula,
  ocrDisponible,
  terminarOcr,
  _establecerTesseract,
};
