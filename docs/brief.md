# raycoder — brief v24 (interfaz bilingüe e interacción accesible)

## Qué es esto

raycoder es una herramienta de código abierto (proyecto de GitHub, licencia AGPL) que arma código a partir de una idea descrita en lenguaje natural, usando un flujo de interrogación → spec → tickets con dependencias → implementación con TDD → revisión, corriendo local, aprovechando las suscripciones que el usuario ya tiene.

**No** es una versión simplificada tipo Lovable para gente sin conocimiento de programación. Es para un rango de usuarios que va desde vos mismo, pasando por alguien que programa profesionalmente, hasta alguien que entiende de programación lo suficiente para tomar decisiones técnicas puntuales pero no para construir el proyecto entero solo.

**Meta-objetivo de esta primera etapa:** construir una base sólida en modo avanzado, para poder seguir desarrollando el resto de raycoder *usando raycoder sobre su propio repositorio* (dogfooding). El hito decisivo no es "raycoder puede correr un agente" — es: **raycoder puede ejecutar un ticket, morir en cualquier punto, volver a arrancar, y saber exactamente qué pasó, qué cambió y qué debe hacer a continuación, sin poner en riesgo el repo.**

La forma canónica del ciclo completo:

```
branch base canónica → workspace aislado del ticket → revisión →
integración automática si reconcilia limpio → DONE → desbloquea descendientes
```

## Licencia

**AGPL.**

## Plataformas

Windows, macOS y Linux. Cada adapter debe encapsular las diferencias y limitaciones de plataforma de su proveedor; una limitación de un proveedor futuro no condiciona el motor ni bloquea la primera integración.

## Cómo se accede

Servidor local que se levanta con un comando de terminal, se usa desde el navegador. Nada de Electron/Tauri.

## Gestor de paquetes

**pnpm** — para el desarrollo de raycoder mismo. No es requisito para el usuario final que corre `npx raycoder`.

## Cómo se instala y corre

`npx` sigue siendo la vía cero-instalación y el bootstrap del instalador user-local. La entrada
pública recomendada para una versión estable es `npx raycoder@latest install`; una prerelease o
reproducción exacta usa `npx raycoder@<versión-exacta> install`. No se usa `npm -g`, no se
requieren privilegios de administrador y no se descargan ni ejecutan scripts remotos fuera del
paquete resuelto por npm.

```text
npx raycoder@latest install [--no-shortcut]
npx raycoder@<versión-exacta> install [--no-shortcut]
raycoder update
raycoder rollback
raycoder uninstall

npx raycoder [project-directory] [--port <0-65535>] [--no-open]
npx raycoder doctor [project-directory]
npx raycoder cleanup --global
```

La instalación persistente mantiene un launcher público estable en `~/.raycoder/bin` y el mismo
comando `raycoder` después de cada actualización. Los runtimes se guardan internamente por
versión. Un puntero `current` se reemplaza de forma atómica sólo después de instalar en staging y
validar `raycoder --version`; nunca se sobrescribe un runtime que pueda estar ejecutándose. Tras
una activación exitosa se conservan únicamente la versión activa y la anterior, que sirve para
`rollback`.

El instalador agrega el launcher al entorno de usuario sin elevar privilegios y crea por defecto
un acceso apropiado para la plataforma: menú Inicio en Windows, `~/Applications` en macOS y una
entrada `.desktop` de usuario en Linux. `--no-shortcut` omite ese acceso. Si hay una instancia
raycoder activa, `update`, `rollback` y `uninstall` se rehúsan a operar con un diagnóstico; el
usuario debe cerrar la aplicación primero.

Una sola instancia global administra varios proyectos. Sin ruta se abre el selector sin elegir ni abrir automáticamente ninguno; con ruta se abre el repo válido o se precarga el wizard. El puerto se resuelve como `--port` → `RAYCODER_PORT` → `4317`: un puerto explícito ocupado falla, mientras que el default ocupado cae a uno libre del sistema. Una segunda invocación compatible reutiliza la instancia viva; una versión distinta informa su URL y requiere cerrarla sin matar el proceso. La URL siempre se imprime y `--no-open` desactiva el navegador.

## Preflight check, antes de cada arranque del servidor

Corre en cada arranque, no toca nada, solo informa:

```
✓ Node 24.x detectado
✓ codex — runtime oficial disponible y sesión de ChatGPT activa
○ claude — adapter todavía no incluido en esta build
○ cursor-agent — adapter todavía no incluido en esta build
○ opencode — adapter todavía no incluido en esta build
✓ engram — instalado
✗ engram — no configurado para codex (`engram setup codex`)
```

**Solo Node 24 es requisito esencial para levantar el servidor local y su interfaz.** Git se diagnostica globalmente y se exige al abrir o crear proyectos, no para mostrar el selector. Fallas individuales de proveedores y la ausencia total de un proveedor ejecutable no bloquean el control plane: deshabilitan las acciones que requieren agentes y se muestran en la UI con diagnóstico accionable. Los proveedores todavía no implementados pueden mostrarse como próximos, pero no participan del resultado de ejecución del preflight.

La incorporación de proveedores es **incremental**. La primera build implementa únicamente Codex. La arquitectura debe permitir llegar después a cuatro o cinco conexiones sin modificar el contrato del core, pero el número y la identidad final de esos proveedores no son una invariante de esta etapa.

## Desinstalación: clara y conservadora

`raycoder uninstall` muestra un inventario exacto y exige confirmación interactiva. Elimina sólo
launchers, runtimes versionados, puntero de activación, metadata propia del instalador, acceso de
usuario y el fragmento de PATH que raycoder haya agregado. Preserva configuración, registro de
proyectos y toda metadata `.raycoder/` local de los proyectos. Nunca lee, inventaría ni copia
credenciales del proveedor. La desinstalación se rehúsa mientras exista una instancia activa.

Los datos preservados en `~/.raycoder/` y los `.raycoder/` de cada proyecto se eliminan únicamente
mediante los flujos de cleanup ya existentes, separados del desinstalador.

La limpieza de un proyecto parte de un inventario con fingerprint y vencimiento, requiere la frase exacta `DELETE <project-name>` y se niega mientras haya scheduler o preview activos. Worktrees dirty, tickets `FAILED`/`INTERRUPTED` y branches no integradas quedan deseleccionados y exigen `force`. Nunca se elimina el checkout principal ni rutas fuera de `.raycoder/workspaces` o `.raycoder/integrations`. El cleanup global exige TTY y `DELETE GLOBAL RAYCODER DATA`, rehúsa operar con una instancia viva y solo borra archivos globales conocidos.

## Modelo Git y workspace

**Cada ticket corre en un workspace físicamente aislado del working tree principal del usuario, asociado a una branch propia** — una branch sola no alcanza; hace falta algo como `git worktree` (o un clone/copy separado). El mecanismo exacto queda a criterio de implementación; la invariante es el aislamiento físico.

Se registra por ticket:
```
ticket.branch · ticket.base_branch · ticket.base_commit · ticket.workspace
```

**Invariante central de ancestry:** todo ticket crea su workspace a partir del **head actual de su `base_branch` en el momento en que pasa a `RUNNING`**. Como sus dependencias deben estar `DONE` antes de que llegue a `READY` (ver DAG), **un ticket nunca necesita nacer de la branch privada de otro ticket** — siempre arranca desde una versión integrada y canónica del proyecto. Stacked branches quedan explícitamente fuera de esta etapa.

- **`base_commit` es central para la reconciliación:** raycoder nunca asume que la branch base sigue igual al integrar. Antes de integrar, reconcilia contra el head actual de la `base_branch`.
- El agente hace los commits de su propio trabajo en la branch del ticket.
- **Repo dirty al crear el workspace de un ticket:** no es una advertencia pasiva — raycoder obliga a una elección explícita: continuar desde el último commit conocido (dejando claro que los cambios sin commitear del usuario *no* estarán incluidos en `base_commit` ni en el workspace del ticket), o cancelar y preparar el repo primero.
- Si un ticket falla, su workspace y su branch quedan intactos para inspección.
- `CHANGES_REQUESTED` vuelve al mismo workspace/branch.

## Metadata local y archivos del usuario

raycoder **no modifica automáticamente archivos versionados del proyecto ni reescribe historia Git del usuario**, fuera de las operaciones explícitas de integración de tickets. Puede mantener metadata local no versionada necesaria para su funcionamiento.

Concretamente: `.raycoder/` se excluye mediante mecanismos **locales no versionados** (`.git/info/exclude` cuando el proyecto es un repo Git) — **raycoder nunca edita el `.gitignore` del usuario**.

El servidor acepta solamente assets estáticos allowlisteados. Las mutaciones validan `Host` y, cuando está presente, `Origin`; CLI y tests locales sin `Origin` siguen habilitados. Los errores HTTP usan `{ error, code, details? }`.

## Interfaz y diagnóstico accionable

La interfaz sigue siendo una aplicación web local liviana, sin framework obligatorio. Su navegación
principal combina las vistas `Overview`, `Plan`, `Tickets` y `Activity` con un progreso compacto
`Idea/Plan → Tickets → Ejecución → Integración`; DAG, sesiones y ajustes permanecen disponibles
como herramientas avanzadas. `Overview` ofrece una siguiente acción derivada exclusivamente del
estado durable, nunca de estado efímero del navegador.

La UI se ofrece íntegramente en español e inglés y respeta por defecto idioma y esquema de color
del sistema. Todos los textos propios de la interfaz —incluidos estados, vacíos, formularios,
diálogos, acciones, ayuda y accesibilidad— pertenecen a catálogos simétricos y extensibles. Los
mensajes del usuario y del proveedor, comandos, rutas, códigos y salida técnica se preservan sin
traducir como evidencia. El usuario puede fijar idioma y tema claro/oscuro; estas preferencias son
globales y se guardan en la configuración propia de raycoder.

El progreso `Idea/Plan → Tickets → Ejecución → Integración` es navegación contextual accesible,
no un indicador inerte: cada etapa abre la vista y sección vigente que permite entender su estado,
lo pendiente y la próxima acción, incluso antes de haber comenzado. Todo control debe ser usable
con teclado, mantener foco visible, exponer estados mediante texto además de color y respetar
movimiento reducido.

La conversación se actualiza por polling sin reconstruir el editor ni perder borrador, foco,
selección o posición de lectura. Sigue los mensajes nuevos sólo cuando el usuario está al final; si
está leyendo mensajes anteriores conserva la posición y ofrece una acción localizada para volver
al final. `Enter` envía, `Shift+Enter` inserta una línea y la composición IME nunca dispara un envío.
Los eventos normalizados muestran un resumen semántico; en particular, un evento de comando
muestra el comando real y su resultado en lugar de una etiqueta genérica repetida.

Un estado `error` nunca se representa como una etiqueta genérica ni desaparece al refrescar. La UI
muestra código durable, explicación localizada, acción permitida y detalle técnico sanitizado. Los
enlaces y acciones se derivan de un catálogo local allowlisteado; datos del proveedor nunca pueden
inyectar comandos ni URLs. Errores desconocidos conservan su código y detalle. La actividad por
proyecto se proyecta desde sesiones, eventos, tickets, preparación e integración ya persistidos;
el selector conserva para proyectos cerrados un resumen de atención de última observación, sin
introducir todavía semántica de leído/no leído.

Reintentar una sesión de planificación fallida crea una sesión durable nueva enlazada a la anterior
y reutiliza su solicitud original. No duplica el mensaje del usuario ni confunde el reintento con la
reanudación opaca de una sesión `interrupted`. Ningún error de cuota, autenticación o proveedor se
reintenta automáticamente.

## Preparación del workspace

Antes de iniciar el agente de implementación, raycoder prepara las dependencias dentro del
workspace aislado del ticket. La preparación es durable, pertenece al core y pasa por el
`Scheduler` del proyecto; el ticket no entra en `RUNNING` hasta que termina exitosamente.

La primera preparación ejecutable de un proyecto requiere aprobación explícita. La UI muestra
las unidades, comandos, posibilidad de red y ejecución de scripts de instalación. La aprobación
se recuerda sólo para el proyecto y para un fingerprint que incluye estrategia, plataforma,
herramientas, manifests, lockfiles y scripts. Un cambio de identidad invalida la aprobación.

Se incluyen estrategias reproducibles para Node (pnpm, npm, Yarn y Bun), Python (uv, Poetry y
Pipenv), Rust/Cargo y Go modules. La autodetección sólo decide cuando hay una estrategia
inequívoca en la raíz. Monorepos, repos mixtos y preparaciones Bash/PowerShell usan una lista
ordenada configurada explícitamente; los scripts deben estar versionados y dentro del repo, y se
ejecutan sin interpolación de shell. Un stack desconocido continúa con preparación no aplicable;
un stack reconocido pero ambiguo o sin lock válido se bloquea con diagnóstico.

Una preparación fallida o interrumpida preserva workspace, comandos, salida sanitizada y
diagnóstico. Nunca se borran workspaces fallidos ni se toma SQLite como prueba de vida de un
proceso. La preparación tampoco puede modificar archivos versionados: cualquier cambio aborta y
bloquea el ticket para inspección.

## Política de verificación y TDD

`implement` intenta seguir TDD en los seams verificables. Cuando el proyecto no tiene una estrategia de testing razonable, el agente documenta el mecanismo de verificación alternativo antes de implementar, en vez de imponer tests artificiales.

La verificación autoritativa no depende de que el agente afirme haber corrido tests. El core
construye y persiste un plan reproducible por workspace, lo ejecuta después del commit de
implementación y antes de `REVIEW`, y conserva cada intento, comando, salida sanitizada,
diagnóstico y fingerprint. Los estados de la verificación son ortogonales al lifecycle del ticket:
`AWAITING_APPROVAL`, `QUEUED`, `VERIFYING`, `PASSED`, `FAILED`, `UNAVAILABLE`, `CANCELLED` e
`INTERRUPTED`.

La autodetección sólo se aplica a un stack inequívoco en la raíz. Node conserva `verify` o la
secuencia disponible `typecheck`, `lint`, `test`, `build`; uv usa `uv run --locked pytest`, Poetry
`poetry run pytest`, Pipenv `pipenv run pytest` sin cargar `.env`, Rust `cargo test --locked` y Go
`go test ./...` con módulos read-only. Monorepos y repos mixtos requieren unidades explícitas y
ordenadas. Bash y PowerShell sólo ejecutan scripts regulares, versionados y contenidos en el
repositorio, con argumentos literales y sin interpolación.

La autorización del workspace cubre preparación y verificación y muestra ambos planes antes de
iniciar el agente. Su fingerprint incluye comandos, plataforma, herramientas y versiones,
manifests, locks y scripts. Una aprobación anterior a este contrato se invalida una sola vez. El
plan se recalcula inmediatamente antes de ejecutarse; si el agente cambió una entrada relevante,
se exige una nueva aprobación. Un mecanismo ausente o ambiguo bloquea con diagnóstico y acceso
directo a Settings: raycoder nunca inventa comandos.

Fallo, cancelación o reinicio preservan el workspace y el intento. `QUEUED` o `VERIFYING` se
recuperan como `INTERRUPTED`; SQLite nunca prueba que el proceso externo siga vivo. La salida se
limita y sanitiza, y una verificación que introduce cambios versionados adicionales falla. La
misma política se aplica al resultado reconciliado cuando la base se movió.

## Lifecycle y recovery del ticket

```
QUEUED → READY → RUNNING → REVIEW → READY_TO_MERGE → DONE
                     ↑          │
                     └── CHANGES_REQUESTED

Excepcionales: BLOCKED · FAILED · CANCELLED · INTERRUPTED
```

- **`QUEUED`**: creado por `to-tickets`; tiene predecesores en el DAG que todavía no están `DONE`.
- **`READY`**: todos sus predecesores están `DONE`; esperando que el dispatcher lo tome.
- **`RUNNING`**: el agente está trabajando (`implement`) en el workspace aislado del ticket, creado en este momento desde el head actual de la `base_branch`.
- **`REVIEW`**: el trabajo está commiteado en la branch del ticket y en revisión (`code-review`, autorrevisión o revisor independiente según configuración).
- **`CHANGES_REQUESTED`**: la revisión pidió cambios; vuelve a `RUNNING` sobre el mismo workspace y la misma branch, sin recrear nada.
- **`READY_TO_MERGE`**: revisión aprobada, todavía no integrado. Ver "Integración" abajo.
- **`DONE`**: **integrado exitosamente a la branch base.** No es sinónimo de "revisión aprobada" — es un evento posterior y distinto. Solo `DONE` satisface dependencias en el DAG.
- **`BLOCKED`**: recuperable con input humano (crédito agotado, ambigüedad irresoluble por el agente, conflicto o verificación fallida en la integración). **Preserva el estado operativo del que vino (`blocked_from`)** — al resolverse vuelve a ese estado salvo que la acción humana indique otra transición.
- **`FAILED`**: **raycoder sabe que la ejecución terminó mal** (código de salida conocido, error no recuperable). Workspace y branch quedan intactos. Requiere acción explícita para reintentar.
- **`CANCELLED`**: cancelado explícitamente por el usuario.
- **`INTERRUPTED`**: **raycoder no sabe con certeza cómo terminó** — perdió seguimiento de la ejecución (crash de raycoder o del proceso del agente).

**Reintentos automáticos:** solo fallos claramente transitorios. Errores de lógica, tests que fallan, o crédito agotado nunca reintentan solos.

**Recovery al reiniciar raycoder:** cualquier ticket en `RUNNING`/`REVIEW`/`READY_TO_MERGE` al momento de un cierre no controlado se reclasifica a `INTERRUPTED`. El estado persistido nunca se toma como prueba de que un proceso sigue vivo — se reconcilian por separado, sin que ninguna sea autoritativa por sí sola: el estado persistido, el estado del workspace Git, y la existencia real de procesos del proveedor.

## Dependencias del DAG

**Un ticket pasa de `QUEUED` a `READY` únicamente cuando todos sus predecesores están en `DONE`.** `READY_TO_MERGE` no satisface dependencias: hasta que el cambio no está integrado, no forma parte de la base canónica sobre la que pueden construirse tickets descendientes. Un ticket `BLOCKED` o `FAILED` mantiene bloqueados a sus descendientes.

Visualización de solo lectura en la UI. El DAG nace o se reemplaza únicamente al confirmar un artefacto de tickets aprobado; una conversación, una respuesta del proveedor y una edición de formulario nunca lo modifican directamente. **Invariante dura: el dominio rechaza cualquier mutación que produzca un ciclo antes de persistirla.**

## Integración

```
revisión aprobada
      ↓
READY_TO_MERGE
      ↓
reconciliar contra el head actual de base_branch
      ↓
¿el head se movió desde base_commit?
      ├── no  → integrar → DONE
      └── sí  → verificar el resultado reconciliado
                    ├── pasa   → integrar → DONE
                    └── falla  → BLOCKED
      (conflicto en cualquier punto → BLOCKED)
```

**Modo de integración, configurable globalmente:**
- **`auto` (default):** integra automáticamente cuando la reconciliación es limpia y la verificación aplicable pasa. Requiere intervención humana solo ante conflicto o verificación fallida.
- **`confirm`:** siempre pide confirmación explícita del usuario antes de tocar la branch base.

**Verificación condicional de integración:** raycoder vuelve a correr el plan durable sobre el
resultado reconciliado **solo si el head de la `base_branch` se movió respecto de `base_commit`**.
Si no se movió, reutiliza la verificación autoritativa que pasó antes de revisión. Esto atrapa el
caso que git no detecta: un merge textualmente limpio pero semánticamente roto.

**Si la base se movió pero el proyecto no tiene un mecanismo de verificación disponible** (ver "Política de verificación y TDD"), el ticket pasa a `BLOCKED` para decisión humana en vez de integrarse a ciegas.

## Contrato entre adapter y core

```
AgentAdapter:
  capabilities()            → qué soporta ESTE proveedor
  preflight()                → estado de instalación/login
  startSession(input)        → arranca una sesión
  send(session, prompt)      → stream de eventos normalizados
  cancel(session)             → cancelación
```

**`capabilities()`** combina capacidades estructurales conocidas por el adapter (cancelación, reanudar sesión, skills nativas, sandboxing disponible) con metadata descubierta dinámicamente del proveedor **cuando el proveedor lo permita, con fallback a metadata mantenida por el propio adapter** — el core nunca conoce catálogos de modelos directamente.

Eventos normalizados:
```
assistant_message · tool_call · tool_result · file_change ·
command · usage · warning · error · completed
```

El frontend y el dispatcher hablan contra este protocolo normalizado, nunca contra la forma nativa de cada proveedor.

## Capability discovery

La tabla de configuración por etapa deriva sus opciones válidas de `capabilities()` de cada adaptador. Si un proveedor no tiene noción de "esfuerzo", esa columna se muestra como no aplicable en vez de forzar una traducción artificial.

## Seguridad: qué garantiza raycoder y qué no

raycoder inicia cada agente con la carpeta del proyecto (dentro del workspace aislado del ticket) como raíz de trabajo, y configura las restricciones disponibles de cada proveedor para limitar sus operaciones a ese workspace. Las garantías concretas dependen del sandbox real de cada proveedor y de la plataforma — no es una garantía de seguridad absoluta.

## Estado propio de raycoder

`~/.raycoder/` (config global) y `.raycoder/` por proyecto (historial SQLite, skills locales). Engram usa su base global por defecto (`~/.engram/engram.db`), no reconfigurada por proyecto — `.raycoder/` no contiene datos de Engram.

**Nota a futuro, no bloqueante:** con Engram global y varios proyectos en paralelo, las consultas a memoria durable deben conservar identidad de proyecto cuando el dato sea específico de un proyecto — evitar que una decisión de arquitectura del Proyecto A aparezca como si aplicara al Proyecto B.

## Memoria: contexto explícito vs. contexto recuperable

- **Contexto explícito** — el artefacto formal entre etapas. Determinístico, garantizado.
- **Contexto recuperable** — lo que Engram trae a pedido, vía MCP. No garantizado, no automático.

## Skills: bundle, no archivo suelto

```
bundle source · upstream revision · local modifications · dependency closure
```

"Restaurar default" restaura el bundle completo, no un archivo aislado. El mecanismo concreto de tracking queda a criterio de implementación.

## Proveedores: rollout y contrato estable vs. metadata variable

| Prioridad | Proveedor | Contrato de autenticación (estable) | Categoría de riesgo (cualitativa) |
|---|---|---|---|
| **Primera integración** | **Codex (ChatGPT)** | SDK oficial de Codex sobre el runtime local y la sesión de ChatGPT del usuario | Bajo-medio |
| Futuro | **Claude (Pro/Max)** | CLI-subproceso del binario oficial (nunca Agent SDK con token de suscripción reusado) | Bajo-medio — pool compartido por cuenta |
| Futuro | **Cursor** | Cuenta/suscripción de Cursor; el uso automatizado consume los límites/pools del plan vigente | Medio-alto para uso intensivo automatizado |
| Futuro | **OpenCode Go** | Credencial propia de OpenCode Go; catálogo administrado de modelos, sujeto a cambios del proveedor | Similar a Cursor |
| Por definir | **Quinta conexión eventual** | Se define al seleccionarla; debe entrar por el mismo contrato `AgentAdapter` | Por evaluar |

Agotar la cuota se maneja igual en todos los casos: el ticket queda `BLOCKED`.

**Skills:** Codex soporta skills como capacidad nativa. Para cada proveedor futuro, el adapter declarará esta capacidad sin que el core la presuponga.

## Configuración de proveedor + modelo + esfuerzo, por etapa

Tabla de 5 filas × 3 columnas (Proveedor, Modelo, Esfuerzo) en Ajustes, opciones derivadas de `capabilities()`. Default global + override por proyecto.

## Modos

- **Modo avanzado:** spec y tickets con dependencias visibles, editables. Se construye primero.
- **Modo simple:** más adelante.

## El motor de interrogación → spec → tickets

Reusa el bundle de `mattpocock/skills`. Default global + override por proyecto, con copia automática del bundle al abrir un proyecto sin skills propias.

## Planificación conversacional

Cada proyecto tiene un único hilo durable de planificación. La entrada primaria del usuario es
una conversación asistida por `grill-with-docs`; el JSON puede existir internamente, en la API
o como diagnóstico, pero no se presenta como formulario principal. El flujo obligatorio es:

```text
conversación → SPEC borrador → aprobación explícita de revisión →
tickets borrador → aprobación explícita de revisión → confirmación del DAG ejecutable
```

Solicitar una SPEC fija la conversación visible hasta ese momento como un artefacto aprobado
de interrogación. La sesión nueva que produce la SPEC recibe únicamente ese artefacto como
contexto explícito. La sesión que produce tickets recibe únicamente la revisión aprobada de la
SPEC. Corregir la conversación y regenerar, o editar una SPEC o un plan de tickets mediante
formularios estructurados, crea una revisión nueva; nunca reescribe ni elimina revisiones
anteriores.

SPEC y tickets conservan revisión, autoría, timestamps, estado, artefacto reemplazado y vínculos
a los mensajes y sesiones que los originaron. Sólo una revisión concreta puede aprobarse. Una
aprobación nueva marca como reemplazada la aprobación anterior de esa misma etapa, sin borrarla.
Confirmar exige la revisión de tickets aprobada y vigente. Una confirmación posterior puede
reemplazar atómicamente el DAG creado por una confirmación anterior únicamente mientras sus
tickets sigan sin ejecución (`READY`/`QUEUED`); trabajo ya iniciado o tickets ajenos al plan se
preservan y bloquean el reemplazo con diagnóstico.

Las sesiones de planificación y sus eventos normalizados se persisten en orden. El hilo expone
`idle`, `running`, `interrupted` y `error`; cada sesión conserva además sus estados terminales de
completada o cancelada. Cancelar es explícito. Al reiniciar, una sesión que figuraba en ejecución
se marca `interrupted`: SQLite no prueba que el proceso externo siga vivo. Reanudar utiliza el id
opaco del proveedor sólo cuando el adapter declara esa capacidad; en caso contrario se ofrece un
diagnóstico accionable y el usuario puede cancelar esa sesión y continuar con una nueva.

Las acciones de planificación que invocan o controlan agentes pasan por el `Scheduler` del
proyecto. El progreso se reconstruye desde mensajes, sesiones y eventos durables; la UI puede
consultarlo incrementalmente sin convertir una conexión abierta en fuente de verdad.

Sin proveedor ejecutable, proyectos, conversación histórica, artefactos y formularios
estructurados siguen disponibles. Enviar, regenerar o reanudar se deshabilita con diagnóstico.
Un repositorio sin `HEAD` también puede planificar, editar, aprobar y confirmar el DAG, pero no
ejecutar tickets hasta tener un commit base.

## Proyectos: nuevo o existente

Crear nuevo desde cero, o abrir un repo/carpeta existente en cualquier lugar del disco (incluido el propio repo de raycoder). No hay stack fijo — se detecta del repo.

La inspección siempre es de solo lectura y precede al alta. Los repos existentes se canonicalizan a su raíz. Una ruta inexistente o carpeta vacía puede crearse, con confirmación, mediante `git init -b main` y un commit raíz vacío `chore: initialize raycoder project` firmado efímeramente como `raycoder <raycoder@local.invalid>`, sin modificar `.git/config`. Una carpeta no Git con archivos puede inicializarse con confirmación, pero raycoder no ejecuta `git add` ni crea un commit: la planificación queda disponible y los tickets no se ejecutan hasta que el usuario cree el baseline. Los errores parciales conservan el estado resultante y nunca disparan rollback destructivo.

Los proyectos registrados exponen `closed`, `opening`, `open` y `error`. Un path movido permanece visible con diagnóstico reparable, y abrir un proyecto actualiza su recencia. Cada proyecto abierto posee un `ProjectRuntime` independiente; arrancar el host con cero proyectos no crea runtime ni `.raycoder/` en el directorio de invocación.

## Caso especial: raycoder editándose a sí mismo

Copia de código fuente separada de la instalación activa. Una versión nueva se prepara y valida
fuera del runtime activo y sólo después cambia el puntero estable; desarrollar raycoder nunca
reescribe la versión que está corriendo.

## Estructura de conversaciones: no es un chat único por proyecto

- Un hilo para la planificación (`grill-with-docs` → `to-spec` → `to-tickets`).
- Un hilo por ticket (`implement` → `code-review`).

Cada sesión recibe como contexto explícito sólo el artefacto aprobado de la etapa anterior. El
historial de mensajes permanece durable para auditoría y UI, pero no se concatena de forma
implícita al prompt de una sesión nueva.

## Vista previa

- **Mientras un ticket está activo** (`RUNNING`, `REVIEW`, `CHANGES_REQUESTED`, `READY_TO_MERGE`): la vista previa de ese ticket apunta a **su workspace aislado**, no al checkout principal del usuario.
- **Sin ticket activo seleccionado:** la vista de proyecto refleja la branch base / checkout principal.
- Se adapta al tipo de proyecto: vista previa en vivo si tiene interfaz visual; logs/estado si no la tiene.
- **Invariante: la vista previa nunca determina estado ni éxito de un ticket.** Es observabilidad, no fuente de verdad — el lifecycle y la verificación siguen siendo autoritativos.

## Conectividad

Interfaz, navegación de proyectos, historial y edición de specs/tickets funcionan sin conexión. La ejecución de agentes requiere conectividad cuando el proveedor/modelo seleccionado la necesita.

## Revisión de tickets

Configurable: autorrevisión o revisor independiente. Nivel: global y por proyecto.

## Proyectos: concurrencia

Varios proyectos pueden tener agentes trabajando en simultáneo. Dentro de cada proyecto, el dispatcher es secuencial (un ticket a la vez).

La ejecución manual por ticket es siempre el default. Auto se activa explícitamente por proyecto
mediante `Start`; confirmar o reemplazar un DAG, abrir el proyecto o reiniciar raycoder nunca lo
inicia ni lo reanuda. `Stop` vuelve a dejar el proyecto en modo manual.

Cada corrida Auto y sus eventos son durables. Auto elige de forma estable por fecha de creación e
ID el próximo ticket `READY` cuyos predecesores estén `DONE`, y ejecuta sólo uno por vez mediante el
`Scheduler` normal del proyecto. La UI muestra la cola prevista, ticket activo, estado y motivo de
pausa, además de `Start`, `Pause`, `Resume` y `Stop`. `Pause` y `Stop` son cooperativos: no matan el
ticket que ya está ejecutándose, pero impiden iniciar el siguiente.

Auto se pausa ante autorización o confirmación pendiente; tickets bloqueados, fallidos, cancelados
o interrumpidos; proveedor ausente, autenticación o cuota; preparación o verificación fallida; una
acción manual sobre tickets; un cambio de configuración operativa; o reemplazo del DAG. No salta
un ticket problemático para continuar con otro y nunca reintenta automáticamente. Cuando ya no
quedan tickets pendientes completa la corrida y vuelve al default manual.

Al reabrir un proyecto, cualquier corrida que figuraba `RUNNING` pasa durablemente a `PAUSED` con
motivo de reinicio y requiere `Resume` explícito. SQLite no se usa como prueba de vida del ticket o
proveedor que hubiera estado activo.

## Motor de agentes: adaptadores por proveedor

La primera integración usa el SDK TypeScript oficial de Codex. El adapter traduce sus sesiones y eventos al contrato normalizado de raycoder y fija el workspace aislado del ticket como raíz de trabajo, con el mínimo permiso de escritura necesario. Si una necesidad futura exige que raycoder gestione directamente autenticación, historial, aprobaciones u otros eventos ricos, el adapter puede evolucionar internamente hacia Codex App Server sin cambiar el contrato del core.

Los proveedores siguientes usan un SDK oficial cuando exista y cubra el contrato; si no, un envoltorio del CLI oficial. La elección queda encapsulada en cada adapter.

## Memoria persistente: Engram

`Gentleman-Programming/engram`, binario Go agnóstico de proveedor, SQLite + FTS5, sin dependencias. Se conecta a cada proveedor vía MCP.

## Explícitamente fuera de esta etapa

- Electron o Tauri.
- Editor de DAG interactivo.
- Modo simple.
- Paralelismo del dispatcher dentro de un mismo proyecto.
- **Stacked branches** (tickets que nacen de la branch privada de otro ticket).
- Acceptance against SPEC.
- OpenRouter / pago por token.
- Contador de uso en vivo por proveedor.
- Aislamiento a nivel de sistema operativo.
- Nuevos adapters de proveedor.

---

## Estado del brief

**Decisiones de producto pendientes: ninguna para esta etapa.**

**Invariantes técnicas pendientes de definición: ninguna conocida.**

Los mecanismos concretos quedan a criterio de implementación, salvo donde el brief los fija expresamente: el conjunto completo de estados del ticket definido en "Lifecycle y recovery del ticket" y la semántica de `BLOCKED`/`FAILED`/`INTERRUPTED`; desbloqueo del DAG únicamente por `DONE`; ancestry desde el head de la `base_branch` (sin stacked branches); workspace físicamente aislado por ticket; tracking de `base_commit`; verificación durable antes de revisión y repetida sobre una reconciliación sólo cuando la base se movió; contrato normalizado de eventos; capability discovery; invariante de no-ciclos; preflight parcial no bloqueante; launcher user-local estable con activación atómica y sólo current/previous; preservación de datos y credenciales durante uninstall; y no modificar archivos versionados del usuario.
