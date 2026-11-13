# ADR-0003: Los datos de las facturas viven en un MySQL local; a OpenAI solo se envían la imagen y el resumen de la sesión, y la imagen nunca se guarda

- Estado: Propuesto
- Fecha: 2026-11-13
- Decide: Ana Ocampo, desarrollador de SistemaVision

## Contexto

Según el inventario de datos, el sistema maneja datos personales de acceso restringido: nombres, cédulas, teléfonos, correos y ubicaciones de emisores y receptores, y el detalle de sus compras. Usa tres servicios fuera del servidor: OpenAI (análisis de la imagen), opcionalmente el API de Hacienda (verificar proveedores) y la descarga única del archivo de idioma de Tesseract. Hoy el sistema corre en la computadora del desarrollador, sin autenticación.

## Decisión

- Los datos estructurados viven en **MySQL en el mismo equipo del backend** (`127.0.0.1`, base `database_development`), en las tablas `proveedores`, `facturas`, `factura_items` y `memoria_agente`. Las credenciales de la base están en variables de entorno (`DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_HOST`), no en el repositorio.
- La **imagen** de la factura se procesa solo en memoria (multer `memoryStorage`) y **nunca** se escribe en disco ni en la base.
- A **OpenAI** se envían: la imagen (completa y en recortes ampliados) y el prompt de sistema con el resumen de la memoria de esa sesión. No se envían datos de otras sesiones.
- El **OCR** corre local con Tesseract: los recortes de la imagen no salen del servidor.
- Al **API de Hacienda** solo se envía la identificación del emisor, y solo si `PROVEEDORES_API_URL` está configurado.
- La memoria de una sesión se borra con `DELETE /api/agente/sesiones/:id` (botón «Reiniciar memoria»). Las facturas y los proveedores no tienen borrado automático.

## Alternativas descartadas

- Guardar la imagen original para auditoría: sería útil para revisar lecturas, pero multiplica los datos personales guardados sin un plazo de borrado definido.
- Una base de datos en la nube: no hace falta para un prototipo local y agregaría otra transferencia de datos a un tercero.
- Enviar a OpenAI todo el historial de facturas guardadas: daría más contexto, pero enviaría datos de personas que no tienen que ver con la factura actual.

## Consecuencias

- Ley 8968: enviar la imagen a OpenAI es una **transferencia internacional** de datos personales (Estados Unidos). Pendiente: informar al usuario en la pantalla de carga que la imagen se envía a OpenAI, y contar con el consentimiento de las personas cuyos datos aparecen, o con otra base legal.
- Derechos de acceso y supresión: hoy no hay una forma, desde la aplicación, de borrar una factura o un proveedor guardados. Pendiente: un endpoint de supresión y un plazo de conservación.
- Una factura puede revelar datos sensibles (por ejemplo, servicios médicos en el detalle). Hoy se clasifican como acceso restringido. Pendiente: decidir si esas facturas se excluyen o se marcan.
- La API no tiene autenticación y usa CORS abierto: sirve solo mientras corra en la computadora del desarrollador. Antes de publicarla hace falta autenticación (ver el registro de riesgos).

## Cómo se verifica

- `BE/index.js` configura multer con `multer.memoryStorage()`.
- Los modelos `BE/models/*.js` definen las cuatro tablas, y la configuración de la base lee las variables `DB_*` del entorno.
- `BE/services/memoryService.js` guarda solo texto: los data URI y el base64 se eliminan antes de guardar.
- `BE/services/ocrService.js` usa `tesseract.js` localmente y guarda en caché el idioma en `BE/.cache/tesseract`.
