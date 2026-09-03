# ADR 0011: Instalación user-local con activación atómica

## Estado

Aceptado para el instalador posterior a RC4.

## Contexto

Ejecutar siempre mediante `npx` es útil para probar raycoder sin instalación, pero no ofrece una
ubicación estable para accesos del sistema, actualizaciones controladas ni rollback. Instalar con
`npm -g` delegaría el layout y los permisos a configuraciones globales distintas en cada equipo,
y reemplazar in-place un paquete podría modificar archivos que una instancia viva todavía usa.

El instalador debe funcionar como usuario normal en Windows, macOS y Linux, mantener el mismo
comando público después de actualizar y coexistir con la configuración, el registro de proyectos
y la metadata local ya existentes. La distribución continúa siendo el paquete publicado en npm;
no se introduce un script remoto por `curl`, un updater privilegiado ni otro canal de artefactos.

## Decisión

### Entrada pública y layout

La entrada recomendada es `npx raycoder@latest install`. Para una prerelease o reproducción
exacta se usa `npx raycoder@<versión-exacta> install`. El proceso bootstrap instala exactamente
la versión de raycoder que lo está ejecutando, aunque haya sido resuelta desde un dist-tag.

El home de instalación es `~/.raycoder/` y separa datos de runtime:

```text
~/.raycoder/
  bin/                         launcher estable y wrappers de plataforma
  versions/<version>/          instalación npm autocontenida de esa versión
  staging/<operación>/         preparación no activa
  current.json                 versión activa/anterior; reemplazo atómico
  install.json                 canal, plataforma y recursos propiedad del instalador
  config.json                  preservado
  projects.db                  preservado
  instance.json                descriptor de instancia; preservado
```

El launcher estable lee `current.json` y ejecuta el CLI de la versión activa mediante Node 24+.
No se usa un symlink porque crearlo en Windows puede requerir una política o privilegio especial.
La instalación agrega `~/.raycoder/bin` al PATH de usuario: mediante el entorno de usuario en
Windows y mediante un bloque marcado, reversible e idempotente en el perfil POSIX. El instalador
informa que una terminal ya abierta puede necesitar reiniciarse.

Por defecto se crea un acceso que apunta siempre al launcher estable: menú Inicio del usuario en
Windows, bundle `.app` en `~/Applications` en macOS y `.desktop` en el directorio de aplicaciones
del usuario en Linux. `--no-shortcut` omite esta acción y la registra como tal.

### Instalación y activación

Cada versión se instala primero en un staging propiedad de la operación mediante una instalación
local de npm, nunca global. Los lifecycle scripts se deshabilitan. El instalador localiza el CLI
resultante y exige que `--version` coincida exactamente con la versión solicitada. Sólo entonces
mueve staging a `versions/<version>` y reemplaza `current.json` mediante archivo temporal y rename.

Una activación conserva la versión que era current como previous. Después del cambio exitoso se
eliminan versiones más antiguas que no sean current o previous. Una falla anterior a la activación
no cambia el puntero; una falla de poda no invalida la versión ya activada y queda diagnosticada.
Nunca se sobrescribe el directorio del runtime activo.

### Update, rollback y canal

`install.json` registra `stable` para versiones normales y `prerelease` para versiones semver con
pre-release, salvo selección explícita. `raycoder update` consulta `latest` para stable y `next`
para prerelease, instala la versión exacta resuelta, la valida y la activa con el mismo protocolo.

`raycoder rollback` valida la versión previous y cambia atómicamente el puntero, intercambiando
current y previous. No descarga paquetes. Tanto update como rollback se rehúsan a operar cuando
el descriptor de instancia corresponde a un proceso raycoder vivo; SQLite o la mera existencia
del archivo no se toman como prueba suficiente de vida.

### Uninstall y límites de propiedad

`raycoder uninstall` calcula y muestra un inventario desde rutas conocidas y `install.json`, exige
la confirmación `UNINSTALL RAYCODER` en un TTY (o `--yes` para automatización explícita) y vuelve a
comprobar que no haya instancia activa antes de borrar. Elimina sólo `bin/`, `versions/`,
`staging/`, `current.json`, `install.json`, el acceso registrado y el fragmento de PATH que creó.
No elimina `~/.raycoder/` si contiene cualquier dato preservado.

El instalador nunca enumera homes ajenos, archivos de autenticación, variables de credenciales ni
configuraciones de proveedores. Los `.raycoder/` de proyectos están fuera de su inventario.

## Consecuencias

- El comando público y los accesos del sistema sobreviven a updates porque nunca apuntan a una
  versión concreta.
- Current y previous permiten rollback sin duplicar indefinidamente el runtime.
- La activación por puntero evita modificar archivos que una instancia podría tener abiertos.
- Node y npm siguen siendo requisitos del bootstrap/update; no se incorpora todavía un runtime
  Node embebido.
- La modificación de PATH es user-local, explícitamente atribuible y reversible, pero una shell
  existente puede no observarla hasta reiniciarse.
- Configuración, proyectos y credenciales permanecen separados del ciclo de instalación.
