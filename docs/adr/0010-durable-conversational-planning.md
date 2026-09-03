# ADR 0010: Planificación conversacional durable y handoffs por artefacto

## Estado

Aceptado para RC4.

## Contexto

RC3 persiste artefactos versionados y confirma tickets antes de crear el DAG, pero la UI todavía
requiere que el usuario escriba JSON y la sesión de planificación no conserva por separado
intención, eventos, estado operativo ni trazabilidad. Tampoco puede distinguir una generación
realmente viva de otra que quedó `running` antes de un reinicio.

RC4 debe convertir conversación, SPEC y tickets en etapas explícitas sin permitir que el adapter
o la UI adquieran autoridad sobre artefactos o lifecycle. También debe seguir siendo útil sin
proveedor y en repositorios sin commit base.

## Decisión

### Hilo, sesiones y concurrencia

Cada base SQLite de proyecto contiene un único hilo de planificación. El hilo resume su estado
como `idle`, `running`, `interrupted` o `error`. Las sesiones asociadas identifican la etapa
(`conversation`, `spec` o `tickets`), el adapter y la sesión opaca del proveedor, la solicitud
durable necesaria para recovery y un estado `idle`, `running`, `completed`, `cancelled`,
`interrupted` o `error`.

Mensajes de usuario, asistente y sistema pueden vincularse a una sesión. Todos los eventos
normalizados del adapter se guardan con secuencia única por sesión antes de que el core derive
un mensaje o un artefacto de ellos. Una única operación de planificación generativa puede estar
activa por proyecto. Enviar, generar y reanudar entra por el `Scheduler`; la cancelación usa su
canal de control sobre la operación activa para no quedar encolada detrás de aquello que debe
interrumpir.

### Handoffs y revisiones

La conversación puede tener varios turnos dentro de su sesión. Cuando el usuario solicita una
SPEC, el core crea una revisión aprobada de `interrogation` que captura los mensajes visibles y
sus ids. Luego abre una sesión nueva de `spec` cuyo único contexto explícito es ese artefacto.
Para generar tickets abre otra sesión y le transfiere solamente la revisión aprobada y vigente
de SPEC.

La forma canónica de SPEC es estructurada (`title`, `summary`, `goals`, `nonGoals`,
`requirements`, `acceptanceCriteria`, `constraints`); la de tickets es una lista de `id`,
`title`, `description` y `predecessorIds`. El proveedor devuelve estas formas como JSON interno,
pero la UI ofrece conversación y campos normales, no un editor JSON. El core valida y normaliza
la salida antes de persistirla.

Cada creación, edición o regeneración produce una fila inmutable nueva con revisión, autor,
timestamps, predecesor de etapa, artefacto reemplazado, sesión fuente y enlaces a los mensajes
fuente. Aprobar afecta una revisión identificada; conserva todas las anteriores y marca como
`superseded` cualquier aprobación previa de la misma etapa.

### Confirmación y reemplazo del DAG

Sólo `confirmTickets` crea tickets. Requiere un artefacto de tickets `approved`, vigente y
acíclico; vuelve a validar el grafo dentro de la operación de dominio antes de persistir. Una
confirmación registra qué revisión creó el DAG.

Una confirmación posterior puede reemplazar únicamente los tickets pertenecientes a la
confirmación previa si todos siguen en `READY` o `QUEUED`. Si alguno arrancó, si existe trabajo
ajeno que colisiona o si la revisión dejó de ser la aprobada vigente, la operación falla sin
cambiar tickets ni dependencias. Los tickets heredados de RC3 no se atribuyen retroactivamente a
un plan y nunca se borran durante este reemplazo.

### Recovery y observabilidad

Al abrir el runtime, toda sesión de planificación `running` pasa a `interrupted` y el hilo refleja
ese estado. No se consulta ni se presume un proceso externo vivo. Si el adapter declara sesiones
reanudables y hay id opaco, el core inicia una sesión de reanudación y continúa la solicitud
persistida; si no, responde con un error de dominio accionable. Cancelar una sesión interrumpida
la cierra localmente y permite iniciar una nueva sin borrar el historial.

La API expone snapshots durables de hilo, mensajes, sesiones, eventos, artefactos y recovery. La
UI consulta esos snapshots durante una operación; no se adopta streaming en RC4 porque el polling
de una fuente durable cubre progreso y reconexión con menos estados transitorios.

Sin proveedor, las mutaciones estructuradas, aprobaciones, confirmación y lectura siguen
disponibles; sólo se rechazan las operaciones generativas. La falta de `HEAD` bloquea ejecución
de tickets, no planificación.

## Consecuencias

- Adapter y UI siguen sin persistir estados ni crear el DAG.
- Una reconexión puede reconstruir exactamente qué pidió el usuario y qué alcanzó a emitir el
  proveedor.
- La trazabilidad y el reemplazo seguro agregan migraciones, pero las bases RC3 se actualizan sin
  reescribir sus artefactos ni tickets existentes.
- El polling puede tener hasta un intervalo corto de latencia visual; los eventos ya persistidos
  no se pierden si el navegador o el servidor se reinician.
- Regenerar una etapa no recibe silenciosamente su borrador anterior: las correcciones deben
  incorporarse a la conversación o hacerse por el formulario estructurado.
