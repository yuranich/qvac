import { describe, expect, test } from 'bun:test'
import { decodeJsonBytes, decodeUtf8Text, encodeJsonBytes } from '../codec.ts'

describe('codec', function () {
  test('round-trips a JSON value through Buffer', function () {
    const value = { a: 1, b: ['x', 'y'], c: null }
    expect(decodeJsonBytes<typeof value>(encodeJsonBytes(value))).toEqual(value)
  })

  test('decodes a plain Uint8Array the same as the Buffer it was copied from', function () {
    const text = 'héllo wörld 🎉'
    const buffer = Buffer.from(JSON.stringify(text))
    // Simulate the mobile worklet boundary: a plain Uint8Array copy of the
    // same bytes, not a Buffer instance.
    const plain = new Uint8Array(buffer)
    expect(decodeJsonBytes<string>(plain as unknown as Buffer)).toBe(text)
  })

  test('decodeUtf8Text decodes plain text bytes, including multi-byte characters', function () {
    const text = 'emoji: 🎉 accents: héllo'
    expect(decodeUtf8Text(Buffer.from(text, 'utf8'))).toBe(text)
    const plain = new Uint8Array(Buffer.from(text, 'utf8'))
    expect(decodeUtf8Text(plain as unknown as Buffer)).toBe(text)
  })
})
