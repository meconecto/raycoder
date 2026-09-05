# ADR 0013 — UI local accionable y actividad proyectada

## Estado

Aceptado.

## Contexto

El core ya persiste sesiones, eventos, diagnósticos, intentos de preparación e integración, pero la
interfaz original sólo mostraba operaciones activas e interrumpidas. Una sesión terminal con
`quota_exhausted` quedaba reducida al estado del hilo `error`, mostrado con el color genérico de un
estado activo. El detalle durable existía en SQLite pero no era visible ni recuperable desde la UI.

La interfaz también concentraba navegación, red, render y eventos en un único módulo, usaba textos
solamente en inglés y tenía tema oscuro fijo. Agregar observabilidad no debe crear una segunda
máquina de estados ni permitir que el frontend decida transiciones de dominio.

## Decisión

- La UI continúa siendo HTML, CSS y módulos JavaScript estáticos, divididos por estado/API,
  internacionalización, componentes y vistas. No se introduce un framework frontend.
- La navegación principal es híbrida: vistas de trabajo estables más un progreso compacto y una
  siguiente acción derivada del snapshot durable.
- `GlobalConfig` v3 incorpora preferencias `locale: auto|es|en` y
  `theme: system|light|dark`, con lectura compatible de v1 y v2.
- Los errores se presentan mediante un catálogo local por código. El código y el detalle original
  sanitizado siempre permanecen accesibles; acciones y enlaces son identificadores allowlisteados.
- La actividad es una proyección de fuentes durables existentes. No puede persistir ni decidir
  transiciones de tickets, planificación, preparación o integración.
- El registro global conserva sólo un resumen de atención de última observación para poder mostrar
  proyectos cerrados. No se incorpora estado de leído, dismiss ni telemetría.
- Un reintento de sesión `error` crea una sesión nueva con `retry_of_session_id`; `resume` queda
  reservado para recuperación de sesiones `interrupted` cuando el adapter la soporta.

## Consecuencias

La causa y recuperación de un error permanecen visibles tras refresh o reapertura. Las vistas
pueden evolucionar sin volver a concentrar toda la aplicación en un archivo, mientras el core
continúa siendo la única autoridad de lifecycle. Cambiar de v2 a v3 no reescribe la configuración
hasta que el usuario modifica una preferencia o ajuste.
