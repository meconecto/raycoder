# ADR 0014: Verificación durable y multistack

## Estado

Aceptado.

## Contexto

La revisión del agente puede ejecutar pruebas, pero su relato no es una evidencia autoritativa y
la verificación incorporada sólo comprendía Node durante una reconciliación. Eso deja sin una
política reproducible al commit original del ticket y a proyectos Python, Rust, Go, monorepos o
scripts propios. También impide mostrar y autorizar de antemano todo el código local que una
operación de workspace ejecutará.

## Decisión

El core detecta o valida un `WorkspaceVerificationPlan`, lo incluye junto con la preparación en
una autorización fingerprinted del proyecto y persiste cada `WorkspaceVerificationAttempt` en
SQLite. El plan se ejecuta, sin shell implícito y con entorno acotado, después del commit de
implementación y antes de revisión. Si la base se movió, se recalcula y ejecuta nuevamente sobre
el worktree de reconciliación antes de avanzar la base canónica.

La autodetección sólo acepta una raíz inequívoca. Node, uv, Poetry, Pipenv, Cargo y Go tienen
convenciones explícitas; un repositorio mixto o monorepo usa unidades ordenadas configuradas por
proyecto. Bash y PowerShell sólo reciben paths versionados dentro del repositorio y argumentos
literales. Si no existe una convención verificable, la operación se bloquea con diagnóstico en
vez de inventar un comando.

El fingerprint incorpora plataforma, arquitectura, ejecutable resuelto, versión, comandos y
hashes de manifests, locks y scripts. Se recalcula antes de ejecutar para cerrar TOCTOU. Cambiar
una entrada relevante invalida el consentimiento. Los consentimientos exclusivos de preparación
del contrato anterior no autorizan verificación y se reemplazan al primer uso.

Los intentos son durables y neutrales respecto del proveedor. Salida y errores se sanitizan y
limitan; cancelación termina el proceso exacto mediante `AbortSignal`; archivos versionados
modificados por la verificación producen fallo. Al abrir el runtime, intentos `QUEUED` o
`VERIFYING` pasan a `INTERRUPTED` sin inferir vida externa desde SQLite.

## Consecuencias

La transición a revisión y una integración reconciliada quedan respaldadas por evidencia local
uniforme entre stacks. La primera ejecución y cualquier cambio del plan requieren una decisión
humana adicional, y los proyectos sin convención deben configurar una unidad explícita antes de
ejecutar tickets.
