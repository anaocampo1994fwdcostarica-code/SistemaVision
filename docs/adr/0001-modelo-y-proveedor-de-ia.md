# ADR-0001: Usar gpt-4o de OpenAI, llamado solo desde el backend, para leer las facturas, y Tesseract local para verificar los dígitos

- Estado: Aceptado
- Fecha: 2026-11-13
- Decide: Ana Ocampo, desarrollador de SistemaVision

## Contexto

El sistema tiene que leer fotos de facturas electrónicas v4.4 de Costa Rica y devolver todos sus campos en una estructura fija: encabezado, emisor, receptor, líneas con CABYS e IVA, resumen y medios de pago. Las fotos llegan con distinta calidad y en español, con formato numérico costarricense (punto de miles, coma decimal). El modelo debe soportar imágenes y *function calling* para funcionar como agente. En las pruebas, gpt-4o se equivocó con secuencias largas de dígitos repetidos (clave de 50 dígitos y consecutivo de 20).

## Decisión

- El modelo de visión es **gpt-4o de OpenAI**, configurable con `OPENAI_VISION_MODEL`. Se llama con `fetch` a `https://api.openai.com/v1/chat/completions` **solo desde el servidor**, en `BE/services/visionService.js`.
- La llave está en la variable de entorno `OPENAI_API_KEY` del archivo `BE/.env`, que no se sube al repositorio. El frontend nunca llama a OpenAI.
- El modelo funciona como agente: tiene herramientas (`buscar_factura`, `consultar_proveedor`, `guardar_factura`, `solicitar_mayor_detalle`, `solicitar_nueva_imagen`, `ampliar_zona`, `leer_digitos_ocr`) y un ciclo limitado por `AGENTE_MAX_PASOS` (8), `AGENTE_MAX_AMPLIACIONES` (4) y `AGENTE_MAX_OCR` (6).
- Los dígitos críticos (clave, consecutivo, fecha) se verifican con **Tesseract** (`tesseract.js`), que corre **localmente** en el servidor (`BE/services/ocrService.js`). No envía datos a terceros; solo descarga una vez el archivo de idioma `eng.traineddata`.
- Los totales y la clave no se aceptan solo porque los dice el modelo: pasan por `validarFactura` y por la reconciliación con el OCR (`BE/services/esquemaFactura.js`).

## Alternativas descartadas

- Solo OCR tradicional (Tesseract) sin modelo de lenguaje: lee bien los dígitos, pero no entiende la estructura de la factura (qué número es el subtotal, qué línea es un descuento) ni los distintos diseños.
- Otros modelos multimodales (por ejemplo Claude o Gemini): no se descartan por calidad, sino porque el proyecto ya tenía llave, código y pruebas con OpenAI; cambiar de proveedor queda abierto con un ADR nuevo.
- Llamar al modelo desde el navegador: expondría la llave de API a cualquier usuario.
- Leer el XML firmado de Hacienda en lugar de la imagen: sería más exacto, pero el caso de uso es fotografiar facturas impresas o recibidas en PDF, donde no siempre se tiene el XML.

## Consecuencias

- Se gana la capacidad de leer facturas con diseños distintos y de corregirse en varios pasos.
- Se pierde control sobre dónde se procesan las imágenes: viajan a OpenAI, en Estados Unidos (ver ADR-0003).
- Costo estimado: una factura usa varias llamadas con imágenes en alta resolución; se estima entre US$0,03 y US$0,10 por factura, a confirmar en el panel de uso de OpenAI. Con 300 facturas al mes serían menos de US$30.
- Si OpenAI falla o sube el precio, el análisis se detiene; el OCR local sigue funcionando, pero no basta solo. Pendiente: aislar el proveedor detrás de una interfaz propia para poder cambiarlo.

## Cómo se verifica

- `BE/services/visionService.js` es el único archivo que llama a `api.openai.com`; se puede comprobar con `grep -rn "api.openai.com" BE FE/sistemaVision/src`.
- `BE/.env` está en `.gitignore` y `BE/.env.example` documenta `OPENAI_API_KEY`, `OPENAI_VISION_MODEL` y los límites del agente.
- Las pruebas de `BE/test/agente.test.js` (`npm test`) simulan `fetch` y comprueban los límites de pasos, de ampliaciones y la reconciliación con el OCR.
