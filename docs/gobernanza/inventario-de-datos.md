# Inventario de datos

No se puede gobernar lo que no se sabe que se tiene. Una fila por cada dato que el sistema guarda, recibe o envía a un tercero, incluido el proveedor del modelo de IA.

Sistema: **SistemaVision**, un agente que lee fotos de facturas electrónicas de Costa Rica (v4.4 de Hacienda), extrae sus datos y los registra en MySQL. No tiene cuentas de usuario: cada navegador tiene un `sessionId` aleatorio.

| Dato | ¿Personal? | Categoría (Ley 8968, art. 9) | De dónde viene | Dónde se guarda | ¿Sale a un tercero? ¿A quién? | Cuánto se conserva | Quién puede verlo |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Imagen de la factura | Sí | Acceso restringido | La sube el usuario desde el frontend | Solo en memoria del servidor durante el análisis (multer `memoryStorage`); no se escribe en disco ni en la BD | Sí: OpenAI (gpt-4o), completa y en recortes ampliados, para extraer los datos | Lo que dura la petición; OpenAI la puede retener según su política de API | El usuario que la sube y el proceso del servidor |
| Nombre del emisor (proveedor) | Sí | Acceso restringido | Leído de la factura por la IA | MySQL, tabla `proveedores` (`nombre`, `nombre_comercial`) | Sí: OpenAI, dentro de la imagen y del resumen de memoria | Indefinido: no hay borrado automático | Cualquiera con acceso a la API `/api/facturas` (sin autenticación) |
| Identificación del emisor (cédula física, jurídica, DIMEX o NITE) | Sí | Acceso restringido | Leído de la factura por la IA y por el OCR | MySQL, `proveedores.identificacion` | Sí: OpenAI; y Hacienda (`PROVEEDORES_API_URL`) si está configurado, para verificar al proveedor | Indefinido | Cualquiera con acceso a la API |
| Teléfono, correo y ubicación del emisor | Sí | Acceso restringido | Leído de la factura por la IA | MySQL, `proveedores` (`telefono`, `correo`, `ubicacion`) | Sí: OpenAI, dentro de la imagen | Indefinido | Cualquiera con acceso a la API |
| Nombre, identificación y correo del receptor | Sí | Acceso restringido | Leído de la factura por la IA | MySQL, `facturas` (`receptor_nombre`, `receptor_identificacion`, `receptor_correo`, `receptor_datos`) | Sí: OpenAI, dentro de la imagen y del resumen de memoria | Indefinido | Cualquiera con acceso a la API |
| Detalle de la compra (descripción de productos y servicios, montos, IVA, medio de pago) | Sí | Acceso restringido | Leído de la factura por la IA | MySQL, `factura_items` y `facturas` (totales, `medios_pago`, `datos_crudos`) | Sí: OpenAI | Indefinido | Cualquiera con acceso a la API |
| Clave numérica y consecutivo de la factura | No | No aplica | Leído de la factura por la IA y por el OCR (Tesseract, local) | MySQL, `facturas` (`clave`, `numero_consecutivo`) | Sí: OpenAI, dentro de la imagen | Indefinido | Cualquiera con acceso a la API |
| Memoria de la sesión (instrucciones del usuario y resúmenes de facturas con nombres, cédulas y totales) | Sí | Acceso restringido | La genera el agente en cada análisis o pregunta | MySQL, tabla `memoria_agente`; en RAM si MySQL no responde | Sí: OpenAI, porque se inyecta en el prompt de sistema de cada llamada de esa sesión | Hasta que se llame a `DELETE /api/agente/sesiones/:id` (botón «Reiniciar memoria») | Quien conozca el `sessionId` |
| Identificador de sesión (`sessionId`) | No | No aplica | Lo genera el servidor con `crypto.randomUUID()` | `localStorage` del navegador y MySQL (`memoria_agente.session_id`, `facturas.session_id`) | No | Hasta que el usuario reinicia la memoria o borra su navegador | El usuario en su navegador |

## Lo que NO recolectamos

- Cuentas de usuario, contraseñas o correos de quien usa el sistema: no hay inicio de sesión; la sesión es un UUID aleatorio.
- La imagen original de la factura en disco o en la BD: solo se procesa en memoria; en la memoria del agente se guarda un resumen de texto, nunca el base64.
- Números de tarjeta, cuentas bancarias o firmas digitales: el agente solo registra el *tipo* de medio de pago (por ejemplo «SINPE Móvil») y su monto.
- El XML firmado de Hacienda: el sistema trabaja con la representación gráfica (foto o PDF convertido a imagen), no con el comprobante firmado.
