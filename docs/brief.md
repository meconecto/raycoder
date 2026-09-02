# raycoder — brief v16 (integración incremental de proveedores)

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

## Cómo se corre: `npx raycoder`

Sin instalación global persistente — única vía de ejecución. Por defecto resuelve la versión publicada según el comportamiento estándar de npm. La integridad del paquete la cubre el mecanismo estándar de npm.

## Preflight check, antes de cada arranque del servidor

Corre en cada arranque, no toca nada, solo informa:

```
✓ Node 20.x detectado
✓ codex — runtime oficial disponible y sesión de ChatGPT activa
○ claude — adapter todavía no incluido en esta build
○ cursor-agent — adapter todavía no incluido en esta build
○ opencode — adapter todavía no incluido en esta build
✓ engram — instalado
✗ engram — no configurado para codex (`engram setup codex`)
```

**Solo Node es requisito esencial de arranque para el usuario final.** Fallas individuales de proveedores no bloquean el arranque; el preflight solo bloquea por Node faltante o si no existe ningún proveedor ejecutable entre los adapters incluidos en esa build. Los proveedores implementados pero no disponibles quedan deshabilitados en la UI con diagnóstico accionable. Los proveedores todavía no implementados pueden mostrarse como próximos, pero no participan del resultado del preflight.

La incorporación de proveedores es **incremental**. La primera build implementa únicamente Codex. La arquitectura debe permitir llegar después a cuatro o cinco conexiones sin modificar el contrato del core, pero el número y la identidad final de esos proveedores no son una invariante de esta etapa.

## Desinstalación: clara

Sin instalación global persistente, "desinstalar" en el sentido tradicional no aplica. `~/.raycoder/` y los `.raycoder/` de cada proyecto quedan como limpieza opcional y explícita, nunca automática.

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

## Política de verificación y TDD

`implement` intenta seguir TDD en los seams verificables. Cuando el proyecto no tiene una estrategia de testing razonable, el agente documenta el mecanismo de verificación alternativo antes de implementar, en vez de imponer tests artificiales.

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

Visualización de solo lectura en la UI; modificaciones solicitadas conversacionalmente y aplicadas previa confirmación del usuario. **Invariante dura: el backend rechaza cualquier mutación que produzca un ciclo.**

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

**Verificación condicional:** raycoder corre la verificación del proyecto sobre el resultado reconciliado **solo si el head de la `base_branch` se movió respecto de `base_commit`**. Si no se movió, el árbol a integrar es exactamente el que el agente ya verificó durante `implement`, y no se vuelve a verificar. Esto atrapa el caso que git no detecta: un merge textualmente limpio pero semánticamente roto (por ejemplo, algo que entró a la base renombró código que el ticket usa).

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

## Proyectos: nuevo o existente

Crear nuevo desde cero, o abrir un repo/carpeta existente en cualquier lugar del disco (incluido el propio repo de raycoder). No hay stack fijo — se detecta del repo.

## Caso especial: raycoder editándose a sí mismo

Copia de código fuente separada de la instalación activa. Cambios instalados de forma manual — build + reinstalación.

## Estructura de conversaciones: no es un chat único por proyecto

- Un hilo para la planificación (`grill-with-docs` → `to-spec` → `to-tickets`).
- Un hilo por ticket (`implement` → `code-review`).

Cada sesión recibe como contexto explícito solo el artefacto de la etapa anterior.

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

---

## Estado del brief

**Decisiones de producto pendientes: ninguna.**

**Invariantes técnicas pendientes de definición: ninguna conocida.**

Los mecanismos concretos quedan a criterio de implementación, salvo donde el brief los fija expresamente: el conjunto completo de estados del ticket definido en "Lifecycle y recovery del ticket" y la semántica de `BLOCKED`/`FAILED`/`INTERRUPTED`; desbloqueo del DAG únicamente por `DONE`; ancestry desde el head de la `base_branch` (sin stacked branches); workspace físicamente aislado por ticket; tracking de `base_commit`; verificación condicional a que la base se haya movido; contrato normalizado de eventos; capability discovery; invariante de no-ciclos; preflight parcial no bloqueante; y no modificar archivos versionados del usuario.
