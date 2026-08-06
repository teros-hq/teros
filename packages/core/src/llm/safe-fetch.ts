/**
 * SSRF-safe download fetch (TER-508 / TER-458).
 *
 * `fetch` con el default `redirect: 'follow'` deja que un host de la allowlist
 * con un open-redirect rebote la descarga a una IP interna o al endpoint de
 * metadata de la nube (169.254.169.254) → robo de credenciales IAM. Validar
 * solo la URL de entrada NO basta: los hops del redirect hay que revalidarlos.
 *
 * Este helper sigue los redirects MANUALMENTE y revalida CADA hop contra
 * `isValidUrl`, con un cap de saltos. Está extraído a propósito: el mismo
 * patrón vivía duplicado e inline en `ImagePipeline.downloadImage`, y fue justo
 * esa duplicación la que dejó `DocumentExtractor.downloadDocument` sin proteger
 * (el gemelo de TER-508). Un único helper hace que ningún path de descarga con
 * allowlist pueda volver a olvidar la revalidación.
 */

/** Cap de redirects a seguir en una descarga (cada hop se revalida). */
export const MAX_DOWNLOAD_REDIRECTS = 5;

/** Lanzada cuando un hop apunta a un destino no permitido o el redirect es inválido. */
export class SsrfRedirectError extends Error {
  constructor(
    message: string,
    public readonly requestedUrl: string,
  ) {
    super(message)
    this.name = "SsrfRedirectError"
  }
}

/**
 * Como `fetch`, pero siguiendo los redirects a mano y revalidando cada salto.
 * Lanza `SsrfRedirectError` si un `Location` no pasa `isValidUrl`, si falta el
 * header, si está malformado, o si se supera `maxRedirects`. Devuelve la
 * primera respuesta NO-redirect (el caller comprueba `response.ok`).
 */
export async function fetchFollowingRedirectsSafely(
  url: string,
  opts: {
    isValidUrl: (candidate: string) => boolean
    signal?: AbortSignal
    maxRedirects?: number
  },
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? MAX_DOWNLOAD_REDIRECTS
  let currentUrl = url
  let hop = 0

  while (true) {
    const response = await fetch(currentUrl, {
      redirect: "manual",
      signal: opts.signal,
    })

    // No es un redirect 3xx → devolver tal cual (el caller valida response.ok).
    if (response.status < 300 || response.status >= 400) {
      return response
    }

    if (hop >= maxRedirects) {
      throw new SsrfRedirectError(`Too many redirects (>${maxRedirects})`, url)
    }

    const location = response.headers.get("location")
    if (!location) {
      throw new SsrfRedirectError(`Redirect (${response.status}) with no Location header`, url)
    }

    let nextUrl: string
    try {
      // Resolver relativo contra la URL actual (los servidores pueden devolver Location relativo).
      nextUrl = new URL(location, currentUrl).toString()
    } catch {
      throw new SsrfRedirectError(`Malformed redirect Location: ${location}`, url)
    }

    if (!opts.isValidUrl(nextUrl)) {
      throw new SsrfRedirectError(`Blocked SSRF redirect to non-allowed target: ${nextUrl}`, url)
    }

    currentUrl = nextUrl
    hop++
  }
}
