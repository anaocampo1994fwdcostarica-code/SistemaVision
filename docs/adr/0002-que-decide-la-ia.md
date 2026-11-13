# ADR-0002: La IA extrae y registra los datos de la factura; nunca paga, aprueba, anula ni declara, y los números críticos los valida el código

- Estado: Propuesto
- Fecha: 2026-11-13
- Decide: Aaron, desarrollador de SistemaVision

## Contexto

El agente lee la foto de una factura y decide en varios pasos qué hacer: pedir más resolución, ampliar una zona, leer dígitos con OCR, buscar si la factura ya existe, consultar al proveedor y guardar la factura en MySQL. Lo que produce afecta la contabilidad de la organización que usa el sistema y a las personas que aparecen en la factura (emisor y receptor). Un dato mal leído, como un total o una cédula, puede terminar en un registro contable incorrecto.

## Decisión

Lo que la IA **sí** hace:

- Extrae los campos de la factura a un esquema fijo (`ESTRUCTURA_TEXTO` en `BE/services/esquemaFactura.js`).
- Decide qué herramienta usar dentro de un ciclo limitado: más resolución, ampliar zonas, OCR, buscar duplicados, consultar al proveedor.
- Llama a `guardar_factura` para registrar la factura en MySQL cuando considera que la lectura es confiable y no está duplicada, salvo que el usuario escriba en la instrucción que no guarde.
- Responde preguntas sobre las facturas de la sesión usando la memoria.

Lo que la IA **nunca** hace, porque no tiene ninguna herramienta para ello:

- No paga, no aprueba pagos, no anula ni modifica facturas ya guardadas y no borra registros.
- No envía nada a Hacienda ni a ningún sistema contable externo.
- No puntúa ni clasifica a proveedores o clientes.

Controles que no dependen de la IA:

- `validarFactura` revisa largos de clave, consecutivo y CABYS, el cuadre de cada línea y de los totales, y la coherencia de la clave con la fecha, la cédula y el consecutivo.
- La reconciliación con el OCR local corrige la clave, el consecutivo y la fecha cuando el modelo los lee mal, y lo informa en «notas».
- `guardar_factura` rechaza duplicados por clave (o por consecutivo y emisor).
- La pantalla muestra al usuario los datos extraídos, las advertencias, las notas y los pasos del agente después de cada análisis.

Pendiente: hoy la factura se guarda **antes** de que una persona la revise. Este ADR queda en estado Propuesto hasta agregar un paso de confirmación: que el agente deje la factura en estado «borrador» y solo pase a «registrada» cuando el usuario pulse **Confirmar**.

## Alternativas descartadas

- Dejar que la IA guarde y además marque la factura como aprobada para pago: un error de lectura pasaría directo a un pago; el pago siempre es decisión de una persona.
- Aceptar los totales y la clave tal como los devuelve el modelo: en las pruebas reales el modelo se saltó dígitos de la clave e invirtió día y mes, así que esos campos los valida el código.
- Que la IA no guarde nada y solo muestre el resultado: es lo más seguro, pero obliga a reescribir a mano cada factura; se prefiere el modelo de borrador más confirmación (pendiente).

## Consecuencias

- Mantener a una persona en el ciclo cuesta un clic por factura, pero evita que una lectura equivocada termine en la contabilidad sin que nadie la vea.
- Mientras no exista la confirmación, una factura mal leída puede quedar guardada con advertencias; hay que revisarlas en la pantalla o en `facturas.advertencias`.
- Como la IA no tiene herramientas para borrar, pagar ni enviar a Hacienda, un ataque de inyección de instrucciones en la imagen no puede ejecutar esas acciones.

## Cómo se verifica

- La lista de herramientas está en `BE/services/agentTools.js` (`definicionesTools`): ninguna borra, paga, actualiza facturas existentes ni llama a Hacienda para declarar.
- Las pruebas de `BE/test/agente.test.js` comprueban el rechazo de duplicados por clave, que una clave incompleta o un total que no cuadra disparan el reintento, y la reconciliación con el OCR.
- Las advertencias quedan guardadas en la columna `facturas.advertencias` y se muestran en `FacturaElectronicaView.jsx`.
- Pendiente: una prueba que compruebe que `guardar_factura` crea la factura en estado «borrador» y que solo la acción del usuario la cambia a «registrada».
