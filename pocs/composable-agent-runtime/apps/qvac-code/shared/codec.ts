// JSON <-> Buffer helpers shared by every payload/journal codec in this
// package.

export function encodeJsonBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value))
}

export function decodeJsonBytes<Value>(bytes: Buffer): Value {
  return JSON.parse(decodeUtf8(bytes)) as Value
}

// Some rows (record-outcome's `result`) carry plain text rather than JSON.
// Exposed separately so callers do not have to round-trip through
// JSON.stringify/parse just to read a string back.
export function decodeUtf8Text(bytes: Buffer): string {
  return decodeUtf8(bytes)
}

/**
 * Bytes reach this code as a Buffer on Bare and Node, but as a plain
 * Uint8Array across the mobile worklet boundary, and Uint8Array.toString()
 * yields comma-joined byte values rather than text. Decode explicitly so the
 * result does not depend on which prototype survived the transport.
 */
function decodeUtf8(bytes: Buffer | Uint8Array | string) {
  if (typeof bytes === 'string') return bytes
  // Already a Buffer on Bare and Node, which is the path every local decode
  // takes; Buffer.from would copy it again for nothing.
  if (Buffer.isBuffer(bytes)) return bytes.toString('utf8')
  // Buffer.from normalises a plain Uint8Array into a Buffer whose toString
  // decodes text. TextDecoder is not available on Hermes.
  return Buffer.from(
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  ).toString('utf8')
}
