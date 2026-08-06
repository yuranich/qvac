import { describe, expect, test } from 'bun:test'
import {
  encodeJournalBody,
  encodeTurnPayload,
  formatTurnWorkId,
  type CodeJournalBody
} from '@qvac-poc/qvac-code-shared'
import type {
  CodeGateRecord,
  CodeJournalEntryRecord,
  CodeWorkRecord
} from '@qvac-poc/qvac-code-shared/store'
import { createTranscriptViewModel } from './transcript-view-model.ts'

const SESSION_ID = 's1'
const SEQ = 1
const WORK_ID = formatTurnWorkId({ sessionId: SESSION_ID, seq: SEQ })

function workRow(overrides: Partial<CodeWorkRecord> = {}): CodeWorkRecord {
  return {
    workId: WORK_ID,
    payload: encodeTurnPayload({
      kind: 'code-turn',
      sessionId: SESSION_ID,
      seq: SEQ,
      prompt: 'do the thing',
      requestedBy: 'device-a'
    }),
    payloadFormat: 'application/vnd.qvac.poc.code-turn+json',
    payloadVersion: 1,
    createdAt: 1000,
    ...overrides
  } as CodeWorkRecord
}

function entryRow(
  id: string,
  body: CodeJournalBody,
  recordedAt = 1
): CodeJournalEntryRecord {
  return {
    id,
    workId: WORK_ID,
    entryType: body.type,
    body: encodeJournalBody(body),
    recordedAt
  } as CodeJournalEntryRecord
}

function counting(spy: { calls: number }) {
  return function decode(body: Buffer) {
    spy.calls += 1
    // Re-implement the smallest possible decode so the fixture stays
    // independent of the shared package's own decoder while still letting
    // projectTurn (which uses the real decoder internally) render the block.
    const parsed = JSON.parse(body.toString('utf8')) as CodeJournalBody
    return parsed
  }
}

describe('transcript view model: projection', () => {
  test('renders a turn from work + entries + gates', () => {
    const model = createTranscriptViewModel()
    const view = model.apply(
      [entryRow('e1', { writer: 'exec-a', seq: 0, type: 'assistant-delta', text: 'Hello' })],
      [],
      workRow()
    )
    expect(view.turnWorkId).toBe(WORK_ID)
    expect(view.sessionId).toBe(SESSION_ID)
    expect(view.prompt).toBe('do the thing')
  })
})

describe('transcript view model: incremental merge', () => {
  test('applying the same snapshot twice returns the identical view and does not re-decode', () => {
    const spy = { calls: 0 }
    const model = createTranscriptViewModel({ decode: counting(spy) })
    const entries = [
      entryRow('e1', { writer: 'exec-a', seq: 0, type: 'assistant-delta', text: 'Hello' })
    ]
    const first = model.apply(entries, [], workRow())
    expect(spy.calls).toBe(1)

    const second = model.apply(entries, [], workRow())
    expect(second).toBe(first)
    expect(spy.calls).toBe(1)
  })

  test('appending one entry only decodes the new entry, not the earlier ones', () => {
    const spy = { calls: 0 }
    const model = createTranscriptViewModel({ decode: counting(spy) })
    const first = [
      entryRow('e1', { writer: 'exec-a', seq: 0, type: 'assistant-delta', text: 'Hel' })
    ]
    const firstView = model.apply(first, [], workRow())
    expect(spy.calls).toBe(1)

    const second = [
      ...first,
      entryRow('e2', { writer: 'exec-a', seq: 1, type: 'assistant-delta', text: 'lo' })
    ]
    const secondView = model.apply(second, [], workRow())
    expect(spy.calls).toBe(2)
    expect(secondView).not.toBe(firstView)
    expect(secondView.blocks).toEqual([{ kind: 'assistant', text: 'Hello' }])
  })

  test('reset forgets the cache so a previously-seen entry is decoded again', () => {
    const spy = { calls: 0 }
    const model = createTranscriptViewModel({ decode: counting(spy) })
    const entries = [
      entryRow('e1', { writer: 'exec-a', seq: 0, type: 'assistant-delta', text: 'Hello' })
    ]
    model.apply(entries, [], workRow())
    expect(spy.calls).toBe(1)
    model.reset()
    model.apply(entries, [], workRow())
    expect(spy.calls).toBe(2)
  })

  test('a gate decision changing forces a recompute even with the same entries', () => {
    const model = createTranscriptViewModel()
    const entries = [
      entryRow('e1', { writer: 'exec-a', seq: 0, type: 'assistant-delta', text: 'Hi' })
    ]
    const gate: CodeGateRecord = {
      id: `${WORK_ID}:claim`,
      workId: WORK_ID,
      gateId: 'claim',
      kind: 'qvac.poc.code.claim/v1',
      recordedAt: 1
    } as CodeGateRecord
    const first = model.apply(entries, [gate], workRow())
    const second = model.apply(
      entries,
      [{ ...gate, decision: 'claim/exec-a' }],
      workRow()
    )
    expect(second).not.toBe(first)
    expect(second.claimedBy).toBe('exec-a')
  })

  // The cache key has to cover every field projectTurn reads, not the subset
  // it happened to key on: `recordedAt` feeds `updatedAt` and `outcomeResult`
  // feeds `finalText`, so a write that moves either must not be served stale.
  test('a gate recordedAt changing forces a recompute even with the same decision', () => {
    const model = createTranscriptViewModel()
    const entries = [
      entryRow('e1', { writer: 'exec-a', seq: 0, type: 'assistant-delta', text: 'Hi' })
    ]
    const gate: CodeGateRecord = {
      id: `${WORK_ID}:claim`,
      workId: WORK_ID,
      gateId: 'claim',
      kind: 'qvac.poc.code.claim/v1',
      decision: 'claim/exec-a',
      recordedAt: 1
    } as CodeGateRecord
    const first = model.apply(entries, [gate], workRow())
    // Above the work's own createdAt, so it actually wins projectTurn's
    // Math.max and the staleness is observable rather than just internal.
    const second = model.apply(entries, [{ ...gate, recordedAt: 2000 }], workRow())
    expect(second).not.toBe(first)
    expect(second.updatedAt).toBe(2000)
  })

  test('an outcomeResult arriving forces a recompute even at the same outcomeStatus', () => {
    const model = createTranscriptViewModel()
    const entries = [
      entryRow('e1', { writer: 'exec-a', seq: 0, type: 'assistant-delta', text: 'Hi' })
    ]
    const completed = workRow({ outcomeStatus: 'completed' })
    const first = model.apply(entries, [], completed)
    const second = model.apply(
      entries,
      [],
      workRow({ outcomeStatus: 'completed', outcomeResult: Buffer.from('the answer') })
    )
    expect(second).not.toBe(first)
    expect(second.finalText).toBe('the answer')
  })
})
