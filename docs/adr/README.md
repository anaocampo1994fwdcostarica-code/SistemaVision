# Registro de decisiones de arquitectura (ADR)

Cada decisión que no es obvia queda escrita aquí: qué se decidió, por qué, qué se descartó y qué consecuencias tiene.

**Regla de oro:** un ADR aceptado no se edita. Si la decisión cambia, se escribe uno nuevo que lo reemplaza, y el anterior pasa a «Reemplazado por ADR-XXXX».

| ADR | Decisión | Estado |
| --- | --- | --- |
| [0001](0001-modelo-y-proveedor-de-ia.md) | gpt-4o de OpenAI desde el backend, más Tesseract local | Aceptado |
| [0002](0002-que-decide-la-ia.md) | La IA extrae y registra; nunca paga, aprueba ni declara | Propuesto |
| [0003](0003-donde-viven-los-datos.md) | MySQL local; a OpenAI solo la imagen y el resumen de la sesión | Propuesto |

Origen del formato: Michael Nygard, [Documenting Architecture Decisions](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions) (2011). Plantilla abierta de referencia: [MADR](https://adr.github.io/madr/).
