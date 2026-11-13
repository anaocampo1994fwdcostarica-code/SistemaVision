import { useRef, useState } from 'react';
import { toBlob, toPng } from 'html-to-image';
import FacturaImprimible from './FacturaImprimible';
import { compararFacturas, dineroCR } from '../utils/facturaFormato';
import './GeneradorFactura.css';

const API_URL = 'http://localhost:3001';
const CLAVE_SESION = 'sistemaVision.sessionId';
const EJEMPLO =
  'Factúrale a Ana Mora, cédula 1-2345-6789, el bootcamp Full Stack módulo 1 por 350 mil con IVA 2% ' +
  'y un kit de bienvenida de 12 mil con IVA 13%, pagó por SINPE';

// Misma sesión que el resto de la consola: el agente recuerda las facturas generadas
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
  } catch {
    /* sin persistencia */
  }
};

// Opciones de html-to-image: el doble de resolución y fondo blanco
const OPCIONES_IMAGEN = { pixelRatio: 2, cacheBust: true, backgroundColor: '#ffffff' };

export default function GeneradorFactura() {
  const [texto, setTexto] = useState('');
  const [sessionId, setSessionId] = useState(leerSesion);
  const [conversacion, setConversacion] = useState([]); // [{ rol, texto }]
  const [pendiente, setPendiente] = useState(null); // { pregunta, faltantes } si faltan datos
  const [resultado, setResultado] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState(null);
  const [exportando, setExportando] = useState(null); // 'png' | 'agente'
  const [prueba, setPrueba] = useState(null); // { diferencias, leido }
  const facturaRef = useRef(null);

  const generar = async (e) => {
    e?.preventDefault();
    const pedido = texto.trim();
    if (!pedido || cargando) return;
    setCargando(true);
    setError(null);
    setPrueba(null);
    setConversacion((c) => [...c, { rol: 'user', texto: pedido }]);
    try {
      const response = await fetch(`${API_URL}/api/facturas/generar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texto: pedido, sessionId }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || `Error del servidor (${response.status})`);

      const r = data.data;
      if (r.sessionId && r.sessionId !== sessionId) {
        setSessionId(r.sessionId);
        escribirSesion(r.sessionId);
      }
      setTexto('');
      if (r.estado === 'faltan_datos') {
        setPendiente({ pregunta: r.pregunta, faltantes: r.faltantes });
        setResultado(null);
        setConversacion((c) => [...c, { rol: 'assistant', texto: r.pregunta }]);
      } else {
        setPendiente(null);
        setResultado(r);
        setConversacion((c) => [...c, { rol: 'assistant', texto: r.respuesta }]);
      }
    } catch (err) {
      setError(err.message || 'No se pudo generar la factura.');
    } finally {
      setCargando(false);
    }
  };

  const nuevaFactura = () => {
    setTexto('');
    setPendiente(null);
    setResultado(null);
    setConversacion([]);
    setPrueba(null);
    setError(null);
  };

  const nombreArchivo = () => `factura-fwd-${resultado?.datosEstructurados?.numero_consecutivo || 'prueba'}`;

  const descargarPdf = () => window.print();

  const descargarPng = async () => {
    if (!facturaRef.current) return;
    setExportando('png');
    setError(null);
    try {
      const dataUrl = await toPng(facturaRef.current, OPCIONES_IMAGEN);
      const enlace = document.createElement('a');
      enlace.href = dataUrl;
      enlace.download = `${nombreArchivo()}.png`;
      enlace.click();
    } catch (err) {
      setError(`No se pudo crear el PNG: ${err.message}`);
    } finally {
      setExportando(null);
    }
  };

  /** Convierte la factura a PNG, la pasa por el agente de visión y compara los datos. */
  const probarConAgente = async () => {
    if (!facturaRef.current || !resultado) return;
    setExportando('agente');
    setError(null);
    setPrueba(null);
    try {
      const blob = await toBlob(facturaRef.current, OPCIONES_IMAGEN);
      const formData = new FormData();
      formData.append('factura', new File([blob], `${nombreArchivo()}.png`, { type: 'image/png' }));
      formData.append('instruccion', 'Prueba de lectura de una factura generada: extrae los datos y NO la guardes.');
      // Sin sessionId: la prueba no se mezcla con la memoria de la conversación
      const response = await fetch(`${API_URL}/api/facturas/analizar`, { method: 'POST', body: formData });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || `Error del servidor (${response.status})`);
      const leido = data.data.datosEstructurados;
      setPrueba({ diferencias: compararFacturas(resultado.datosEstructurados, leido), leido, agente: data.data });
    } catch (err) {
      setError(`La prueba con el agente falló: ${err.message}`);
    } finally {
      setExportando(null);
    }
  };

  const total = resultado?.datosEstructurados?.resumen?.total_comprobante;

  return (
    <div className="gen-contenedor">
      <header className="gen-header no-print">
        <h2>Generar factura</h2>
        <p>
          Describí en tus palabras qué querés facturar. El agente extrae los datos, el sistema calcula los montos y arma
          una factura electrónica v4.4 con la marca FWD Costa Rica.
        </p>
      </header>

      {/* Conversación (pedido y preguntas del agente) */}
      {conversacion.length > 0 && (
        <div className="gen-conversacion no-print" aria-live="polite">
          {conversacion.map((m, i) => (
            <div key={i} className={`gen-msg gen-${m.rol}`}>
              {m.texto}
            </div>
          ))}
        </div>
      )}

      {pendiente && (
        <div className="gen-pendiente no-print">
          <strong>Faltan datos:</strong> {pendiente.faltantes.join(' · ')}
        </div>
      )}

      <form className="gen-form no-print" onSubmit={generar}>
        <label htmlFor="gen-texto" className="gen-label">
          {pendiente ? 'Tu respuesta' : '¿Qué querés facturar?'}
        </label>
        <textarea
          id="gen-texto"
          className="gen-textarea"
          rows={4}
          value={texto}
          placeholder={pendiente ? 'Ej.: Para Carlos Rojas, cédula 1-1111-1111, cuesta 450 mil' : `Ej.: ${EJEMPLO}`}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) generar(e);
          }}
          disabled={cargando}
        />
        <div className="gen-acciones">
          {!pendiente && !texto && (
            <button type="button" className="gen-btn-secundario" onClick={() => setTexto(EJEMPLO)} disabled={cargando}>
              Usar el ejemplo
            </button>
          )}
          {(resultado || pendiente) && (
            <button type="button" className="gen-btn-secundario" onClick={nuevaFactura} disabled={cargando}>
              Nueva factura
            </button>
          )}
          <button type="submit" className="gen-btn" disabled={!texto.trim() || cargando}>
            {cargando ? 'Generando…' : pendiente ? 'Responder' : 'Generar'}
          </button>
        </div>
      </form>

      {error && (
        <div className="alert alert-error no-print">
          <strong>Error: </strong>
          {error}
        </div>
      )}

      {resultado && (
        <>
          <div className="gen-resumen no-print">
            <span className="chip chip-completado">Generada · {dineroCR(total)}</span>
            {resultado.guardada ? (
              <span className="chip">Guardada en la BD (id {resultado.facturaGuardadaId})</span>
            ) : (
              <span className="chip chip-aviso">No guardada</span>
            )}
            <span className="chip">Validación: sin advertencias</span>
          </div>
          {(resultado.supuestos?.length > 0 || resultado.avisos?.length > 0) && (
            <div className="gen-supuestos no-print">
              {resultado.avisos?.map((a, i) => (
                <p key={`a${i}`} className="gen-aviso">
                  ⚠️ {a}
                </p>
              ))}
              {resultado.supuestos?.length > 0 && (
                <>
                  <strong>Valores por defecto aplicados:</strong>
                  <ul>
                    {resultado.supuestos.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          <div className="gen-botones no-print">
            <button type="button" className="gen-btn" onClick={descargarPdf}>
              Descargar PDF
            </button>
            <button type="button" className="gen-btn-secundario" onClick={descargarPng} disabled={!!exportando}>
              {exportando === 'png' ? 'Creando PNG…' : 'Descargar PNG'}
            </button>
            <button type="button" className="gen-btn-secundario" onClick={probarConAgente} disabled={!!exportando}>
              {exportando === 'agente' ? 'El agente está leyendo la factura…' : 'Probar con el agente de visión'}
            </button>
          </div>

          {resultado.imagen?.url && (
            <section className="gen-imagen-ia no-print">
              <div><strong>Vista visual FWD generada con gpt-image-2</strong><small>Los datos fiscales mostrados provienen del comprobante estructurado validado.</small></div>
              <img src={`${API_URL}${resultado.imagen.url}`} alt="Factura FWD Costa Rica generada" />
              <a className="gen-btn-secundario" href={`${API_URL}${resultado.imagen.url}`} download target="_blank" rel="noreferrer">Descargar imagen generada</a>
            </section>
          )}

          {prueba && (
            <div className={`gen-prueba no-print ${prueba.diferencias.length ? 'con-diferencias' : 'coincide'}`}>
              {prueba.diferencias.length === 0 ? (
                <strong>✅ El agente de visión leyó todos los campos comparados igual que los generados.</strong>
              ) : (
                <>
                  <strong>
                    El agente de visión leyó {prueba.diferencias.length} campo(s) distinto(s) a los generados:
                  </strong>
                  <table>
                    <thead>
                      <tr>
                        <th>Campo</th>
                        <th>Generado</th>
                        <th>Leído</th>
                      </tr>
                    </thead>
                    <tbody>
                      {prueba.diferencias.map((d) => (
                        <tr key={d.campo}>
                          <td>{d.campo}</td>
                          <td className="gen-mono">{d.generado}</td>
                          <td className="gen-mono">{d.leido}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
              <small>
                Lectura del agente: estado {prueba.agente.estado}, resolución {prueba.agente.detailFinal}, confianza{' '}
                {prueba.agente.confianza ?? '—'}
                {prueba.agente.claveOcr ? ', clave verificada por OCR' : ''}.
              </small>
            </div>
          )}

          <div className="fi-contenedor">
            <FacturaImprimible datos={resultado.datosEstructurados} ref={facturaRef} />
          </div>
        </>
      )}
    </div>
  );
}
