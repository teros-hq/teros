# Cassettes LLM — replay determinista (`@llm`)

`llm.json` contiene las respuestas LLM (Kimi/Fireworks) **grabadas** que el job E2E reproduce en
CI vía `TEROS_LLM_REPLAY` (un `MockLLMAdapter`, ver `packages/core/src/testing/LLMRecorder.ts`).
El mock NO llama al provider real → los specs `@llm` corren **deterministas, sin API key, sin
coste, sin flakiness**. En CI basta una API key **dummy** (el provider `teros` se resuelve, pero el
mock ignora el valor); el job E2E la escribe solo.

El matching es por **hash del input** (mensajes + nombres de tools; ignora `systemPrompt`). El hash
exige que el input sea **determinista**: por eso el modo determinista (`TEROS_DETERMINISTIC=1`,
TER-563) **congela el reloj** (`FixedClock`) y **siembra los IDs** (`SeededIdGenerator` → `channelId`),
de modo que el `[Current Context]` del prompt es idéntico entre grabación y replay. Los specs `@llm`
además usan **texto fijo** (sin `Date.now()`) y el upload deriva el nombre de archivo del contenido.
Si el input cambia, el replay **lanza** (no devuelve una cassette equivocada en silencio). Cada evento
guarda su `delay` real → el replay reproduce el ritmo (necesario para el botón Stop); el
`MockLLMAdapter` respeta `options.signal` para reproducir la cancelación.

**La cassette del Stop test ("Cuenta del 1 al 40 despacio") es SINTÉTICA**: al grabarla, el propio
test corta el turno → el `RecordingLLMAdapter` capturaba 0 eventos (inútil para reproducir un turno
en curso). Se sustituyó por un turno que cuenta 1..40 (81 eventos con delay) para que dure lo
suficiente, aparezca el StopButton y el test lo cancele. Verifica el MECANISMO del Stop (aparece +
cancela), no el contenido del LLM. Al re-grabar, re-inyectar esta cassette (no se graba sola).

## Re-grabar (cuando cambian los prompts o los specs `@llm`)

En local, con el stack containerizado + una key Fireworks **real**:

1. Key real en `.secrets-ci/system/fireworks.json`: `{"apiKey":"fw_..."}` (restaurar la dummy al final).
2. Override de grabación (`TEROS_LLM_RECORD` > `TEROS_LLM_REPLAY`). El determinismo
   (`TEROS_DETERMINISTIC`/`SEED`/`EPOCH`) ya viene de `docker-compose.e2e.yml`, así que record y replay
   comparten el MISMO contexto → el hash grabado == el que computa el replay:
   ```yaml
   # /tmp/dc-record.yml — paths absolutos para que el volumen persista al host
   services:
     backend:
       environment:
         TEROS_LLM_RECORD: /app/scripts/playwright-smoke/recordings/llm.json
       volumes:
         - /ABS/PATH/scripts/playwright-smoke/recordings:/app/scripts/playwright-smoke/recordings
   ```
3. `docker compose -f docker-compose.test.yml -f docker-compose.e2e.yml -f /tmp/dc-record.yml up -d --build`
4. `bun run src/scripts/sync-mcas.ts` + `sync-models.ts` + `node scripts/playwright-smoke/seed.mjs`.
5. **Graba con la SUITE COMPLETA — NO `--grep "@llm"`**:
   `docker compose ... exec -T -w /app browser yarn smoke` → graba a `llm.json`.
   El `channelId` se siembra con un counter **por proceso de backend**, así que el ordinal de cada
   turno `@llm` depende de cuántos canales creó **toda la suite** antes de él. Grabar solo `--grep
   "@llm"` da un orden distinto al que CI reproduce (suite completa) → todos los hashes salvo el
   primero fallan en replay. Atajo para ahorrar tiempo: `--grep-invert "@security"` salta los specs
   lentos/flaky que corren **después** de los `@llm` (no afectan sus ordinales) — válido solo
   mientras ningún spec saltado cree canales **antes** de un `@llm`.
6. **Re-inyectar a mano** la cassette sintética del Stop test (no se graba sola, ver arriba):
   `python3` que busca el cassette cuyo último user-message contiene `"Cuenta del 1 al 40"` y le
   sustituye `events` por los 81 sintéticos (1..40) + `response.content` por el texto del contador.
7. Restaurar la key dummy en `.secrets-ci` y commitear el `llm.json` actualizado.

> **Contrato (throw-on-miss):** el match es EXACTO. Cambiar prompts/tools, o añadir/reordenar specs
> que crean canales **antes** de los `@llm`, desplaza el `channelId` → el replay **lanza** con el
> hash esperado y los disponibles. Es la señal de que toca regrabar (suite completa); no hay fallback
> silencioso que devuelva una cassette equivocada.
