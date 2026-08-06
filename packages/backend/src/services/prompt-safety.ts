/**
 * prompt-safety — saneamiento del contenido colaborativo que llega al system
 * prompt en producción (TER-379 / SEC-002/003/013).
 *
 * Dos preocupaciones independientes:
 *
 *  1. **Rechazar** Unicode invisible / bidi peligroso (fail-loud, NUNCA
 *     silenciar — principio "No Fallbacks"). Estos code points esconden cargas
 *     de prompt-injection a la persona que revisa una skill mientras el LLM sí
 *     las lee. Corre en write-time (skill-service create/update).
 *
 *  2. **Neutralizar** los tags estructurales con que el prompt envuelve el
 *     contenido, para que un body/contexto no pueda cerrar su bloque
 *     (`</skill>`, `</project>`, `</context>`) ni forjar uno nuevo. Corre en
 *     render-time (model-service.buildSystemPrompt).
 *
 * La lógica de (1) y la neutralización no destructiva de (2) están portadas de
 * `packages/shared/src/skill-format/sanitize.ts` de la rama
 * `fix/skills-v2-security-hardening` (Skills v2, aún experimental/sin mergear).
 * Skills v2 reemplazará este render con `system-prompt-builder.ts`; mientras
 * tanto el vector vive en `model-service.ts` y prod necesita la defensa aquí.
 * Cuando v2 aterrice, ambos lados convergen en el módulo de `skill-format`.
 *
 * Es defensa en profundidad sobre la authz del CRUD de skills (TER-481), no la
 * sustituye — el prompt injection no se "resuelve" del todo (límite conocido).
 */

/**
 * Code points prohibidos. Elegidos para cazar los canales de ataque reales sin
 * falsos positivos sobre texto legítimo:
 *  - U+E0000–U+E007F  Unicode tags (invisibles; jamás legítimos en prosa)
 *  - U+200B           zero-width space
 *  - U+202A–U+202E    bidi embeddings/overrides (Trojan Source)
 *  - U+2060–U+2064    word joiner + invisible math operators
 *  - U+2066–U+2069    bidi isolates (Trojan Source)
 *  - U+FEFF           BOM interior / zero-width no-break space
 *
 * Deliberadamente NO incluidos (usos legítimos): U+200C/U+200D (ZWNJ/ZWJ —
 * escrituras índicas/persas y secuencias ZWJ de emoji) y U+200E/U+200F
 * (LRM/RLM, marcas direccionales de texto bidi normal).
 */
const DANGEROUS_UNICODE =
  /[\u{E0000}-\u{E007F}\u{200B}\u{202A}-\u{202E}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{FEFF}]/u

const DANGEROUS_UNICODE_GLOBAL = new RegExp(DANGEROUS_UNICODE.source, "gu")

/**
 * SEC-013: cap duro al tamaño del contenido de skill (en unidades UTF-16). Las
 * instrucciones de skill son prosa; 256 KiB ya está muy por encima de cualquier
 * skill real y por debajo de un nivel que amenazaría la ventana de contexto o
 * la memoria del backend.
 */
export const MAX_SKILL_CONTENT_CHARS = 256 * 1024

/** La lanza `assertSafeSkillText` para que el caller la mapee a un código estable. */
export class SkillSanitizationError extends Error {
  constructor(
    message: string,
    public readonly field: string,
    public readonly codepoint: string,
    public readonly index: number,
  ) {
    super(message)
    this.name = "SkillSanitizationError"
  }
}

function formatCodepoint(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`
}

/**
 * Devuelve el primer code point prohibido en `text` (con su offset), o `null`
 * si el texto está limpio.
 */
export function findDangerousUnicode(text: string): { codepoint: string; index: number } | null {
  DANGEROUS_UNICODE_GLOBAL.lastIndex = 0
  const m = DANGEROUS_UNICODE_GLOBAL.exec(text)
  if (!m) return null
  const cp = m[0].codePointAt(0)
  return { codepoint: formatCodepoint(cp ?? 0), index: m.index }
}

/**
 * Lanza `SkillSanitizationError` si `text` lleva un code point invisible/bidi
 * que podría colar instrucciones ocultas al modelo. `field` nombra el campo
 * ofensor para el mensaje de error.
 */
export function assertSafeSkillText(text: string, field: string): void {
  const hit = findDangerousUnicode(text)
  if (hit) {
    throw new SkillSanitizationError(
      `${field} contains a disallowed invisible/bidi Unicode character (${hit.codepoint} at offset ${hit.index}). ` +
        "Such characters can hide instructions from human review and are not permitted.",
      field,
      hit.codepoint,
      hit.index,
    )
  }
}

/**
 * Neutraliza los tags estructurales que el system prompt usa como envoltorio
 * (`<skill>`, `<project>`, `<context>`, `<available_skills>`, `<file>`), para
 * que el contenido NO pueda emitir un `</skill>` literal (etc.) y escapar de su
 * bloque ni forjar uno nuevo. Solo se escapa el `<` de uno de nuestros tag
 * names conocidos a `&lt;`; cualquier otro `<` (markdown / código normal) queda
 * intacto → no destructivo para el contenido legítimo. El modelo decodifica
 * `&lt;` como `<`, así que el texto se lee igual; solo pierde la capacidad de
 * romper la estructura.
 */
const PROMPT_BLOCK_TAG = /<(\/?)(available_skills|skill|project|context|file)\b/gi

export function neutralizePromptTags(text: string): string {
  return text.replace(PROMPT_BLOCK_TAG, "&lt;$1$2")
}

/** Escapa un valor interpolado en un atributo XML (`name="…"`). */
export function escapePromptBlockAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}
