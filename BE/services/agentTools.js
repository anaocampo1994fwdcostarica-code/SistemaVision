/**
 * agentTools.js
 * ------------------------------------------------------------------
 * Herramientas (Function Calling) que el agente de visión puede usar,
 * adaptadas al comprobante electrónico v4.4 de Hacienda (Costa Rica).
 *
 * - DEFINICIONES: el "contrato" en formato OpenAI (type: 'function').
 *   Es lo que ve el modelo para DECIDIR si llama una herramienta.
 * - IMPLEMENTACIONES: el código que ejecuta el backend cuando el modelo
 *   pide una herramienta. El resultado vuelve al modelo como mensaje role "tool".
 *
 * Regla de oro: ejecutarTool() NUNCA lanza excepciones. Si algo falla
 * (MySQL apagado, timeout del servicio externo, argumentos inválidos...)
 * devuelve { ok: false, error } para que el modelo pueda reaccionar.
 * ------------------------------------------------------------------
 */
const { Op } = require('sequelize');
const {
  FACTURA_JSON_SCHEMA,
  CAMPOS_TOTALES,
  parsearImporte,
  limpiarCodigo,
  aplicarCorrecciones,
  reconciliarConClaveOcr,
  reconciliarZonasOcr,
  validarFactura,
} = require('./esquemaFactura');

// Los modelos se cargan de forma diferida para no abrir conexiones al importar
// el módulo (y para poder sustituirlos por dobles en las pruebas).
let db = null;
function modelos() {
  if (!db) db = require('../models');
  return db;
}

// Herramientas "de control": no tocan datos, cambian el flujo del agente.
// Las ejecuta directamente visionService, no este módulo.
const TOOLS_CONTROL = ['solicitar_mayor_detalle', 'ampliar_zona', 'leer_digitos_ocr', 'solicitar_nueva_imagen'];

// ------------------------------------------------------------------
// Definiciones en formato OpenAI
// ------------------------------------------------------------------
const DEFINICIONES = [
  {
    type: 'function',
    function: {
      name: 'buscar_factura',
      description:
        'Busca comprobantes ya guardados por clave, número consecutivo, identificación (cédula) o nombre del emisor. ' +
        'Devuelve las coincidencias y, por moneda, la suma de total_comprobante y total_impuesto. ' +
        'Usa solo_sesion_actual=true para "las facturas que te pasé" en esta conversación.',
      parameters: {
        type: 'object',
        properties: {
          clave: { type: 'string', description: 'Clave de 50 dígitos (exacta)' },
          numero_consecutivo: { type: 'string', description: 'Consecutivo de 20 dígitos (coincidencia parcial)' },
          identificacion_emisor: { type: 'string', description: 'Cédula / identificación del emisor (exacta)' },
          nombre_emisor: { type: 'string', description: 'Nombre del emisor (coincidencia parcial)' },
          solo_sesion_actual: { type: 'boolean', description: 'Limitar a comprobantes guardados en esta sesión' },
          limite: { type: 'integer', description: 'Máximo de coincidencias a devolver (1-100, por defecto 20)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'consultar_proveedor',
      description:
        'Consulta un emisor por su identificación (cédula física/jurídica, DIMEX, NITE): primero en la base de datos ' +
        'local y, si está configurado, en el servicio externo (p. ej. Hacienda /fe/ae). Útil para validar la cédula, ' +
        'el nombre y la actividad económica.',
      parameters: {
        type: 'object',
        properties: {
          identificacion: { type: 'string', description: 'Identificación sin guiones' },
          nombre: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'guardar_factura',
      description:
        'Guarda el comprobante completo (emisor + encabezado + receptor + líneas + resumen) en una transacción. ' +
        'Rechaza duplicados por clave, o por consecutivo + emisor. Completa los datos que le falten al proveedor. ' +
        'Llámala solo cuando los datos sean fiables y las cuentas cuadren.',
      parameters: {
        ...FACTURA_JSON_SCHEMA,
        properties: {
          ...FACTURA_JSON_SCHEMA.properties,
          confianza: { type: ['number', 'null'], description: 'Confianza de 0 a 1 en los datos extraídos' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'solicitar_mayor_detalle',
      description:
        'Pide que se reenvíe LA MISMA imagen en alta resolución (detail "high"). ' +
        'Úsala si el texto es pequeño o borroso, o si dudas de la clave, el consecutivo, los CABYS o los importes.',
      parameters: {
        type: 'object',
        properties: {
          motivo: { type: 'string', description: 'Qué necesitas ver mejor' },
        },
        required: ['motivo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ampliar_zona',
      description:
        'Recorta una región de la imagen ORIGINAL y te la envía ampliada en alta resolución en el siguiente paso. ' +
        'Úsala para leer dígitos y textos pequeños: clave, consecutivo, identificaciones, códigos de actividad, CABYS y correos. ' +
        'Prefiere zona "personalizada" con un recuadro ajustado al dato cuando sepas dónde está; las demás zonas son atajos aproximados. ' +
        'Máximo 4 ampliaciones por análisis.',
      parameters: {
        type: 'object',
        properties: {
          zona: {
            type: 'string',
            enum: ['encabezado', 'clave', 'emisor', 'receptor', 'detalle', 'resumen', 'personalizada'],
          },
          motivo: { type: 'string', description: 'Qué dato necesitas leer' },
          recuadro: {
            type: 'object',
            description: 'Solo para zona "personalizada": porcentajes (0-100) respecto a la imagen completa',
            properties: {
              x: { type: 'number', description: 'Borde izquierdo, % del ancho' },
              y: { type: 'number', description: 'Borde superior, % del alto' },
              ancho: { type: 'number', description: '% del ancho' },
              alto: { type: 'number', description: '% del alto' },
            },
            required: ['x', 'y', 'ancho', 'alto'],
          },
        },
        required: ['zona', 'motivo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'leer_digitos_ocr',
      description:
        'Lee una zona de la imagen ORIGINAL con OCR (Tesseract), que no se salta dígitos repetidos como "999999" o "0000000457". ' +
        'Devuelve el texto crudo y, por línea, los grupos de dígitos con su longitud. Para campo "clave" devuelve como ' +
        'candidato una secuencia de exactamente 50 dígitos que empiece por 506; para "consecutivo", una de 20 dígitos. ' +
        'OBLIGATORIA para la clave y el consecutivo antes de la respuesta final.',
      parameters: {
        type: 'object',
        properties: {
          zona: {
            type: 'string',
            enum: ['encabezado', 'clave', 'emisor', 'receptor', 'detalle', 'resumen', 'personalizada'],
          },
          campo: {
            type: 'string',
            enum: ['clave', 'consecutivo', 'identificacion', 'actividad', 'cabys', 'otro'],
          },
          recuadro: {
            type: 'object',
            description: 'Solo para zona "personalizada": porcentajes (0-100) respecto a la imagen completa',
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
              ancho: { type: 'number' },
              alto: { type: 'number' },
            },
            required: ['x', 'y', 'ancho', 'alto'],
          },
        },
        required: ['zona', 'campo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'solicitar_nueva_imagen',
      description:
        'Termina el análisis pidiendo al usuario otra foto, porque la actual no sirve ' +
        '(cortada, muy borrosa, reflejos, no es un comprobante...). Incluye recomendaciones concretas.',
      parameters: {
        type: 'object',
        properties: {
          motivo: { type: 'string' },
          recomendaciones: { type: 'array', items: { type: 'string' } },
        },
        required: ['motivo', 'recomendaciones'],
      },
    },
  },
];

/**
 * Devuelve las definiciones que se envían a OpenAI.
 * Sin imagen (chat de seguimiento) no tiene sentido ofrecer las tools de control.
 */
function definicionesTools({ conImagen = true } = {}) {
  return DEFINICIONES.filter((d) => conImagen || !TOOLS_CONTROL.includes(d.function.name));
}

// ------------------------------------------------------------------
// Utilidades
// ------------------------------------------------------------------

/**
 * Convierte la fecha de emisión en Date. Acepta ISO 8601 (con o sin hora)
 * y DD/MM/AAAA [HH:mm[:ss]]. Sin zona horaria se asume Costa Rica (-06:00).
 */
function normalizarFechaHora(valor) {
  if (!valor) return null;
  const s = String(valor).trim();
  let iso = s;
  const dmy = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (dmy) {
    const [, d, m, a, hh = '00', mi = '00', ss = '00'] = dmy;
    const anio = a.length === 2 ? `20${a}` : a;
    iso = `${anio}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T${hh.padStart(2, '0')}:${mi}:${ss}-06:00`;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    iso = `${s}T00:00:00-06:00`;
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) {
    iso = `${s}-06:00`;
  }
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t);
}

/** Recorta textos al tamaño de la columna (MySQL en modo estricto rechaza los largos). */
function texto(valor, max) {
  if (valor === null || valor === undefined || valor === '') return null;
  const s = typeof valor === 'string' ? valor : typeof valor === 'object' ? JSON.stringify(valor) : String(valor);
  return s.trim().slice(0, max) || null;
}

const redondear = (n) => Math.round(n * 100000) / 100000;
const vacio = (v) => v === null || v === undefined || v === '';

/** Traduce errores de Sequelize/MySQL a un mensaje entendible por el modelo. */
function describirError(error) {
  const codigo = error?.parent?.code || error?.original?.code || error?.code;
  if (
    /Connection(Refused|Error|Timedout)|HostNotFound|AccessDenied/.test(error?.name || '') ||
    ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'PROTOCOL_CONNECTION_LOST', 'ER_ACCESS_DENIED_ERROR'].includes(codigo)
  ) {
    return `Base de datos no disponible (${codigo || error.name}). No se pudo completar la operación.`;
  }
  if (error?.name === 'SequelizeUniqueConstraintError') {
    return 'Ya existe un registro con esa clave o consecutivo (restricción única de la base de datos).';
  }
  return error?.message || String(error);
}

const plano = (registro) => (registro && typeof registro.toJSON === 'function' ? registro.toJSON() : registro);

// Códigos de tipo de identificación que usa Hacienda
const TIPO_ID_HACIENDA = { '01': 'Física', '02': 'Jurídica', '03': 'DIMEX', '04': 'NITE' };

/** Extrae lo útil de la respuesta del servicio externo (formato de Hacienda /fe/ae, tolerante a otros). */
function mapearDatosExternos(datos) {
  if (!datos || typeof datos !== 'object') return {};
  const actividades = Array.isArray(datos.actividades) ? datos.actividades : [];
  const activa = actividades.find((a) => a?.estado === 'A') || actividades[0];
  return {
    nombre: datos.nombre || datos.razon_social || null,
    tipo_identificacion: TIPO_ID_HACIENDA[datos.tipoIdentificacion] || datos.tipo_identificacion || null,
    codigo_actividad: activa?.codigo ? String(activa.codigo) : datos.codigo_actividad || null,
    actividad: activa?.descripcion || null,
    regimen: datos.regimen?.descripcion || null,
    situacion: datos.situacion || null,
  };
}

// ------------------------------------------------------------------
// Implementaciones
// ------------------------------------------------------------------

/** buscar_factura: coincidencias + totales (comprobante e impuesto) por moneda. */
async function buscarFactura(args, ctx) {
  const { Factura, Proveedor } = modelos();

  // Alias del formato anterior
  const clave = limpiarCodigo(args.clave);
  const consecutivo = limpiarCodigo(args.numero_consecutivo ?? args.numero_factura);
  const identificacion = limpiarCodigo(args.identificacion_emisor ?? args.nif_rfc);

  const whereFactura = {};
  const whereProveedor = {};
  if (clave) whereFactura.clave = clave;
  if (consecutivo) whereFactura.numero_consecutivo = { [Op.like]: `%${consecutivo}%` };
  if (args.solo_sesion_actual && ctx.sessionId) whereFactura.session_id = ctx.sessionId;
  if (identificacion) whereProveedor.identificacion = identificacion;
  if (args.nombre_emisor) whereProveedor.nombre = { [Op.like]: `%${String(args.nombre_emisor).trim()}%` };

  const filtrarProveedor = Object.keys(whereProveedor).length > 0;
  const limite = Math.min(Math.max(Number.parseInt(args.limite, 10) || 20, 1), 100);

  // Se traen hasta 500 filas para sumar y se devuelven solo `limite` en detalle.
  const MAX_FILAS = 500;
  const filas = await Factura.findAll({
    where: whereFactura,
    attributes: { exclude: ['datos_crudos'] },
    include: [
      {
        model: Proveedor,
        as: 'proveedor',
        attributes: ['id', 'nombre', 'identificacion'],
        ...(filtrarProveedor ? { where: whereProveedor, required: true } : {}),
      },
    ],
    order: [['id', 'DESC']],
    limit: MAX_FILAS,
  });

  const facturas = filas.map(plano);
  const totalesPorMoneda = {};
  for (const f of facturas) {
    const moneda = f.moneda || 'SIN_MONEDA';
    const acc = (totalesPorMoneda[moneda] ||= { cantidad: 0, total_comprobante: 0, total_impuesto: 0 });
    acc.cantidad += 1;
    acc.total_comprobante = redondear(acc.total_comprobante + (parsearImporte(f.total_comprobante) || 0));
    acc.total_impuesto = redondear(acc.total_impuesto + (parsearImporte(f.total_impuesto) || 0));
  }

  return {
    ok: true,
    cantidad: facturas.length,
    truncado: facturas.length === MAX_FILAS,
    totales_por_moneda: totalesPorMoneda,
    coincidencias: facturas.slice(0, limite).map((f) => ({
      id: f.id,
      tipo_documento: f.tipo_documento,
      clave: f.clave,
      numero_consecutivo: f.numero_consecutivo,
      fecha_emision: f.fecha_emision,
      emisor: f.proveedor?.nombre ?? null,
      identificacion_emisor: f.proveedor?.identificacion ?? null,
      receptor: f.receptor_nombre,
      origen: f.origen ?? null,
      moneda: f.moneda,
      total_impuesto: parsearImporte(f.total_impuesto),
      total_comprobante: parsearImporte(f.total_comprobante),
    })),
  };
}

/**
 * GET al servicio externo de proveedores con timeout. Nunca lanza.
 * Ejemplo: PROVEEDORES_API_URL=https://api.hacienda.go.cr/fe/ae → GET ...?identificacion=XXX
 */
async function consultarServicioExterno({ identificacion, nombre }) {
  const base = process.env.PROVEEDORES_API_URL;
  if (!base) return { consultado: false, motivo: 'PROVEEDORES_API_URL no está configurada' };
  if (!identificacion) return { consultado: false, motivo: 'El servicio externo requiere la identificación' };

  const timeoutMs = Number.parseInt(process.env.PROVEEDORES_API_TIMEOUT_MS, 10) || 5000;
  try {
    const url = new URL(base);
    url.searchParams.set('identificacion', identificacion);
    if (nombre && !/hacienda\.go\.cr/.test(url.hostname)) url.searchParams.set('nombre', nombre);

    const headers = { Accept: 'application/json' };
    if (process.env.PROVEEDORES_API_KEY) headers.Authorization = `Bearer ${process.env.PROVEEDORES_API_KEY}`;

    const resp = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) });
    if (resp.status === 404) return { consultado: true, encontrado: false };
    if (!resp.ok) return { consultado: true, encontrado: false, error: `El servicio respondió ${resp.status}` };

    const datos = await resp.json().catch(() => null);
    return { consultado: true, encontrado: !!datos, datos, resumen: mapearDatosExternos(datos) };
  } catch (error) {
    const esTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return {
      consultado: true,
      encontrado: false,
      error: esTimeout ? `Timeout tras ${timeoutMs} ms` : error.message,
    };
  }
}

/** consultar_proveedor: primero MySQL; luego (opcional) el servicio externo. */
async function consultarProveedor(args) {
  const identificacion = limpiarCodigo(args.identificacion ?? args.nif_rfc);
  const nombre = args.nombre ? String(args.nombre).trim() : null;
  if (!identificacion && !nombre) return { ok: false, error: 'Indica la identificación o el nombre del proveedor.' };

  let registro = null;
  let errorBd = null;
  try {
    const { Proveedor } = modelos();
    const where = identificacion ? { identificacion } : { nombre: { [Op.like]: `%${nombre}%` } };
    registro = await Proveedor.findOne({ where });
  } catch (error) {
    errorBd = describirError(error);
  }

  const externo = await consultarServicioExterno({ identificacion, nombre });

  // Si el servicio externo lo confirma y existe en BD: verificado + completar datos faltantes.
  if (registro && externo.encontrado && externo.datos) {
    try {
      const cambios = { verificado: true, datos_externos: externo.datos };
      for (const campo of ['nombre', 'tipo_identificacion', 'codigo_actividad']) {
        if (vacio(registro[campo]) && externo.resumen?.[campo]) cambios[campo] = externo.resumen[campo];
      }
      await registro.update(cambios);
    } catch {
      /* no es crítico: la consulta sigue siendo válida */
    }
  }

  if (errorBd && !externo.encontrado) {
    return { ok: false, error: errorBd, servicio_externo: externo };
  }

  const p = plano(registro);
  return {
    ok: true,
    encontrado_en_bd: !!p,
    proveedor: p
      ? {
          id: p.id,
          nombre: p.nombre,
          nombre_comercial: p.nombre_comercial,
          tipo_identificacion: p.tipo_identificacion,
          identificacion: p.identificacion,
          codigo_actividad: p.codigo_actividad,
          verificado: !!p.verificado,
        }
      : null,
    error_bd: errorBd,
    servicio_externo: externo.datos ? { ...externo, datos: undefined } : externo,
  };
}

/** Datos del proveedor a partir del emisor del comprobante. */
function datosProveedorDesde(f) {
  const e = f.emisor || {};
  return {
    nombre: texto(e.nombre || e.nombre_comercial || e.identificacion, 255),
    nombre_comercial: texto(e.nombre_comercial, 255),
    tipo_identificacion: texto(e.tipo_identificacion, 40),
    identificacion: texto(e.identificacion, 20),
    codigo_actividad: texto(e.codigo_actividad || f.codigo_actividad_emisor, 10),
    ubicacion: e.ubicacion || null,
    direccion: texto(e.ubicacion?.otras_senas || e.direccion, 500),
    telefono: texto(e.telefono, 30),
    correo: texto(e.correo, 160),
  };
}

/** Tarifa del IVA (código 01) de una línea. */
function tarifaIva(linea) {
  const iva = linea.impuestos.find((i) => i.codigo == null || String(i.codigo) === '01') || linea.impuestos[0];
  return iva?.tarifa ?? null;
}

/**
 * guardar_factura: proveedor (findOrCreate + completar faltantes) + comprobante + líneas,
 * todo en una transacción. Rechaza duplicados por clave o por consecutivo + emisor.
 */
async function guardarFactura(args, ctx) {
  const { confianza, ...datos } = args || {};
  // Normaliza y aplica correcciones deterministas (p. ej. fecha con día/mes invertidos según la clave)
  const corregida = aplicarCorrecciones(datos);
  if (!corregida.factura) return { ok: false, error: 'No se recibieron datos del comprobante.' };
  // Si el OCR leyó el comprobante en este análisis, se reconcilia antes de guardar:
  // actividad/cédula de las zonas emisor y receptor, y clave, consecutivo y fecha de la clave.
  const porZonas = reconciliarZonasOcr(corregida.factura, ctx.zonasOcr || {}, ctx.clavesOcr || []);
  const reconciliada = reconciliarConClaveOcr(porZonas.factura, ctx.clavesOcr || []);
  const f = reconciliada.factura;
  const notas = [...corregida.notas, ...porZonas.notas, ...reconciliada.notas];
  if (!f.clave && !f.numero_consecutivo) {
    return { ok: false, error: 'Se necesita la clave o el numero_consecutivo para guardar.' };
  }
  if (!f.emisor?.identificacion && !f.emisor?.nombre) {
    return { ok: false, error: 'Se necesita al menos la identificación o el nombre del emisor.' };
  }

  const { advertencias } = validarFactura(f);
  const r = f.resumen || {};
  const rec = f.receptor || {};
  const datosProveedor = datosProveedorDesde(f);
  const { sequelize, Proveedor, Factura, FacturaItem } = modelos();

  return sequelize.transaction(async (transaction) => {
    // 1) Duplicado por clave (identifica el comprobante de forma única en todo el país)
    if (f.clave) {
      const existente = await Factura.findOne({ where: { clave: f.clave }, transaction });
      if (existente) {
        return {
          ok: false,
          duplicada: true,
          motivo_duplicado: 'clave',
          factura_id_existente: existente.id,
          error: `El comprobante con clave ${f.clave} ya estaba guardado (id ${existente.id}).`,
        };
      }
    }

    // 2) Proveedor: buscar o crear, y completar los datos que le falten
    const [proveedor, proveedorCreado] = await Proveedor.findOrCreate({
      where: datosProveedor.identificacion
        ? { identificacion: datosProveedor.identificacion }
        : { nombre: datosProveedor.nombre },
      defaults: datosProveedor,
      transaction,
    });
    let camposCompletados = [];
    if (!proveedorCreado) {
      const cambios = {};
      for (const [campo, valor] of Object.entries(datosProveedor)) {
        if (!vacio(valor) && vacio(proveedor[campo])) cambios[campo] = valor;
      }
      camposCompletados = Object.keys(cambios);
      if (camposCompletados.length) await proveedor.update(cambios, { transaction });
    }

    // 3) Duplicado por consecutivo + emisor
    if (f.numero_consecutivo) {
      const existente = await Factura.findOne({
        where: { numero_consecutivo: f.numero_consecutivo, proveedor_id: proveedor.id },
        transaction,
      });
      if (existente) {
        return {
          ok: false,
          duplicada: true,
          motivo_duplicado: 'consecutivo_emisor',
          factura_id_existente: existente.id,
          error: `El consecutivo ${f.numero_consecutivo} del emisor "${proveedor.nombre}" ya estaba guardado (id ${existente.id}).`,
        };
      }
    }

    // 4) Comprobante
    const factura = await Factura.create(
      {
        proveedor_id: proveedor.id,
        tipo_documento: texto(f.tipo_documento, 60),
        version: texto(f.version, 10),
        clave: texto(f.clave, 50),
        numero_consecutivo: texto(f.numero_consecutivo, 20),
        fecha_emision: normalizarFechaHora(f.fecha_emision),
        codigo_actividad_emisor: texto(f.codigo_actividad_emisor || f.emisor?.codigo_actividad, 10),
        proveedor_sistemas: texto(f.proveedor_sistemas, 40),
        condicion_venta: texto(f.condicion_venta, 60),
        plazo_credito_dias: f.plazo_credito_dias ?? null,

        receptor_nombre: texto(rec.nombre, 255),
        receptor_nombre_comercial: texto(rec.nombre_comercial, 255),
        receptor_tipo_identificacion: texto(rec.tipo_identificacion, 40),
        receptor_identificacion: texto(rec.identificacion, 20),
        receptor_codigo_actividad: texto(rec.codigo_actividad, 10),
        receptor_ubicacion: rec.ubicacion || null,
        receptor_telefono: texto(rec.telefono, 30),
        receptor_correo: texto(rec.correo, 160),

        moneda: texto(r.moneda, 10),
        tipo_cambio: r.tipo_cambio ?? null,
        ...Object.fromEntries(CAMPOS_TOTALES.map((c) => [c, r[c] ?? null])),
        medios_pago: r.medios_pago,
        desglose_impuesto: r.desglose_impuesto,
        resumen: r,

        otros_cargos: f.otros_cargos,
        informacion_referencia: f.informacion_referencia,
        leyendas: f.leyendas,
        estado_hacienda: texto(f.estado_hacienda, 40),
        advertencias,

        origen: ctx.origen === 'generada' ? 'generada' : 'analizada',
        confianza: typeof confianza === 'number' ? confianza : null,
        session_id: ctx.sessionId || null,
        datos_crudos: datos,
      },
      { transaction }
    );

    // 5) Líneas de detalle
    if (f.detalle.length) {
      await FacturaItem.bulkCreate(
        f.detalle.map((l) => {
          const montosDescuento = l.descuentos.map((d) => d.monto).filter((m) => typeof m === 'number');
          return {
            factura_id: factura.id,
            numero_linea: l.numero_linea,
            codigo_cabys: texto(l.codigo_cabys, 13),
            codigo_comercial: texto(l.codigo_comercial, 100),
            cantidad: l.cantidad ?? null,
            unidad_medida: texto(l.unidad_medida, 20),
            detalle: texto(l.detalle, 1000),
            precio_unitario: l.precio_unitario ?? null,
            monto_total: l.monto_total ?? null,
            descuentos: l.descuentos,
            monto_descuento: montosDescuento.length ? redondear(montosDescuento.reduce((a, b) => a + b, 0)) : null,
            subtotal: l.subtotal ?? null,
            base_imponible: l.base_imponible ?? null,
            impuestos: l.impuestos,
            tarifa_iva: tarifaIva(l),
            impuesto_neto: l.impuesto_neto ?? null,
            monto_total_linea: l.monto_total_linea ?? null,
          };
        }),
        { transaction }
      );
    }

    return {
      ok: true,
      factura_id: factura.id,
      proveedor_id: proveedor.id,
      proveedor_creado: proveedorCreado,
      proveedor_campos_completados: camposCompletados,
      lineas_guardadas: f.detalle.length,
      total_comprobante: r.total_comprobante ?? null,
      advertencias,
      notas,
      mensaje: `Comprobante ${f.numero_consecutivo || f.clave} guardado con id ${factura.id}.`,
    };
  });
}

const IMPLEMENTACIONES = {
  buscar_factura: buscarFactura,
  consultar_proveedor: consultarProveedor,
  guardar_factura: guardarFactura,
};

/**
 * Ejecuta una herramienta de datos. Nunca lanza: los errores se devuelven
 * como resultado para que el modelo decida qué hacer.
 * @param {string} nombre
 * @param {object} args - argumentos ya parseados (JSON) que mandó el modelo
 * @param {{ sessionId?: string }} ctx - contexto que pone el backend, no el modelo
 */
async function ejecutarTool(nombre, args, ctx = {}) {
  const impl = IMPLEMENTACIONES[nombre];
  if (!impl) return { ok: false, error: `Herramienta desconocida: ${nombre}` };
  try {
    return await impl(args || {}, ctx);
  } catch (error) {
    return { ok: false, error: describirError(error) };
  }
}

module.exports = {
  TOOLS_CONTROL,
  definicionesTools,
  ejecutarTool,
  // Exportadas para pruebas y reutilización
  parsearImporte,
  normalizarFechaHora,
  mapearDatosExternos,
};
