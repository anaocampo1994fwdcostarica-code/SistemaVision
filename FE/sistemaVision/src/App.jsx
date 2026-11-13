import { useState } from 'react';
import FacturaUploader from './components/FacturaUploader';
import GeneradorFactura from './components/GeneradorFactura';
import './App.css';

// Secciones con contenido; el resto del menú sigue siendo decorativo por ahora
const SECCIONES = [
  { id: 'carga', icono: '▣', nombre: 'Facturas / Carga' },
  { id: 'generar', icono: '✎', nombre: 'Generar factura' },
];

function App() {
  const [seccion, setSeccion] = useState('carga');

  const enlace = ({ id, icono, nombre }) => (
    <a
      key={id}
      role="button"
      tabIndex={0}
      className={seccion === id ? 'active' : undefined}
      aria-current={seccion === id ? 'page' : undefined}
      onClick={() => setSeccion(id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setSeccion(id);
        }
      }}
    >
      {icono} <span>{nombre}</span>
    </a>
  );

  return (
    <div className="console-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">▣</span><strong>FacturaAI</strong><span className="brand-divider">/</span><strong>LedgerVision</strong></div>
        <div className="topbar-status"><span className="status-dot" /> SESIÓN #4829 ACTIVA</div>
        <div className="topbar-pill">Auditoría Nivel 4 (ISO 27001)</div>
        <div className="topbar-spacer" />
        <span className="erp-pill">▦ Acme Corp ERP⌄</span><span>Documentación</span><span>Estado del Sistema</span><span>⌕</span><span>♧</span><span className="user-pill">●</span>
      </header>
      <aside className="sidebar">
        <div className="sidebar-kicker">CONSOLA CONTABLE</div>
        <nav>
          {SECCIONES.map(enlace)}
          <a>▤ <span>Historial &amp; Registros</span></a>
          <a>⌁ <span>Auditoría Fiscal</span></a>
          <a>⚙ <span>Configuración del Agente</span></a>
        </nav>
        <div className="sidebar-footer"><span>Extracción OCR SLA</span><strong>99.8%</strong><i /></div>
      </aside>
      <main className="app-main">
        {/* Ambas secciones quedan montadas para no perder su estado al cambiar de una a otra */}
        <div hidden={seccion !== 'carga'}>
          <FacturaUploader />
        </div>
        <div hidden={seccion !== 'generar'}>
          <GeneradorFactura />
        </div>
      </main>
    </div>
  );
}

export default App;
