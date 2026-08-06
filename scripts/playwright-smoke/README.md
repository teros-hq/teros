# Smoke de plataforma (Playwright)

Validación end-to-end del stack real de Teros. Dos capas:

1. **Suite `@playwright/test`** (principal) — valida toda la plataforma por dominio
   contra el stack vivo, con reporter HTML, fixtures y storageState.
2. **Harness standalone** (`smoke.js` + `lib.js`) — smoke de salud de un comando sin
   instalar `@playwright/test`; también es la fuente única del login de Teros.

## Requisitos

1. Stack levantado: backend `:10001` (`cd packages/backend && yarn dev`) + Expo `:8081` (`cd packages/app && yarn web`). Mongo + Qdrant (docker) suelen estar arriba.
2. Usuarios de test sembrados (idempotente): `yarn smoke:seed`.

## Suite `@playwright/test`

```bash
yarn smoke           # suite completa (incluye @llm con Kimi real)
yarn smoke:health    # solo @health (~30s sanity)
yarn smoke:no-llm    # todo menos @llm (sin coste Fireworks)
yarn smoke:report    # abre el reporter HTML (.report/)
```

Filtrar por dominio: `yarn smoke --grep "@agents|@projects"`. Ver navegador: `HEADED=1 yarn smoke`.

### Cobertura por dominio (`tests/*.spec.ts`)

| Spec | Tag | Qué valida |
|---|---|---|
| `health` | `@health` | app carga (window.teros), sidebar, 0 errores JS |
| `agents` | `@agents` | CRUD + realtime a 2ª sesión (agent.created/updated/deleted) |
| `workspaces` | `@workspaces` | create/update/archive + realtime |
| `crossuser` | `@crossuser` | fan-out user1→user2 en el workspace compartido |
| `conversations` | `@llm` | round-trip real con Kimi + lifecycle de canal (rename/close/reopen) |
| `projects` | `@projects`, `@llm` | board: create-project→task→move→assign + start-task (board runner) |
| `apps` | `@apps` | install→list-tools→grant→permisos→uninstall + executeTool (degradable) |
| `files` | `@files` | fileBrowser write→list + fileShare publish→get→unshare |
| `voice` | `@voice` | channel.transcribeAudio con WAV mínimo (degradable) |
| `composer` | `@composer`, `@llm` | **interacción UI real** del InputComposer: escribir+Enter envía, drafts que persisten al recargar (por channelId) y no se arrastran entre canales, file chooser nativo |

### Principios de diseño (por qué así)

- **`window.teros` es el locator.** RN-Web no tiene roles ARIA (`<Image>`→div, botón→TouchableOpacity), así que las aserciones de estado van sobre la API live vía `page.evaluate`, no sobre el DOM. Las web-first assertions (`toBeVisible`) se reservan para login/render. Tipos en `helpers/teros-global.d.ts` (firmas verificadas del cliente).
- **Excepción: interacción UI real** (`composer`). Cuando lo que se valida ES la interacción del navegador (textarea, Enter, drafts, file chooser), el spec maneja el DOM real. Como los botones RN-Web son icon-only sin texto/aria, los anclajes son **testIDs** añadidos al componente (`composer-input/-attach/-send`) — `data-testid` en web, inerte en runtime. El *setup de datos* sigue por `window.teros` (crear/abrir el canal); solo la *interacción* va por UI.
- **Realtime = evento WS.** El recorder (`installEventRecorder`) graba los eventos que el cliente reenvía; `waitForEvent` hace polling del buffer. Patrón: `clearEvents(observador)` → acción en el actor → `waitForEvent(observador, {type})` + re-list (consistencia). `clearEvents` evita falsos positivos (buffer compartido con `workers:1`).
- **storageState** (login una vez en el project `setup`) con fallback a login completo si la sesión no rehidrata. El login (`helpers/login.ts`) es determinista: si el contexto arranca con una sesión persistida, la limpia para autenticar siempre como el usuario pedido.
- **@llm con provider `teros`/Kimi** (credential-free, system secret Fireworks): aserciones laxas (role assistant + texto no vacío, nunca texto exacto), timeouts holgados, `retries: 2` en CI. Excluible con `yarn smoke:no-llm`.
- **Degradable, no rojo falso.** Lo que depende de infra opcional (containers MCA on-demand, STT) hace `test.skip(condición, razón)` cuando no está disponible en el entorno, dejando la razón en el reporte.

### Añadir un dominio

Crear `tests/<dominio>.spec.ts` que importe `{ test, expect } from '../fixtures'` y los helpers de `../helpers/teros`. Fixtures disponibles: `terosPage` (user1), `secondUser1Page` (2ª sesión user1, realtime), `user2Page` (crossuser), `seed`, `capturedErrors(page)`. Si usas una API nueva de `window.teros`, añade su firma a `helpers/teros-global.d.ts`. Cero cambios en el resto.

## Regression del release 2026-06-11 (TER-550)

Cobertura e2e de los fixes del despliegue del 11-jun. Cada spec está **verificado por
mutación** (green→red→green: revertir el fix en el código → el spec se pone rojo →
revertir → verde). Specs nuevos (todos aditivos sobre el harness existente):

| Spec | Tag | Bug(s) | Qué prueba (mutación) |
|---|---|---|---|
| `security` | `@security` | #210/#211/#173/#174/#153/#158 | 8 authz cross-workspace/IDOR (project/agent/app/skill/scheduler/board/set-channel-project/agent read) |
| `security-authz` | `@security` | #173/#210/#172/#211 | skill.get/list/create, project.list, file.share WS, gates admin (update-core/update-mca/list-all-mcas) |
| `security-prompt-injection` | `@security` | #208 | skill.create rechaza Unicode invisible/bidi + contenido >256 KiB |
| `security-lockout` | `@security` | #157 | tras lockout expirado, un fallo NO re-bloquea (contador→1, password correcta entra) |
| `scheduler` | `@security` | #174 | create-recurring-task ownership + channelId malformado (INVALID_INPUT) |
| `board-actions` | `@infra` | #158 | board.move-my-task registrada (happy-path + guard NOT_FOUND≠UNKNOWN_ACTION) |
| `chat-transport-error-code` | `@security` | #238 | el transporte WS preserva `error.code` (FORBIDDEN) en los 3 gates admin |
| `chat-i18n-providers` | `@security` | #239 | ventana My Providers en es-ES (badge 'Activo', 'N modelo(s)', sin inglés) |

Helpers nuevos (Fase 0): `helpers/db.ts` (Mongo: `ensureLockoutUser`/`setIdentityLockState`/
`getIdentityLockState`, para estado sin superficie WS) y `rawWsLogin` en `helpers/teros.ts`
(handshake auth WS throwaway sin tocar la sesión del page).

### Cubierto en su capa determinista (no e2e — por qué)

Política (mejor práctica de testing de flujos con LLM, verificada): la **lógica
determinista** se prueba en su capa (unit/render, mutación-verificada); un **gate e2e
binario sobre una decisión estocástica del LLM** (que el agente decida llamar una tool,
delegar, reintentar) es un anti-patrón de flakiness. Estos bugs ya tienen su red mordiente
en la capa correcta — un spec de navegador aquí sería frágil y redundante:

| Bug | Capa | Test (mutación-verificado) |
|---|---|---|
| #225 permisos al desconectar | backend unit | `packages/backend/tests/unit/permission-disconnect-leak.test.ts` (13 tests, 3 capas, SessionManager real) |
| #164 cancel/interrupt de turno | core unit | `packages/core/src/conversation/{TurnDriver,ChannelWorker,ChannelWorkerRegistry}.test.ts` |
| #163 adapter OAuth tool_use huérfano | core unit | `packages/core/src/llm/AnthropicOAuthAdapter.test.ts` (throw INV-1 vs skip silencioso) + `conversation/synthesizeOrphans.test.ts` (remediación upstream) |
| #166/#212 rate-limit 429 | core unit | `packages/core/src/errors/AgentError.test.ts` (`fromAnthropicError` → `isRateLimit`/`retryAfterSecs`, con `APIError` real del SDK) |
| #226 EventBubble sub-canal | app render | `packages/app/src/components/chat/bubbles/EventBubble.render.test.tsx` (shape-agnostic, 11 ramas) |
| #223 listener leak useChatChannel | app render | `packages/app/src/hooks/chat/useChatChannel.render.test.ts` |
| #221 RootErrorBoundary | app render | `packages/app/src/components/RootErrorBoundary.render.test.tsx` |
| #222 Sentry backend contexto | backend unit | `packages/backend/tests/unit/sentry.test.ts` (AsyncLocalStorage real, leak concurrente) |
| #218 /health Mongo-down (503) | backend unit | `packages/backend/tests/unit/health.test.ts` (contrato 503/degraded; el 200/ok real lo cubre `health.spec.ts` e2e) |
| #168/#209 SSRF imagen/documento | core unit | `packages/core/src/llm/{ImagePipeline.ssrf,safe-fetch,DocumentExtractor}.test.ts` |

> Por qué no e2e: el stack local @llm no procesa turnos de forma fiable (`Could not resolve
> config for agent`), y no hay disparador determinista del permission flow
> (`app.execute-tool` ejecuta directo, sin agente ni permisos), así que un e2e de estos
> bugs dependería de que Kimi decida una acción concreta — flaky por construcción.

### Irreducibles — sin superficie de navegador (documentado, NO spec)

- **deploy-prod.yml #219** y **PM2 readiness #220**: un navegador no puede ejercer un
  workflow de GitHub Actions ni `process.send('ready')`. Ya cubiertos en su capa (#219:
  unit/integration de `wait-for-health.mjs`+`rollback.sh`; #220: unit del bootstrap).

### Fase 2 — conectores MCA → scope de Jairo (TER-395)

feedback token #235, holded/datetime/playwright/discord #236, kelify/admin #237, board-tools
#153, OAuth refresh #154/#169, MCA hot-reconnect #167: el testing de MCAs es scope de Jairo
(TER-395), no de esta suite. Quedan a su cargo; no son deuda de TER-550.

### Relacionado — hotfix TER-551 (rama aparte)

El IDOR de `POST /api/share` (#172 cerró el path WS pero no el HTTP que usa el frontend) se
arregla en **TER-551 / PR #244** con su propio spec `security-share-http.spec.ts`
(mutación-verificada e2e). Vive en la rama `TER-551/fix-share-http-authz`, no aquí.

## Harness standalone (`smoke.js` / `lib.js`)

Atajo de salud que **no** requiere `@playwright/test` (usa `playwright` directo):

```bash
node scripts/playwright-smoke/smoke.js            # health (~30s)
node scripts/playwright-smoke/smoke.js --full --headless --user=user2
```

Exit `0` verde · `1` algún check falló · `2` stack no disponible. `lib.js` es la fuente
del login de Teros + gotchas RN-Web (la suite porta ese login a `helpers/login.ts`).

> `run.js` es el smoke realtime histórico (TER-304). Su cobertura ahora vive en la suite
> (`agents`/`workspaces`/`crossuser`); se conserva como referencia standalone.

## Notas

- Los specs E2E (setup+act+assert de un ciclo completo) superan el límite de 50 líneas
  de Biome — son warnings benignos, no errores.
- 404 de red (avatar local) se reportan como ⚠️ y no fallan; errores JS de consola/page sí.
