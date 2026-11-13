import './FacturaImprimible.css';
import { montoCR, dineroCR, cantidadCR, fechaCR, cedulaCR, ubicacionCR } from '../utils/facturaFormato';

// Paleta del brand book de FWD Costa Rica
const COLOR = {
  azul: '#0A6CB9',
  morado: '#662D91',
  turquesa: '#20BEC6',
  amarillo: '#FFCB05',
  naranja: '#F7901E',
  rojo: '#E20613',
};

/**
 * Ícono "Fast Forward" de la marca: dos triángulos, el segundo superpuesto al primero.
 * Hecho en SVG (no es una imagen) para que escale y se imprima nítido.
 */
function Flechas({ atras, adelante, alto = 22 }) {
  return (
    <svg className="fi-flechas" viewBox="0 0 56 32" height={alto} width={(alto * 56) / 32} aria-hidden="true">
      <polygon points="0,0 28,16 0,32" fill={atras} />
      <polygon points="22,0 50,16 22,32" fill={adelante} />
      <polygon points="22,3.4 28,16 22,28.6" fill={atras} opacity="0.55" />
    </svg>
  );
}

/**
 * Factura electrónica v4.4 imprimible con la marca FWD (tamaño carta).
 * Recibe los mismos datosEstructurados que devuelve el análisis.
 * @param {{ datos: object, ref?: React.Ref }} props
 */
export default function FacturaImprimible({ datos, ref }) {
  if (!datos) return null;
  const r = datos.resumen || {};
  const moneda = r.moneda || 'CRC';
  const emisor = datos.emisor || {};
  const receptor = datos.receptor || {};
  const detalle = datos.detalle || [];
  const iva = (l) => l.impuestos?.[0] || {};
  const descuento = (l) => (l.descuentos || []).reduce((s, d) => s + (d.monto || 0), 0);
  const medios = (r.medios_pago || []).map((m) => `${m.tipo} ${dineroCR(m.total, moneda)}`).join(' + ');

  const totales = [
    ['Total servicios gravados', r.total_serv_gravados],
    ['Total servicios exentos', r.total_serv_exentos],
    ['Total mercancías gravadas', r.total_mercancias_gravadas],
    ['Total mercancías exentas', r.total_mercancias_exentas],
  ].filter(([, v]) => v > 0);
  const totalesFuertes = [
    ['Total gravado', r.total_gravado],
    ...(r.total_exento > 0 ? [['Total exento', r.total_exento]] : []),
    ['Total venta', r.total_venta],
    ['Total descuentos', r.total_descuentos],
    ['Total venta neta', r.total_venta_neta],
    ['Total impuesto', r.total_impuesto],
  ];

  return (
    <article className="fi" ref={ref}>
      {/* Siempre visible: el sistema no firma el XML ni lo envía a Hacienda */}
      <div className="fi-prueba">DOCUMENTO DE PRUEBA · SIN VALIDEZ FISCAL</div>

      {/* Encabezado: logo oficial tal cual + eslogan */}
      <header className="fi-encabezado">
        <img className="fi-logo" src="/fwd-logo.png" alt="FWD Costa Rica" crossOrigin="anonymous" />
        <span className="fi-separador" />
        <p className="fi-eslogan">
          <span className="fi-rojo">Avancemos</span> hacia el futuro juntos.
        </p>
      </header>

      {/* Emisor + banda del tipo de documento */}
      <section className="fi-fila fi-fila-emisor">
        <div className="fi-emisor">
          <h3>Emisor: {emisor.nombre}</h3>
          <p>
            Cédula {emisor.tipo_identificacion || ''}: {cedulaCR(emisor.identificacion, emisor.tipo_identificacion)}
          </p>
          <p>Actividad económica: {emisor.codigo_actividad || '—'}</p>
          {ubicacionCR(emisor.ubicacion) && <p>{ubicacionCR(emisor.ubicacion)}</p>}
          <p>
            {[emisor.telefono && `Tel: ${emisor.telefono}`, emisor.correo].filter(Boolean).join(' · ')}
          </p>
        </div>
        <div className="fi-banda-tipo">
          <Flechas atras={COLOR.amarillo} adelante={COLOR.turquesa} alto={30} />
          <div>
            <strong>FACTURA ELECTRÓNICA</strong>
            <span>Versión {datos.version || '4.4'}</span>
          </div>
        </div>
      </section>

      {/* Consecutivo / fecha / condición + clave */}
      <section className="fi-fila fi-fila-datos">
        <dl className="fi-caja fi-datos">
          <dt>N° Consecutivo:</dt>
          <dd className="fi-mono">{datos.numero_consecutivo}</dd>
          <dt>Fecha de emisión:</dt>
          <dd>{fechaCR(datos.fecha_emision)}</dd>
          <dt>Condición de venta:</dt>
          <dd>
            {datos.condicion_venta}
            {datos.plazo_credito_dias ? ` (${datos.plazo_credito_dias} días)` : ''}
          </dd>
        </dl>
        <div className="fi-caja fi-clave">
          <span>Clave numérica:</span>
          <code>{datos.clave}</code>
        </div>
      </section>

      {/* Receptor */}
      <section className="fi-receptor">
        <span className="fi-receptor-etiqueta">Receptor:</span>
        <div>
          <strong>{receptor.nombre}</strong>
          <p>
            Cédula {receptor.tipo_identificacion || ''}: {cedulaCR(receptor.identificacion, receptor.tipo_identificacion)}
            {receptor.correo && (
              <>
                {' · '}
                <b>Correo:</b> {receptor.correo}
              </>
            )}
          </p>
        </div>
      </section>

      {/* Detalle */}
      <table className="fi-tabla">
        <thead>
          <tr>
            <th>#</th>
            <th>CABYS</th>
            <th>Descripción</th>
            <th>Cant.</th>
            <th>Unid.</th>
            <th>Precio unit.</th>
            <th>Descuento</th>
            <th>Subtotal</th>
            <th>IVA</th>
            <th>Monto IVA</th>
            <th>Total línea</th>
          </tr>
        </thead>
        <tbody>
          {detalle.map((l) => (
            <tr key={l.numero_linea}>
              <td>{l.numero_linea}</td>
              <td className="fi-mono">{l.codigo_cabys || '—'}</td>
              <td className="fi-desc">{l.detalle}</td>
              <td>{cantidadCR(l.cantidad)}</td>
              <td>{l.unidad_medida}</td>
              <td className="num">{montoCR(l.precio_unitario)}</td>
              <td className="num">{montoCR(descuento(l))}</td>
              <td className="num">{montoCR(l.subtotal)}</td>
              <td>{iva(l).tarifa ?? '—'}%</td>
              <td className="num">{montoCR(l.impuesto_neto)}</td>
              <td className="num">{montoCR(l.monto_total_linea)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Desglose + totales */}
      <section className="fi-fila fi-fila-totales">
        <div className="fi-desglose">
          <h4>Desglose de impuestos:</h4>
          {(r.desglose_impuesto || []).map((d) => (
            <p key={d.codigo_tarifa}>
              <span>
                IVA {d.tarifa}% (tarifa {d.codigo_tarifa}):
              </span>
              <span>{montoCR(d.total)}</span>
            </p>
          ))}
        </div>
        <dl className="fi-totales">
          {totales.map(([etiqueta, valor]) => (
            <div key={etiqueta}>
              <dt>{etiqueta}:</dt>
              <dd>{montoCR(valor)}</dd>
            </div>
          ))}
          {totalesFuertes.map(([etiqueta, valor]) => (
            <div key={etiqueta} className="fi-fuerte">
              <dt>{etiqueta}:</dt>
              <dd>{montoCR(valor)}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* Total */}
      <section className="fi-total">
        <Flechas atras={COLOR.amarillo} adelante={COLOR.turquesa} alto={34} />
        <span className="fi-total-barra" />
        <strong className="fi-total-etiqueta">TOTAL COMPROBANTE:</strong>
        <strong className="fi-total-valor">{dineroCR(r.total_comprobante, moneda)}</strong>
      </section>

      <p className="fi-pago">
        <b>Medio de pago:</b> {medios || '—'} · <b>Moneda:</b> {moneda} · <b>Tipo de cambio:</b> {montoCR(r.tipo_cambio ?? 1)}
      </p>

      {/* Pie */}
      <footer className="fi-pie">
        <p>Emitida conforme a la normativa de comprobantes electrónicos de la Dirección General de Tributación.</p>
        <div className="fi-pie-flechas">
          <span className="fi-linea" />
          {[COLOR.azul, COLOR.morado, COLOR.turquesa, COLOR.amarillo, COLOR.naranja, COLOR.rojo].map((c) => (
            <Flechas key={c} atras={c} adelante={c} alto={18} />
          ))}
          <span className="fi-linea" />
        </div>
      </footer>
    </article>
  );
}
