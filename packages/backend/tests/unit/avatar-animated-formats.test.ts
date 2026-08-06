/**
 * TER-609 — contrato de avatares animados. El soporte de GIF/WebP animado se
 * apoya en que el upload los acepte y el static serve los sirva con el MIME
 * correcto (no se recomprimen, así que la animación se preserva). Este guard
 * muerde si alguien retira esos formatos del whitelist o del mapa de MIME.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = resolve(__dirname, '../../src')
const read = (rel: string): string => readFileSync(resolve(SRC, rel), 'utf8')

describe('avatar animado (GIF/WebP) · contrato de formatos', () => {
  it('el upload de avatar acepta image/gif e image/webp', () => {
    const src = read('handlers/http-upload-handler.ts')
    const set = src.match(/ALLOWED_AVATAR_MIME_TYPES\s*=\s*new Set\(\[([\s\S]*?)\]\)/)
    expect(set).not.toBeNull()
    expect(set![1]).toContain('image/gif')
    expect(set![1]).toContain('image/webp')
  })

  it('el static serve mapea .gif y .webp a su MIME type', () => {
    // El MIME_TYPES que usa handleStaticFile vive en bootstrap/http-server.ts
    // (constante propia, NO la de http-upload-handler.ts). Verificar el correcto:
    // si se quita gif/webp de aquí, el avatar animado se sirve como octet-stream.
    const src = read('bootstrap/http-server.ts')
    expect(src).toMatch(/'\.gif':\s*'image\/gif'/)
    expect(src).toMatch(/'\.webp':\s*'image\/webp'/)
  })
})
