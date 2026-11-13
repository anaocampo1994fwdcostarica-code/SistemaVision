import './FacturaElectronicaView.css';

// ------------------------------------------------------------------
// Formato es-CR
// ------------------------------------------------------------------
const formatoNumero = new Intl.NumberFormat('es-CR', { minimumFractionDigits: 2, maximumFractionDigits: 5 });
const formatoCantidad = new Intl.NumberFormat('es-CR', { maximumFractionDigits: 3 });
const SIMBOLOS = { CRC: '₡', USD: '$', EUR: '€' };

const esNumero = (v) => typeof v === 'number' && Number.isFinite(v);
const vacio = (v) => v === null || v === undefined || v === '';

/** Monto con formato es-CR; si no es número, se muestra tal cual. */
function monto(v) {
  if (esNumero(v)) return formatoNumero.format(v);
  return vacio(v) ? '—' : String(v);
}

function dinero(v, moneda) {
  if (!esNumero(v)) return monto(v);
  const simbolo = SIMBOLOS[moneda];
  return simbolo ? `${simbolo}${formatoNumero.format(v)}` : `${formatoNumero.format(v)}${moneda ? ` ${moneda}` : ''}`;
}

const cantidad = (v) => (esNumero(v) ? formatoCantidad.format(v) : monto(v));
const porcentaje = (v) => (esNumero(v) ? `${formatoCantidad.format(v)} %` : monto(v));

/**
 * Fecha tal como está impresa (DD/MM/AAAA HH:mm), SIN conversión de zona horaria:
 * se leen los componentes del texto "AAAA-MM-DDTHH:mm:ss" en lugar de usar new Date(),
 * que interpretaría la hora como UTC o local del navegador y podría cambiar el día.
 */
function fecha(v) {
  if (vacio(v)) return '—';
  const s = String(v).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return s; // ya viene como DD/MM/AAAA u otro formato: se muestra tal cual
  const [, a, mes, d, hh, mi] = m;
  const conHora = hh !== undefined && !(hh === '00' && mi === '00');
  return `${d}/${mes}/${a}${conHora ? ` ${hh}:${mi}` : ''}`;
}

const texto = (v) => (vacio(v) ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

function ubicacionTexto(u) {
  if (!u || typeof u !== 'object') return null;
  const partes = [u.provincia, u.canton, u.distrito, u.barrio].filter((p) => !vacio(p));
  const linea = partes.join(', ');
  return [linea, u.otras_senas].filter((p) => !vacio(p)).join(' — ') || null;
}

const lista = (v) => (Array.isArray(v) ? v : []);

// ------------------------------------------------------------------
// Bloques
// ------------------------------------------------------------------
function Campo({ etiqueta, valor, mono = false }) {
  return (
    <div className="fe-campo">
      <span className="fe-etiqueta">{etiqueta}</span>
      <span className={`fe-valor ${mono ? 'fe-mono' : ''}`}>{valor}</span>
    </div>
  );
}

function TarjetaPersona({ titulo, persona }) {
  if (!persona) {
    return (
      <div className="fe-card">
        <h5>{titulo}</h5>
        <p className="fe-vacio">No indicado</p>
      </div>
    );
  }
  const ubicacion = ubicacionTexto(persona.ubicacion);
  return (
    <div className="fe-card">
      <h5>{titulo}</h5>
      <p className="fe-nombre">{persona.nombre || '—'}</p>
      {persona.nombre_comercial && <p className="fe-sub">{persona.nombre_comercial}</p>}
      <dl className="fe-dl">
        <dt>Identificación</dt>
        <dd>
          {persona.tipo_identificacion ? `${persona.tipo_identificacion} · ` : ''}
          <span className="fe-mono">{persona.identificacion || '—'}</span>
        </dd>
        {persona.codigo_actividad && (
          <>
            <dt>Actividad</dt>
            <dd className="fe-mono">{persona.codigo_actividad}</dd>
          </>
        )}
        {ubicacion && (
          <>
            <dt>Ubicación</dt>
            <dd>{ubicacion}</dd>
          </>
        )}
        {persona.telefono && (
          <>
            <dt>Teléfono</dt>
            <dd>{persona.telefono}</dd>
          </>
        )}
        {persona.correo && (
          <>
            <dt>Correo</dt>
            <dd>{persona.correo}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

/** Texto de la(s) exoneración(es) de una línea. */
function exoneracionTexto(linea) {
  const exos = lista(linea.impuestos)
    .map((i) => i?.exoneracion)
    .filter(Boolean);
  if (!exos.length) return '—';
  return exos
    .map((e) => [esNumero(e.porcentaje) ? `${formatoCantidad.format(e.porcentaje)} %` : null, esNumero(e.monto) ? monto(e.monto) : null, e.numero_documento]
      .filter(Boolean)
      .join(' · '))
    .join(' / ');
}

const tarifaIva = (linea) => {
  const imps = lista(linea.impuestos);
  const iva = imps.find((i) => vacio(i?.codigo) || String(i.codigo) === '01') || imps[0];
  return iva?.tarifa;
};

const sumaDescuentos = (linea) => {
  const montos = lista(linea.descuentos).map((d) => d?.monto).filter(esNumero);
  return montos.length ? montos.reduce((a, b) => a + b, 0) : null;
};

const ETIQUETAS_TOTALES = [
  ['total_serv_gravados', 'Servicios gravados'],
  ['total_serv_exentos', 'Servicios exentos'],
  ['total_serv_exonerado', 'Servicios exonerados'],
  ['total_serv_no_sujeto', 'Servicios no sujetos'],
  ['total_mercancias_gravadas', 'Mercancías gravadas'],
  ['total_mercancias_exentas', 'Mercancías exentas'],
  ['total_merc_exonerada', 'Mercancías exoneradas'],
  ['total_merc_no_sujeta', 'Mercancías no sujetas'],
  ['total_gravado', 'Total gravado'],
  ['total_exento', 'Total exento'],
  ['total_exonerado', 'Total exonerado'],
  ['total_no_sujeto', 'Total no sujeto'],
  ['total_venta', 'Total venta'],
  ['total_descuentos', 'Descuentos'],
  ['total_venta_neta', 'Venta neta'],
  ['total_impuesto', 'Impuestos'],
  ['total_iva_devuelto', 'IVA devuelto'],
  ['total_otros_cargos', 'Otros cargos'],
];

// ------------------------------------------------------------------
// Componente principal
// ------------------------------------------------------------------
/**
 * Muestra un comprobante electrónico v4.4 completo.
 * @param {{ datos: object, advertencias?: string[], camposIlegibles?: string[] }} props
 */
export default function FacturaElectronicaView({ datos, advertencias = [], camposIlegibles = [], notas = [] }) {
  if (!datos) return null;

  const r = datos.resumen || {};
  const moneda = r.moneda || 'CRC';
  const detalle = lista(datos.detalle);
  const otrosCargos = lista(datos.otros_cargos);
  const desglose = lista(r.desglose_impuesto);
  const mediosPago = lista(r.medios_pago);
  const referencias = lista(datos.informacion_referencia);
  const leyendas = lista(datos.leyendas);

  return (
    <div className="fe">
      {/* Avisos de validación */}
      {(advertencias.length > 0 || camposIlegibles.length > 0 || notas.length > 0) && (
        <div className="fe-avisos">
          {/* Correcciones automáticas (informativas, no son errores) */}
          {notas.length > 0 && (
            <div className="fe-aviso fe-aviso-info">
              <strong>ℹ️ Correcciones y reconciliación automáticas</strong>
              <ul>
                {notas.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </div>
          )}
          {advertencias.length > 0 && (
            <div className="fe-aviso fe-aviso-error">
              <strong>⚠️ Inconsistencias detectadas ({advertencias.length})</strong>
              <ul>
                {advertencias.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </div>
          )}
          {camposIlegibles.length > 0 && (
            <div className="fe-aviso">
              <strong>Campos ilegibles:</strong> {camposIlegibles.join(', ')}
            </div>
          )}
        </div>
      )}

      {/* Encabezado */}
      <section className="fe-seccion">
        <div className="fe-titulo">
          <h4>{datos.tipo_documento || 'Comprobante electrónico'}</h4>
          <div className="fe-chips">
            {datos.version && <span className="chip">v{datos.version}</span>}
            {datos.estado_hacienda && (
              <span className={`chip ${/acept/i.test(datos.estado_hacienda) ? 'chip-completado' : 'chip-aviso'}`}>
                Hacienda: {datos.estado_hacienda}
              </span>
            )}
          </div>
        </div>
        <div className="fe-grid-encabezado">
          <Campo etiqueta="Clave" valor={datos.clave || '—'} mono />
          <Campo etiqueta="Consecutivo" valor={datos.numero_consecutivo || '—'} mono />
          <Campo etiqueta="Fecha de emisión" valor={fecha(datos.fecha_emision)} />
          <Campo etiqueta="Condición de venta" valor={texto(datos.condicion_venta)} />
          <Campo
            etiqueta="Plazo de crédito"
            valor={vacio(datos.plazo_credito_dias) ? '—' : `${datos.plazo_credito_dias} días`}
          />
          <Campo etiqueta="Actividad económica" valor={texto(datos.codigo_actividad_emisor)} mono />
          {datos.proveedor_sistemas && <Campo etiqueta="Proveedor de sistemas" valor={datos.proveedor_sistemas} mono />}
          <Campo etiqueta="Moneda" valor={`${moneda}${esNumero(r.tipo_cambio) && r.tipo_cambio !== 1 ? ` (TC ${monto(r.tipo_cambio)})` : ''}`} />
        </div>
      </section>

      {/* Emisor y receptor */}
      <section className="fe-personas">
        <TarjetaPersona titulo="Emisor" persona={datos.emisor} />
        <TarjetaPersona titulo="Receptor" persona={datos.receptor} />
      </section>

      {/* Detalle */}
      <section className="fe-seccion">
        <h5>Detalle ({detalle.length} {detalle.length === 1 ? 'línea' : 'líneas'})</h5>
        {detalle.length === 0 ? (
          <p className="fe-vacio">No se detectaron líneas de detalle.</p>
        ) : (
          <div className="fe-tabla-scroll">
            <table className="fe-tabla">
              <thead>
                <tr>
                  <th>#</th>
                  <th>CABYS</th>
                  <th>Código</th>
                  <th>Descripción</th>
                  <th className="num">Cantidad</th>
                  <th>Unidad</th>
                  <th className="num">Precio</th>
                  <th className="num">Monto</th>
                  <th className="num">Descuento</th>
                  <th className="num">Subtotal</th>
                  <th className="num">IVA %</th>
                  <th className="num">Impuesto</th>
                  <th>Exoneración</th>
                  <th className="num">Total línea</th>
                </tr>
              </thead>
              <tbody>
                {detalle.map((l, i) => (
                  <tr key={i}>
                    <td>{l.numero_linea ?? i + 1}</td>
                    <td className="fe-mono">{l.codigo_cabys || '—'}</td>
                    <td className="fe-mono">{texto(l.codigo_comercial)}</td>
                    <td className="fe-desc">{l.detalle || '—'}</td>
                    <td className="num">{cantidad(l.cantidad)}</td>
                    <td>{l.unidad_medida || '—'}</td>
                    <td className="num">{monto(l.precio_unitario)}</td>
                    <td className="num">{monto(l.monto_total)}</td>
                    <td className="num">{monto(sumaDescuentos(l))}</td>
                    <td className="num">{monto(l.subtotal)}</td>
                    <td className="num">{porcentaje(tarifaIva(l))}</td>
                    <td className="num">{monto(l.impuesto_neto)}</td>
                    <td>{exoneracionTexto(l)}</td>
                    <td className="num fe-fuerte">{monto(l.monto_total_linea)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Otros cargos */}
      {otrosCargos.length > 0 && (
        <section className="fe-seccion">
          <h5>Otros cargos</h5>
          <div className="fe-tabla-scroll">
            <table className="fe-tabla">
              <thead>
                <tr>
                  <th>Tipo</th>
                  <th>Detalle</th>
                  <th className="num">Porcentaje</th>
                  <th className="num">Monto</th>
                </tr>
              </thead>
              <tbody>
                {otrosCargos.map((o, i) => (
                  <tr key={i}>
                    <td>{texto(o.tipo_documento)}</td>
                    <td>{texto(o.detalle)}</td>
                    <td className="num">{porcentaje(o.porcentaje)}</td>
                    <td className="num">{monto(o.monto)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Resumen */}
      <section className="fe-seccion fe-resumen-layout">
        <div>
          <h5>Resumen</h5>
          <dl className="fe-totales">
            {ETIQUETAS_TOTALES.filter(([c]) => !vacio(r[c])).map(([c, etiqueta]) => (
              <div key={c} className={`fe-total-fila ${['total_venta_neta', 'total_impuesto'].includes(c) ? 'fe-fuerte' : ''}`}>
                <dt>{etiqueta}</dt>
                <dd>{dinero(r[c], moneda)}</dd>
              </div>
            ))}
          </dl>
          <div className="fe-total-comprobante">
            <span>Total del comprobante</span>
            <strong>{dinero(r.total_comprobante, moneda)}</strong>
          </div>
        </div>

        <div className="fe-columna-lateral">
          <h5>Desglose de impuestos</h5>
          {desglose.length === 0 ? (
            <p className="fe-vacio">Sin desglose.</p>
          ) : (
            <table className="fe-tabla fe-tabla-compacta">
              <thead>
                <tr>
                  <th>Código</th>
                  <th>Tarifa</th>
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {desglose.map((d, i) => (
                  <tr key={i}>
                    <td className="fe-mono">
                      {texto(d.codigo)}
                      {d.codigo_tarifa ? ` / ${d.codigo_tarifa}` : ''}
                    </td>
                    <td>{porcentaje(d.tarifa)}</td>
                    <td className="num">{monto(d.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h5>Medios de pago</h5>
          {mediosPago.length === 0 ? (
            <p className="fe-vacio">No indicados.</p>
          ) : (
            <ul className="fe-medios">
              {mediosPago.map((m, i) => (
                <li key={i}>
                  <span>{m.tipo || '—'}</span>
                  <span>{esNumero(m.total) ? dinero(m.total, moneda) : ''}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* Referencias */}
      {referencias.length > 0 && (
        <section className="fe-seccion">
          <h5>Información de referencia</h5>
          <div className="fe-tabla-scroll">
            <table className="fe-tabla">
              <thead>
                <tr>
                  <th>Tipo de documento</th>
                  <th>Número</th>
                  <th>Fecha</th>
                  <th>Código</th>
                  <th>Razón</th>
                </tr>
              </thead>
              <tbody>
                {referencias.map((ref, i) => (
                  <tr key={i}>
                    <td>{texto(ref.tipo_documento)}</td>
                    <td className="fe-mono">{texto(ref.numero)}</td>
                    <td>{fecha(ref.fecha)}</td>
                    <td>{texto(ref.codigo)}</td>
                    <td>{texto(ref.razon)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Leyendas y otros */}
      {(leyendas.length > 0 || !vacio(datos.otros)) && (
        <section className="fe-seccion">
          {leyendas.length > 0 && (
            <>
              <h5>Leyendas</h5>
              <ul className="fe-leyendas">
                {leyendas.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            </>
          )}
          {!vacio(datos.otros) && (
            <>
              <h5>Otra información</h5>
              <p className="fe-otros">{texto(datos.otros)}</p>
            </>
          )}
        </section>
      )}

      {/* JSON plegable */}
      <details className="fe-json">
        <summary>JSON completo del comprobante</summary>
        <pre className="raw-json">{JSON.stringify(datos, null, 2)}</pre>
      </details>
    </div>
  );
}
