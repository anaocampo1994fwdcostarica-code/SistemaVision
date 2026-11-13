# SistemaVision: de servicio de visión a agente

`services/agentServiceFacturas.js` se deja **sin cambios** para comparar.
El agente está en `services/visionService.js` (`SYSTEM_PROMPT`, `analyzeImage`, `ejecutarAgente`) y extrae
**comprobantes electrónicos v4.4 de Hacienda de Costa Rica** completos.

## Antes vs. ahora

| Aspecto | Antes (`agentServiceFacturas.js`) | Ahora (`visionService.js`) |
|---|---|---|
| Llamadas a OpenAI | 1 llamada fija | Ciclo de hasta `AGENTE_MAX_PASOS` (8) |
| Resolución de imagen | Siempre `high` | Empieza en `low`; sube a `high` si el modelo lo pide o si la regla de seguridad lo exige |
| Datos extraídos | emisor, receptor, número, fecha, totales, ítems | Comprobante v4.4 completo: clave, consecutivo, actividad, emisor/receptor con ubicación, líneas con CABYS, descuentos, impuestos y exoneraciones, otros cargos, resumen completo, medios de pago, referencias y leyendas |
| Validación | Ninguna | `validarFactura`: formatos (clave 50, consecutivo 20, CABYS 13) y cuentas (±1) → `advertencias` |
| Acciones | Solo extrae JSON | El modelo decide si buscar, consultar el proveedor (p. ej. Hacienda), guardar, pedir más detalle o pedir otra foto |
| Persistencia | Ninguna | MySQL: `Proveedor` → `Factura` → `FacturaItem` (transacción; duplicados por clave o consecutivo + emisor) |
| Estado | Sin estado | Memoria por `sessionId` (MySQL, o RAM con reconexión cada 60 s) |
| Preguntas de seguimiento | No | `POST /api/agente/chat` ("¿cuánto suman las facturas que te pasé?") |
| Imagen mala | Devuelve lo que pueda | `estado: "requiere_nueva_imagen"` + motivo + recomendaciones |
| Errores de BD | — | Se devuelven al modelo como resultado de la tool; el agente sigue |
| Respuesta | JSON de la factura | `datosEstructurados` + `estado`, `confianza`, `calidad_imagen`, `campos_ilegibles`, `advertencias`, `respuesta`, `detailFinal`, `facturaGuardadaId`, `pasos`, `sessionId` |

## El comprobante v4.4 (`services/esquemaFactura.js`)

- **`ESTRUCTURA_TEXTO`**: la forma de `datosEstructurados`, incrustada en el `SYSTEM_PROMPT`.
- **`FACTURA_JSON_SCHEMA`**: los parámetros de la tool `guardar_factura`.
- **`normalizarFactura(f)`**: quita guiones y espacios de la clave, el consecutivo, los CABYS y las cédulas; convierte importes en texto a número; pasa la tarifa a porcentaje (0.13 → 13); deduce `tipo_documento` del consecutivo si falta. También acepta el formato anterior (`numero_factura`, `items`, `total`, `nif_rfc`).
- **`validarFactura(f)`** → `{ valida, advertencias[] }`, con tolerancia ±1:
  - la clave tiene 50 dígitos, el consecutivo 20 y cada CABYS 13; el consecutivo coincide con las posiciones 22 a 41 de la clave; el tipo de documento coincide con el del consecutivo;
  - por línea: `cantidad × precio_unitario = monto_total` y `subtotal + impuesto_neto = monto_total_linea`;
  - `total_venta − total_descuentos = total_venta_neta`;
  - `total_venta_neta + total_impuesto + total_otros_cargos − total_iva_devuelto = total_comprobante`;
  - suma de las líneas = `total_venta_neta + total_impuesto`;
  - suma de `medios_pago` = `total_comprobante`.

  Solo compara cuando están todos los valores necesarios: un campo ausente no se considera una inconsistencia; el modelo lo informa en `campos_ilegibles`.

### Lectura de facturas reales de Costa Rica

- **Números**: en los montos, el punto separa los miles y la coma es el decimal (`"32.500,00"` = 32500). En las cantidades, la coma es decimal (`"2,000"` = 2, `"1,500"` = 1.5).
  - El modelo devuelve `cantidad`, `precio_unitario`, `monto_total`, `subtotal`, `impuesto_neto` y `monto_total_linea` **como texto impreso**. El código los convierte con `parsearCantidad` (cantidades) y `parsearImporte` (montos).
  - `validarFactura` avisa de una "posible confusión de separadores" si el precio tiene decimales y la cantidad es un entero ≥ 1000.
- **Clave**: se verifica que las posiciones 4 a 9 coincidan con `fecha_emision` (DDMMAA), las posiciones 10 a 21 con la identificación del emisor rellena a 12 dígitos y las posiciones 22 a 41 con `numero_consecutivo`. Cada advertencia indica el valor que se esperaba.
- **Fechas**: impresas como DD/MM/AAAA; el agente las devuelve como `AAAA-MM-DDTHH:mm:ss`, sin zona horaria. El frontend las muestra sin `new Date()`, así que no se desplazan por la zona horaria.
- **Sin datos inventados**: el correo, el teléfono y los códigos se copian tal cual. Las secciones que no existen o dicen "no aplica" quedan como `[]`. `plazo_credito_dias` es `null` en ventas de contado.
- **Verificación**: si la respuesta ya se analizó en `high` y la validación sigue fallando, hay **un** último paso (tipo `"verificacion"` en la traza). En ese paso se reenvía la imagen con la lista exacta de advertencias y se pide releer solo esos campos.

### Ampliación de zonas (`ampliar_zona`, `services/imagenZoom.js`)

Con `detail: "high"`, gpt-4o reduce la imagen a unos 768 px en su lado corto: una factura de 1800×1892 se ve a menos de la mitad y se confunden los dígitos pequeños.

- **Cómo funciona**:
  - El modelo pide una zona: `encabezado`, `clave`, `emisor`, `receptor`, `detalle` o `resumen` (atajos aproximados), o `personalizada` con `recuadro { x, y, ancho, alto }` en porcentajes (la opción preferida).
  - El backend recorta esa región de la **imagen original** con sharp (respetando la orientación EXIF) y la amplía a un ancho mínimo de `AGENTE_ZOOM_ANCHO_MIN` (1500 px), sin pasar de 4× ni de 2048 px.
  - El recorte se envía en el siguiente paso como imagen `high`. El resultado de la tool no incluye la imagen.
- **Límites**: `AGENTE_MAX_AMPLIACIONES` (4) por análisis, contando también las automáticas. Si sharp no está instalada, la tool devuelve un error y el agente sigue.
- **En la verificación**: si las advertencias mencionan la clave, el consecutivo o la fecha, se amplían automáticamente el encabezado y la clave, y se envían junto con las advertencias.
- **Traza**: cada intento aparece como `tipo: "ampliacion"`, con zona, motivo, origen (`modelo` / `verificacion`), tamaño y si funcionó. La respuesta incluye `ampliaciones` (cuántas se hicieron).

### OCR de dígitos (`leer_digitos_ocr`, `services/ocrService.js`)

gpt-4o cuenta mal las secuencias largas de dígitos repetidos (`999999`, `0000000457`) aunque la zona esté ampliada: es una limitación del modelo, no de resolución. Para eso está el OCR:

- **Cómo funciona**: el modelo indica la `zona` (o `personalizada` con recuadro) y el `campo`. El backend recorta la zona con `imagenZoom` (escala de grises, más contraste, enfoque, PNG, ≥ `OCR_ANCHO_MIN` = 2000 px) y la pasa por Tesseract (`OCR_IDIOMA`: `eng` o `spa`).
- **Qué devuelve**: el texto crudo y, por línea, los grupos de dígitos con su longitud. Los espacios y guiones dentro de un número se quitan; `/`, `:` y las letras lo cortan. Para `clave` devuelve como `candidato` una secuencia de 50 dígitos que empieza por 506; para `consecutivo`, una de 20.
- **Worker**: uno solo para todo el proceso, con un timeout de 20 s por lectura. Si se agota, se descarta y se crea otro. `index.js` lo cierra con SIGINT/SIGTERM. Los datos del idioma se descargan una vez a `.cache/tesseract`.
- **Errores**: sin tesseract.js (o si falla), la tool devuelve un error y el agente sigue.
- **Límite**: `AGENTE_MAX_OCR` (6) lecturas por análisis, aparte de las ampliaciones.
- **Prompt**: la tool es obligatoria para la clave y el consecutivo, y se usa para las actividades y las cédulas si hay dudas.

### Reconciliación con la clave del OCR (`reconciliarConClaveOcr`)

Si el OCR encontró en el análisis una clave **estructuralmente válida** (50 dígitos, 506, día y mes posibles, tipo de documento conocido, situación 1-3), se aplica en código tras cada respuesta del modelo y también dentro de `guardar_factura`:

- la clave del modelo se sustituye por la del OCR;
- el consecutivo se toma de `clave[21..41]` si no coincide → nota "Consecutivo tomado de la clave (OCR)";
- la fecha se corrige si con día y mes invertidos coincide con `clave[3..9]`, **sin** exigir que la cédula y el consecutivo validen;
- si la identificación del emisor rellena a 12 dígitos coincide con `clave[9..21]`, se anota como confirmación; si no coincide, la advertencia se mantiene.

Todo va en `notas`, no en `advertencias`. La traza muestra los pasos `ocr` (zona, campo, candidato) y `reconciliacion`. La respuesta incluye `claveOcr` y `lecturasOcr`.

### OCR obligatorio por código (`origen: "automatico"`)

No se depende de que el modelo llame a `leer_digitos_ocr`. Una sola vez por análisis, al llegar la primera respuesta final con datos (o antes de `guardar_factura`, para no guardar dígitos mal leídos):

- **Clave**: si el modelo no leyó la clave con OCR y aún no hay candidato, el código lee la zona `clave` y, si no aparece una de 50 dígitos, la zona `encabezado`.
- **Emisor y receptor**: lee las zonas `emisor` y `receptor`, salvo que el modelo ya lo haya hecho. Busca el número de **exactamente 6 dígitos** que sigue a "Actividad" y la identificación (9-12 dígitos) que sigue a "Cédula", en la misma línea.
  - Si difieren del modelo, se usan los del OCR, con una nota del tipo "Actividad del receptor tomada del OCR".
  - Si el OCR no encuentra la etiqueta o el número está incompleto, se deja el valor del modelo sin advertencia.
  - Para la cédula del emisor manda la clave del OCR: no se cambia una cédula que la clave confirma ni se pone una que la contradice.
- **Traza**: cada lectura aparece como `tipo: "ocr"` con `origen: "automatico"` y, en emisor y receptor, lo `encontrado`.
- **Respuesta**: incluye `ocrZonas`.
- **Límite**: el máximo de `AGENTE_MAX_OCR` es solo para las lecturas que pide el modelo. Las automáticas son, como mucho, 4.

### Correcciones deterministas (`notas`)

Si la fecha de emisión con día y mes invertidos coincide **exactamente** con el DDMMAA de la clave, y el resto de la clave valida (506, identificación y consecutivo), la fecha se corrige sola. Por ejemplo: `2026-12-11` con la clave `506121126…` pasa a `2026-11-12`. Se informa en `notas`, no en `advertencias`; el frontend lo muestra como aviso informativo.

## Generación inversa: texto → factura FWD (`services/generadorFactura.js`)

`POST /api/facturas/generar` con `{ texto, sessionId? }`. Ejemplo: *"Factúrale a Ana Mora, cédula 1-2345-6789, el bootcamp Full Stack módulo 1 por 350 mil con IVA 2% y un kit de bienvenida de 12 mil con IVA 13%, pagó por SINPE"*.

| Paso | Quién | Qué |
|---|---|---|
| Extracción | Modelo (solo texto, JSON) | Receptor, líneas (descripción, cantidad, tipo servicio/producto, precio, descuento, tarifa, CABYS), condición, plazo, medios de pago, moneda y fecha. **Solo lo que dijo el usuario; no calcula.** Se aplica una lista blanca: cualquier total que devuelva se descarta. |
| Datos obligatorios | Código | Receptor (nombre y cédula de 9-12 dígitos), precio de cada línea, tarifa válida, plazo si es a crédito, tipo de cambio si no es CRC. Si falta algo, devuelve `estado: "faltan_datos"` con una pregunta y guarda un **borrador** en la memoria del `sessionId`. La siguiente respuesta con el mismo `sessionId` lo completa. |
| Valores por defecto | Código | Emisor de `config/emisor.json`, fecha y hora de Costa Rica, CRC, Contado, `Sp` para servicios y `Unid` para productos, IVA 13 % y Efectivo si no se dicen. Cada valor por defecto aplicado se informa en `supuestos`. |
| Cálculo | Código (redondeo a 2 decimales) | Montos de cada línea, resumen (servicios / mercancías según la unidad), desglose por tarifa (13 %=08, 4 %=04, 2 %=03, 1 %=02, 0 %=01) y total. |
| Consecutivo | Código | `001` + `00001` + `01` + el siguiente número libre del emisor en la tabla `facturas`. Si otro proceso toma el mismo, se reintenta. Sin MySQL, el consecutivo es provisional y no se guarda. |
| Clave | Código | `506` + DDMMAA + cédula del emisor (12) + consecutivo + `1` + 8 dígitos aleatorios (50 en total). |
| Validación | Código | `validarFactura` debe dar **cero advertencias**; si no, se lanza una excepción, porque sería un error del código. |
| Guardado | `guardar_factura` | Con `origen: "generada"` (columna nueva). La memoria recibe el resumen, así el chat puede responder sobre las facturas generadas. |

Los datos de `config/emisor.json` (cédula, actividad, correo...) vienen de la factura de referencia; reemplazalos por los reales. La columna `origen` es nueva: si las tablas ya existían, arrancá una vez con `DB_SYNC_ALTER=true`.

En el frontend, la sección **"Generar factura"** del menú muestra la factura con `FacturaImprimible.jsx`:

- tamaño carta, con el logo oficial (`public/fwd-logo.png`, rasterizado del brand book) y la paleta de marca;
- Figtree para el cuerpo y Barlow Condensed como sustituto de Mundial Narrow;
- flechas en SVG y montos con formato `370.560,00`;
- siempre la franja **"DOCUMENTO DE PRUEBA · SIN VALIDEZ FISCAL"**, porque el sistema no firma el XML ni lo envía a Hacienda.

Debajo de la factura hay tres botones:

- **Descargar PDF**: `window.print()` con `@media print`, en tamaño carta.
- **Descargar PNG**: `html-to-image`, con `pixelRatio: 2`.
- **Probar con el agente de visión**: convierte la factura a PNG, la pasa por `/api/facturas/analizar` y lista los campos que el agente leyó distinto.

## 1. Uso de herramientas (function calling)

`services/agentTools.js` define las tools en formato OpenAI y su implementación:

- **buscar_factura**: por clave, consecutivo, identificación o nombre del emisor (o solo las de la sesión). Devuelve las coincidencias y `totales_por_moneda` (`cantidad`, `total_comprobante`, `total_impuesto`).
- **consultar_proveedor**: por `identificacion`. Primero busca en MySQL. Si `PROVEEDORES_API_URL` está definida, hace `GET {URL}?identificacion=XXX` con timeout (p. ej. `https://api.hacienda.go.cr/fe/ae`). Si lo encuentra, marca al proveedor como `verificado` y completa su nombre, tipo de identificación y actividad.
- **guardar_factura**: en **una transacción**:
  - rechaza el duplicado por clave (antes de tocar el proveedor);
  - hace `findOrCreate` del proveedor por identificación y **completa los campos que le falten**;
  - rechaza el duplicado por consecutivo + emisor;
  - guarda el comprobante con todos sus campos y `advertencias`, y las líneas con `impuestos` (JSON con exoneraciones) y `tarifa_iva`.

  Los importes como `"27.120,00"` o `"1.234"` (miles en Costa Rica) se convierten a número.

Se envían con `tool_choice: "auto"`: **el modelo decide** cuándo usarlas. El backend las ejecuta y devuelve el resultado en un mensaje `role: "tool"`. `ejecutarTool()` nunca lanza una excepción: si MySQL está apagado, devuelve `{ ok: false, error }`.

## 2. Razonamiento en varios pasos

Cada paso es una llamada al modelo: **observar** (historial + imagen) → **decidir** (tools o respuesta final) → **actuar** (ejecutar las tools y volver a observar).

- El primer análisis va con `detail: "low"`.
- `solicitar_mayor_detalle`: el backend reinyecta **la misma imagen** en `high` después de los mensajes `tool`. La copia en `low` se sustituye por un texto.
- `solicitar_nueva_imagen`: termina con `estado: "requiere_nueva_imagen"`, `motivo` y `recomendaciones`.
- **Red de seguridad en código**: se reintenta **una sola vez** en `high` si la respuesta todavía se analizó en `low` y se cumple alguna de estas condiciones:
  - `confianza < AGENTE_UMBRAL_CONFIANZA`;
  - `calidad_imagen: "mala"`;
  - `campos_ilegibles` no está vacío;
  - **`validarFactura` encontró inconsistencias**. En ese caso, el mensaje del reintento incluye la lista concreta, por ejemplo: "La clave debe tener 50 dígitos y tiene 49…".
- La respuesta de la API incluye las `advertencias` de la respuesta final.

## 3. Memoria

`services/memoryService.js` (`nuevaSesion`, `guardar`, `cargar`, `borrar`, `construirContexto`, `resumirFactura`) sobre el modelo `MemoriaAgente`.

- En cada llamada se cargan los últimos `AGENTE_MAX_RECUERDOS` de la sesión y se inyectan en el system prompt.
- Al terminar se guardan la instrucción, un **resumen de texto** del comprobante y la respuesta. El resumen incluye tipo, consecutivo, emisor con cédula, receptor, total con moneda, impuestos, número de líneas y clave. **La imagen nunca se guarda.**
- Si MySQL falla, la memoria pasa a un `Map` en RAM y **vuelve a probar MySQL cada `MEMORIA_REINTENTO_MS` (60 s)**. Cuando MySQL responde, se le pasan los recuerdos que se guardaron en RAM.
- Si no llega un `sessionId`, se genera con `crypto.randomUUID()`.

## Base de datos

- `config/config.js` (sustituye a `config.json`) lee `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_HOST` y `DB_PORT` del `.env`. `.sequelizerc` apunta a ese archivo.
- Al arrancar: `authenticate()` y `sync({ alter: process.env.DB_SYNC_ALTER === 'true' })`. Si fallan, el servidor arranca igual con un aviso.
- **Actualizar desde la versión anterior**: arranca una vez con `DB_SYNC_ALTER=true`. Antes de `sync`, `services/migracionLegado.js` renombra las columnas antiguas (`nif_rfc → identificacion`, `numero_factura → numero_consecutivo`, `total → total_comprobante`, …) y elimina el índice único antiguo. Sin ese paso, `alter` borraría esas columnas y, con ellas, sus datos, y MySQL dejaría `UNIQUE(proveedor_id)`. Después vuelve a poner `DB_SYNC_ALTER=false`.

## Endpoints

| Método | Ruta | Uso |
|---|---|---|
| POST | `/api/facturas/analizar` | FormData: `factura`, `instruccion?`, `sessionId?` |
| POST | `/api/agente/chat` | `{ sessionId, mensaje }`, sin imagen |
| GET | `/api/agente/sesiones/:id/memoria` | Ver los recuerdos de una sesión |
| DELETE | `/api/agente/sesiones/:id` | Borrar la memoria de una sesión |
| GET | `/api/facturas` | Comprobantes guardados (`?sessionId=&limite=`) |
| GET | `/api/health` | Estado del servidor, de la BD y del modo de memoria |

## Frontend

`FacturaElectronicaView.jsx` muestra el comprobante completo, con los montos en formato es-CR:

- encabezado y tarjetas del emisor y del receptor;
- detalle con scroll horizontal (CABYS, IVA %, exoneración…);
- otros cargos;
- resumen con el total resaltado, desglose de impuestos y medios de pago;
- referencias, leyendas y JSON plegable;
- advertencias y campos ilegibles.

## Pruebas

```bash
npm test
```

`test/agente.test.js` simula `fetch` (las respuestas de OpenAI) y los modelos, sin red ni MySQL. Tiene 13 pruebas:

- **Agente:**
  - (a) el modelo pide más detalle y luego guarda;
  - (b) la regla automática reintenta en `high`, y solo una vez;
  - (c) una pregunta de seguimiento usa la memoria;
  - un duplicado por consecutivo + emisor se rechaza;
  - una tool devuelve el error cuando MySQL está caído;
  - se borra la memoria.
- **Comprobante v4.4:**
  - `validarFactura` no da advertencias con un comprobante correcto;
  - una clave incompleta y un total que no cuadra disparan el reintento en `high` con la lista de inconsistencias;
  - se rechaza un duplicado por clave;
  - `parsearImporte("1.234") = 1234` y `parsearImporte("1.234,50") = 1234.5`.
- **Memoria:** vuelve a MySQL cuando este responde.
