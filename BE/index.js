const express = require('express');
const cors = require('cors');
const multer = require('multer');
require('dotenv').config();

const db = require('./models');
const { ejecutarAgente } = require('./services/visionService');
const { generarFactura } = require('./services/generadorFactura');
const memoria = require('./services/memoryService');
const { migrarEsquemaLegado } = require('./services/migracionLegado');
const { terminarOcr } = require('./services/ocrService');
const { OUTPUT_DIR } = require('./services/imagenFactura');

const app = express();
const PORT = process.env.PORT || 3001;

// Estado de la base de datos (se rellena al arrancar)
const estadoBD = { disponible: false, error: null };

// Configuración de middlewares
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use('/api/facturas/generadas', express.static(OUTPUT_DIR, { fallthrough: false }));

// Configurar multer en memoria para procesar la imagen sin guardarla en disco
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // Máximo 15MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten archivos de imagen (JPEG, PNG, WebP).'), false);
    }
  },
});

// Ruta de health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'SistemaVision BE',
    baseDeDatos: estadoBD.disponible ? 'conectada' : `no disponible${estadoBD.error ? `: ${estadoBD.error}` : ''}`,
    memoria: memoria.getModo(),
  });
});

/**
 * Analiza una factura con el AGENTE.
 * FormData:
 *  - factura      (archivo de imagen, obligatorio salvo que se envíe `imagen`/`url` en JSON)
 *  - instruccion  (opcional) p. ej. "no la guardes, solo léela"
 *  - sessionId    (opcional) si falta, el agente crea uno y lo devuelve
 * La respuesta trae los datos en data.datosEstructurados.
 */
app.post('/api/facturas/analizar', upload.single('factura'), async (req, res) => {
  try {
    let imagen = null;
    let mimeType = 'image/jpeg';

    if (req.file) {
      imagen = req.file.buffer;
      mimeType = req.file.mimetype;
    } else if (req.body?.imagen) {
      imagen = req.body.imagen;
    } else if (req.body?.url) {
      imagen = req.body.url;
    }

    if (!imagen) {
      return res.status(400).json({
        success: false,
        error: 'Debe adjuntar un archivo de imagen en el campo "factura" o enviar "imagen" en el body.',
      });
    }

    const resultado = await ejecutarAgente({
      imagen,
      mimeType,
      instruccion: req.body?.instruccion,
      sessionId: req.body?.sessionId || undefined,
      detail: req.body?.detail,
    });

    return res.json({ success: true, data: resultado });
  } catch (error) {
    console.error('Error al analizar factura:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Error interno al procesar la factura.',
    });
  }
});

/**
 * Chat de seguimiento sin imagen: { sessionId, mensaje }.
 * Ej.: "¿cuánto suman las facturas que te pasé?"
 */
app.post('/api/agente/chat', async (req, res) => {
  const { sessionId, mensaje } = req.body || {};
  if (!mensaje || !String(mensaje).trim()) {
    return res.status(400).json({ success: false, error: 'El campo "mensaje" es obligatorio.' });
  }
  try {
    const resultado = await ejecutarAgente({ instruccion: String(mensaje), sessionId: sessionId || undefined });
    return res.json({ success: true, data: resultado });
  } catch (error) {
    console.error('Error en el chat del agente:', error);
    return res.status(500).json({ success: false, error: error.message || 'Error interno del agente.' });
  }
});

/**
 * Funcionalidad inversa: texto en lenguaje natural → factura electrónica v4.4 de FWD.
 * Body: { texto, sessionId? }. Si faltan datos, responde estado "faltan_datos" con una
 * pregunta; el usuario contesta con el mismo sessionId y se completa el borrador.
 */
app.post('/api/facturas/generar', async (req, res) => {
  const { texto, sessionId } = req.body || {};
  if (!texto || !String(texto).trim()) {
    return res.status(400).json({ success: false, error: 'El campo "texto" es obligatorio.' });
  }
  try {
    const resultado = await generarFactura({ texto: String(texto), sessionId: sessionId || undefined });
    return res.json({ success: true, data: resultado });
  } catch (error) {
    console.error('Error al generar la factura:', error);
    return res.status(500).json({ success: false, error: error.message || 'Error interno al generar la factura.' });
  }
});

// Consulta la memoria de una sesión
app.get('/api/agente/sesiones/:id/memoria', async (req, res) => {
  try {
    const limite = Number.parseInt(req.query.limite, 10) || 100;
    const recuerdos = await memoria.cargar(req.params.id, limite);
    return res.json({ success: true, data: { sessionId: req.params.id, modo: memoria.getModo(), recuerdos } });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Borra la memoria de una sesión ("Reiniciar memoria")
app.delete('/api/agente/sesiones/:id', async (req, res) => {
  try {
    const eliminados = await memoria.borrar(req.params.id);
    return res.json({ success: true, data: { sessionId: req.params.id, eliminados } });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Lista las facturas guardadas (filtros opcionales: ?sessionId=...&limite=...)
app.get('/api/facturas', async (req, res) => {
  try {
    const limite = Math.min(Number.parseInt(req.query.limite, 10) || 50, 200);
    const where = req.query.sessionId ? { session_id: req.query.sessionId } : {};
    const facturas = await db.Factura.findAll({
      where,
      attributes: { exclude: ['datos_crudos'] },
      include: [
        { model: db.Proveedor, as: 'proveedor', attributes: ['id', 'nombre', 'nif_rfc', 'verificado'] },
        { model: db.FacturaItem, as: 'items' },
      ],
      order: [['id', 'DESC']],
      limit: limite,
    });
    return res.json({ success: true, data: facturas });
  } catch (error) {
    return res.status(503).json({ success: false, error: `No se pudieron obtener las facturas: ${error.message}` });
  }
});

// Manejo de errores de multer y generales
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ success: false, error: `Error en la subida: ${err.message}` });
  } else if (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
  next();
});

/**
 * Conecta y sincroniza MySQL. Si falla, el servidor arranca igual:
 * la memoria pasa a RAM y las tools devolverán el error al modelo.
 */
async function iniciarBaseDeDatos() {
  try {
    await db.sequelize.authenticate();
    // DB_SYNC_ALTER=true actualiza las tablas existentes al esquema v4.4.
    // Antes se renombran las columnas antiguas para no perder datos (ver migracionLegado.js).
    const alter = process.env.DB_SYNC_ALTER === 'true';
    if (alter) {
      const cambios = await migrarEsquemaLegado(db.sequelize);
      if (cambios.length) console.log(`Migración del esquema anterior: ${cambios.join('; ')}`);
    }
    await db.sequelize.sync({ alter });
    estadoBD.disponible = true;
    memoria.setModo('mysql');
    console.log(`MySQL conectado y modelos sincronizados${alter ? ' (alter)' : ''}.`);
  } catch (error) {
    estadoBD.error = error.message;
    memoria.setModo('ram');
    console.warn('⚠️  AVISO: no se pudo conectar/sincronizar MySQL. El servidor arranca igualmente.');
    console.warn(`   Motivo: ${error.message}`);
    console.warn('   La memoria del agente usará RAM (reintentará MySQL periódicamente) y las herramientas de BD devolverán error al modelo.');
    console.warn('   Revisa DB_USER, DB_PASSWORD, DB_NAME y DB_HOST en el .env.');
  }
}

if (require.main === module) {
  iniciarBaseDeDatos().finally(() => {
    const servidor = app.listen(PORT, () => {
      console.log(`Servidor backend corriendo en http://localhost:${PORT}`);
    });

    // Apagado ordenado: cerrar el worker de Tesseract (OCR) y la conexión a MySQL
    let apagando = false;
    const apagar = async (senal) => {
      if (apagando) return;
      apagando = true;
      console.log(`\n${senal} recibido: cerrando el servidor...`);
      servidor.close();
      await terminarOcr();
      await db.sequelize.close().catch(() => {});
      process.exit(0);
    };
    process.on('SIGINT', () => apagar('SIGINT'));
    process.on('SIGTERM', () => apagar('SIGTERM'));
  });
}

module.exports = app;
