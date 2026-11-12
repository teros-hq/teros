/**
 * A tiny synthetic PNG for the Teros size test (TPROV-REQ-10): a red circle
 * on the left and a blue square on the right on white, 160×100. Generated at
 * runtime (no asset to ship); a model that sees describes exactly that, a model
 * that does not either errors or guesses.
 *
 * @spec TPROV-REQ-10
 */
import { deflateSync } from "node:zlib"

const W = 160
const H = 100

function crc32(buf: Buffer): number {
  let c: number
  let crc = 0xffffffff
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]!) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, "ascii")
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crc])
}

let cached: Buffer | null = null

/** The PNG bytes (memoised). */
export function terosTestImagePng(): Buffer {
  if (cached) return cached
  const rows: Buffer[] = []
  for (let y = 0; y < H; y++) {
    const row = Buffer.alloc(1 + W * 3)
    row[0] = 0 // filter: none
    for (let x = 0; x < W; x++) {
      let r = 255
      let g = 255
      let b = 255
      if ((x - 45) ** 2 + (y - 50) ** 2 <= 28 ** 2) [r, g, b] = [220, 30, 30]
      else if (x >= 95 && x <= 145 && y >= 25 && y <= 75) [r, g, b] = [30, 60, 220]
      row[1 + x * 3] = r
      row[2 + x * 3] = g
      row[3 + x * 3] = b
    }
    rows.push(row)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0)
  ihdr.writeUInt32BE(H, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // RGB
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  cached = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ])
  return cached
}

/** What a seeing model must mention: both shapes with their colour and side. */
export function describesTestImage(text: string): boolean {
  const t = text.toLowerCase()
  const red = /\b(red|rojo|roja)\b/.test(t) && /\b(circle|círculo|circulo)\b/.test(t)
  const blue = /\b(blue|azul)\b/.test(t) && /\b(square|cuadrado)\b/.test(t)
  return red && blue
}
