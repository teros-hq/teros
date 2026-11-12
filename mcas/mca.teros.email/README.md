# mca.teros.email — Email para agentes (y humanos) de Teros

MCA de sistema de email self-hosted sobre **Stalwart (JMAP)**. Cada instancia
instalada **ES un buzón** (`MAIL_ACCOUNT` en los user secrets de la app):
lee carpetas y mensajes, envía con identidad propia, marca leído y destruye.
Las tools admin aprovisionan buzones `@agents.teros.ai` / `@humans.teros.ai`
con contraseñas derivadas deterministas que **nunca se almacenan**.

## Modelo de identidad

- `MAIL_ACCOUNT` (user secret, obligatorio) — el buzón de la instancia.
- Contraseña: `MAIL_PASSWORD` (user secret, opcional — buzones humanos) o
  `derivePassword(MAIL_ACCOUNT, STALWART_MASTER_SECRET)`
  = `base62(HMAC-SHA256(master, 'v1:'+email))[0:32]` (buzones de agente).
- `MAIL_FROM_NAME` (user secret, opcional) — display name por defecto al enviar.
- Multi-instancia: una app por buzón (patrón `mca.teros.remote` / gmail).

## Secrets

**System (por mcaId, `SECRET_MCA_*`):**

| Secret | Descripción |
|---|---|
| `STALWART_BASE_URL` + `STALWART_ADMIN_TOKEN` | Transporte único directo contra Stalwart (p. ej. `https://relay.teros.ai` + su API key admin, Bearer) |
| `STALWART_MASTER_SECRET` | Semilla HMAC de derivePassword |

## Tools (12 + 1 privada)

**Correo** (scope = el buzón de la instancia): `session-info`, `list-folders`,
`list-messages`, `read-message`, `send`, `mark-read`, `destroy`.

**Admin** (plano de aprovisionamiento, siempre `ask`): `admin-list-domains`,
`admin-list-accounts`, `admin-create-account`, `admin-change-password`,
`dns-zone`.

**Privada:** `-health-check` (config + sesión viva, sin valores de secrets).

## Bugs de Stalwart respetados (spec §8)

1. `Email/query` con filtro falla en esta versión → `list-messages` usa
   `Email/get ids:null` + filtrado/orden/paginación client-side.
2. Errores JMAP dentro de HTTP 200 → `assertNoJmapErrors` los lanza
   (`[JMAP_ERROR]` con la description literal del servidor).
3. `isEnabled` NO se acepta en `x:Domain/set` create.
4. DKIM se genera en background tras crear dominio → `dns-zone` reintenta.
5. Envío = flujo de 2 métodos con back-reference `#draft` y
   `onSuccessUpdateEmail` (payload literal del toolkit verificado).
6. `admin-change-password` reemplaza `credentials/0` (elimina app-passwords).

## Desarrollo

```bash
tsc --noEmit -p tsconfig.json        # compilar
bun /opt/teros/scripts/generate-mca-tools.ts mca.teros.email   # regenerar tools.json
```

Spec completa: tarea 1 del proyecto «MCA de email» (tn_W34CaHHoo7rKU77w).
