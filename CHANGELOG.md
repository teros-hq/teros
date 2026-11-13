# Changelog

All notable changes to Teros are documented in this file.

> **Workflow:**
> Move items from `Future` into a new version block when you're ready to plan a release.
> Check them off `[x]` as they're completed. Deploy = done.

---

## v1.4.8 - Objetos de plataforma, sign-in que solo muestra lo configurado y recuperación de contraseña para cuentas OAuth

> Ventana 2026-11-12 → 2026-11-13. Tag `v1.4.8`.

### Objetos

- [x] **Objetos de plataforma (OBJ)**: un objeto pertenece a un workspace o a un usuario y se sirve por su propia URL, con transformaciones de imagen en la misma URL (OBJ-REQ-1, OBJ-REQ-2, OBJ-REQ-3, OBJ-REQ-7). Spec en `docs/specs/`.
- [x] **El avatar de un agente es un objeto**: lo subido se resuelve a la URL del objeto y se pide en variantes de tamaño; deja de escribirse nada en el directorio estático (OBJ-REQ-4, OBJ-REQ-5, OBJ-REQ-6). Los objetos de un agente desaparecen con él.
- [x] **Migración de avatares al arrancar**: los avatares que vivían en el directorio estático pasan a ser objetos; un fichero que falta se sustituye por el avatar por defecto (OBJ-REQ-8, OBJ-REQ-9).

### Autenticación

- [x] **La recuperación de contraseña llega a las cuentas que solo entran por OAuth**: una cuenta creada con Microsoft (o cualquier proveedor) no tenía identidad `password`, así que `requestPasswordReset` no la encontraba y caía en el challenge señuelo. Al usuario se le decía "te hemos enviado un código" y **no se enviaba nada**. Ahora, cuando el email es de un usuario real y no suspendido pero no hay identidad de contraseña, se provisiona una con una contraseña que nadie puede teclear (32 bytes aleatorios hasheados y descartados, sin credencial temporal que filtrar) y el flujo sigue normal; el usuario elige su primera contraseña y hasta entonces sigue entrando por su proveedor. Una cuenta suspendida se queda en el señuelo, para que un baneo no se levante por autoservicio. De paso arregla la otra mitad: `changePassword` actualizaba por `(userId, type: 'password')` sin upsert, así que el reset habría fallado con "Could not update password" aunque el código hubiera llegado.
- [x] **El backend dice qué métodos de acceso tiene configurados (SIGNM 1.0.0)**: `GET /api/auth-methods` informa de si Google, GitHub y Microsoft se inicializaron al arrancar (SIGNM-REQ-1..3).
- [x] **Las pantallas de acceso dibujan solo lo que el backend ofrece**: sin proveedores configurados, quedan email y contraseña a secas; con uno o varios, solo esos botones (SIGNM-REQ-4..7).

### Infraestructura

- [x] **`docker/logs.sh` sigue los servicios por defecto (SHLOG 1.0.0)**: sin argumentos sigue backend, container-agent y frontend; las bases de datos solo cuando se nombran. Las líneas del health-probe de MongoDB enterraban todo lo demás (SHLOG-REQ-1, SHLOG-REQ-2).
- [x] **El formulario de proveedores dibuja el glifo de marca de cada proveedor** en vez de una nube genérica; los tipos sin glifo conservan un icono de reserva.
- [x] **OCR y pdf-to-images giran sin descargar datos de idioma**: spa y eng van empaquetados, el arranque está acotado y ningún trabajo se queda en `processing`.

### Correcciones

- [x] **La tarjeta de acceso mantiene su separación sobre el botón de email** cuando no se dibuja ningún proveedor (SIGNM-REQ-6).
- [x] **Security batch 1 y 2**: 35 paquetes transitivos vulnerables re-resueltos dentro de su rango semver y `undici` parcheado bajo discord.js y el cliente de Qdrant (239 → 68 avisos abiertos); fuera `nodemailer` sin uso, bcrypt 6 (elimina tar 6), vitest 4, OpenTelemetry 2.9, uuid 11, file-type 21 y esbuild 0.25 en los bundles (68 → 19 avisos abiertos, ningún crítico).

---

## v1.4.7 - Onboarding v2, imágenes de release, recuperación de contraseña de verdad y bundle web a la mitad

> Ventana 2026-11-08 → 2026-11-12. Tag `v1.4.7`.

### Despliegue

- [x] **Frontend configurable en runtime (WEBCFG)**: el bundle web ya no lleva las URLs del backend dentro. El contenedor de nginx escribe `/config.js` al arrancar desde `TEROS_BACKEND_URL` / `TEROS_WS_URL` (en compose, los mismos valores de `.env` de siempre) y la app los lee antes de cargar; sin nada configurado habla con su propio origen. Una sola imagen del frontend sirve para cualquier despliegue, paso previo a publicar imágenes pre-construidas. Metro y nativo siguen usando `EXPO_PUBLIC_*` en build.
- [x] **Imágenes de release en GHCR**: `release-images.yml` (solo en el repo público) construye `ghcr.io/teros-hq/teros-backend` y `teros-frontend` para amd64 y arm64 en runners nativos con cada tag `v*`. El compose las nombra (`TEROS_IMAGE_TAG`, por defecto `latest`) y conserva los `build:` para desarrollo; el instalador hace `pull` en vez de construir (6–20 min menos) con `TEROS_BUILD=1` como alternativa. Nuevos `docker/{start,stop,update,logs}.sh`, que el instalador ya anunciaba pero no existían.
- [x] **Onboarding v2, fase A (ONB)**: el wizard depende de la edición, que ahora llega del backend en cada login y en `profile.get` en vez de compilarse en el bundle. En self-hosted: términos con la nota de licencia y "tus datos se quedan en tu máquina", acceso sin lista de espera, y un paso nuevo "Conecta un modelo" que prueba la clave con una respuesta real de Iria (`provider.test` con `probe`) y la deja como proveedor por defecto; sin modelo que responda no se sale del wizard. En cloud no aparece ese paso (Teros provider por defecto). Fuera los pasos de Apps y Accesos; la lista "lo que vamos a configurar" y el resumen final cuentan solo lo que pasa de verdad; splash de 1,4 s que se salta con un clic o una tecla.
- [x] **Workspace Private e Iria garantizados al iniciar sesión (SIP)**: el admin que crea el instalador con `create-user.ts` se insertaba directo en Mongo y se saltaba el alta normal, así que entraba sin workspace ("No workspace to load") y sin agente. Ahora cualquier inicio de sesión correcto (contraseña, verificación de email, MFA, reset de contraseña, OAuth) asegura de forma idempotente el workspace Private, `privateWorkspaceId` y el agente por defecto, sin bloquear nunca el login si algo falla.
- [x] **La sesión sobrevive a la recarga en instalaciones compose (CORSAPP)**: la lista blanca de CORS del backend incluye siempre el origen de `APP_URL`, así que las llamadas con credenciales a `/auth/session` desde `localhost:10002` ya no las bloquea el navegador y la cookie de sesión se instala. El compose pasa `APP_URL` y `CORS_ALLOWED_ORIGINS` al backend.
- [x] **Runtimes de apps incluidos en la instalación**: en una instalación nueva no existía `teros/mca-runtime:latest` (solo lo construía `scripts/build-mca-runtimes.sh`, que mencionaba el README), así que cualquier herramienta de app fallaba con "Unable to find image". `release-images.yml` publica también `teros-mca-runtime`, `-bash` y `-playwright` en GHCR, y el nuevo `docker/pull-runtimes.sh` los descarga y los etiqueta con el nombre local (si no puede, los construye). Lo llaman el instalador y `update.sh`.
- [x] **Solo modelos con herramientas para los agentes (ONB 2.1)**: un modelo de Ollama solo de texto (mythomax) pasaba la prueba del onboarding y el primer chat con Iria fallaba con "does not support tools". La prueba ahora ofrece una herramienta, el descubrimiento de Ollama lee las capacidades reales (`/api/show`) y pone primero los modelos con herramientas, y `agent.set-model` rechaza modelos sin ellas.
- [x] **Imagen del backend a menos de la mitad**: el `Dockerfile` del backend ya no instala los workspaces de la app, e2e ni los MCAs (sus dependencias se hoistaban a la imagen: Expo, Tamagui, React Native, 430 MB de `node_modules` por MCA) y poda las devDependencies tras compilar. De 3,7 GB a 1,4 GB. De paso, `pngjs` pasa a dependencia declarada del backend (el sync de MCAs lo importaba y solo llegaba vía Expo) y `@tamagui/animations-css` baja de la raíz del monorepo a `packages/app`, que es quien lo usa.
- [x] **Log de deploy legible (DEP 1.3.0)**: una línea de columnas fijas por paso, agrupadas por fases, con una línea viva de spinner y barra de progreso.

### Autenticación

- [x] **Recuperación de contraseña reescrita de punta a punta (PWR 1.0.0 → 1.1.0)**: el flujo se pensó y se especificó entero (`docs/specs/core/password-recovery.md`) después de que tres clientes se quedaran fuera. El handler **sí manda ya** el `challengeToken` en el frame `auth_error` (antes lo descartaba, así que el frontend pintaba la respuesta correcta del servidor como un error y nunca llegaba a la pantalla del código). Nuevo `verify_password_reset`: el código se comprueba **antes** de pedir la contraseña nueva, cuenta intentos sin consumir el challenge y mantiene el socket abierto entre los dos pasos.
- [x] **El reset en dos pantallas, con las seis casillas primero (PWR-REQ-7..12)**: seis casillas de código con pegado desde el portapapeles y validación contra el servidor, y después la contraseña nueva con las reglas en vivo; los errores se limpian al escribir. El campo del código se libra de los overlays del gestor de contraseñas y el contador de longitud solo aparece mientras la regla no se cumple. "Atrás" desde olvidé-mi-contraseña vuelve al login con email cuando no hay historial.
- [x] **Throttle de 20 s para pedir códigos (PWR, UX)**: no se puede pedir otro código antes de 20 s, con la cuenta atrás dentro del propio botón ("Puedes pedir otro código en 18 s"); la ventana compartida arranca al enviar la petición, así que saltar entre las dos pantallas no la reinicia. Es UX, no seguridad: el rate limit real de 3 códigos/hora por email sigue en el backend.
- [x] **La pantalla de reset sobrevive a una recarga**: el email viaja en los params de la ruta y el `challengeToken` sigue fuera de la URL a propósito (es un secreto); si la sesión de reset se perdió, la pantalla lo dice y ofrece "Pedir un código nuevo" en vez de devolver al usuario a la pantalla anterior sin explicación.
- [x] **Los emails de reset y verificación llevan la marca actual**: página lila, tarjeta blanca, logo violeta y el código destacado, en vez de la plantilla heredada.
- [x] **Fin del bucle de cookie auth (AUTHC)**: tras un logout o un intento de cookie fallido, la pantalla de login seguía reintentando la autenticación por cookie — fondo parpadeando y rate limit comido. Ahora la cookie auth se detiene hasta el siguiente login explícito.

### Rendimiento web

- [x] **El bundle web pasa de 18,7 MB a 8,6 MB de JS eager (LOADP 1.0.0 → 1.1.0)**: nueva spec `docs/specs/client/web-load-performance.md` que fija qué puede viajar en el bundle antes de la primera pantalla. Iconos importados uno a uno en web (el set de Lucide se carga bajo demanda), `CodeBlock` entra en el registro de Prism y el SDK de Sentry se carga en idle con su cola de replay — fuera de la ruta crítica. Medido: 18,7 → 9,5 MB con los iconos y 9,5 → 8,6 MB con Sentry.
- [x] **Fuera PostHog**: analítica de producto sin uso — unos 260 KB de bundle y un init síncrono en el arranque que ya no paga nadie.

### Interfaz

- [x] **Las pestañas inactivas hibernan a los 60 s (TABH 1.0.0)**: las pestañas de un panel acoplado se desmontan tras un minuto sin foco (`docs/specs/client/tab-hibernation.md`), con el chat de voz y el navegador exentos; los badges de no leídos se alimentan de un solo watcher en lugar de uno por pestaña. Menos memoria y menos renders en sesiones con muchas pestañas abiertas.
- [x] **`/config.js` vacío bajo Metro (WEBCFG-REQ-6)**: en desarrollo la página cargaba el HTML de fallback como si fuera el script de configuración; ahora Metro sirve un `config.js` vacío y la app usa su propio origen.

### Publicación

- [x] **`mca.whatsapp` pasa a ser privado**: funciona sobre WAHA, un cliente no oficial, así que ni la app ni su imagen de runtime (`docker/mca-runtime-whatsapp`) salen ya en el repositorio público.

### Correcciones

- [x] **Password reset roto para todos (RESETWS)**: los mensajes WebSocket `forgot_password` / `reset_password` / `resend_password_reset` eran rechazados por el gate `isClientMessage` — `AuthMessageSchema` en `packages/shared/src/protocol.ts` no incluía esos métodos aunque el `auth-handler` sí los consume (drift protocolo↔handler). El frontend recibía un error genérico que nadie capturaba y a los 10 s saltaba "la solicitud expiró". Añadidos los 3 schemas al union; afectados en prod: 3 usuarios desde el deploy del 9-nov.
- [x] **Logout web no cerraba la sesión (LOGCOOKIE)**: `destroySession()` nunca llamaba a `clearSessionCookie()` — la cookie httpOnly sobrevivía al logout y `GET /auth/session` restauraba la sesión al recargar ("le doy a logout y si recargo vuelvo a entrar"). Ahora `destroySession` lanza `DELETE /auth/session` al inicio (solapado con el teardown local) y lo espera al final con un tope de 2 s; los fallos de red nunca bloquean el logout. Al parar una impersonación se reinstala la cookie con el token del admin — antes una recarga reanudaba la impersonación.
- [x] **Selector de canal vacío en workspaces compartidos (MUW-AUTO)**: en la acción *Message a channel* de Automate, un miembro veía el dropdown "Select a channel" vacío y mudo en un workspace compartido — las conversaciones nacen personales de su creador (MUW-REQ-4) y ninguna estaba compartida. Ahora se muestra un aviso explicativo ("conversaciones privadas de su creador hasta que se compartan — abre una y activa Make shared") en vez de un dropdown sin contexto. Verificado con reproducción real (Playwright) en workspace compartido.
- [x] **Automate ya no se cae con automatizaciones de tipo desconocido**: `StarterCard` hacía `TRIGGER_META[starter.type]` sin fallback, así que un starter con un tipo que el frontend no conoce (documento legacy en la DB de cloud) devolvía `undefined` y el error boundary tumbaba **la ventana entera** — con `Cannot read properties of undefined (reading 'icon')`. Ahora los lookups van por `triggerMeta()` / `actionMeta()`, que nunca devuelven undefined, y los starters desconocidos se filtran de la lista: una tarjeta degradada permitiría tocar el toggle o el borrado sobre una forma que no sabemos interpretar. Tres tests de regresión con tipos legacy.
- [x] **El flujo de reset web deja de depender de estado en memoria**: la pantalla del código se rellena desde los params de ruta y, si el challenge no está, lo explica con un banner y un enlace de recuperación, en vez de quedar muda.
- [x] **El split de paneles ya no rompe con "Missing theme" (LOADP 1.2.0, LOADP-REQ-1)**: los imports de Lucide icono a icono resolvían en web a los ficheros CJS, que traían una segunda copia de Tamagui; ahora resuelven a ESM y comparten la copia de la app.
- [x] **La barra lateral lista solo las conversaciones del workspace visible (CHAN-REQ-11, CHAN-REQ-12)**: `channel_list_status` lleva `workspaceId`, `headless` y `originChannelId`, y el cliente añade un canal solo si pertenece al workspace que se muestra.

---

## v1.4.6 - Deploy sin caídas, MCA streams y primera release fair source

> Ventana 2026-11-04 → 2026-11-08. Tag `v1.4.6`. Primera versión publicada en el repo público con el checklist `docs/standards/PUBLIC-RELEASE-CHECKLIST.md`.

**Deploy sin caídas (spec DEP)**
- [x] El deploy de prod construye cada commit en su propio directorio (`releases/<sha>`, worktree + node_modules propios, a baja prioridad de CPU/IO) y nunca toca el árbol del backend vivo; el frontend se publica por symlink atómico
- [x] Blue/green del backend: dos apps PM2 (`teros-backend-blue` :10021, `teros-backend-green` :10022) detrás de nginx, que posee el puerto público y el estable 10001 de callbacks MCA; la activación arranca el color libre, espera `/health` con el `release` nuevo, cambia el upstream, verifica y solo entonces para el anterior
- [x] El backend cierra los sockets con 1012 al apagarse y el cliente reconecta en 250–1500 ms sin backoff; el barrido de resume espera a que el color anterior haya salido (`instance:*` en `leader_locks`); `MCA_CALLBACK_PORT` para las URLs que reciben los contenedores
- [x] `rollback.sh` reactiva una release en disco sin reconstruir; el execution host solo recicla contenedores si cambió `mcas/`, `docker/` o `mca-sdk`
- [x] Log de deploy legible: pasos numerados con duración y resultado, salida de subcomandos en ficheros por paso (`.deploy/<run>/`), resumen final; runbook de cutover `docs/runbooks/20261104_zero-downtime-deploy-cutover.md`
- [x] Pre deja Docker Compose y usa el mismo `deploy-server.sh` que prod (nginx en el host en 10001/10002, PM2 blue/green, releases); lo específico de cada host vive en su `.env.deploy`; el agente de contenedores del mismo host se reinicia tras el deploy; `deploy-pre.sh` retirado; runbook `docs/runbooks/20261105_pre-release-flow-cutover.md`

**MCA streams y Browser MCA (specs MCS / CLB)**
- [x] Protocolo de MCA streams: un MCA empuja frames binarios y estado y recibe el input de los viewers por su socket `/mca`, relevado en `/ws/stream` con tickets; el cloud browser del backend pasa a usarlo (`804553c16`)
- [x] El Browser MCA muestra pestañas visibles: perfil Chromium persistente por usuario (Xvfb, sin flag de automatización, con el proxy del MCA) streameado a la Browser window web (`0d5180b38`)
- [x] El Browser MCA se renombra a `mca.teros.browser` (directorio, manifest, registro de capacidades, heurísticas de permisos) con migración de apps, toggles de agente y salud de tools; `sync-mcas` aplica los renombrados antes de borrar apps huérfanas (`806be4485`, `7da91665c`)

**Apps y administración**
- [x] Secretos de una app gestionables desde el widget de auth: desconectar, lista de variables y set enmascarado (`fbd02baef`)
- [x] Catálogo de admin dividido en lista ligera (id, nombre, categoría, nº de tools, disponibilidad) más detalle por app bajo demanda, con búsqueda; el payload completo reventaba el contexto de los agentes (`1dc39b006`)
- [x] Volúmenes de workspace en GCP: aprovisionador de acceso gcsfuse (service account por app con `roles/storage.objectUser` sobre el prefijo del volumen) y montaje de workspace y app-data en el backend de contenedores Kubernetes (`90209fc43`)

**Release pública (fair source)**
- [x] Teros se describe como «The open AI agent operating system», fair source bajo FSL-1.1 con badge de fair.io; nunca «open source» (`08fa217a9`)
- [x] Ficheros legales y de comunidad: `LICENSE` (renombrado desde `LICENSE.md`, CIF ESB88787445), CLA completo, `SECURITY.md`, `CODE_OF_CONDUCT.md` (`34c509778`, `5d3f12996`)
- [x] Checklist de publicación `docs/standards/PUBLIC-RELEASE-CHECKLIST.md`, `publish.allowlist` y `scripts/publish/{export,scan,sync}.sh`; log en `docs/runbooks/public-releases.md` (`888a37acb`, `d214c60cf`)
- [x] Limpieza previa: correos del equipo y hostnames internos fuera de fixtures y comentarios, página de voz para tablet con token embebido eliminada (token revocado en RAW), vídeos de marketing y `files-to-mcas/` fuera del repo (`948f399d3`, `0e2449ca7`, `8f4b24a46`, `2605f01e8`)
- [x] Historia del repo público reescrita una única vez: 8 commits firmados, sin co-autores, mismo árbol (`95540bb90`)

---

## v1.4.5 - Chrome en la nube, PDFs con visión e higiene de tests

> Ventana 2026-11-03 → 2026-11-04 (deploy). 21 commits. Tag `v1.4.5`.

**Browser en la nube**
- [x] Backend del cloud browser: CDP executor portado del desktop, host de Chrome del usuario (launchers local/docker, sin flags de automatización, perfil persistente), plano de datos `/ws/browser` con screencast + input, y `ui.browser-*` enrutado a tabs de la nube — apagado por defecto (`CLOUD_BROWSER_MODE`) (`074275a80`)
- [x] Browser window en web: streamea el Chrome de la nube — canvas + input sobre `/ws/browser`, BrowserToolbar compartida con la vista nativa, fallback en desktop cuando no hay navegador (`a4ed5af2c`)
- [x] El proxy residencial pasa a ser secret del MCA de Playwright (`.secrets/mcas/mca.teros.playwright`) — `systemEnvironment` del manifest alimenta `chromium.launch({ proxy })` y el backend lee el mismo fichero; variables `CLOUD_BROWSER_PROXY_*` retiradas (`250efe080`)
- [x] Spec CLB v0.1.0 (draft) del cloud browser (`c689478ec`)

**PDFs con visión**
- [x] `pdf-to-images` en file-processor: cada página a imagen para que el modelo LEA documentos con visión (`d12ea61b6`)
- [x] El adapter OpenAI-compatible envía las imágenes de tool-results a los modelos de visión (`12df9b752`)

**Higiene de tests — alcanzar a apps v2.2 / MUW**
- [x] 14 suites unit + 6 integration actualizadas: fixtures con owner del workspace, mocks con getChannelViewer/isAppVisibleTo/isAppUsableBy/canManageApp (MUW-REQ-12/13), `setAppScope` owner-only (MUW-REQ-11), canal personal ajeno fuera del listado (MUW-REQ-4/5) (`ab18bd9dd`, `c7535f1e9`)
- [x] Smoke E2E: composer localizado por canal (`data-channel-id` en composer-root, `composer(page, channelId)` para todos los controles), specs de seguridad esperan `ACCESS_DENIED` (MUW-REQ-3) y avatar por cookie de sesión httpOnly (`8f6f0d5c1`, `c04983ef6`, `bb2b68ce6`)
- [x] Smoke pineado a `teros-l` — TPROV retiró teros-kimi-k3 y 15 specs colgaban del pin (`f3840cfbd`)
- [x] AppUserAuthService retirada con su colección (apps v2.2, migración 20261102_003); la suite legacy-compat conserva sus casos (`08f493d0e`)

**Y además**
- [x] Changelog v1.4.4 + tag retroactivo `v1.4.4` en el commit de main (`966f0bfe9`) (`9bbaf1f49`)
- [x] Renderers para set-app-secret, get-app-secret y copy-app-auth — tarjetas enmascaradas e i18n en/es/ko (`18fac65c3`)
- [x] Launcher: Start = nueva conversación/browser/home/tasks, Create agent en Work, Teros provider en Administration clásica (`8c7e1ac02`) + glyph de Feedback admin (`11b9ee14f`)
- [x] Size test del provider: ejecuta la ruta en pantalla y usa el modelo del propio size (`966f0bfe9`)
- [x] tmux `--` separator, parse-schedule lee MONGODB_URI, typechecks de CI arreglados (`5c6e7f235`, `64788475f`), manifest del todo-list declara eventos de dependencias (`c1fb4b351`)

---

## v1.4.4 - Teros Provider, el runner Claude Code y un sistema de tareas de verdad

> Ventana 2026-10-26 → 2026-11-03 (deploy). 275 commits. Tag `v1.4.4`.

**Teros Provider (TPROV) — modelos por tallas**
- [x] Spec TPROV 1.0.0 + implementación: los modelos se exponen por **tallas L/M/S** en vez de nombres crudos — el size router enruta cada talla al upstream/modelo configurado; cambiar de proveedor es configuración, no código (`f63a2b9a9`)
- [x] Upstreams configurables por talla (**Helmcode, Fireworks, Together**) con **failover** y **vision routing** (las peticiones con imagen van al size con visión) (`f63a2b9a9`)
- [x] Admin window del provider: upstream/modelo/effort por talla, estado de keys y **test en vivo** (texto + imagen) (`ddff910d7`)
- [x] Migración del sistema anterior (providers/modelos pineados) al modelo de sizes (`f63a2b9a9`)

**CCR — Claude Code como runner de tareas**
- [x] Arranque inmune al driver lease, single-flight, resume-note en vez de re-brief (ahorro de tokens), fallback a sesión fresca sin silenciar el fallo
- [x] Attach read-only: ver un terminal no roba el volante del agente; cwd único `/workspace`; animación de trabajando en las filas de Tareas para sesiones Claude

**Tareas — eventos, dependencias y autoplay robusto**
- [x] Eventos en la to-do con paridad de board: suscripciones, "avísame cuando termine", wake-on-completion
- [x] Dependencias (ver y respetar) + estado **cancelled** recuperable + **reviewer** por tarea con validación manual por defecto
- [x] Autoplay v2: play/pause global separado de config por runner, working huérfanas prohibidas, start fallido → 2 reintentos → blocked con error visible
- [x] Spec de migración boards→vistas escrita

**Seguridad — HTML compartido y sesión**
- [x] CSP sandbox en `/objects` y `/share`: HTML/SVG compartido en origen opaco — los scripts corren pero sin acceso a cookies, storage ni fetch same-origin (`734c58bb3`)
- [x] Token de sesión fuera del body de `/auth/session`: WS autentica por cookie (frame `method:'cookie'`), HTTP acepta Bearer o cookie, `credentials:'include'` en 8 llamadas cliente, `strictObject` anti-smuggling (`f717bdb4f`, `19d2755cb`)
- [x] Revocación de shares real: no-store en errores de `/objects` y `/share` — sin cachés heurísticas ni 404 cacheables (`5a1159e71`)
- [x] Verificado con PoC ético click-gated en RAW: la cadena de ataque (fetch same-origin → token de 30 días) queda rota

**Navbar v2 y escritorio**
- [x] Navbar v2 tras flag `navbar_v2`: rail de 3 zonas, pins workspace/personal persistidos (servicio + WS domain + migración, 441 docs sembrados), drag-to-pin, widgets de Tareas/Proyectos
- [x] Desktops dinámicos: hasta 10 escritorios creados con +, eliminables, persistencia por desktop
- [x] Control de UI por el agente: abrir ventanas en desktop/panel concretos, crear desktops, colapsar navbar, dark/light (mca.teros.ui 1.1.0)
- [x] Preview tabs (patrón VS Code) con barrida de todas las aperturas que no lo respetaban

**Sistema y providers**
- [x] System capabilities aisladas (Fase 1): 5 tools fuera del catálogo, toggles por agente, sección "Platform capabilities"
- [x] Automate: cron en lenguaje natural (parser compartido + preview), eventos de to-do en catálogo, acción de crear en to-do
- [x] GitHub MCA 5.4.0: seguridad, clones por agente, errores clasificados, permiso Workflows, límites de tamaño
- [x] Ollama local fuera de cloud + filtro de manifests `:cloud` + rename Playwright→Browser

**Operación y estabilidad**
- [x] Teros Remote: keep-alive diario backend→daemon + TTL de inactividad 48-72h con auto-stop y reconexión guiada
- [x] Admin: broadcast de refresh a todos los browsers conectados (recarga escalonada) + webhook para el pipeline de deploy
- [x] Admin: gestión de usuarios (grant-access, update-role) + copy-app-auth con workspaces obligatorios
- [x] Postprocesado de transcripciones (STT cleaner): heurística whitelist + LLM con guarda anti-invención, flags `stt.clean` (OFF por defecto) — el significado jamás se altera (`8e853865d`)
- [x] Launcher: Start = nueva conversación, browser/home/tasks en el launcher, Create agent → Work, provider en Administration
- [x] Un solo renderer Markdown en instrucciones, outputs, file viewer y chat

## v1.4.3 - Sugerencias en el chat, navegador y el fix de Gmail

> Ventana 2026-10-28 → 2026-10-30 (deploy). 18 commits. Tag `v1.4.3`.

**El chat te propone el siguiente paso**
- [x] Prompts sugeridos contextuales: en conversaciones con ≥1 mensaje, la fila de tools ("X can use") se sustituye por 2-3 chips con mensajes que el usuario podría enviar a continuación — generados tras cada respuesta por un LLM interno barato (teros-glm-5p3-flash), persistidos en el canal e hidratados al recargar (`153a4a82f`)
- [x] Tap en un chip → el texto cae en el composer, editable, NUNCA auto-send; chips inertes mientras se graba voz
- [x] Política de fallo: si la generación falla se mantiene el set anterior — el chat nunca se bloquea

**Fixes críticos**
- [x] Gmail OAuth desbloqueado: el scope `gmail.settings.basic` (añadido 19-oct para firmas nativas) no estaba en la lista de scopes verificados por Google → bloqueo duro "app no verificada" para TODA conexión nueva de Gmail desde el deploy del 28-oct. Eliminado del manifest; la firma nativa degrada en cascada para quien no la tenía (`790a57c26`)
- [x] Mensajes en cola mid-turn: la cola se comprueba tras CADA tool call — lo escrito a mitad de turno entra en el siguiente paso, no espera al final del turno completo (regresión ~22-29 oct) (`6626d8ce1`)

**Navegador dentro de Teros**
- [x] Nuevo tipo de ventana "browser": visor web con iframe, toolbar y fallback honesto cuando un sitio bloquea embeds (`fa4ebd4f9`)
- [x] Fix: el split-resize se congelaba sobre iframes — pointer capture + overlay pointer-events:none (`da1935975`)

**To Do → Tareas**
- [x] Rename global user-facing: UI, i18n (es/en/ko) y display name del MCA pasan a Tareas/Tasks; identificadores internos estables (`9dcd69623`)
- [x] Plan de migración para producción documentado (`de96befb5`)
- [x] Launcher de Tareas pineado en la zona de apps del sidebar (`9ac3c5b3c`)

**Feedback con ciclo de vida**
- [x] Triage estandarizado: vistas tracking/future/dismissed/completed, email al reporter al resolver, intake out-of-band (`4a7e9254a`, `1e891a87f`)
- [x] Feedback Admin registrado en el launcher para admins (`4b49fc7ed`)

**Estabilidad**
- [x] CI verde: 6 tests stale arreglados (rojo desde 28-oct) + cassettes E2E re-grabadas desde árbol limpio (`a36de10e7`, `2d05a708b`, `dd437b555`)
- [x] set-input/set-output aceptan path del volumen + overwrite guard explícito (`fd3e20355`)
- [x] i18n de tools de Twilio — patrón estándar MCA (`7caee9251`)
- [x] QA job description v1 (`a64b772dc`)

## v1.4.2 - Permisos en lote, To Do autoplay y estabilidad

> Ventana 2026-10-26 → 2026-10-28 (deploy). 228 commits. Tag `v1.4.2`.

**Permissions v4 — batches (PERMB)**
- [x] Batch de tool calls con permiso: cada ask del step registra su petición y se pregunta a la vez — un solo panel, no solo la primera con el resto "Skipped" (PERMB-REQ-1)
- [x] Los pendientes no expiran por edad (PERMB 1.1.0) y el marker no se broadcastea como `tool_call_complete` — la card en vivo se queda pending (PERMB-REQ-2)
- [x] Batch grants se ejecutan de una en una por canal (PERMB-REQ-3) — sin perder la sesión MCP
- [x] Panel agrupado que ve las rows del marker v4, Allow/Deny por fila (PERMB-REQ-4) + un solo chime por batch (requests en <2s añaden su row en silencio)
- [x] La card de la tool decide en todos los sitios: navbar sheet y Pending approvals renderizan ToolCallBlock, batch frame, appName + descripción humanizada, labels Always allow/deny, i18n (PERMW)
- [x] Grant path v4: el resultado real de la tool aprobada llega al session store y el wake del agente lo ve en contexto (`700801d14`)
- [x] Marker honesto: el skip ya no promete auto-retry inexistente — el wake nombra la tool aprobada y las skipped a relanzar (`d335f673d`)

**To Do — autoplay y operativa**
- [x] Autoplay del To Do: las tareas `working` sin conversación ya no quedan zombis — arrancables vía start-node (`42d75f46a`)
- [x] El actor del log es el agente de verdad (callerAgentId via thin client) — no el usuario de facturación (TODOLG-REQ-1)
- [x] Viewer: toggle formatted/source y el violet bold del kit To Do (TODOOV-REQ-10/11)
- [x] Specs del eje To Do revisadas y aprobadas por Pablo (TODOAP, TODOMD, TODOOV, TODODH, TODORF, TODOLG)

**Estabilidad y fixes**
- [x] Sancho MCA: calls MCP serializadas + single-flight en la inicialización de sesión — las calls concurrentes ya no pierden la sesión (`589fc5758`, bug cazado en E2E)
- [x] `writeMessage` idempotente por `info.id` — deja de duplicar cada assistant message (299k docs basura, 47% de session_messages) (`d335f673d`)
- [x] Proxy null fix (`8d9f71872`) + hoist de hooks condicionales que crasheaban ventanas (`af0183f0a`)
- [x] Teros Remote: guía de pairing nunca-pareada + instalador de una línea en la description (`ab1113a1f`)
- [x] Manifest de mca.teros.remote ≤500 chars con el comando exacto (`af712ac80`) — desbloquea la validación del deploy
- [x] i18n: labels Make shared/Make personal (en, es, ko) (`1dd978e75`)
- [x] Notas: terminales que te necesitan en navbar/Pending/Home (`8f93673af`, `0a35db281`)

**Docs**
- [x] Specs PERMB 1.0/1.1/1.2.1 + PERMW 1.0.0 — el changelog de specs como log de decisiones
- [x] Changelog HTML de la v1.4.1 y v1.4.2 en `docs/changelog/` (design system, dark-first)


## v1.4.1 (parte) — MCA Wake-on-Demand Fix

> On branch `dev` (2026-10-16). Found by Alice during FVU E2E verification on RAW: after a backend restart, containerized MCAs (`containerMode: per-app`) never woke on-demand — every tool call returned `MCA_NOT_READY (status: standby)` and the backend never even attempted to spawn the container.

**Backend — mca-manager**
 - [x] `executeTool` no longer lets a cached not-ready health result block `getOrSpawn()`. The cached health now only short-circuits with `MCA_NOT_READY` when the MCA is actually running (`status: 'ready'`) but reports itself sick (expired OAuth, broken credentials). For dormant MCAs (standby/error/stopping) the cached snapshot is ignored and the spawn branch runs — fixing the deadlock where the only path that could start the MCA was the very tool call being blocked
 - [x] `checkHealth` without `forceSpawn` no longer caches its `unknown` result on dormant MCAs — a sleeping MCA is not an unhealthy one. Previously any health sweep after a restart (e.g. `admin-infra-mca-health`) poisoned the whole standby fleet for the rest of the session
 - [x] `checkHealth` no longer treats a ready containerized MCA as "not running" just because it has no MCP client: container MCAs speak HTTP (`httpClients`), so a live httpClient now counts as running. `HealthContext` gained an optional `httpClients` map, wired in `McaManager.healthCtx`
 - [x] Unit tests for the health-cache × executeTool interaction (`mca-manager-wake-on-demand.test.ts`): standby without health, standby with cached unknown (the original deadlock), ready with cached not_ready (still blocks — correct), error with cached not_ready (retries spawn), plus the new checkHealth caching rules

**admin-infra MCA**
 - [x] `admin-infra-mca-health` now sends `forceSpawn: true` by default (new optional `forceSpawn` parameter, `false` for a cheap read-only snapshot). The old default was a trap: one call after a backend restart cached `unknown` on every standby MCA and locked the fleet until the next restart

## v1.3.0 - Light & Dark Themes, Board Improvements & Observability

**Themes**
 - [x] Full light/dark theme system — adaptive tokens across the entire app (chat, boards, conversations, settings, all MCA renderers)
 - [x] Light mode as default (aligns with the landing page); toggle from the bottom of the sidebar
 - [x] Theme-adaptive tab bar, shadows, modal backdrops, status bar, safe zones
 - [x] SVG concave corner tabs — composite opaque colors, no transparency artifacts in light mode
 - [x] DesktopIndicator — theme-adaptive tiles replacing dark-only dots
 - [x] UITestWindow — theme preview with tab variations, token swatches & contrast tests

**What's New modal**
 - [x] Visual changelog carousel with per-user tracking ("What's New" on first launch after a release)
 - [x] Multi-language support (en/es/ko) for changelog content + all UI strings
 - [x] Icons via `@tamagui/lucide-icons` (Rocket, TrendingUp, Wrench, AlertTriangle)
 - [x] i18n all modal strings — category labels, prev/next/close/dismiss buttons, progress indicator

**Board & Tasks**
 - [x] Deep links for all 36 windows — bidirectional URL sync, shareable/bookmarkable
 - [x] TaskDetailPanel redesigned — tabs for Instructions, Progress, and Conversation
 - [x] Sticky title and tags while scrolling task content
 - [x] Progress notes with avatars, collapsible markdown, and fade gradients
 - [x] Separate Instructions field on tasks (distinct from description)
 - [x] Board columns scroll properly when a task detail panel is open
 - [x] Unified agent selector with play/stop controls
 - [x] board-manager: update-project, delete-project, update-board-config tools

**Voice mode**
 - [x] Silent mode server-side enforcement (AF-4)
 - [x] Voice transcripts persisted to session store so text agent can see them (AF-5)
 - [x] Pre-startSession voice errors surfaced + 400/500 WS close codes mapped (AF-3, AF-7)
 - [x] Voice worker runs in conversation channel for full history access (AF-2)
 - [x] Screen awake during voice sessions via wake lock
 - [x] Voice mode colors migrated to design system tokens
 - [x] Web tooltip for voice button in chat header
 - [x] Prevent duplicate responses when voice mode is active

**UI polish**
 - [x] Consistent loading spinners across the app (AppSpinner, indigo #5E6AD2)
 - [x] Click outside the task panel to close it
 - [x] FileViewer HTML content adapts to window width
 - [x] Chat fonts migrated to DM Sans + Newsreader + JetBrains Mono
 - [x] 24 MCA tool renderers migrated to theme-adaptive tokens
 - [x] Conversation titles fontWeight normalized in navbar + ConversationsWindow

**Observability — Latitude OTLP export (F3a + F4)**
 - [x] Structural OTLP export of agent traces to Latitude (tokens, latency, tools — no text)
 - [x] Gated by env vars (`LATITUDE_EXPORT_URL/TOKEN/PROJECT`) + feature flag `observability.latitude-export`
 - [x] Latitude score emitter — scores every turn incl. ZDR default (F4·C0)
 - [x] Session Trace signal badge — webhook + disposable index + frontend badge (F4·C1)
 - [x] Prompt-regression gate — contract + behavioural (F4·C3)
 - [x] Latitude signals dashboard (F4·C2)
 - [x] Runbook for swapping export target (Latitude → Langfuse/Arize/Tempo in ~3 lines)

**Compaction & context fixes**
 - [x] Count full prompt with provider-aware tokenizer for compaction trigger (TER-705)
 - [x] Keep protected messages after compaction (CTX-002 / TER-704)
 - [x] Detect context-length overflow structurally across all LLM adapters (CTX-007 / TER-706)
 - [x] Elide oversized tool-call args from LLM history at the prompt choke point (CTX-016)
 - [x] Emit valid JSON when truncating oversized OpenRouter tool-call args (CTX-016)
 - [x] Kill-switch `TOOL_ARG_EVICTION_ENABLED` documented

**Feature flags**
 - [x] Fix: `featureFlags.changed` push now resolves with workspace context — workspace overrides no longer invisible until reload (TER-460)

**MCA Health dashboard**
 - [x] MCA tool health persistence + schema read path (backend)
 - [x] MCA health dashboard (read-only) with live test engine
 - [x] Render + contract test suites (frontend)
 - [ ] Approval-path tool metadata uses the `@agentapps/protocol` field names (`parameters`) behind a single adapter seam — the metadata source can move from local `tools.json` to a session-plane `tools_list` without touching the ranking, intent or badge layers
 - [ ] MCAs declare approval prose with `annotations.intentTemplate` instead of a frontend module — the only form available to an app authored outside this repo

**Integrations**
 - [x] Make.com MCA v2.0 — full scenario lifecycle management
 - [x] notify-by-email tool in messaging MCA

**Other fixes**
 - [x] Auth: extract locale from profile in normalizeAuthUser
 - [x] Conversation: a queued message never aborts in-flight tool calls
 - [x] Agent-to-agent messages use explicit senderType + senderId
 - [x] Billing: guard Stripe chargeInvoice against amount divergence (TER-702)
 - [x] Shared: normalize OperationTimeoutError as TIMEOUT, not unknown (#389)
 - [x] EAS: iOS EAS builds work from the monorepo

## v1.4.1 (parte) — MCA Permission Approval Detail

> Branch `feat/mca-permission-approval-detail`, merged pre-1.4.1. Documented here; user-facing summary in `docs/changelog/changelog-v1.4.1.html`.

**Permissions**
 - [x] Approval cards now explain what a tool will actually do — the tool's own description (or curated summary), capability badges (Reads only / Irreversible / Network) sourced from the manifest, and the parameter values that will be sent
 - [x] Parameters are ranked by decision-relevance (schema-required first), annotated with each field's own schema description, and expandable in place — objects and arrays no longer collapse to an opaque `{...}`
 - [x] Parameters the tool never declared in its schema are flagged
 - [x] Grouped (parallel) approvals: each row carries a one-line parameter digest and capability badges, and expands to the full detail — so approving some while denying others is an informed choice
 - [x] Covers all 42 MCA renderers plus the default renderer with no per-renderer changes (mounted in `withPermissionSupport`)
 - [x] New workspace-scoped `app.get-tool-details` WS action; metadata is fetched lazily and cached per app, never persisted
 - [x] Removed the dead 2001-line `PermissionRequestWidget.tsx` and repointed the docs that still described it as live
 - [x] An approval card whose metadata fetch failed now says so, instead of looking identical to a tool that declares nothing
 - [x] A wrong-typed tool argument can no longer crash the approval card — the per-MCA description overrides decline unusable input rather than throwing into a tree with no error boundary
 - [x] Deeply nested parameter values state how much they withhold instead of dead-ending on an inert placeholder
 - [x] The approval detail now renders **inside** the tool card, below the renderer's own body, instead of floating on the chat background between the card and the Deny/Allow bar — it is part of the tool call, and collapses with it. The bar stays attached below the card so collapsing can never hide the decision
 - [x] A tool with no parameters says so once, not twice — the default body no longer restates the parameter table that the approval detail already shows in richer form
 - [x] Per-MCA approval descriptions (the bash/filesystem/netlify consequence prose) actually reach the card: `mcaId` was never forwarded to the renderer, so that entire layer of the intent ladder was dead in production

**Resolved from the branch review**
 - [x] `ToolDetailsCache.ensure()` coalesced only two concurrent callers and deleted in-flight entries without an identity check — now keyed per tool name and deleted by identity
 - [x] Tool-details failures were permanent for the session — now retried on transport reconnect, and the cache is cleared on session teardown so a second account in the same tab cannot read the first account's cached metadata
 - [x] An empty `toolName` crashed the standalone approval card (the grouped path already guarded it) — both decision surfaces now agree
 - [x] Dropped the 5 unexecuted Cucumber approval scenarios rather than shipping them as apparent coverage: they had never run, could not be run without pointing the suite at the production MongoDB instance, and forwarded their grant/deny frames to a backend with no record of the synthetic request ids. The behaviour they described is covered by the render and unit suites
 - [x] "show more" on a clipped parameter value was inert — the remaining characters were discarded when the value was bounded, so a reviewer approving a large `content` param saw 240 characters and an invitation that led nowhere. The bounded value now carries the whole string and the row reveals it
 - [x] A grouped approval opened a default-rendered card onto an empty padded box: the params table was suppressed on `pending_permission` status, but a grouped card gets no detail to replace it. Suppression is now keyed on the detail's actual presence, and `FallbackBody` returns nothing rather than an empty wrapper
 - [x] The tool-details retry on reconnect only helped cards that had not mounted yet — an already-mounted card's fetch effect never re-ran, so it kept showing "details unavailable" on a recovered connection. The cache now notifies subscribers when failures become retryable
 - [x] `app.get-tool-details` returned metadata for `_`-prefixed private tools that the registration path deliberately withholds from the LLM and the client
 - [x] The `''`-toolName hardening stopped short of the Allow/Deny bar: "Allow always" round-tripped the empty name to `app.updateToolPermission`, which rejects it, and the failure is only logged — so the one-off grant succeeded while the persistent rule silently never saved
 - [x] The grouping signature covered input *arity* but not input *values*, so a same-keys correction (`{path:"src/a"}` → `{path:"src/abc"}`) left the panel row's digest stale — the one thing a reviewer compares sibling rows on
 - [x] Removed four near-copies of the tool-metadata shape (two full duplicates plus two hand-written subsets) in favour of one `types/tool-details.ts`, with the annotations aliased to `@teros/shared`'s `McaToolAnnotations`. The copies listed 8 of 12 fields and, because a narrower object type stays assignable to a wider one, TypeScript reported nothing — the app simply could not see `stability`, `version` or `deprecationMessage`

**Follow-ups** (triaged, none blocking)
 - [ ] HIGH: `packages/e2e` defaults to the production MongoDB instance (`localhost:27017`) — `docs/standards/TESTING-STRATEGY.md:101` says it must never be touched. Pre-existing; only the separate `teros_test` DB name protects real data
 - [ ] Re-add acceptance coverage for tool approval once the UI Cucumber lane can run against a disposable database
 - [ ] No `ErrorBoundary` exists anywhere in the chat or MCA render trees, so any throw in any of 42 renderers blanks the app. Worth its own ticket — this feature surfaced it twice
 - [ ] No integration test binds the client's `app.get-tool-details` action string to the registered handler; deleting the registration would still pass every suite but one
 - [ ] Record in the spec that nested parameters cannot be flagged undeclared (`ToolInputSchema` covers only top-level properties)
 - [ ] Promote the `app.get-tool-details` response shape into `@teros/shared` and validate the handler's return against it — per ARCHITECTURE.md the WS contract lives there, and `types/tool-details.ts` is an app-side stand-in
 - [ ] `useChatPermissions.onGrantAlways` swallows an `updateToolPermission` failure into `console.error`, so a rejected "always" rule looks identical to a saved one (pre-existing; violates engineering principle 2)

## Future

**UI**
 - [ ] @mention system — full mention resolution and agent-to-agent addressing in conversations

**Permissions** (moved from v1.2.0 — both need a rethink/design pass before implementing)
 - [x] Redo the permission request widget — see the Unreleased block above
 - [ ] Auto mode in permissions

**Voice**
 - [ ] Event queueing in voice conversations — events arriving while the
   assistant is speaking (e.g. tool results, permission requests) interrupt the
   TTS playback mid-sentence, causing abrupt cutoffs and disjointed resume.
   Events should be queued and processed after the current speech turn
   completes, the same way normal text conversations defer incoming messages
   until the current turn finishes (post_turn_fifo / boundary_aware strategy).

**Conversations / History**
 - [ ] INVESTIGATE: The Alice agent does not have full access to conversation history.
   When the user asks about previous conversations (e.g. the containers and scalability topic),
   list-channels does not return all existing channels. Investigate:
   - Are conversations being saved correctly in the DB?
   - Does the agent have limited permissions to access certain channels?
   - Is there a filter by workspace, date or conversation type?
   - Are old conversations archived or deleted automatically?
   Possibly related to container scalability issues if conversation storage
   is distributed or sharded.

## v1.2.2 - 

 - [ ] 

## v1.2.1 - Multi-Host Execution & Inline Forms

**Forms**
 - [x] Inline user forms — `request-user-input` built-in tool + FormWidget in the conversation
 - [x] Wizard presentation: question-by-question mode, review step, choice auto-advance, progress in header, i18n copy

**Infra — core/execution separation**
 - [x] Container agent daemon on the execution host (phase 0) — the core no longer talks to Docker directly
 - [x] Remote execution hosts parameterized; prod containers run on a dedicated host (int5)
 - [x] Multi-host deploy — execution host updated in parallel, runtime image builds moved off the core
 - [x] Container hardening for high-concurrency days — container cap, CPU/memory limits, idle timeouts, async Docker calls
 - [x] Egress firewall for egress MCAs (SSRF containment at the network layer): remote core callback allowed, replies to core-initiated connections accepted (conntrack), rules persist across reboots
 - [x] Terminal works against a remote execution host (`TERMINAL_DOCKER_HOST`) and gets a real TTY in `docker exec`

**MCAs**
 - [x] Self-heal stale container entries on CONNECTION_FAILED; aligned idle timeouts
 - [x] Unconnected accounts report `AUTH_REQUIRED` instead of `SYSTEM_CONFIG_MISSING`
 - [x] stdio MCA spawn fixes — `node_modules/.bin` in PATH, ESM `__dirname`

**Permissions**
 - [x] Permission widget rehydrates after reconnect (pending permission persisted through stream desync)
 - [x] Queue poller respects the interrupt strategy — tools no longer die with "cancelled before completion" while waiting for a grant (headless/voice)
 - [x] `alwaysAsk` on app-uninstall; removed from access-grant and skill-grant-access

**UI**
 - [x] Admin-only windows (feature flags, session trace) hidden from the launcher for non-admins
 - [x] PWA serves the cached app shell on offline navigations instead of a blank "Offline" page


## v1.2.0 - UX Improvements

** MCAs **
 - [x] Whatsapp auth simplification
 - [x] Informative message in whatsapp auth tab

 - [x] Superagent has all apps

** Permissions **
 - [x] Read-only mode defaults to allowed
 - [x] UX: No countdown in permissions
 - [x] The agent always tries to use the apps it has, and if it can't access an
   app — because it errors or because it isn't installed — it stops there,
   unless the user tells it to look for a workaround.

** Providers **
 - [x] Add GLM-5.2 to Fireworks + Teros (base + Fast router)
 - [x] Add Kimi 2.7 Fast to Fireworks + Teros (Code Fast router)

 - [x] If the app doesn't exist in the workspace, the agent asks for permission to install it


## v1.1.1 - Board Autorun & Sync

**Workspaces & Agents**
 - [x] Full mobile parity for workspace switching, skills, and projects

**Boards**
 - [x] Board Autorun — supervisor agent with concurrent task assignment and worker slots

**UI**
 - [x] File Browser — full navigation, preview, and file opener

 - [x] Markdown Viewer — standalone viewer window with file opener registration

**Integrations**
 - [x] Notion MCA — extended tool coverage and UX improvements

**MCA tools**
 - [ ] Move tool `description` strings to a translation system — today they are
   hardcoded English in each `ToolConfig` and shown verbatim in the permissions
   UI and Tool Call Cards
 - [ ] Curate MCP annotations per MCA (`readOnlyHint`, `destructiveHint`,
   `idempotentHint`, `openWorldHint`, `irreversible`) — the 2026-07-04 bake made
   `readOnlyHint` explicit everywhere from the retired name heuristic; each MCA
   still needs a manual review pass
 - [ ] Tool naming standardization — kebab-case everywhere, drop service
   prefixes (`linear-*`, `railway-*`, `monday_*`), uniform `-health-check`,
   remove orphaned tools.json entries (`linear-delete-project`)

**Tooling — pinned dependencies**
 - `@react-native-async-storage/async-storage@2.2.0` is pinned in
   `packages/app/package.json`. v3.x is incompatible with Expo SDK 54+
   (see [expo/expo#43757](https://github.com/expo/expo/issues/43757)).
   Bump together with the next Expo SDK upgrade — without that, the
   theme persistence path silently downgrades to in-memory.


## v1.1.0 - Workspaces & Projects

**Workspaces**
 - [x] Private Workspace — auto-created on registration, always first, non-deletable

 - [x] Superagents — global agents visible across all workspaces, shown first in Navbar

 - [x] Workspace zone in Navbar — conversations, agents, apps and skills scoped to active workspace

 - [x] Global workspace selector with backdrop and sorted list

 - [x] `<context>` block injected into system prompt (channel, time, user, workspace, project)

**Projects**
 - [x] Project dashboard window with board, agents and activity panels

 - [x] `/project/[projectId]` route and Navbar section with inline create

 - [x] Project context injected into system prompt for associated conversations

 - [x] Migration script to create projects from existing boards

**Skills**
 - [x] Skills backend — model, service, handlers and WsRouter registration

 - [x] Skills injected into agent system prompt at runtime

 - [x] SkillsWindow — create, edit, delete and assign skills to agents

 - [x] AgentWindow Skills tab — assign and enable/disable skills per agent

 - [x] Skill management tools in core MCA

**Navbar**
 - [x] Fused Teros + superagent header with Account section and clean footer

 - [x] @mention system — hook, dropdown, chips and Lexical composer input

 - [x] New conversation button (+) on superagent header

 - [x] Projects section always visible with inline create

**Desktop**
 - [x] Persist tiling layout per user/workspace — restored on reconnect

 - [x] Drag tab to desktop dot to move windows cross-desktop

 - [x] Custom ghost image pill when dragging tabs

**Scheduler**
 - [x] Unified scheduler events with MCA event subscription system

 - [x] Auto-create and clean up channel subscriptions with reminders and recurring tasks

**New integrations**
 - [x] Railway MCA — deployment management with UI renderer

 - [x] Render MCA — with UI renderer

 - [x] GitHub MCA — migrated to GitHub App, added `clone-repo` tool

 - [x] Figma MCA — migrated to OAuth2, added `file_variables:read` scope

**Infrastructure**
 - [x] Migration system with TTL index as first migration

 - [x] PubSub system — `PubSubService`, `channel_subscriptions`, unified pub/sub across voice, file watcher and scheduler

 - [x] MCA Event Subscription Service wired into backend (`/api/mca-event`)

 - [x] `channel_started` / `channel_finished` events rendered in chat with link

 - [x] `get-blocks` tool with pagination for Notion MCA

 - [x] User profile stats with real data (chats, agents, days active)

 - [x] Badges system — `founding_partner`, `early_bird`

 - [x] File Browser and Markdown Viewer windows (foundation)

**Fixes**
 - [x] Permission request system — stop typing on pending, handle tool status updates, fix race condition

 - [x] Agents can read their own active channel correctly

 - [x] Superagents included in agent list and new conversation modal

 - [x] Skill injection scoped to active workspace

 - [x] Workspace app resolution with legacy `ownerId` fallback

 - [x] `workspaceId` passed correctly through delegate-task and sub-conversations

 - [x] Desktop layout restored correctly on workspace switch

 - [x] Blank window on stale `activeWindowId` resolved

 - [x] Non-ASCII display names encoded correctly in email headers

 - [x] Duplicate tool names detected before LLM call

---

## v1.3.1 - MCA Catalog Redesign, Security Hardening & New Providers

**MCA Catalog**
- [x] Complete catalog redesign — sidebar, stats, and card grid (TER-525)
- [x] MCA detail window with brand hero, permissions, and groups (TER-524, TER-526)
- [x] Category tokens and fonts for catalog (TER-523)
- [x] Install state badges, health dot, and Installed filter (TER-528, TER-530)
- [x] Multiple instance management in MCA detail (TER-535)
- [x] App.context injection into system prompt (TER-534)
- [x] Assign MCAs to agents from AppWindow (TER-532)
- [x] Tools with descriptions in MCA detail (TER-531)
- [x] AppWindow redesign with usability hierarchy and design system re-theme (TER-527)
- [x] Visual polish for catalog and AppWindow (TER-537)
- [x] Populate changelog for 60 MCAs (TER-522)
- [x] Short action descriptions, install wizard, collapsible instances (TER-522)
- [x] Horizontal filters, All/Installed scope, contextual stats (TER-538)
- [x] Highlight installed MCAs with green accent and pill
- [x] Inline setup per instance after install (no modal, no navigation)
- [x] Configured state in cards, instance dropdown, agent role
- [x] Google Suite group + MCA detail cleanup
- [x] Cards show installed app count instead of "Pending"
- [x] 2 cards per row on mobile
- [x] Theme-aware McaIcon component with SVG inline rendering
- [x] Switch MCAs with SVG to icon.svg, backup PNGs
- [x] Normalize SVG sizing + 20% margin for visual consistency
- [x] Restore PNG for Slack, ElevenLabs, Perplexity icons
- [x] Spanish and Korean translations for all 73 MCAs
- [x] MCA-level translation system
- [x] Translate 'N apps' count in catalog cards
- [x] Translate CatalogDetailWindow
- [x] Spanish i18n for mca.google.contacts and ActiveCampaign

**Security**
- [x] SEC-1: Enforce install gate on workspace path + authz on grant/revoke (B-4) (#411)
- [x] SEC-2: Enforce cross-tenant authz on channel creation, file reads, tasks, uploads (#412)
- [x] SEC-3: Use argv-form git clone in mca.github to close command injection (A4) (#413)
- [x] SEC-4: Force-attach executable file downloads + SSRF-guard odoo client (#414)
- [x] SEC-5: Authenticate every MCA callback route by container token (#418)
- [x] SEC-6: Safe network defaults, timing-safe compare, close ownership bypass (TER-725) (#419)
- [x] SEC-7: Golden-set + install-gate invariant + CI wiring (TER-726) (#420)
- [x] Sanitize hardcoded secrets in mca.whatsapp manifest (WS2 / TER-719 / TER-731) (#416)
- [x] Scrub team PII + infra disclosure outside docs (TER-741) (#422)
- [x] Docs/bundle/domain/PII curation for open-source publication (WS3 / TER-719 / TER-732) (#417)

**Providers & Models**
- [x] Add Kimi K3 to Teros provider and enable on Fireworks
- [x] Add GPT-5.6 Sol to OpenAI provider and Kimi K3 to Fireworks
- [x] Add GLM-5.2, GLM-5.2 Fast, and Kimi K2.7 Code Fast to Fireworks + Teros providers
- [x] Update model catalog for all providers (July 2026) (#352)

**Features**
- [x] Download button in File Browser
- [x] Download mode in HTTP file handler
- [x] Move conversations between workspaces from the UI
- [x] channel.move-to-workspace WS handler
- [x] Approve/deny permissions from navbar dropdown
- [x] Agent generates full email-safe HTML, backend only appends Teros banner
- [x] Task detail panel restructured with frosted glass dropdowns

**Fixes**
- [x] Support legacy ws_ workspace IDs in permission checks
- [x] Seed tool permissions in createWorkspaceApp to match createApp
- [x] Heartbeat tool-input deltas to prevent stall watchdog killing live streams (TER-650)
- [x] Simplify AgentWindow conversation list and fix reload guard
- [x] Restore inline getStore()?.sessionUsageId pattern for regression guard
- [x] Remove leftover conflict marker in plaud manifest
- [x] Post-rebase cleanup — google badge, conflict marker remnants

**Infrastructure & DevOps**
- [x] Docker: add script to build MCA runtime images for clone-and-run (TER-744) (#425)
- [x] Docker: add container-agent service so MCAs work on docker compose up (TER-734) (#424)
- [x] Make clone-and-run reproducible — seed key, compose defaults, ports (TER-740) (#421)
- [x] Replace old licensor entity Copernico Labs with Teros AI, S.L. (TER-743) (#423)
- [x] Turn lifecycle clean architecture spec — single-writer turn state, typed errors, transport liveness

**Board & Tasks**
- [x] Add instructions field to batch-create-tasks and improve field descriptions

---

## v1.0.0 - Hello Private Beta

**Voice**
 - [x] Voice unified into chat — inline mode, no separate window

 - [x] Real-time broadcast with 🎙️ indicator in chat bubbles

 - [x] Voice session persistence, auto-reconnect and transcript view

 - [x] Voice selector with curated options, mute button and interruption handling

**Delegation**
 - [x] Sub-conversation visibility toggle and permission escalation to parent channel

 - [x] Forward sub-agent turns to parent channel automatically

 - [x] `delegate-task` tool with headless conversation creation

**Boards**
 - [x] Runner/Manager role separation (`board-runner` / `board-manager` MCAs)

 - [x] Task dependency management with circular dependency detection

 - [x] Drag & drop reorder with ghost card effect

 - [x] Tag filters, text search and hidden task count

 - [x] Auto-dispatcher with worker slots and play/pause

 - [x] Board deep links and double-pane state isolation

**New integrations**
 - [x] Browserbase MCA — cloud browser sessions with Live View (16 tools)

 - [x] ClickUp MCA — full OAuth2 integration (17 tools)

 - [x] GitHub MCA — rewritten with OAuth2 (25 tools)

 - [x] Outlook MCA — Microsoft Outlook via Graph API

 - [x] Homey MCA — smart home integration with token refresh

 - [x] Figma MCA — initial integration

 - [x] Notion MCA — migrated from API key to OAuth2

 - [x] Docker environment manager MCA — Phase 1 PoC

**Providers**
 - [x] Google Gemini — 2.0 Flash, 2.5 Flash, 2.5 Pro and latest 3.x models

 - [x] Default provider/model system with UI controls

**UI**
 - [x] Permission system — approval queue, sound notifications and escalation

 - [x] `send-html-file` tool with FileViewer window and real-time file watching

 - [x] Infinite scroll upward with stable content position

 - [x] Per-tab navigation history with back/forward; Cmd+Click opens in new tab

 - [x] User badges: `founding_partner`, `early_bird`

 - [x] Activity bars (7 days) in user cards

 - [x] Admin users panel with grant-access action

 - [x] Access-granted email via Resend

**Infrastructure**
 - [x] `WsFramework` — `WsRouter`, `SubscriptionManager` and domain migration

 - [x] Paginate channel list with keyset cursor

 - [x] `WsLogger` NDJSON with client IP and batch `getAgentApps` with TTL cache

 - [x] Production backup script with database and volumes

 - [x] Volume migration and verification scripts

 - [x] Provider management tools in core MCA

 - [x] `accessGranted` flow replacing invitation system

 - [x] FSL-1.1-Apache-2.0 license and CONTRIBUTING.md

---

## v0.2.0 - Hello Stable

 - [x] `FilesystemRenderer` in chat — syntax highlighting and inline diff

---

## v0.1.0 - Hello Teros

 - [x] Initial internal release

---

[v1.3.1]: https://github.com/teros-hq/teros/compare/v1.3.0...v1.3.1
[v1.3.0]: https://github.com/teros-hq/teros/compare/v1.2.1...v1.3.0
[v1.2.1]: https://github.com/teros-hq/teros/compare/v1.2.0...v1.2.1
[v1.2.0]: https://github.com/teros-hq/teros/compare/v1.1.1...v1.2.0
[v1.1.1]: https://github.com/teros-hq/teros/compare/v1.1.0...v1.1.1
[v1.1.0]: https://github.com/teros-hq/teros/compare/v1.0.0...v1.1.0
[v1.0.0]: https://github.com/teros-hq/teros/compare/v0.2.0...v1.0.0
[v0.2.0]: https://github.com/teros-hq/teros/compare/v0.1.0...v0.2.0
[v0.1.0]: https://github.com/teros-hq/teros/releases/tag/v0.1.0
