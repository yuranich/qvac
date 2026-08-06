// Work-id grammar for this app's two durable-work row kinds:
//   session: code/<sessionId>
//   turn:    code/<sessionId>/turn/<seq padded to 6 digits>
//
// Everything here is pure and synchronous: no Math.random(), no Date.now(),
// no `new Date()`. Callers inject entropy and time so the whole package
// stays deterministic under test.

const SESSION_PREFIX = 'code'
const TURN_SEGMENT = 'turn'
const SEQ_DIGITS = 6
// Seq must fit the zero-padded digit width above, so it is bounded well
// below the point where padding would silently truncate it.
const SEQ_EXCLUSIVE_MAX = 10 ** SEQ_DIGITS
const SESSION_ID_LENGTH = 10
const SESSION_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
/**
 * An executor id is embedded in slash-delimited tokens -- the claim decision
 * `claim/<executorId>`, the approval gate id `approval/<executorId>/<index>` --
 * so it must contain no slash. Constrain it to one character class here rather
 * than leaving each caller to invent an id and discover the constraint when a
 * claim fails at runtime.
 */
const EXECUTOR_ID_PATTERN = /^[A-Za-z0-9_-]+$/
const EXECUTOR_ID_MAX_LENGTH = 96

export type CodeWorkId =
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'turn'; readonly sessionId: string; readonly seq: number }

export function formatSessionWorkId(sessionId: string): string {
  return `${SESSION_PREFIX}/${requireSessionId(sessionId)}`
}

/**
 * The only way to build an executor id. Opaque to everything except equality
 * and display, so the parts are sanitised rather than escaped -- two different
 * hostnames never collide in practice because the project hash disambiguates.
 */
export function formatExecutorId(input: {
  readonly hostname: string
  readonly projectHash: string
}): string {
  const hostname = sanitizeIdPart(input.hostname)
  const projectHash = sanitizeIdPart(input.projectHash)
  if (!hostname || !projectHash) {
    throw new Error('Executor id needs a hostname and a project hash')
  }
  return requireExecutorId(`code-${hostname}-${projectHash}`)
}

export function requireExecutorId(executorId: string): string {
  if (
    !EXECUTOR_ID_PATTERN.test(executorId) ||
    executorId.length > EXECUTOR_ID_MAX_LENGTH
  ) {
    throw new Error(`Invalid executor id: ${JSON.stringify(executorId)}`)
  }
  return executorId
}

export function isExecutorId(value: string): boolean {
  return (
    EXECUTOR_ID_PATTERN.test(value) && value.length <= EXECUTOR_ID_MAX_LENGTH
  )
}

function sanitizeIdPart(value: string) {
  return value.trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

export function formatTurnWorkId(input: {
  readonly sessionId: string
  readonly seq: number
}): string {
  const sessionId = requireSessionId(input.sessionId)
  const seq = requireSeq(input.seq)
  return `${SESSION_PREFIX}/${sessionId}/${TURN_SEGMENT}/${padSeq(seq)}`
}

export function parseCodeWorkId(workId: string): CodeWorkId | null {
  const segments = workId.split('/')
  if (segments.length === 2) {
    const [prefix, sessionId] = segments
    if (prefix !== SESSION_PREFIX || sessionId == null || !isValidSessionId(sessionId)) {
      return null
    }
    return { kind: 'session', sessionId }
  }
  if (segments.length === 4) {
    const [prefix, sessionId, turnSegment, seqText] = segments
    if (
      prefix !== SESSION_PREFIX ||
      sessionId == null ||
      !isValidSessionId(sessionId) ||
      turnSegment !== TURN_SEGMENT ||
      seqText == null ||
      seqText.length !== SEQ_DIGITS ||
      !/^\d+$/.test(seqText)
    ) {
      return null
    }
    const seq = Number(seqText)
    if (!isValidSeq(seq)) return null
    return { kind: 'turn', sessionId, seq }
  }
  return null
}

export function isTurnOfSession(workId: string, sessionId: string): boolean {
  const parsed = parseCodeWorkId(workId)
  return parsed != null && parsed.kind === 'turn' && parsed.sessionId === sessionId
}

/**
 * Derives a short, url-safe session id from caller-supplied entropy (e.g. a
 * random hex string or a device-scoped counter). Two 32-bit FNV/Fowler-Noll
 * variant hashes are combined into a 64-bit value and rendered in base36 --
 * enough spread for a PoC session id without pulling in a crypto module.
 */
export function createSessionId(entropy: string): string {
  if (!entropy) throw new Error('Session id entropy is required')
  let high = 0x811c9dc5
  let low = 0x9e3779b9
  for (let index = 0; index < entropy.length; index++) {
    const code = entropy.charCodeAt(index)
    high ^= code
    high = Math.imul(high, 16777619)
    low = Math.imul(low ^ code, 2654435761)
  }
  let value = (BigInt(high >>> 0) << 32n) | BigInt(low >>> 0)
  const base = BigInt(SESSION_ID_ALPHABET.length)
  let id = ''
  for (let index = 0; index < SESSION_ID_LENGTH; index++) {
    const digit = SESSION_ID_ALPHABET[Number(value % base)]
    id = (digit ?? '0') + id
    value /= base
  }
  return id
}

function isValidSessionId(sessionId: string): boolean {
  return sessionId.length > 0 && !/[\s/]/.test(sessionId)
}

function requireSessionId(sessionId: string): string {
  if (!isValidSessionId(sessionId)) {
    throw new Error(`Invalid code session id: ${JSON.stringify(sessionId)}`)
  }
  return sessionId
}

function isValidSeq(seq: number): boolean {
  return Number.isSafeInteger(seq) && seq >= 0 && seq < SEQ_EXCLUSIVE_MAX
}

function requireSeq(seq: number): number {
  if (!isValidSeq(seq)) throw new Error(`Invalid code turn seq: ${seq}`)
  return seq
}

function padSeq(seq: number): string {
  return String(seq).padStart(SEQ_DIGITS, '0')
}
