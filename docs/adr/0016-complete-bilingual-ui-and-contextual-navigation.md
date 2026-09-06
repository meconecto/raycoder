# ADR 0016: interfaz bilingüe completa y navegación contextual

## Estado

Aceptado.

## Contexto

La primera capa de preferencias globales localizó sólo el chrome principal. Las vistas dinámicas
conservaron literales en inglés, el progreso se renderizó como elementos no interactivos y el
polling de planificación reemplazó el DOM completo. Eso dejó una selección de idioma parcial,
perdió la posición de lectura y obligó a usar el mouse para enviar mensajes. Los eventos de comando
también se reducían a su tipo normalizado, ocultando la evidencia útil que ya estaba persistida.

## Decisión

La UI conserva HTML, CSS y JavaScript estáticos, pero todo texto propio se obtiene de catálogos
simétricos español/inglés. Los helpers de presentación resuelven interpolación, plurales y etiquetas
de estados, etapas, roles y eventos. El contenido del usuario o proveedor y la evidencia técnica
—comandos, rutas, herramientas, códigos y salida cruda— no se traducen ni se reinterpretan.

El progreso se representa con botones accesibles. Cada etapa navega hacia la vista y el ancla
contextual existentes; una etapa pendiente sigue habilitada y explica qué falta. No se crean nuevas
fuentes de estado en el navegador: estado, atención y siguiente acción se derivan del snapshot
durable.

La vista de planificación separa su estructura estable de las regiones vivas. El polling actualiza
transcript, operación y errores sin reemplazar el compositor ni los editores. El transcript sigue el
final sólo mientras el usuario permanece cerca de él; de otro modo conserva el scroll y anuncia
mensajes nuevos. El compositor usa submit de formulario: Enter envía, Shift+Enter agrega una línea,
IME queda protegido y una solicitud pendiente no puede duplicarse.

Los eventos se formatean por tipo. Los comandos presentan comando, directorio y resultado cuando
existen; eventos desconocidos conservan su tipo crudo. El detalle durable permanece disponible y
los duplicados visuales exactos pueden compactarse sin modificar el journal.

## Consecuencias

- Cambiar de idioma actualiza toda la interfaz sin alterar contenido ni diagnósticos persistidos.
- La navegación de alto nivel funciona con mouse y teclado aun para etapas futuras.
- El polling deja de interferir con la escritura y la lectura de conversaciones largas.
- Los catálogos y una comprobación automática previenen regresiones de localización.
- No se agregan endpoints, migraciones ni autoridad de dominio a la UI.
