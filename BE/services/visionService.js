/**
 * visionService.js
 * ------------------------------------------------------------------
 * Agente de visión para facturas. Frente a agentServiceFacturas.js
 * (una sola llamada, sin estado), este servicio añade:
 *
 *  1. USO DE HERRAMIENTAS: el modelo decide (tool_choice "auto") cuándo
 *     buscar, consultar o guardar; el backend ejecuta y devuelve role "tool".
 *  2. RAZONAMIENTO EN VARIOS PASOS: ciclo observar → decidir → actuar con
 *     un máximo de pasos, empezando en detail "low" y subiendo a "high"
 *     cuando el modelo lo pide o cuando la regla de seguridad lo exige.
 *  3. MEMORIA: recuerdos de la sesión inyectados en el system prompt y
 *     guardados al terminar (solo texto, nunca la imagen).
 * ------------------------------------------------------------------
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const { definicionesTools, ejecutarTool } = require('./agentTools');
const memoria = require('./memoryService');
const {
  ESTRUCTURA_TEXTO,
  aplicarCorrecciones,
  reconciliarConClaveOcr,
  reconciliarZonasOcr,
  validarFactura,
} = require('./esquemaFactura');
const { ampliarZona } = require('./imagenZoom');
const ocr = require('./ocrService');

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

const SYSTEM_PROMPT = `Eres un agente especialista en análisis y extracción de información visual, enfocado en comprobantes electrónicos de Hacienda de Costa Rica (versión 4.4): facturas, tiquetes, notas de crédito y débito, facturas de compra y de exportación, y recibos electrónicos de pago.

Trabajas en un ciclo OBSERVAR → DECIDIR → ACTUAR:
1. OBSERVAR: analiza la imagen (si la hay), la instrucción del usuario y la memoria de la sesión.
2. DECIDIR: determina si ya tienes datos fiables o si necesitas una herramienta.
3. ACTUAR: llama las herramientas que aporten valor; el sistema te devolverá sus resultados y volverás a observar.

Herramientas disponibles:
- solicitar_mayor_detalle: la primera imagen llega en baja resolución (detail "low"). Si el texto es pequeño o borroso, o dudas de la clave, el consecutivo, los CABYS, la cédula o los importes, pide la misma imagen en alta resolución ANTES de dar datos definitivos.
- ampliar_zona: con detail "high" la imagen completa se reduce a unos 768 px en su lado corto, así que los dígitos y las letras pequeñas se confunden. ampliar_zona recorta una región de la imagen ORIGINAL y te la envía ampliada en el siguiente paso. ANTES de la respuesta final úsala para leer la clave, el consecutivo, las identificaciones (cédulas), los códigos de actividad, los CABYS y los correos. Prefiere zona "personalizada" con un recuadro { x, y, ancho, alto } en porcentajes ajustado al dato cuando sepas dónde está (puedes pedir varias en el mismo paso); "encabezado", "clave", "emisor", "receptor", "detalle" y "resumen" son atajos aproximados. Tienes un máximo de 4 ampliaciones por análisis: agrupa los datos cercanos en un mismo recuadro.
- leer_digitos_ocr: lee una zona con OCR (Tesseract). Tú cuentas mal las secuencias largas de dígitos repetidos ("999999", "0000000457") aunque la zona esté ampliada; el OCR no. Devuelve el texto crudo, los grupos de dígitos de cada línea con su longitud y, para "clave"/"consecutivo", un candidato de 50/20 dígitos. Indica zona (o "personalizada" con recuadro) y campo (clave | consecutivo | identificacion | actividad | cabys | otro).
- solicitar_nueva_imagen: si la imagen no sirve ni en alta resolución (cortada, desenfocada, reflejos, poca luz, no es un comprobante), termina pidiendo otra foto con un motivo y recomendaciones concretas.
- consultar_proveedor: valida o completa los datos del emisor por su identificación (cédula).
- guardar_factura: guarda el comprobante completo cuando los datos sean fiables, las cuentas cuadren y el usuario no haya pedido lo contrario. Si responde "duplicada", no reintentes: informa al usuario.
- buscar_factura: consulta comprobantes guardados (por clave, consecutivo o cédula del emisor). Para "las facturas que te pasé" usa solo_sesion_actual=true.

Reglas de extracción:
- Extrae TODO lo que sea visible: encabezado, emisor, receptor, cada línea de detalle con sus descuentos, impuestos y exoneraciones, otros cargos, el resumen completo, medios de pago, referencias y leyendas.

Prohibido inventar o completar datos:
- Nunca inventes, deduzcas ni completes información. Usa null para lo que no se vea y añade ese campo a "campos_ilegibles". Lo que no encaje en la estructura va en "otros".
- El correo, el teléfono, los códigos (actividad, CABYS, código comercial, códigos de impuesto y tarifa) y los nombres se copian EXACTAMENTE como están impresos: no corrijas la ortografía, no completes dominios de correo ni prefijos telefónicos.
- Copia los correos y los códigos LETRA POR LETRA y DÍGITO POR DÍGITO. No "corrijas" ni acortes palabras que te parezcan raras o mal escritas: un correo como "ferrerobles@..." se copia completo aunque parezca un error o una palabra conocida ("ferroblos"). Si un carácter es dudoso, amplía la zona en vez de adivinar.
- Cuidado con los dígitos que se confunden en letra pequeña (2/9, 0/8, 1/7, 5/6, 3/8): léelos en una ampliación antes de responder.
- Si una sección no existe o dice "no aplica" (otros cargos, información de referencia), su arreglo queda vacío: "otros_cargos": [], "informacion_referencia": [].
- "plazo_credito_dias" es null cuando la venta es de contado o cuando el plazo no aparece impreso.

Formato numérico de Costa Rica (MUY IMPORTANTE):
- En los MONTOS el punto separa los miles y la coma es el decimal: "32.500,00" = 32500; "2.400,00" = 2400; "1.234.567,89" = 1234567.89.
- En las CANTIDADES la coma es decimal y suelen ir con 3 decimales: "2,000" = 2 (dos unidades, NO dos mil); "1,500" = 1.5.
- En cada línea de detalle, devuelve "cantidad", "precio_unitario", "monto_total", "subtotal", "impuesto_neto" y "monto_total_linea" como STRING, copiados carácter por carácter tal como aparecen impresos (p. ej. "2,000", "16.250,00"). No los conviertas: el sistema los convierte.
- El resto de los importes (resumen, descuentos, desglose, medios de pago) van como números JSON ya convertidos con esa regla (32500, no "32.500,00"). La tarifa de IVA va como porcentaje (13, no 0.13).

Fechas:
- En Costa Rica las fechas están impresas como DD/MM/AAAA (día primero). Devuélvelas como "AAAA-MM-DDTHH:mm:ss", con la hora impresa y sin zona horaria. Ejemplo: "15/03/2025 10:30" → "2025-03-15T10:30:00". Si no hay hora, usa "T00:00:00".

Lectura de dígitos (clave y consecutivo):
- OBLIGATORIO: antes de la respuesta final llama leer_digitos_ocr con campo "clave" y con campo "consecutivo" (puedes pedir ambas en el mismo paso). Llámala también para los códigos de actividad y las identificaciones si tienes cualquier duda.
- Si el OCR devuelve una clave de 50 dígitos que empieza por 506 y pasa las validaciones cruzadas (su fecha DDMMAA coincide con la fecha de emisión, su identificación con la del emisor y su consecutivo con el número consecutivo), USA LA CLAVE DEL OCR, no la que leíste tú. Si el OCR no encuentra la clave o falla, usa una ampliación (ampliar_zona) y léela tú por grupos.
- Si tu lectura y la del OCR difieren en un código corto (actividad, cédula), revisa ese código en una ampliación antes de decidir.
- Copia la clave por grupos y cuenta los ceros de cada grupo: 506 | DDMMAA | identificación del emisor (12 dígitos, rellena con ceros a la izquierda) | consecutivo (20) | situación (1) | código de seguridad (8) = 50 dígitos.
- Copia el consecutivo por grupos: sucursal (3) | terminal (5) | tipo de documento (2) | número (10) = 20 dígitos.
- Comprueba que la fecha de la clave coincide con fecha_emision (DDMMAA), que su identificación coincide con la del emisor y que su consecutivo coincide con numero_consecutivo. Devuelve ambos SIN guiones, espacios ni puntos; lo mismo para los CABYS (13 dígitos) y las cédulas.
- Verifica que las cuentas cuadren (tolerancia ±1): cantidad × precio_unitario = monto_total; subtotal + impuesto_neto = monto_total_linea; total_venta − total_descuentos = total_venta_neta; total_venta_neta + total_impuesto + total_otros_cargos − total_iva_devuelto = total_comprobante; la suma de las líneas = total_venta_neta + total_impuesto; la suma de medios_pago = total_comprobante. Si no cuadran, vuelve a leer los números (o pide más detalle) antes de responder, y baja la confianza si persiste.
- Si una herramienta devuelve un error (por ejemplo, la base de datos no está disponible), no la repitas en bucle: continúa con lo que tengas y explica la limitación al usuario.
- Responde siempre en español.

Cuando ya no necesites herramientas, responde ÚNICAMENTE con un objeto JSON con esta forma:
{
  "estado": "completado" | "requiere_nueva_imagen",
  "calidad_imagen": "buena" | "regular" | "mala" | null,
  "confianza": número entre 0 y 1,
  "campos_ilegibles": ["..."],
  "datosEstructurados": <objeto con la estructura de abajo> | null,
  "respuesta": "mensaje breve para el usuario"
}

Estructura de "datosEstructurados":
${ESTRUCTURA_TEXTO}

Si no hay imagen (pregunta de seguimiento), usa "datosEstructurados": null, "calidad_imagen": null y responde la pregunta en "respuesta".`;

/** Configuración leída en cada llamada (permite cambiar el .env sin tocar código). */
function leerConfig() {
  const entero = (v, def) => {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : def;
  };
  const decimal = (v, def) => {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : def;
  };
  return {
    model: process.env.OPENAI_VISION_MODEL || 'gpt-4o',
    maxPasos: entero(process.env.AGENTE_MAX_PASOS, 8),
    umbralConfianza: decimal(process.env.AGENTE_UMBRAL_CONFIANZA, 0.7),
    maxRecuerdos: entero(process.env.AGENTE_MAX_RECUERDOS, 10),
    maxAmpliaciones: entero(process.env.AGENTE_MAX_AMPLIACIONES, 4),
    zoomAnchoMinimo: entero(process.env.AGENTE_ZOOM_ANCHO_MIN, 1500),
    maxOcr: entero(process.env.AGENTE_MAX_OCR, 6),
    ocrAnchoMinimo: entero(process.env.OCR_ANCHO_MIN, 2000),
    timeoutMs: entero(process.env.OPENAI_TIMEOUT_MS, 120000),
  };
}

// ------------------------------------------------------------------
// Utilidades
// ------------------------------------------------------------------

/** Convierte Buffer / ruta / URL / data URI al valor de image_url.url. */
function construirImageUrl(imagen, mimeType = 'image/jpeg') {
  if (Buffer.isBuffer(imagen)) return `data:${mimeType || 'image/jpeg'};base64,${imagen.toString('base64')}`;
  if (typeof imagen !== 'string' || !imagen.trim()) {
    throw new Error('Se requiere una imagen válida (Buffer, URL, data URI o ruta local).');
  }
  const entrada = imagen.trim();
  if (/^(https?:|data:)/.test(entrada)) return entrada;

  const ruta = path.resolve(entrada);
  const mimes = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
  const mime = mimes[path.extname(ruta).toLowerCase()] || mimeType;
  return `data:${mime};base64,${fs.readFileSync(ruta).toString('base64')}`;
}

const normalizarDetail = (d, porDefecto) => (['low', 'high', 'auto'].includes(d) ? d : porDefecto);

/** Una llamada a chat/completions con fetch nativo. Devuelve choices[0].message. */
async function llamarOpenAI(body, timeoutMs = leerConfig().timeoutMs) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('Falta configurar OPENAI_API_KEY en el archivo .env');

  const resp = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) {
    const detalle = await resp.text().catch(() => '');
    throw new Error(`Error de OpenAI (${resp.status}): ${detalle}`);
  }
  const data = await resp.json();
  const mensaje = data?.choices?.[0]?.message;
  if (!mensaje) throw new Error('La respuesta de OpenAI no contiene un mensaje.');
  return mensaje;
}

function parsearJSON(texto) {
  if (!texto) return null;
  const limpio = String(texto).trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  try {
    return JSON.parse(limpio);
  } catch {
    return null;
  }
}

/** Normaliza la respuesta final del modelo al contrato del agente. */
function normalizarRespuestaFinal(contenido) {
  const json = parsearJSON(contenido);
  if (!json || typeof json !== 'object') {
    // El modelo respondió texto libre: se conserva como respuesta.
    return {
      estado: 'completado',
      calidad_imagen: null,
      confianza: null,
      campos_ilegibles: [],
      datosEstructurados: null,
      respuesta: String(contenido || '').trim(),
    };
  }
  const confianza = Number.parseFloat(json.confianza);
  // Limpia códigos, convierte importes, adapta el formato antiguo y aplica las
  // correcciones deterministas (p. ej. fecha con día/mes invertidos según la clave)
  const { factura, notas } = aplicarCorrecciones(json.datosEstructurados ?? json.datos_estructurados ?? null);
  return {
    estado: json.estado === 'requiere_nueva_imagen' ? 'requiere_nueva_imagen' : 'completado',
    calidad_imagen: ['buena', 'regular', 'mala'].includes(json.calidad_imagen) ? json.calidad_imagen : null,
    confianza: Number.isFinite(confianza) ? Math.min(Math.max(confianza, 0), 1) : null,
    campos_ilegibles: Array.isArray(json.campos_ilegibles) ? json.campos_ilegibles.map(String) : [],
    datosEstructurados: factura,
    notas,
    respuesta: typeof json.respuesta === 'string' ? json.respuesta : '',
    motivo: json.motivo,
    recomendaciones: Array.isArray(json.recomendaciones) ? json.recomendaciones : undefined,
  };
}

/** Advertencias de validarFactura para los datos de la respuesta (vacío si no hay datos). */
function advertenciasDe(final) {
  return final.datosEstructurados ? validarFactura(final.datosEstructurados).advertencias : [];
}

/** Red de seguridad: ¿la respuesta es dudosa y merece un reintento en "high"? */
function motivoReintento(final, umbral, advertencias) {
  if (final.estado === 'requiere_nueva_imagen') return null;
  const motivos = [];
  if (final.confianza === null || final.confianza < umbral) motivos.push(`confianza ${final.confianza ?? 'ausente'} < ${umbral}`);
  if (final.calidad_imagen === 'mala') motivos.push('calidad_imagen "mala"');
  if (final.campos_ilegibles.length) motivos.push(`campos ilegibles: ${final.campos_ilegibles.join(', ')}`);
  if (advertencias.length) motivos.push(`${advertencias.length} inconsistencia(s) en la validación`);
  return motivos.length ? motivos.join('; ') : null;
}

/** Resume valores para la traza (evita devolver objetos enormes). */
function resumir(valor, max = 400) {
  if (valor === undefined) return undefined;
  const texto = typeof valor === 'string' ? valor : JSON.stringify(valor);
  if (texto.length <= max) return typeof valor === 'string' ? valor : JSON.parse(texto);
  return `${texto.slice(0, max)}… (${texto.length} caracteres)`;
}

function parsearArgumentos(texto) {
  const json = parsearJSON(texto);
  return json && typeof json === 'object' ? json : {};
}

function contenidoUsuario(texto, imageUrl, detail) {
  const partes = [{ type: 'text', text: texto }];
  if (imageUrl) partes.push({ type: 'image_url', image_url: { url: imageUrl, detail } });
  return partes;
}

/**
 * Reinyecta la MISMA imagen en alta resolución. Las copias anteriores de la imagen
 * completa se sustituyen por un texto para no pagar dos veces sus tokens
 * (las ampliaciones de zonas se conservan: son recortes distintos).
 */
function reinyectarImagenHigh(messages, imageUrl, texto) {
  for (const m of messages) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    m.content = m.content.map((p) =>
      p.type === 'image_url' && p.image_url?.url === imageUrl
        ? { type: 'text', text: '[Imagen completa previa omitida; se reenvía en alta resolución más abajo]' }
        : p
    );
  }
  messages.push({ role: 'user', content: contenidoUsuario(texto, imageUrl, 'high') });
}

/** Partes de mensaje (texto + imagen high) para una o varias ampliaciones. */
function partesAmpliaciones(ampliaciones) {
  return ampliaciones.flatMap((z) => [
    {
      type: 'text',
      text:
        `Ampliación de la zona "${z.zona}" (x ${z.recuadro.x}%, y ${z.recuadro.y}%, ancho ${z.recuadro.ancho}%, ` +
        `alto ${z.recuadro.alto}% de la imagen completa) — motivo: ${z.motivo || 'sin motivo'}.`,
    },
    { type: 'image_url', image_url: { url: z.dataUrl, detail: 'high' } },
  ]);
}

function construirSystemPrompt(cfg, contextoMemoria, hayImagen) {
  return [
    SYSTEM_PROMPT,
    `\nParámetros de esta ejecución:\n- Umbral de confianza para considerar fiables los datos: ${cfg.umbralConfianza}.\n- Máximo de pasos: ${cfg.maxPasos}.\n- Máximo de ampliaciones (ampliar_zona): ${cfg.maxAmpliaciones}.\n- ${hayImagen ? 'El usuario adjuntó una imagen (llega primero en detail "low").' : 'No hay imagen: es una pregunta de seguimiento.'}`,
    `\nMemoria de la sesión (de más antigua a más reciente):\n${contextoMemoria}`,
  ].join('\n');
}

// ------------------------------------------------------------------
// API pública
// ------------------------------------------------------------------

/**
 * Análisis de una sola pasada (sin herramientas ni memoria): observa la imagen
 * y devuelve el JSON normalizado del agente. Útil como bloque básico o para comparar.
 * @param {Buffer|string} imagen
 * @param {{ mimeType?: string, detail?: 'low'|'high'|'auto', instruccion?: string, model?: string }} [opciones]
 */
async function analyzeImage(imagen, opciones = {}) {
  const cfg = leerConfig();
  const detail = normalizarDetail(opciones.detail, 'high');
  const imageUrl = construirImageUrl(imagen, opciones.mimeType);
  const mensaje = await llamarOpenAI({
    model: opciones.model || cfg.model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: contenidoUsuario(
          `${opciones.instruccion || 'Extrae los datos de esta factura.'}\nNo tienes herramientas disponibles: responde directamente con el JSON final.`,
          imageUrl,
          detail
        ),
      },
    ],
  });
  const final = normalizarRespuestaFinal(mensaje.content);
  return { ...final, advertencias: advertenciasDe(final), notas: final.notas || [], detail };
}

/**
 * Ejecuta el agente completo.
 * @param {object} params
 * @param {Buffer|string} [params.imagen] - imagen de la factura (opcional en preguntas de seguimiento)
 * @param {string} [params.instruccion] - instrucción del usuario
 * @param {string} [params.sessionId] - si falta, se genera con crypto.randomUUID()
 * @param {string} [params.mimeType]
 * @param {'low'|'high'|'auto'} [params.detail='low'] - resolución del primer análisis
 */
async function ejecutarAgente({ imagen, instruccion, sessionId, mimeType, detail } = {}) {
  const cfg = leerConfig();
  const hayImagen = imagen !== undefined && imagen !== null && imagen !== '';
  const textoInstruccion = typeof instruccion === 'string' ? instruccion.trim() : '';
  if (!hayImagen && !textoInstruccion) throw new Error('Debes enviar una imagen o una instrucción.');

  const sid = sessionId || memoria.nuevaSesion();
  const imageUrl = hayImagen ? construirImageUrl(imagen, mimeType) : null;
  let detailActual = hayImagen ? normalizarDetail(detail, 'low') : null;

  // --- MEMORIA: recuerdos previos inyectados en el system prompt ---
  const contexto = await memoria.construirContexto(sid, cfg.maxRecuerdos);

  const messages = [
    { role: 'system', content: construirSystemPrompt(cfg, contexto.texto, hayImagen) },
    {
      role: 'user',
      content: contenidoUsuario(
        textoInstruccion || 'Analiza esta factura, extrae sus datos y guárdala si son fiables.',
        imageUrl,
        detailActual
      ),
    },
  ];
  const tools = definicionesTools({ conImagen: hayImagen });

  const pasos = [];
  let facturaGuardadaId = null;
  let reintentoAutomatico = false;
  let verificacionHecha = false;
  let final = null;
  let pasosUsados = 0;
  let ampliacionesUsadas = 0;

  /**
   * Recorta y amplía una zona de la imagen ORIGINAL (máximo cfg.maxAmpliaciones por análisis).
   * Registra cada intento en la traza como tipo "ampliacion" (zona, motivo y resultado).
   */
  async function ampliar({ zona, motivo, recuadro }, paso, origen) {
    if (ampliacionesUsadas >= cfg.maxAmpliaciones) {
      const error = `Se alcanzó el máximo de ${cfg.maxAmpliaciones} ampliaciones por análisis. Continúa con lo que ya tienes.`;
      pasos.push({ paso, tipo: 'ampliacion', origen, zona, motivo, ok: false, error });
      return { ok: false, error };
    }
    const z = await ampliarZona(imagen, { zona, recuadro }, { anchoMinimo: cfg.zoomAnchoMinimo });
    if (!z.ok) {
      pasos.push({ paso, tipo: 'ampliacion', origen, zona, motivo, ok: false, error: z.error });
      return z;
    }
    ampliacionesUsadas += 1;
    pasos.push({ paso, tipo: 'ampliacion', origen, zona: z.zona, motivo, recuadro: z.recuadro, tamano: z.tamano, ok: true });
    return { ...z, motivo };
  }

  // Claves de 50 dígitos encontradas por el OCR en este análisis (para la reconciliación)
  const clavesOcr = [];
  // Actividad e identificación leídas por OCR en las zonas "emisor" y "receptor"
  const zonasOcr = {};
  let lecturasOcr = 0;
  let lecturasOcrModelo = 0;
  let ocrClaveIntentado = false; // ¿el modelo llamó a leer_digitos_ocr con campo "clave"?
  let ocrAutomaticoHecho = false;

  /**
   * leer_digitos_ocr: recorta la zona en escala de grises con más contraste (≥ 2000 px de ancho)
   * y la pasa por Tesseract. Registra cada lectura en la traza como tipo "ocr" con su origen
   * ("modelo" si la pidió el modelo, "automatico" si la lanzó el código).
   */
  async function leerConOcr({ zona, recuadro, campo = 'otro' }, paso, origen = 'modelo') {
    const fallo = (error) => {
      pasos.push({ paso, tipo: 'ocr', origen, zona, campo, ok: false, error });
      return { ok: false, error };
    };
    // El límite es para las lecturas que pide el modelo; las automáticas son fijas (máx. 4)
    if (origen === 'modelo' && lecturasOcrModelo >= cfg.maxOcr) {
      return fallo(`Se alcanzó el máximo de ${cfg.maxOcr} lecturas OCR por análisis. Continúa con lo que ya tienes.`);
    }
    if (!ocr.ocrDisponible()) {
      return fallo('tesseract.js no está instalado (npm install tesseract.js): no se puede leer con OCR. Continúa con tu propia lectura.');
    }
    const z = await ampliarZona(
      imagen,
      { zona, recuadro },
      { anchoMinimo: cfg.ocrAnchoMinimo, ladoMaximo: 4000, factorMaximo: 6, paraOcr: true }
    );
    if (!z.ok) return fallo(z.error);

    lecturasOcr += 1;
    if (origen === 'modelo') lecturasOcrModelo += 1;
    const lectura = await ocr.leerDigitos(z.buffer, campo);
    if (!lectura.ok) return fallo(lectura.error);

    for (const c of lectura.candidatosClave) if (!clavesOcr.includes(c)) clavesOcr.push(c);
    // En las zonas del emisor y del receptor se buscan "Actividad" y "Cédula"
    let datosZona;
    if (z.zona === 'emisor' || z.zona === 'receptor') {
      datosZona = { actividad: ocr.extraerActividad(lectura.texto), identificacion: ocr.extraerCedula(lectura.texto) };
      zonasOcr[z.zona] = datosZona;
    }
    pasos.push({
      paso,
      tipo: 'ocr',
      origen,
      zona: z.zona,
      campo,
      ok: true,
      candidato: lectura.candidato?.valor ?? null,
      ...(datosZona ? { encontrado: datosZona } : {}),
      lineas: lectura.lineas.length,
    });
    return {
      ok: true,
      campo,
      zona: z.zona,
      texto: lectura.texto,
      lineas: lectura.lineas.slice(0, 40),
      candidato: lectura.candidato,
      candidatos: lectura.candidatos,
      ...(campo !== 'clave' && lectura.candidatosClave.length ? { clave_encontrada: lectura.candidatosClave[0] } : {}),
      ...(datosZona ? { encontrado: datosZona } : {}),
    };
  }

  /**
   * OCR OBLIGATORIO por código (una sola vez por análisis), sin depender del modelo:
   * - si el modelo no leyó la clave con OCR y aún no hay candidato: zona "clave" y, si no
   *   aparece una de 50 dígitos, zona "encabezado";
   * - zonas "emisor" y "receptor" (actividad y cédula), salvo que ya se hayan leído.
   */
  async function asegurarOcrAutomatico(paso) {
    if (ocrAutomaticoHecho || !hayImagen) return;
    ocrAutomaticoHecho = true;
    if (!ocr.ocrDisponible()) {
      pasos.push({
        paso,
        tipo: 'ocr',
        origen: 'automatico',
        ok: false,
        error: 'tesseract.js no está instalado: se omite el OCR automático.',
      });
      return;
    }
    if (!ocrClaveIntentado && !clavesOcr.length) {
      await leerConOcr({ zona: 'clave', campo: 'clave' }, paso, 'automatico');
      if (!clavesOcr.length) await leerConOcr({ zona: 'encabezado', campo: 'clave' }, paso, 'automatico');
    }
    for (const zona of ['emisor', 'receptor']) {
      if (!zonasOcr[zona]) await leerConOcr({ zona, campo: 'otro' }, paso, 'automatico');
    }
  }

  /** Reconciliación determinista con todo lo leído por OCR (zonas + clave). */
  function reconciliarConOcr(datos) {
    if (!datos || (!clavesOcr.length && !Object.keys(zonasOcr).length)) return { factura: datos, notas: [] };
    const porZonas = reconciliarZonasOcr(datos, zonasOcr, clavesOcr);
    const porClave = reconciliarConClaveOcr(porZonas.factura, clavesOcr);
    return { factura: porClave.factura, notas: [...porZonas.notas, ...porClave.notas] };
  }

  // --- CICLO observar → decidir → actuar ---
  for (let paso = 1; paso <= cfg.maxPasos; paso++) {
    pasosUsados = paso;
    const inicio = Date.now();

    // OBSERVAR + DECIDIR: el modelo ve todo el historial y elige herramientas o respuesta final.
    const mensaje = await llamarOpenAI({
      model: cfg.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages,
      tools,
      tool_choice: 'auto',
    });
    const toolCalls = Array.isArray(mensaje.tool_calls) ? mensaje.tool_calls : [];

    pasos.push({
      paso,
      tipo: 'decision',
      detail: detailActual,
      decision: toolCalls.length ? 'usar_herramientas' : 'responder',
      herramientas: toolCalls.map((t) => t.function?.name),
      duracionMs: Date.now() - inicio,
    });

    if (toolCalls.length) {
      // ACTUAR: el backend ejecuta cada herramienta y devuelve el resultado como role "tool".
      messages.push({ role: 'assistant', content: mensaje.content ?? null, tool_calls: toolCalls });
      let motivoDetalle = null;
      let nuevaImagen = null;
      const ampliacionesPendientes = [];

      for (const llamada of toolCalls) {
        const nombre = llamada.function?.name;
        const args = parsearArgumentos(llamada.function?.arguments);
        let resultado;

        if (nombre === 'solicitar_mayor_detalle') {
          if (!hayImagen) resultado = { ok: false, error: 'No hay imagen en esta conversación.' };
          else if (detailActual === 'high') {
            resultado = { ok: false, error: 'La imagen ya está en alta resolución. Trabaja con ella o usa solicitar_nueva_imagen.' };
          } else {
            motivoDetalle = args.motivo || 'sin motivo indicado';
            resultado = { ok: true, mensaje: 'Se reenviará la misma imagen en alta resolución (detail "high").' };
          }
        } else if (nombre === 'ampliar_zona') {
          if (!hayImagen) {
            resultado = { ok: false, error: 'No hay imagen en esta conversación.' };
          } else {
            const z = await ampliar({ zona: args.zona, motivo: args.motivo, recuadro: args.recuadro }, paso, 'modelo');
            if (z.ok) {
              ampliacionesPendientes.push(z);
              // El resultado NO incluye la imagen (va en el siguiente mensaje de usuario)
              resultado = {
                ok: true,
                mensaje: 'La ampliación se envía a continuación como imagen en alta resolución.',
                zona: z.zona,
                recuadro: z.recuadro,
                tamano: z.tamano,
                ampliaciones_restantes: cfg.maxAmpliaciones - ampliacionesUsadas,
              };
            } else {
              resultado = z;
            }
          }
        } else if (nombre === 'leer_digitos_ocr') {
          if (args.campo === 'clave') ocrClaveIntentado = true;
          resultado = hayImagen
            ? await leerConOcr({ zona: args.zona, recuadro: args.recuadro, campo: args.campo }, paso)
            : { ok: false, error: 'No hay imagen en esta conversación.' };
        } else if (nombre === 'solicitar_nueva_imagen') {
          nuevaImagen = {
            motivo: args.motivo || 'La imagen no es legible.',
            recomendaciones: Array.isArray(args.recomendaciones) ? args.recomendaciones.map(String) : [],
          };
          resultado = { ok: true, mensaje: 'Se pedirá al usuario una nueva imagen.' };
        } else {
          // Antes de guardar se asegura el OCR obligatorio, para no guardar dígitos mal leídos;
          // clavesOcr y zonasOcr permiten a guardar_factura reconciliar con lo leído por OCR.
          if (nombre === 'guardar_factura') await asegurarOcrAutomatico(paso);
          resultado = await ejecutarTool(nombre, args, { sessionId: sid, clavesOcr, zonasOcr });
          if (nombre === 'guardar_factura' && resultado?.ok && resultado.factura_id) {
            facturaGuardadaId = resultado.factura_id;
          }
        }

        messages.push({ role: 'tool', tool_call_id: llamada.id, content: JSON.stringify(resultado) });
        pasos.push({ paso, tipo: 'herramienta', herramienta: nombre, argumentos: resumir(args), resultado: resumir(resultado) });
      }

      if (nuevaImagen) {
        final = {
          estado: 'requiere_nueva_imagen',
          calidad_imagen: 'mala',
          confianza: null,
          campos_ilegibles: [],
          datosEstructurados: null,
          respuesta: `No puedo leer bien la factura: ${nuevaImagen.motivo}`,
          ...nuevaImagen,
        };
        break;
      }

      if (motivoDetalle) {
        // La imagen va DESPUÉS de los mensajes de tool (OpenAI exige que los tool sigan al assistant).
        detailActual = 'high';
        reinyectarImagenHigh(messages, imageUrl, `Aquí tienes la misma imagen en alta resolución (motivo: ${motivoDetalle}). Continúa el análisis.`);
        pasos.push({ paso, tipo: 'mayor_detalle', origen: 'modelo', motivo: motivoDetalle });
      }

      if (ampliacionesPendientes.length) {
        // Los recortes también van DESPUÉS de los mensajes de tool, en detail "high"
        messages.push({
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                'Ampliaciones solicitadas: recortes de la imagen original, ampliados para leer el texto pequeño. ' +
                'Copia los dígitos y las letras exactamente como se ven en ellos.',
            },
            ...partesAmpliaciones(ampliacionesPendientes),
          ],
        });
      }
      continue;
    }

    // Respuesta final del modelo (+ validación en código de formatos y cuentas)
    const candidata = normalizarRespuestaFinal(mensaje.content);

    // OCR OBLIGATORIO + RECONCILIACIÓN determinista (no depende de que el modelo llame al OCR)
    if (candidata.datosEstructurados) {
      await asegurarOcrAutomatico(paso);
      const { factura, notas } = reconciliarConOcr(candidata.datosEstructurados);
      candidata.datosEstructurados = factura;
      candidata.notas = [...(candidata.notas || []), ...notas];
      if (notas.length) pasos.push({ paso, tipo: 'reconciliacion', notas });
    }

    const advertenciasCandidata = advertenciasDe(candidata);
    pasos.push({
      paso,
      tipo: 'respuesta_modelo',
      estado: candidata.estado,
      confianza: candidata.confianza,
      calidad_imagen: candidata.calidad_imagen,
      campos_ilegibles: candidata.campos_ilegibles,
      advertencias: advertenciasCandidata,
    });

    // RED DE SEGURIDAD: si la respuesta es dudosa (o no cuadra) y seguimos en "low", un reintento automático en "high".
    const motivo =
      hayImagen && detailActual === 'low' && !reintentoAutomatico && paso < cfg.maxPasos
        ? motivoReintento(candidata, cfg.umbralConfianza, advertenciasCandidata)
        : null;
    if (motivo) {
      reintentoAutomatico = true;
      detailActual = 'high';
      messages.push({ role: 'assistant', content: mensaje.content ?? '' });
      const listaAdvertencias = advertenciasCandidata.length
        ? `\nLa validación encontró estas inconsistencias; revísalas en la imagen:\n${advertenciasCandidata.map((a) => `- ${a}`).join('\n')}\n`
        : '';
      reinyectarImagenHigh(
        messages,
        imageUrl,
        `Revisión automática: tu respuesta no es suficientemente fiable (${motivo}).${listaAdvertencias}\n` +
          'Aquí tienes la misma imagen en alta resolución: vuelve a analizarla y entrega el JSON final. ' +
          'Si ya guardaste el comprobante y los datos cambian, indícalo en "respuesta".'
      );
      pasos.push({ paso, tipo: 'reintento_automatico', origen: 'regla', motivo, advertencias: advertenciasCandidata });
      continue;
    }

    // VERIFICACIÓN: ya en "high" (tras el reintento o porque el modelo lo pidió) y la validación
    // sigue fallando → UN último paso pidiendo releer SOLO los campos con advertencias.
    if (
      hayImagen &&
      detailActual === 'high' &&
      advertenciasCandidata.length &&
      !verificacionHecha &&
      candidata.estado !== 'requiere_nueva_imagen' &&
      paso < cfg.maxPasos
    ) {
      verificacionHecha = true;
      messages.push({ role: 'assistant', content: mensaje.content ?? '' });

      // Si las advertencias tocan la clave, el consecutivo o la fecha, se amplían
      // automáticamente el encabezado y la clave y se envían junto con las advertencias.
      const ampliacionesVerificacion = [];
      if (/clave|consecutivo|fecha/i.test(advertenciasCandidata.join(' '))) {
        for (const zona of ['encabezado', 'clave']) {
          const z = await ampliar(
            { zona, motivo: 'Verificación automática: releer clave, consecutivo y fecha' },
            paso,
            'verificacion'
          );
          if (z.ok) ampliacionesVerificacion.push(z);
        }
      }

      reinyectarImagenHigh(
        messages,
        imageUrl,
        'Verificación final: la validación todavía encuentra estas inconsistencias en tu respuesta:\n' +
          `${advertenciasCandidata.map((a) => `- ${a}`).join('\n')}\n\n` +
          'Vuelve a mirar la imagen y relee SOLO los campos implicados: la clave por grupos ' +
          '(506 | DDMMAA | 12 | 20 | 1 | 8) y el consecutivo por grupos (3 | 5 | 2 | 10), contando los ceros; ' +
          'las fechas como DD/MM/AAAA; los montos con punto de miles y coma decimal; las cantidades con coma decimal. ' +
          (ampliacionesVerificacion.length
            ? 'Debajo de la imagen completa van ampliaciones del encabezado y de la clave: léelas dígito por dígito. '
            : '') +
          'No cambies los demás campos. Devuelve el JSON final completo con esos campos corregidos. ' +
          'Si lo impreso realmente es así, consérvalo tal cual y explícalo en "respuesta".'
      );
      if (ampliacionesVerificacion.length) {
        messages.at(-1).content.push(...partesAmpliaciones(ampliacionesVerificacion));
      }
      pasos.push({
        paso,
        tipo: 'verificacion',
        advertencias: advertenciasCandidata,
        ampliaciones: ampliacionesVerificacion.map((z) => z.zona),
      });
      continue;
    }

    final = { ...candidata, advertencias: advertenciasCandidata };
    break;
  }

  if (!final) {
    final = {
      estado: 'incompleto',
      calidad_imagen: null,
      confianza: null,
      campos_ilegibles: [],
      datosEstructurados: null,
      respuesta: `El agente alcanzó el máximo de ${cfg.maxPasos} pasos sin una respuesta final.`,
    };
    pasos.push({ paso: pasosUsados, tipo: 'limite_pasos', maxPasos: cfg.maxPasos });
  }

  // --- MEMORIA: se guarda solo texto (instrucción, resumen y respuesta) ---
  try {
    const textoUsuario = hayImagen
      ? `[Adjuntó una imagen de factura] ${textoInstruccion || 'Analizar factura.'}`
      : textoInstruccion;
    await memoria.guardar(sid, 'user', textoUsuario);
    if (final.datosEstructurados) {
      await memoria.guardar(
        sid,
        'resumen',
        memoria.resumirFactura(final.datosEstructurados, { facturaGuardadaId, confianza: final.confianza }),
        { facturaGuardadaId, numero_factura: final.datosEstructurados.numero_factura ?? null }
      );
    }
    await memoria.guardar(sid, 'assistant', final.respuesta || `Estado: ${final.estado}`, {
      estado: final.estado,
      confianza: final.confianza,
      detailFinal: detailActual,
      facturaGuardadaId,
    });
  } catch (error) {
    console.warn(`[agente] No se pudo guardar la memoria: ${error.message}`);
  }

  return {
    sessionId: sid,
    sesionNueva: !sessionId,
    estado: final.estado,
    calidad_imagen: final.calidad_imagen,
    confianza: final.confianza,
    campos_ilegibles: final.campos_ilegibles,
    advertencias: final.advertencias || [],
    notas: final.notas || [],
    datosEstructurados: final.datosEstructurados,
    respuesta: final.respuesta,
    ...(final.estado === 'requiere_nueva_imagen'
      ? { motivo: final.motivo, recomendaciones: final.recomendaciones || [] }
      : {}),
    detailFinal: detailActual,
    facturaGuardadaId,
    reintentoAutomatico,
    verificacion: verificacionHecha,
    ampliaciones: ampliacionesUsadas,
    lecturasOcr,
    claveOcr: clavesOcr[0] ?? null,
    ocrZonas: zonasOcr,
    totalPasos: pasosUsados,
    pasos,
    memoria: { modo: memoria.getModo(), recuerdosUsados: contexto.cantidad },
  };
}

module.exports = {
  SYSTEM_PROMPT,
  analyzeImage,
  ejecutarAgente,
  // Reutilizada por generadorFactura (misma llamada a chat/completions con fetch)
  llamarOpenAI,
  // Exportadas para pruebas
  construirImageUrl,
  normalizarRespuestaFinal,
};
