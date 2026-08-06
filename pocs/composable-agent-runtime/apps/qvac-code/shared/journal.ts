import { CODE_ENTRY } from './formats.ts'
import { decodeJsonBytes, encodeJsonBytes } from './codec.ts'
import type { CodeApprovalDecision, CodeDeciderRef } from './approval.ts'

export interface CodeJournalHeader {
  readonly writer: string
  readonly seq: number
}

export type CodeJournalBody = CodeJournalHeader &
  (
    | { readonly type: 'turn-claim'; readonly executorId: string; readonly result: 'won' | 'confirmed' | 'lost' }
    | { readonly type: 'assistant-delta'; readonly text: string }
    | { readonly type: 'thinking-delta'; readonly text: string }
    | { readonly type: 'tool-call'; readonly callRef: string; readonly name: string; readonly summary: string }
    | {
        readonly type: 'tool-result'
        readonly callRef: string
        readonly name: string
        readonly ok: boolean
        readonly summary: string
      }
    | {
        readonly type: 'approval-requested'
        readonly gateId: string
        readonly name: string
        readonly summary: string
        readonly detail: readonly string[]
      }
    | {
        readonly type: 'approval-resolved'
        readonly gateId: string
        readonly decision: CodeApprovalDecision
        readonly reason: string | null
      }
    | { readonly type: 'turn-metrics'; readonly metrics: Readonly<Record<string, number>> }
    | { readonly type: 'turn-error'; readonly message: string; readonly recoverable: boolean }
    | { readonly type: 'turn-interrupted'; readonly executorId: string }
    | { readonly type: 'turn-superseded'; readonly executorId: string; readonly winner: string }
  )

export function entryTypeFor(body: CodeJournalBody): string {
  switch (body.type) {
    case 'turn-claim':
      return CODE_ENTRY.turnClaim
    case 'assistant-delta':
      return CODE_ENTRY.assistantDelta
    case 'thinking-delta':
      return CODE_ENTRY.thinkingDelta
    case 'tool-call':
      return CODE_ENTRY.toolCall
    case 'tool-result':
      return CODE_ENTRY.toolResult
    case 'approval-requested':
      return CODE_ENTRY.approvalRequested
    case 'approval-resolved':
      return CODE_ENTRY.approvalResolved
    case 'turn-metrics':
      return CODE_ENTRY.turnMetrics
    case 'turn-error':
      return CODE_ENTRY.turnError
    case 'turn-interrupted':
      return CODE_ENTRY.turnInterrupted
    case 'turn-superseded':
      return CODE_ENTRY.turnSuperseded
  }
}

export function encodeJournalBody(body: CodeJournalBody): Buffer {
  return encodeJsonBytes(body)
}

/**
 * Unlike the payload decoders in session.ts, a malformed or unrecognised
 * body here must not throw. The journal is a shared, append-only log: a
 * peer running an older build of this app has to be able to skip entries
 * written by a newer version (an unknown `type`, an added field) instead of
 * failing the whole transcript render.
 */
export function decodeJournalBody(bytes: Buffer): CodeJournalBody | null {
  let value: unknown
  try {
    value = decodeJsonBytes(bytes)
  } catch {
    return null
  }
  const header = readHeader(value)
  if (header == null || typeof value !== 'object' || value === null) return null
  const type = Reflect.get(value, 'type')

  if (type === 'turn-claim') {
    const executorId = Reflect.get(value, 'executorId')
    const result = Reflect.get(value, 'result')
    if (typeof executorId !== 'string' || !executorId.trim()) return null
    if (result !== 'won' && result !== 'confirmed' && result !== 'lost') return null
    return { ...header, type, executorId, result }
  }
  if (type === 'assistant-delta' || type === 'thinking-delta') {
    const text = Reflect.get(value, 'text')
    if (typeof text !== 'string') return null
    return { ...header, type, text }
  }
  if (type === 'tool-call') {
    const callRef = Reflect.get(value, 'callRef')
    const name = Reflect.get(value, 'name')
    const summary = Reflect.get(value, 'summary')
    if (typeof callRef !== 'string' || !callRef.trim()) return null
    if (typeof name !== 'string' || !name.trim()) return null
    if (typeof summary !== 'string') return null
    return { ...header, type, callRef, name, summary }
  }
  if (type === 'tool-result') {
    const callRef = Reflect.get(value, 'callRef')
    const name = Reflect.get(value, 'name')
    const ok = Reflect.get(value, 'ok')
    const summary = Reflect.get(value, 'summary')
    if (typeof callRef !== 'string' || !callRef.trim()) return null
    if (typeof name !== 'string' || !name.trim()) return null
    if (typeof ok !== 'boolean') return null
    if (typeof summary !== 'string') return null
    return { ...header, type, callRef, name, ok, summary }
  }
  if (type === 'approval-requested') {
    const gateId = Reflect.get(value, 'gateId')
    const name = Reflect.get(value, 'name')
    const summary = Reflect.get(value, 'summary')
    const detail = Reflect.get(value, 'detail')
    if (typeof gateId !== 'string' || !gateId.trim()) return null
    if (typeof name !== 'string' || !name.trim()) return null
    if (typeof summary !== 'string') return null
    if (!isStringArray(detail)) return null
    return { ...header, type, gateId, name, summary, detail }
  }
  if (type === 'approval-resolved') {
    const gateId = Reflect.get(value, 'gateId')
    const decision = readApprovalDecision(Reflect.get(value, 'decision'))
    const reason = Reflect.get(value, 'reason')
    if (typeof gateId !== 'string' || !gateId.trim()) return null
    if (decision == null) return null
    if (reason !== null && typeof reason !== 'string') return null
    return { ...header, type, gateId, decision, reason }
  }
  if (type === 'turn-metrics') {
    const metrics = Reflect.get(value, 'metrics')
    if (!isNumberRecord(metrics)) return null
    return { ...header, type, metrics }
  }
  if (type === 'turn-error') {
    const message = Reflect.get(value, 'message')
    const recoverable = Reflect.get(value, 'recoverable')
    if (typeof message !== 'string') return null
    if (typeof recoverable !== 'boolean') return null
    return { ...header, type, message, recoverable }
  }
  if (type === 'turn-interrupted') {
    const executorId = Reflect.get(value, 'executorId')
    if (typeof executorId !== 'string' || !executorId.trim()) return null
    return { ...header, type, executorId }
  }
  if (type === 'turn-superseded') {
    const executorId = Reflect.get(value, 'executorId')
    const winner = Reflect.get(value, 'winner')
    if (typeof executorId !== 'string' || !executorId.trim()) return null
    if (typeof winner !== 'string' || !winner.trim()) return null
    return { ...header, type, executorId, winner }
  }
  // Unrecognised type: forward-compatibility path described above.
  return null
}

function readHeader(value: unknown): CodeJournalHeader | null {
  if (typeof value !== 'object' || value === null) return null
  const writer = Reflect.get(value, 'writer')
  const seq = Reflect.get(value, 'seq')
  if (typeof writer !== 'string' || !writer.trim()) return null
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return null
  return { writer, seq }
}

function readApprovalDecision(value: unknown): CodeApprovalDecision | null {
  if (typeof value !== 'object' || value === null) return null
  const verdict = Reflect.get(value, 'verdict')
  if (
    verdict !== 'approved' &&
    verdict !== 'denied' &&
    verdict !== 'withdrawn' &&
    verdict !== 'unanswered'
  ) {
    return null
  }
  const decidedBy = readDeciderRef(Reflect.get(value, 'decidedBy'))
  if (decidedBy == null) return null
  return { verdict, decidedBy }
}

function readDeciderRef(value: unknown): CodeDeciderRef | null {
  if (typeof value !== 'object' || value === null) return null
  const kind = Reflect.get(value, 'kind')
  if (kind === 'executor') {
    const executorId = Reflect.get(value, 'executorId')
    if (typeof executorId !== 'string' || !executorId.trim()) return null
    return { kind, executorId }
  }
  if (kind === 'peer') {
    const deviceRef = Reflect.get(value, 'deviceRef')
    if (typeof deviceRef !== 'string' || !deviceRef.trim()) return null
    return { kind, deviceRef }
  }
  if (kind === 'policy') {
    const rule = Reflect.get(value, 'rule')
    if (rule !== 'run-ended' && rule !== 'deadline') return null
    return { kind, rule }
  }
  return null
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isNumberRecord(value: unknown): value is Readonly<Record<string, number>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.values(value).every((item) => typeof item === 'number')
}
