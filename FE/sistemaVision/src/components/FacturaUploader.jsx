import { useState, useRef, useEffect } from 'react';
import FacturaElectronicaView from './FacturaElectronicaView';
import './FacturaUploader.css';

const API_URL = 'http://localhost:3001';
const CLAVE_SESION = 'sistemaVision.sessionId';

// localStorage puede fallar (modo privado, almacenamiento bloqueado): siempre con try/catch
const leerSesion = () => {
  try {
    return localStorage.getItem(CLAVE_SESION);
  } catch {
    return null;
  }
};
const escribirSesion = (id) => {
  try {
    if (id) localStorage.setItem(CLAVE_SESION, id);
    else localStorage.removeItem(CLAVE_SESION);
  } catch {
    /* sin persistencia: la sesión vive solo en memoria */
  }
};

const ETIQUETAS_ESTADO = {
  completado: 'Completado',
  requiere_nueva_imagen: 'Requiere nueva imagen',
  incompleto: 'Incompleto',
};

/** Texto corto para cada paso de la traza del agente. */
function describirPaso(p) {
  switch (p.tipo) {
    case 'decision':
      return p.decision === 'usar_herramientas'
        ? `Decide usar: ${p.herramientas.join(', ')} (detail ${p.detail ?? '—'})`
        : `Decide responder (detail ${p.detail ?? '—'})`;
    case 'herramienta':
      return `Ejecuta ${p.herramienta}`;
    case 'mayor_detalle':
      return `El modelo pidió más detalle → imagen en "high". Motivo: ${p.motivo}`;
    case 'reintento_automatico':
      return `Regla automática → reintento en "high". Motivo: ${p.motivo}`;
    case 'respuesta_modelo':
      return `Respuesta del modelo: ${p.estado}, confianza ${p.confianza ?? '—'}, calidad ${p.calidad_imagen ?? '—'}` +
        (p.advertencias?.length ? `, ${p.advertencias.length} inconsistencia(s)` : '');
    case 'ampliacion':
      return p.ok
        ? `🔍 Ampliación de la zona "${p.zona}"${p.origen === 'verificacion' ? ' (automática en la verificación)' : ''}: ${p.motivo || 'sin motivo'}` +
            (p.tamano ? ` → ${p.tamano.ancho}×${p.tamano.alto} px` : '')
        : `🔍 Ampliación de "${p.zona ?? '—'}" no realizada: ${p.error}`;
    case 'verificacion':
      return `Verificación final: releer ${p.advertencias?.length ?? 0} campo(s) con inconsistencias` +
        (p.ampliaciones?.length ? ` (con ampliaciones: ${p.ampliaciones.join(', ')})` : '');
    case 'ocr': {
      const origen = p.origen === 'automatico' ? ' [automático]' : '';
      if (!p.ok) {
        return `🔢 OCR${origen}${p.zona ? ` de "${p.zona}"` : ''}${p.campo ? ` (campo ${p.campo})` : ''} no realizado: ${p.error}`;
      }
      const encontrado = p.encontrado
        ? ` · actividad ${p.encontrado.actividad ?? 'no encontrada'}, cédula ${p.encontrado.identificacion ?? 'no encontrada'}`
        : '';
      return `🔢 OCR${origen} de la zona "${p.zona}" (campo ${p.campo}): ` +
        (p.candidato ? `candidato ${p.candidato} (${p.candidato.length} dígitos)` : `sin candidato (${p.lineas} línea(s) leídas)`) +
        encontrado;
    }
    case 'reconciliacion':
      return `🔁 Reconciliación con el OCR: ${p.notas.join(' ')}`;
    case 'limite_pasos':
      return `Se alcanzó el máximo de ${p.maxPasos} pasos`;
    default:
      return p.tipo;
  }
}

export default function FacturaUploader() {
  const [archivo, setArchivo] = useState(null);
  const [preview, setPreview] = useState(null);
  const [instruccion, setInstruccion] = useState('');
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState(null);
  const [resultado, setResultado] = useState(null);
  const [arrastrando, setArrastrando] = useState(false);
  const [sessionId, setSessionId] = useState(leerSesion);
  const [chat, setChat] = useState([]);
  const [mensajeChat, setMensajeChat] = useState('');
  const [enviandoChat, setEnviandoChat] = useState(false);
  const fileInputRef = useRef(null);
  const chatFinRef = useRef(null);

  useEffect(() => {
    chatFinRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [chat]);

  // Guarda el sessionId que devuelve el backend (lo genera si no existía)
  const recordarSesion = (id) => {
    if (id && id !== sessionId) {
      setSessionId(id);
      escribirSesion(id);
    }
  };

  const manejarArchivo = (file) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('Por favor selecciona un archivo de imagen válido (JPG, PNG, WebP).');
      return;
    }
    setError(null);
    setResultado(null);
    setArchivo(file);

    const reader = new FileReader();
    reader.onloadend = () => {
      setPreview(reader.result);
    };
    reader.readAsDataURL(file);
  };

  const onFileChange = (e) => {
    if (e.target.files && e.target.files[0]) {
      manejarArchivo(e.target.files[0]);
    }
  };

  const onDragOver = (e) => {
    e.preventDefault();
    setArrastrando(true);
  };

  const onDragLeave = () => {
    setArrastrando(false);
  };

  const onDrop = (e) => {
    e.preventDefault();
    setArrastrando(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      manejarArchivo(e.dataTransfer.files[0]);
    }
  };

  const enviarFactura = async () => {
    if (!archivo) {
      setError('Por favor selecciona una imagen de factura antes de procesar.');
      return;
    }

    setCargando(true);
    setError(null);

    const formData = new FormData();
    formData.append('factura', archivo);
    if (instruccion.trim()) formData.append('instruccion', instruccion.trim());
    if (sessionId) formData.append('sessionId', sessionId);

    try {
      const response = await fetch(`${API_URL}/api/facturas/analizar`, {
        method: 'POST',
        body: formData,
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || `Error del servidor (${response.status})`);
      }

      setResultado(data.data);
      recordarSesion(data.data.sessionId);
      if (data.data.respuesta) {
        setChat((c) => [...c, { rol: 'assistant', texto: data.data.respuesta }]);
      }
    } catch (err) {
      console.error(err);
      setError(err.message || 'Error al comunicarse con el servidor.');
    } finally {
      setCargando(false);
    }
  };

  const enviarMensaje = async (e) => {
    e.preventDefault();
    const texto = mensajeChat.trim();
    if (!texto || enviandoChat) return;

    setChat((c) => [...c, { rol: 'user', texto }]);
    setMensajeChat('');
    setEnviandoChat(true);
    try {
      const response = await fetch(`${API_URL}/api/agente/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, mensaje: texto }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || `Error del servidor (${response.status})`);
      }
      recordarSesion(data.data.sessionId);
      setChat((c) => [...c, { rol: 'assistant', texto: data.data.respuesta || '(sin respuesta)', pasos: data.data.pasos }]);
    } catch (err) {
      setChat((c) => [...c, { rol: 'error', texto: err.message || 'Error al comunicarse con el agente.' }]);
    } finally {
      setEnviandoChat(false);
    }
  };

  const reiniciarMemoria = async () => {
    if (sessionId) {
      try {
        await fetch(`${API_URL}/api/agente/sesiones/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
      } catch (err) {
        console.warn('No se pudo borrar la memoria en el servidor:', err);
      }
    }
    setSessionId(null);
    escribirSesion(null);
    setChat([]);
    setResultado(null);
  };

  const limpiar = () => {
    setArchivo(null);
    setPreview(null);
    setResultado(null);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Los datos de la factura llegan en data.data.datosEstructurados
  const datos = resultado?.datosEstructurados || null;
  const confianzaPct = typeof resultado?.confianza === 'number' ? Math.round(resultado.confianza * 100) : null;

  return (
    <div className="factura-container">
      <header className="factura-header">
        <h2>🧾 Procesamiento Inteligente de Facturas</h2>
        <p>Carga la foto o escaneo de tu factura y deja que el agente de Visión IA la analice, valide y guarde</p>
      </header>

      {/* Sesión / memoria del agente */}
      <div className="sesion-bar">
        <span>
          🧠 Sesión: <code>{sessionId ? `${sessionId.slice(0, 8)}…` : 'nueva (se creará al enviar)'}</code>
        </span>
        <button type="button" className="btn-cancel" onClick={reiniciarMemoria} disabled={cargando || enviandoChat}>
          Reiniciar memoria
        </button>
      </div>

      {!resultado && (
        <section className="dashboard-preview" aria-label="Vista previa de revisión contable">
          <div className="preview-toolbar"><span className="preview-lot">▣  Lote: LOT-2026-CR-0941</span><div><button type="button" onClick={() => !cargando && fileInputRef.current?.click()}>⇧ Subir otra factura</button><button type="button">{ } Exportar JSON</button><button type="button">☷ Modificar valores</button><button type="button" className="preview-approve">◉ Aprobar y Conciliar ERP</button></div></div>
          <div className="preview-title"><h1>Resultado del Agente de<br/>Visión IA</h1><p>Comprobante analizado, estructurado y contrastado contra normativas<br/>tributarias vigentes.</p></div>
          <div className="preview-status"><div><span className="preview-chip success">● Completado</span><span className="preview-chip warning">ϟ Confianza OCR: 98%</span><span className="preview-chip">Resolución: Alta (2400 DPI)</span></div><strong>▦ TRAZABILIDAD DE<br/>EJECUCIÓN (5 PASOS)⌄</strong><p>▣ Factura analizada y guardada exitosamente. Los datos tributarios han sido normalizados y actualizados en el libro mayor.</p><div className="preview-alert"><b>⚠ Inconsistencias detectadas por el motor de verificación (3 advertencias)</b><span>Revisión requerida antes del cierre contable</span><ul><li>Clave numérica: se detectaron <em>49 caracteres</em> (se requiere regeneración o validación con la DGT).</li><li>Número consecutivo: se detectaron <em>19 caracteres</em> (código de sucursal truncado).</li><li>Línea 1 (TAL-650): Descuadre aritmético en redondeo.</li></ul></div></div>
          <div className="preview-grid"><div className="preview-invoice"><h2>Factura Electrónica <small>v4.4</small><span>● Hacienda: Aceptado Oficialmente</span></h2><label>CLAVE NUMÉRICA TRIBUTARIA (50 DÍGITOS)</label><code>5061211260031019999900100000101000000457112345678</code><div className="preview-fields"><b>CONSECUTIVO<br/><code>00100001010000000457</code></b><b>FECHA DE EMISIÓN<br/>11 dic. 2026, 10:45 a. m.</b><b>CONDICIÓN DE VENTA<br/>Contado (0 días)</b><b>MONEDA BASE<br/>CRC (₡ - Colón)</b></div><div className="preview-people"><article><label>EMISOR FISCAL</label><strong>Ferretería Los Robles S.A.</strong><p>Nombre Fantasía: Ferre Robles<br/>Cédula Jurídica: 3101999999<br/>Actividad Económica: 475991<br/>Teléfono Comercial: 22220000</p></article><article><label>RECEPTOR (COMPRADOR)</label><strong>Comercial Andromeda S.R.L.</strong><p>Empresa vinculada al ERP Acme<br/>Identificación Jurídica: 3102888888<br/>Actividad Económica: 410081<br/>Teléfono Contacto: 24440000</p></article></div></div><aside className="preview-total"><label>TOTAL DEL<br/>COMPROBANTE</label><strong>₡113 520,50</strong><small>CRC</small><hr/><p>Servicios Gravados <b>₡25 000,00</b></p><p>Mercancías Gravadas <b>₡82 550,00</b></p><p>Total Gravado <b>₡107 550,00</b></p><p className="red">Descuentos Concedidos <b>- ₡6 500,00</b></p><p>Venta Neta Imponible <b>₡101 050,00</b></p><p className="red">Total Impuestos (IVA) <b>+ ₡12 470,50</b></p></aside></div>
        </section>
      )}

      {/* Zona de Drop & Carga */}
      <div
        className={`dropzone ${arrastrando ? 'drag-active' : ''} ${preview ? 'has-preview' : ''}`}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={() => !cargando && fileInputRef.current?.click()}
      >
        <input
          type="file"
          ref={fileInputRef}
          onChange={onFileChange}
          accept="image/*"
          style={{ display: 'none' }}
        />

        {preview ? (
          <div className="preview-box">
            <img src={preview} alt="Vista previa de factura" className="preview-img" />
            <p className="preview-caption">Haz clic o arrastra para cambiar la imagen</p>
          </div>
        ) : (
          <div className="dropzone-placeholder">
            <div className="upload-icon">📁</div>
            <p><strong>Arrastra tu factura aquí</strong> o haz clic para buscar</p>
            <span>Soporta JPG, PNG, WEBP (hasta 15MB)</span>
          </div>
        )}
      </div>

      {archivo && (
        <div className="archivo-info">
          <span>📄 <strong>{archivo.name}</strong> ({(archivo.size / 1024).toFixed(1)} KB)</span>
          <button type="button" onClick={limpiar} disabled={cargando} className="btn-cancel">
            Quitar
          </button>
        </div>
      )}

      {/* Instrucción opcional para el agente */}
      <label className="instruccion-label" htmlFor="instruccion">
        Instrucción para el agente (opcional)
      </label>
      <input
        id="instruccion"
        type="text"
        className="instruccion-input"
        placeholder='Ej.: "Solo léela, no la guardes" o "Verifica el proveedor antes de guardar"'
        value={instruccion}
        onChange={(e) => setInstruccion(e.target.value)}
        disabled={cargando}
      />

      {/* Acciones */}
      <div className="acciones-bar">
        <button
          type="button"
          onClick={enviarFactura}
          disabled={!archivo || cargando}
          className="btn-procesar"
        >
          {cargando ? (
            <>
              <span className="spinner"></span> El agente está analizando...
            </>
          ) : (
            '🚀 Procesar Factura'
          )}
        </button>
      </div>

      {/* Mensajes de error */}
      {error && (
        <div className="alert alert-error">
          <strong>Error: </strong> {error}
        </div>
      )}

      {/* Resultado del agente */}
      {resultado && (
        <div className="resultado-section">
          <h3>🤖 Resultado del Agente</h3>

          <div className="agente-estado">
            <span className={`chip chip-${resultado.estado}`}>
              {ETIQUETAS_ESTADO[resultado.estado] || resultado.estado}
            </span>
            <span className="chip">Confianza: {confianzaPct !== null ? `${confianzaPct}%` : '—'}</span>
            <span className="chip">Resolución usada: {resultado.detailFinal || '—'}</span>
            {resultado.calidad_imagen && <span className="chip">Calidad: {resultado.calidad_imagen}</span>}
            {resultado.reintentoAutomatico && <span className="chip chip-aviso">Reintento automático en high</span>}
            {resultado.facturaGuardadaId && (
              <span className="chip chip-completado">Guardada (id {resultado.facturaGuardadaId})</span>
            )}
          </div>

          {resultado.respuesta && <p className="agente-respuesta">{resultado.respuesta}</p>}

          {resultado.estado === 'requiere_nueva_imagen' && (
            <div className="alert alert-aviso">
              <strong>Hace falta otra foto:</strong> {resultado.motivo}
              {resultado.recomendaciones?.length > 0 && (
                <ul>
                  {resultado.recomendaciones.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Con datos, los avisos se muestran dentro de FacturaElectronicaView */}
          {!datos && resultado.campos_ilegibles?.length > 0 && (
            <p className="campos-ilegibles">⚠️ Campos ilegibles: {resultado.campos_ilegibles.join(', ')}</p>
          )}
          {resultado.advertencias?.length > 0 && (
            <span className="chip chip-aviso">{resultado.advertencias.length} advertencia(s) de validación</span>
          )}
          {resultado.claveOcr && (
            <span className="chip chip-completado">Clave verificada por OCR</span>
          )}
          {resultado.notas?.length > 0 && (
            <span className="chip">{resultado.notas.length} corrección(es) automática(s)</span>
          )}

          <details className="pasos-agente">
            <summary>Pasos del agente ({resultado.pasos?.length || 0})</summary>
            <ol>
              {resultado.pasos?.map((p, i) => (
                <li key={i}>
                  <span className="paso-num">Paso {p.paso}</span> {describirPaso(p)}
                  {p.tipo === 'herramienta' && (
                    <pre className="paso-detalle">
                      {JSON.stringify({ argumentos: p.argumentos, resultado: p.resultado }, null, 2)}
                    </pre>
                  )}
                </li>
              ))}
            </ol>
          </details>
        </div>
      )}

      {/* Comprobante electrónico v4.4 completo */}
      {datos && (
        <div className="resultado-section">
          <h3>📋 Comprobante Electrónico</h3>
          <FacturaElectronicaView
            datos={datos}
            advertencias={resultado.advertencias || []}
            notas={resultado.notas || []}
            camposIlegibles={resultado.campos_ilegibles || []}
          />
        </div>
      )}

      {/* Chat de seguimiento con memoria */}
      <div className="chat-section">
        <h3>💬 Pregunta al agente</h3>
        <p className="chat-ayuda">
          El agente recuerda esta sesión. Prueba: “¿Cuánto suman las facturas que te pasé?”
        </p>
        <div className="chat-mensajes">
          {chat.length === 0 && <p className="chat-vacio">Aún no hay mensajes.</p>}
          {chat.map((m, i) => (
            <div key={i} className={`chat-msg chat-${m.rol}`}>
              {m.texto}
            </div>
          ))}
          {enviandoChat && <div className="chat-msg chat-assistant chat-pensando">Pensando…</div>}
          <div ref={chatFinRef} />
        </div>
        <form className="chat-form" onSubmit={enviarMensaje}>
          <input
            type="text"
            className="instruccion-input"
            placeholder="Escribe tu pregunta…"
            value={mensajeChat}
            onChange={(e) => setMensajeChat(e.target.value)}
            disabled={enviandoChat}
          />
          <button type="submit" className="btn-procesar btn-chat" disabled={!mensajeChat.trim() || enviandoChat}>
            Enviar
          </button>
        </form>
      </div>
    </div>
  );
}
