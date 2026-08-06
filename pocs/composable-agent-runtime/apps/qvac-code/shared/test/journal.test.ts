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
