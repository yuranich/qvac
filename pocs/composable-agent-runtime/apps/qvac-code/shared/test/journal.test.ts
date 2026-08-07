import { describe, expect, test } from 'bun:test'
import {
  decodeJournalBody,
  encodeJournalBody,
  entryTypeFor,
  type CodeJournalBody
} from '../journal.ts'
import { CODE_ENTRY } from '../formats.ts'
import { encodeJsonBytes } from '../codec.ts'

const HEADER = { writer: 'executor-1', seq: 4 }

const VARIANTS: readonly CodeJournalBody[] = [
  { ...HEADER, type: 'turn-claim', executorId: 'executor-1', result: 'won' },
  { ...HEADER, type: 'assistant-delta', text: 'hello' },
  { ...HEADER, type: 'thinking-delta', text: 'thinking...' },
  { ...HEADER, type: 'tool-call', callRef: 'call-1', name: 'read_file', summary: 'reads a.ts' },
  { ...HEADER, type: 'tool-result', callRef: 'call-1', name: 'read_file', ok: true, summary: 'done' },
  {
    ...HEADER,
    type: 'approval-requested',
    gateId: 'approval/executor-1/1',
    name: 'run_shell',
    summary: 'run rm -rf tmp',
    detail: ['rm', '-rf', 'tmp']
  },
  {
    ...HEADER,
    type: 'approval-resolved',
    gateId: 'approval/executor-1/1',
    decision: { verdict: 'approved', decidedBy: { kind: 'peer', deviceRef: 'device-a' } },
    reason: 'looks fine'
  },
  { ...HEADER, type: 'turn-metrics', metrics: { tokensIn: 10, tokensOut: 20 } },
  { ...HEADER, type: 'turn-error', message: 'boom', recoverable: false },
  { ...HEADER, type: 'turn-interrupted', executorId: 'executor-1' },
  { ...HEADER, type: 'turn-superseded', executorId: 'executor-1', winner: 'executor-2' }
]

describe('journal bodies', function () {
  for (const body of VARIANTS) {
    test(`round-trips a ${body.type} entry`, function () {
      expect(decodeJournalBody(encodeJournalBody(body))).toEqual(body)
    })

    test(`entryTypeFor maps ${body.type} to a qvac.poc.code.-prefixed entryType`, function () {
      const entryType = entryTypeFor(body)
      expect(entryType.startsWith('qvac.poc.code.')).toBe(true)
      expect((Object.values(CODE_ENTRY) as readonly string[]).includes(entryType)).toBe(true)
    })
  }

  test('returns null for an unrecognised type (forward compatibility)', function () {
    const bytes = encodeJsonBytes({ ...HEADER, type: 'some-future-entry', payload: 'x' })
    expect(decodeJournalBody(bytes)).toBeNull()
  })

  test('returns null for bytes that are not JSON at all', function () {
    expect(decodeJournalBody(Buffer.from('not json'))).toBeNull()
  })

  test('returns null when the header is missing or malformed', function () {
    expect(decodeJournalBody(encodeJsonBytes({ type: 'assistant-delta', text: 'x' }))).toBeNull()
    expect(
      decodeJournalBody(encodeJsonBytes({ writer: '', seq: 1, type: 'assistant-delta', text: 'x' }))
    ).toBeNull()
    expect(
      decodeJournalBody(
        encodeJsonBytes({ writer: 'w', seq: -1, type: 'assistant-delta', text: 'x' })
      )
    ).toBeNull()
    expect(
      decodeJournalBody(
        encodeJsonBytes({ writer: 'w', seq: 1.5, type: 'assistant-delta', text: 'x' })
      )
    ).toBeNull()
  })

  test('returns null when a known type is missing a required field', function () {
    expect(
      decodeJournalBody(encodeJsonBytes({ ...HEADER, type: 'tool-call', name: 'x', summary: 'y' }))
    ).toBeNull()
    expect(
      decodeJournalBody(
        encodeJsonBytes({ ...HEADER, type: 'tool-result', callRef: 'c', name: 'n', summary: 's' })
      )
    ).toBeNull() // missing ok
    expect(
      decodeJournalBody(
        encodeJsonBytes({
          ...HEADER,
          type: 'approval-resolved',
          gateId: 'g',
          decision: { verdict: 'not-a-verdict', decidedBy: { kind: 'executor', executorId: 'e' } },
          reason: null
        })
      )
    ).toBeNull()
    expect(
      decodeJournalBody(
        encodeJsonBytes({
          ...HEADER,
          type: 'approval-resolved',
          gateId: 'g',
          decision: { verdict: 'approved', decidedBy: { kind: 'unknown-kind' } },
          reason: null
        })
      )
    ).toBeNull()
    expect(
      decodeJournalBody(encodeJsonBytes({ ...HEADER, type: 'turn-metrics', metrics: { a: 'not-a-number' } }))
    ).toBeNull()
    expect(
      decodeJournalBody(encodeJsonBytes({ ...HEADER, type: 'turn-error', message: 'm' }))
    ).toBeNull() // missing recoverable
  })

  test('approval-resolved reason may be null', function () {
    const body: CodeJournalBody = {
      ...HEADER,
      type: 'approval-resolved',
      gateId: 'g',
      decision: { verdict: 'unanswered', decidedBy: { kind: 'policy', rule: 'deadline' } },
      reason: null
    }
    expect(decodeJournalBody(encodeJournalBody(body))).toEqual(body)
  })
})

/**
 * Journal bodies arrive from any writer admitted to the mesh, so the fields
 * that name an executor get the same grammar the gate-decision tokens use, and
 * an oversized body is rejected before it is parsed -- every watching peer
 * decodes every entry on every wake, so one writer must not set that cost.
 */
describe('journal bodies are validated against untrusted writers', function () {
  const valid = { writer: 'code-host-hash', seq: 1 }

  test('rejects a writer that is not a well-formed executor id', function () {
    const bytes = encodeJsonBytes({
      writer: 'code/host/hash',
      seq: 1,
      type: 'assistant-delta',
      text: 'hi'
    })
    expect(decodeJournalBody(bytes)).toBeNull()
  })

  test('rejects an oversized executor id rather than holding it in memory', function () {
    const bytes = encodeJsonBytes({
      ...valid,
      type: 'turn-superseded',
      executorId: 'a'.repeat(500),
      winner: 'code-other-hash'
    })
    expect(decodeJournalBody(bytes)).toBeNull()
  })

  test('rejects a winner that is not a well-formed executor id', function () {
    const bytes = encodeJsonBytes({
      ...valid,
      type: 'turn-superseded',
      executorId: 'code-host-hash',
      winner: 'code/other/hash'
    })
    expect(decodeJournalBody(bytes)).toBeNull()
  })

  test('rejects a body larger than the per-entry ceiling', function () {
    const bytes = encodeJsonBytes({
      ...valid,
      type: 'assistant-delta',
      text: 'x'.repeat(70 * 1024)
    })
    expect(decodeJournalBody(bytes)).toBeNull()
  })

  test('still accepts a body at a normal delta size', function () {
    const bytes = encodeJsonBytes({
      ...valid,
      type: 'assistant-delta',
      text: 'x'.repeat(1024)
    })
    expect(decodeJournalBody(bytes)).not.toBeNull()
  })

  test('returns null for valid JSON that is not an object', function () {
    for (const value of [[], 42, 'x', true, null]) {
      expect(decodeJournalBody(encodeJsonBytes(value))).toBeNull()
    }
  })
})
