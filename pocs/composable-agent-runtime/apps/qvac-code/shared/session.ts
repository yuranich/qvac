import { decodeJsonBytes, encodeJsonBytes } from './codec.ts'

export interface CodeSessionPayload {
  readonly kind: 'code-session'
  readonly title: string
  // Display-only. This string is shown in session lists and headers; it
  // must never be treated as a filesystem path. An absolute path arriving
  // from a peer must never reach a sandbox write root -- resolve any actual
  // project root locally, from local config, not from this field.
  readonly projectLabel: string
  readonly model: string
  readonly createdBy: string
}

export interface CodeTurnPayload {
  readonly kind: 'code-turn'
  readonly sessionId: string
  readonly seq: number
  readonly prompt: string
  readonly requestedBy: string
}

export function encodeSessionPayload(payload: CodeSessionPayload): Buffer {
  return encodeJsonBytes(validateSessionPayload(payload))
}

export function decodeSessionPayload(bytes: Buffer): CodeSessionPayload {
  return validateSessionPayload(decodeJsonBytes(bytes))
}

export function encodeTurnPayload(payload: CodeTurnPayload): Buffer {
  return encodeJsonBytes(validateTurnPayload(payload))
}

export function decodeTurnPayload(bytes: Buffer): CodeTurnPayload {
  return validateTurnPayload(decodeJsonBytes(bytes))
}

function validateSessionPayload(value: unknown): CodeSessionPayload {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid code session payload')
  }
  const kind = Reflect.get(value, 'kind')
  const title = Reflect.get(value, 'title')
  const projectLabel = Reflect.get(value, 'projectLabel')
  const model = Reflect.get(value, 'model')
  const createdBy = Reflect.get(value, 'createdBy')
  if (
    kind !== 'code-session' ||
    typeof title !== 'string' ||
    !title.trim() ||
    typeof projectLabel !== 'string' ||
    typeof model !== 'string' ||
    !model.trim() ||
    typeof createdBy !== 'string' ||
    !createdBy.trim()
  ) {
    throw new Error('Invalid code session payload')
  }
  return { kind, title, projectLabel, model, createdBy }
}

function validateTurnPayload(value: unknown): CodeTurnPayload {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid code turn payload')
  }
  const kind = Reflect.get(value, 'kind')
  const sessionId = Reflect.get(value, 'sessionId')
  const seq = Reflect.get(value, 'seq')
  const prompt = Reflect.get(value, 'prompt')
  const requestedBy = Reflect.get(value, 'requestedBy')
  if (
    kind !== 'code-turn' ||
    typeof sessionId !== 'string' ||
    !sessionId.trim() ||
    typeof seq !== 'number' ||
    !Number.isSafeInteger(seq) ||
    seq < 0 ||
    typeof prompt !== 'string' ||
    typeof requestedBy !== 'string' ||
    !requestedBy.trim()
  ) {
    throw new Error('Invalid code turn payload')
  }
  return { kind, sessionId, seq, prompt, requestedBy }
}
