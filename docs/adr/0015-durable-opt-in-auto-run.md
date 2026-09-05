# ADR 0015: ejecución Auto durable y opt-in

## Estado

Aceptado.

## Contexto

El scheduler ya serializa planificación, preparación, implementación, verificación e integración
por proyecto. Su helper `runUntilIdle` no constituye un modo de producto: no guarda intención,
estado ni causa de detención, y podría reanudarse accidentalmente al reconstruir un runtime. Auto
debe ahorrar interacción repetitiva sin convertir una confirmación de DAG en autorización para
ejecutar trabajo futuro.

## Decisión

Auto es un coordinador de dominio por proyecto, por encima del `Scheduler` existente y sin caminos
alternativos hacia el dispatcher. Crear una corrida mediante `Start` es la única forma de activarlo.
La selección del próximo ticket se recalcula desde el DAG durable y se ordena por `created_at, id`;
sólo son elegibles tickets `READY` con todos sus predecesores `DONE`.

SQLite v9 agrega corridas y un journal secuencial de eventos. Una corrida conserva estado
`RUNNING`, `PAUSED`, `STOPPED` o `COMPLETED`, ticket activo, política dirty, motivo de pausa o
finalización y timestamps. Los eventos registran inicio y resultado de cada ticket, además de
pausas, reanudaciones, detenciones y finalización. La configuración de proyecto guarda únicamente
si Auto permanece activado; no guarda credenciales ni aprobaciones efímeras.

El loop es cooperativo. `Pause` o `Stop` nunca cancelan una operación de ticket que ya comenzó y se
aplican antes de elegir el siguiente. Una intervención manual, un cambio de configuración de
preparación/verificación/proveedor o el reemplazo del DAG pausa la corrida antes de la mutación. Las
aprobaciones de workspace pueden acompañar `Start` o `Resume` y recorren los servicios existentes;
Auto no crea una vía de autorización propia.

Una corrida se pausa, sin saltar al siguiente ticket, cuando una operación espera aprobación o
confirmación, termina en `BLOCKED`, `FAILED`, `CANCELLED` o `INTERRUPTED`, o produce un error de
proveedor, preparación, verificación o integración. Sólo termina `COMPLETED` cuando no quedan
tickets `READY` ni `QUEUED` ni estados operativos en curso. No hay reintentos automáticos.

Durante recovery, una corrida `RUNNING` pasa a `PAUSED` con motivo `restart_required`, se limpia su
ticket activo lógico y exige `Resume` explícito. Esto es independiente de la reconciliación del
lifecycle del ticket y nunca interpreta SQLite como evidencia de vida externa.

La API expone snapshot y acciones semánticas `start`, `pause`, `resume` y `stop`. El trabajo corre
en background después de haber persistido la corrida, y la UI continúa usando polling durable.

## Consecuencias

- Manual sigue siendo seguro y predecible por defecto.
- Auto hereda todas las garantías de scheduler, preparación, verificación e integración.
- Reinicios y errores conservan una explicación trazable y nunca disparan trabajo por sí solos.
- Pause/Stop no son cancelación; cancelar el ticket sigue siendo una acción manual separada.
- El journal permite proyectar cola, actividad y diagnósticos sin estado autoritativo en el browser.
