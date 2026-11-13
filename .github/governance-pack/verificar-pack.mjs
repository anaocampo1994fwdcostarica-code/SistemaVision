#!/usr/bin/env node
// Verificador del Governance Pack.
//
// Revisa la FORMA del pack: que los archivos existan, que los ADRs tengan sus
// secciones, que no queden marcadores de plantilla sin llenar, etc.
// NO revisa que lo escrito sea verdad en el código: eso lo revisa una persona.
//
// Uso: node verificar-pack.mjs [carpeta-del-repo] [archivo-de-reporte]
// Sin dependencias: solo Node.js.

import { readFileSync, existsSync, readdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const RAIZ = process.argv[2] ?? '.'
const ARCHIVO_REPORTE = process.argv[3] ?? null

const MINIMO_ADRS = 3
const MINIMO_REGLAS_AGENTS = 5
const MINIMO_FILAS_INVENTARIO = 2
const MINIMO_RIESGOS = 3

const secciones = []

/** Agrega una sección al reporte con sus errores (bloquean) y avisos (no bloquean). */
function nuevaSeccion(titulo) {
  const seccion = { titulo, errores: [], avisos: [], correctos: [] }
  secciones.push(seccion)
  return seccion
}

function leer(rutaRelativa) {
  const ruta = join(RAIZ, rutaRelativa)
  return existsSync(ruta) ? readFileSync(ruta, 'utf8') : null
}

/** Minúsculas y sin tildes, para comparar títulos sin depender de acentos. */
function normalizar(texto) {
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

/** Quita comentarios HTML (no se ven al publicar), bloques de código y código en línea. */
function sinCodigo(texto) {
  return texto
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]*`/g, '')
}

const MARCADOR = /<(?!!--)(?!\/?(?:br|details|summary|sub|sup|img|a|kbd|b|i|code|p)\b)(?!https?:)[^<>\n]{2,}>/i

/** Devuelve el primer marcador de plantilla sin llenar, como `<nombre>`. */
function buscarMarcador(texto) {
  const coincidencia = sinCodigo(texto).match(MARCADOR)
  return coincidencia ? coincidencia[0] : null
}

/** Texto de una sección `## Titulo` hasta el siguiente encabezado del mismo nivel o superior. */
function extraerSeccion(texto, titulo) {
  const lineas = texto.split('\n')
  const buscado = normalizar(titulo)
  let dentro = false
  let nivel = 0
  const resultado = []
  for (const linea of lineas) {
    const encabezado = linea.match(/^(#{1,6})\s+(.*)$/)
    if (encabezado) {
      const nivelActual = encabezado[1].length
      if (dentro && nivelActual <= nivel) break
      if (!dentro && normalizar(encabezado[2]).startsWith(buscado)) {
        dentro = true
        nivel = nivelActual
        continue
      }
    }
    if (dentro) resultado.push(linea)
  }
  return dentro ? resultado.join('\n').trim() : null
}

function contarVinetas(texto) {
  return sinCodigo(texto)
    .split('\n')
    .filter((linea) => /^\s*(?:[-*+]|\d+\.)\s+\S/.test(linea)).length
}

/** Filas de datos de la primera tabla Markdown del texto (sin encabezado ni separador). */
function filasDeTabla(texto) {
  const filas = sinCodigo(texto)
    .split('\n')
    .map((linea) => linea.trim())
    .filter((linea) => linea.startsWith('|'))
  if (filas.length < 2) return { encabezado: [], datos: [] }
  const celdas = (fila) =>
    fila
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((celda) => celda.trim())
  const encabezado = celdas(filas[0])
  const datos = filas
    .slice(1)
    .filter((fila) => !/^\|?\s*:?-{3,}/.test(fila))
    .map(celdas)
    .filter((fila) => fila.some((celda) => celda !== '' && celda !== '...'))
  return { encabezado, datos }
}

function esFechaValida(texto) {
  const coincidencia = texto.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!coincidencia) return false
  const fecha = new Date(`${texto}T00:00:00Z`)
  return !Number.isNaN(fecha.getTime()) && fecha.toISOString().startsWith(texto)
}

function campoDeCabecera(texto, nombre) {
  const patron = new RegExp(`^\\s*[-*]?\\s*\\**${nombre}\\**\\s*:\\s*\\**\\s*(.+?)\\s*$`, 'im')
  const coincidencia = texto.match(patron)
  return coincidencia ? coincidencia[1].replace(/\*+$/, '').trim() : null
}

// ---------- 1. ADRs ----------

function verificarAdrs() {
  const seccion = nuevaSeccion('ADRs en `docs/adr/`')
  const carpeta = join(RAIZ, 'docs', 'adr')
  if (!existsSync(carpeta)) {
    seccion.errores.push('No existe la carpeta `docs/adr/`.')
    return
  }
  const archivos = readdirSync(carpeta)
    .filter((nombre) => /^\d{4}-.+\.md$/i.test(nombre))
    .sort()
  if (archivos.length < MINIMO_ADRS) {
    seccion.errores.push(
      `Hay ${archivos.length} ADR(s); se necesitan al menos ${MINIMO_ADRS} con nombre \`NNNN-nombre-corto.md\`.`,
    )
  }
  if (!archivos.some((nombre) => nombre.startsWith('0002'))) {
    seccion.errores.push('Falta el ADR 0002: qué decide la IA y qué decide una persona.')
  }

  const seccionesRequeridas = [
    'Contexto',
    'Decisión',
    'Alternativas descartadas',
    'Consecuencias',
    'Cómo se verifica',
  ]

  for (const nombre of archivos) {
    const texto = readFileSync(join(carpeta, nombre), 'utf8')
    const problemas = []

    const estado = campoDeCabecera(texto, 'Estado')
    if (!estado || !/^(propuesto|aceptado|reemplazado)/i.test(normalizar(estado))) {
      problemas.push('el estado debe ser Propuesto, Aceptado o Reemplazado por ADR-XXXX')
    }
    const fecha = campoDeCabecera(texto, 'Fecha')
    if (!fecha || !esFechaValida(fecha)) {
      problemas.push('la fecha debe tener formato AAAA-MM-DD')
    }
    const decide = campoDeCabecera(texto, 'Decide')
    if (!decide || buscarMarcador(decide)) {
      problemas.push('falta quién decide (nombre y rol)')
    }
    for (const titulo of seccionesRequeridas) {
      const contenido = extraerSeccion(texto, titulo)
      if (contenido === null) problemas.push(`falta la sección «${titulo}»`)
      else if (contenido.replace(/<!--[\s\S]*?-->/g, '').trim().length < 20)
        problemas.push(`la sección «${titulo}» está vacía o es demasiado corta`)
    }
    const alternativas = extraerSeccion(texto, 'Alternativas descartadas')
    if (alternativas !== null && contarVinetas(alternativas) < 1) {
      problemas.push('«Alternativas descartadas» necesita al menos una opción en viñeta')
    }
    const marcador = buscarMarcador(texto)
    if (marcador) problemas.push(`queda un marcador de plantilla sin llenar: \`${marcador}\``)

    if (problemas.length) seccion.errores.push(`\`${nombre}\`: ${problemas.join('; ')}.`)
    else seccion.correctos.push(`\`${nombre}\``)
  }
}

// ---------- 2. Inventario de datos ----------

function verificarInventario() {
  const ruta = 'docs/gobernanza/inventario-de-datos.md'
  const seccion = nuevaSeccion(`Inventario de datos (\`${ruta}\`)`)
  const texto = leer(ruta)
  if (texto === null) {
    seccion.errores.push('No existe el archivo.')
    return
  }
  const { datos } = filasDeTabla(texto)
  if (datos.length < MINIMO_FILAS_INVENTARIO) {
    seccion.errores.push(`La tabla tiene ${datos.length} fila(s) de datos; se esperan al menos ${MINIMO_FILAS_INVENTARIO}.`)
  }
  const categoriaValida = /sensible|restringido|irrestricto|crediticio/
  datos.forEach((fila, indice) => {
    const numero = indice + 1
    if (fila.length < 8 || fila.slice(0, 8).some((celda) => celda === '')) {
      seccion.errores.push(`Fila ${numero}: hay celdas vacías (se esperan 8 columnas llenas).`)
      return
    }
    const esPersonal = /^s[ií]/i.test(fila[1])
    if (esPersonal && !categoriaValida.test(normalizar(fila[2]))) {
      seccion.errores.push(
        `Fila ${numero} («${fila[0]}»): es dato personal, pero la categoría no es una de la Ley 8968 (sensible, acceso restringido, acceso irrestricto, crediticio).`,
      )
    }
    if (esPersonal && /sensible/.test(normalizar(fila[2]))) {
      seccion.avisos.push(`Fila ${numero} («${fila[0]}»): es dato sensible. Expliquen en un ADR por qué lo necesitan.`)
    }
  })
  const noRecolectamos = extraerSeccion(texto, 'Lo que NO recolectamos')
  if (noRecolectamos === null) seccion.errores.push('Falta la sección «Lo que NO recolectamos».')
  else if (contarVinetas(noRecolectamos) < 1)
    seccion.errores.push('«Lo que NO recolectamos» necesita al menos un dato en viñeta.')
  const marcador = buscarMarcador(texto)
  if (marcador) seccion.errores.push(`Queda un marcador de plantilla sin llenar: \`${marcador}\``)
  if (!seccion.errores.length) seccion.correctos.push(`${datos.length} datos inventariados`)
}

// ---------- 3. Registro de riesgos ----------

function verificarRiesgos() {
  const ruta = 'docs/gobernanza/registro-de-riesgos.md'
  const seccion = nuevaSeccion(`Registro de riesgos (\`${ruta}\`)`)
  const texto = leer(ruta)
  if (texto === null) {
    seccion.errores.push('No existe el archivo.')
    return
  }
  const { datos } = filasDeTabla(texto)
  if (datos.length < MINIMO_RIESGOS) {
    seccion.errores.push(`Hay ${datos.length} riesgo(s); se esperan al menos ${MINIMO_RIESGOS}.`)
  }
  datos.forEach((fila, indice) => {
    const numero = indice + 1
    if (fila.length < 8) {
      seccion.errores.push(`Fila ${numero}: se esperan 8 columnas.`)
      return
    }
    const [, riesgo, afectados, probabilidad, impacto, mitigacion, estado, responsable] = fila
    const faltantes = []
    if (!riesgo) faltantes.push('riesgo')
    if (!afectados) faltantes.push('quién sale afectado')
    if (!mitigacion) faltantes.push('mitigación')
    if (!responsable) faltantes.push('responsable')
    if (faltantes.length) seccion.errores.push(`Fila ${numero}: falta ${faltantes.join(', ')}.`)
    for (const [nombre, valor] of [
      ['la probabilidad', probabilidad],
      ['el impacto', impacto],
    ]) {
      if (!/^(b|m|a|baja|media|alta|bajo|medio|alto)$/i.test(valor ?? '')) {
        seccion.errores.push(`Fila ${numero}: ${nombre} debe ser B, M o A.`)
      }
    }
    if (estado && !/^(hecho|pendiente|en curso)$/i.test(estado)) {
      seccion.avisos.push(`Fila ${numero}: el estado \`${estado}\` no es Hecho, Pendiente ni En curso.`)
    }
  })
  const marcador = buscarMarcador(texto)
  if (marcador) seccion.errores.push(`Queda un marcador de plantilla sin llenar: \`${marcador}\``)
  if (!seccion.errores.length) seccion.correctos.push(`${datos.length} riesgos registrados`)
}

// ---------- 4. AGENTS.md ----------

function verificarAgents() {
  const seccion = nuevaSeccion('`AGENTS.md` en la raíz')
  const texto = leer('AGENTS.md')
  if (texto === null) {
    seccion.errores.push('No existe `AGENTS.md` en la raíz del repo.')
    return
  }
  const reglas = contarVinetas(texto)
  if (reglas < MINIMO_REGLAS_AGENTS) {
    seccion.errores.push(`Tiene ${reglas} regla(s) en viñetas; se esperan al menos ${MINIMO_REGLAS_AGENTS}.`)
  }
  if (!/docs\/adr/i.test(texto)) {
    seccion.avisos.push('No menciona `docs/adr/`: conviene pedirle al agente que lea los ADRs antes de cambiar código.')
  }
  const marcador = buscarMarcador(texto)
  if (marcador) seccion.errores.push(`Queda un marcador de plantilla sin llenar: \`${marcador}\``)
  if (!seccion.errores.length) seccion.correctos.push(`${reglas} reglas`)
}

// ---------- Reporte ----------

verificarAdrs()
verificarInventario()
verificarRiesgos()
verificarAgents()

const totalErrores = secciones.reduce((suma, seccion) => suma + seccion.errores.length, 0)
const totalAvisos = secciones.reduce((suma, seccion) => suma + seccion.avisos.length, 0)

const lineas = ['## Verificación del Governance Pack', '']
lineas.push(
  totalErrores === 0
    ? '**Resultado: la forma del pack está completa.**'
    : `**Resultado: faltan ${totalErrores} cosa(s) por resolver.**`,
)
lineas.push('')
for (const seccion of secciones) {
  const estado = seccion.errores.length ? 'Falta' : 'Completo'
  lineas.push(`### ${seccion.titulo} · ${estado}`, '')
  for (const error of seccion.errores) lineas.push(`- [ ] ${error}`)
  for (const aviso of seccion.avisos) lineas.push(`- Aviso: ${aviso}`)
  for (const correcto of seccion.correctos) lineas.push(`- [x] ${correcto}`)
  lineas.push('')
}
lineas.push(
  '---',
  '',
  'Este bot revisa la **forma** del pack, no la **verdad**. Que lo escrito coincida con lo que hace su código lo revisan ustedes y los profes. Si un ADR afirma algo que el código no hace, está mal aunque este reporte salga completo.',
)
if (totalAvisos) lineas.push('', `Avisos: ${totalAvisos} (no bloquean).`)

const reporte = `${lineas.join('\n')}\n`
process.stdout.write(reporte)
if (ARCHIVO_REPORTE) writeFileSync(ARCHIVO_REPORTE, reporte)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, reporte)
process.exit(totalErrores === 0 ? 0 : 1)
