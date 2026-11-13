/**
 * memoryService.js
 * ------------------------------------------------------------------
 * Memoria por sesión del agente.
 *
 * - Persiste en MySQL (modelo MemoriaAgente).
 * - Si MySQL no está disponible, cambia a una memoria en RAM (Map) para
 *   que el agente siga funcionando. Cada MEMORIA_REINTENTO_MS (60 s) vuelve
 *   a probar MySQL y, si responde, le pasa lo guardado en RAM.
 * - Solo guarda TEXTO: cualquier data URI / base64 se elimina antes de guardar.
 * ------------------------------------------------------------------
 */
const crypto = require('crypto');
const { normalizarFactura, formatearMonto } = require('./esquemaFactura');

const ROLES = ['user', 'assistant', 'resumen'];
const MAX_CARACTERES = 4000;

let db = null;
function modeloMemoria() {
  if (!db) db = require('../models');
  return db.MemoriaAgente;
}

// 'mysql' mientras la BD responda; 'ram' en cuanto falle (o si index.js lo indica al arrancar).
let modo = 'mysql';
let ultimoFallo = 0; // marca de tiempo del último fallo de MySQL
const memoriaRam = new Map(); // sessionId -> [{ id, rol, contenido, metadata, createdAt }]
let siguienteIdRam = 1;

// Cada cuánto se vuelve a probar MySQL estando en modo RAM (por defecto 60 s).
const intervaloReintento = () => {
  const ms = Number.parseInt(process.env.MEMORIA_REINTENTO_MS, 10);
  return Number.isFinite(ms) && ms >= 0 ? ms : 60000;
};

function setModo(nuevoModo) {
  if (!['mysql', 'ram'].includes(nuevoModo)) throw new Error(`Modo de memoria inválido: ${nuevoModo}`);
  modo = nuevoModo;
  if (nuevoModo === 'ram') ultimoFallo = Date.now();
}
const getModo = () => modo;

/**
 * Pasa a MySQL los recuerdos que se guardaron en RAM mientras estuvo caído,
 * para no perderlos al volver. Si falla, se lanza y se sigue en RAM.
 */
async function volcarRamABd(Memoria) {
  const filas = [];
  for (const lista of memoriaRam.values()) {
    for (const { session_id, rol, contenido, metadata } of lista) filas.push({ session_id, rol, contenido, metadata });
  }
  if (filas.length) await Memoria.bulkCreate(filas);
  memoriaRam.clear();
  return filas.length;
}

/**
 * Ejecuta la operación en MySQL; si falla, pasa a modo RAM y la repite ahí.
 * Estando en RAM, cada intervaloReintento() vuelve a probar MySQL.
 */
async function conRespaldo(operacionBd, operacionRam) {
  if (modo === 'ram' && Date.now() - ultimoFallo >= intervaloReintento()) {
    try {
      const Memoria = modeloMemoria();
      const volcados = await volcarRamABd(Memoria);
      modo = 'mysql';
      console.log(`[memoria] MySQL disponible de nuevo. ${volcados} recuerdo(s) pasados de RAM a MySQL.`);
    } catch {
      ultimoFallo = Date.now(); // sigue caído: se reintentará más tarde
    }
  }
  if (modo === 'mysql') {
    try {
      return await operacionBd(modeloMemoria());
    } catch (error) {
      console.warn(`[memoria] MySQL no disponible (${error.message}). Se usará memoria en RAM y se reintentará cada ${intervaloReintento() / 1000} s.`);
      setModo('ram');
    }
  }
  return operacionRam();
}

/** Genera un identificador de sesión nuevo. */
function nuevaSesion() {
  return crypto.randomUUID();
}

/** Quita imágenes en base64 y recorta textos largos. */
function sanitizarTexto(texto) {
  return String(texto ?? '')
    .replace(/data:[\w/+.-]+;base64,[A-Za-z0-9+/=]+/g, '[imagen omitida]')
    .replace(/[A-Za-z0-9+/=]{500,}/g, '[binario omitido]')
    .slice(0, MAX_CARACTERES);
}

function sanitizarMetadata(metadata) {
  if (!metadata) return null;
  return JSON.parse(JSON.stringify(metadata, (_k, v) => (typeof v === 'string' ? sanitizarTexto(v) : v)));
}

/**
 * Guarda un recuerdo.
 * @param {string} sessionId
 * @param {'user'|'assistant'|'resumen'} rol
 * @param {string} contenido - texto (nunca la imagen)
 * @param {object} [metadata]
 */
async function guardar(sessionId, rol, contenido, metadata = null) {
  if (!sessionId) throw new Error('sessionId es obligatorio para guardar memoria.');
  if (!ROLES.includes(rol)) throw new Error(`Rol de memoria inválido: ${rol}`);
  const registro = {
    session_id: sessionId,
    rol,
    contenido: sanitizarTexto(contenido),
    metadata: sanitizarMetadata(metadata),
  };
  if (!registro.contenido.trim()) return null;

  return conRespaldo(
    async (Memoria) => (await Memoria.create(registro)).toJSON(),
    () => {
      const lista = memoriaRam.get(sessionId) || [];
      const item = { id: siguienteIdRam++, ...registro, createdAt: new Date() };
      lista.push(item);
      memoriaRam.set(sessionId, lista);
      return item;
    }
  );
}

/** Devuelve los últimos `limite` recuerdos de la sesión, en orden cronológico. */
async function cargar(sessionId, limite = Number.parseInt(process.env.AGENTE_MAX_RECUERDOS, 10) || 10) {
  if (!sessionId) return [];
  const n = Math.max(1, limite);
  const recuerdos = await conRespaldo(
    async (Memoria) => {
      const filas = await Memoria.findAll({
        where: { session_id: sessionId },
        order: [['id', 'DESC']],
        limit: n,
      });
      return filas.map((f) => f.toJSON()).reverse();
    },
    () => (memoriaRam.get(sessionId) || []).slice(-n)
  );
  return recuerdos.map((r) => ({
    id: r.id,
    rol: r.rol,
    contenido: r.contenido,
    metadata: r.metadata ?? null,
    createdAt: r.createdAt ?? r.created_at ?? null,
  }));
}

/** Borra toda la memoria de una sesión. Devuelve cuántos recuerdos se eliminaron. */
async function borrar(sessionId) {
  const enRam = (memoriaRam.get(sessionId) || []).length;
  memoriaRam.delete(sessionId);
  const enBd = await conRespaldo(
    (Memoria) => Memoria.destroy({ where: { session_id: sessionId } }),
    () => 0
  );
  return enRam + enBd;
}

/**
 * Construye el bloque de texto que se inyecta en el system prompt.
 * @returns {Promise<{ texto: string, cantidad: number }>}
 */
async function construirContexto(sessionId, limite) {
  let recuerdos = [];
  try {
    recuerdos = await cargar(sessionId, limite);
  } catch (error) {
    console.warn(`[memoria] No se pudo cargar la memoria: ${error.message}`);
  }
  if (!recuerdos.length) {
    return { texto: 'No hay interacciones previas en esta sesión.', cantidad: 0 };
  }
  const etiquetas = { user: 'Usuario', assistant: 'Agente', resumen: 'Resumen de factura' };
  const lineas = recuerdos.map((r) => `- [${etiquetas[r.rol] || r.rol}] ${r.contenido}`);
  return { texto: lineas.join('\n'), cantidad: recuerdos.length };
}

/**
 * Resume un comprobante en una sola línea de texto para la memoria:
 * tipo, consecutivo, emisor y cédula, receptor, total con moneda, impuestos,
 * número de líneas y clave.
 * @param {object} datos - datosEstructurados (v4.4; también acepta el formato anterior)
 * @param {{ facturaGuardadaId?: number|null, confianza?: number|null }} [extra]
 */
function resumirFactura(datos, extra = {}) {
  const f = normalizarFactura(datos);
  if (!f) return '';
  const r = f.resumen || {};
  const persona = (p) => (p?.nombre || p?.identificacion ? `${p.nombre ?? 'sin nombre'}${p.identificacion ? ` (cédula ${p.identificacion})` : ''}` : null);
  const partes = [
    `${f.tipo_documento || 'Comprobante'} ${f.numero_consecutivo ?? 's/n'}`,
    `emisor ${persona(f.emisor) ?? 'desconocido'}`,
    `receptor ${persona(f.receptor) ?? 'no indicado'}`,
    f.fecha_emision ? `fecha ${f.fecha_emision}` : null,
    `total ${formatearMonto(r.total_comprobante, r.moneda)}`,
    `impuestos ${formatearMonto(r.total_impuesto, r.moneda)}`,
    `${f.detalle.length} línea(s)`,
    `clave ${f.clave ?? 'no visible'}`,
    typeof extra.confianza === 'number' ? `confianza ${extra.confianza}` : null,
    extra.facturaGuardadaId ? `guardada en BD con id ${extra.facturaGuardadaId}` : 'no guardada en BD',
  ];
  return partes.filter(Boolean).join(', ') + '.';
}

module.exports = {
  nuevaSesion,
  guardar,
  cargar,
  borrar,
  construirContexto,
  resumirFactura,
  setModo,
  getModo,
};
