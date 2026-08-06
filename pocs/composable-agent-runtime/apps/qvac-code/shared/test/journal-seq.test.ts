import { describe, expect, test } from 'bun:test'
import {
  createJournalSeqAllocator,
  encodeJournalBody,
  encodeTurnPayload,
  projectTurn,
  resumeJournalSeq
} from '../index.ts'

const WRITER = 'code-host-abc'

function entry(body: Parameters<typeof encodeJournalBody>[0], recordedAt: number) {
  return { body: encodeJournalBody(body), recordedAt }
}

describe('createJournalSeqAllocator', function () {
  test('hands out consecutive numbers from its start', function () {
    const allocator = createJournalSeqAllocator(0)
    expect([allocator.next(), allocator.next(), allocator.next()]).toEqual([0, 1, 2])
    expect(allocator.peek()).toBe(3)
  })

  test('resumes from a non-zero start', function () {
    const allocator = createJournalSeqAllocator(7)
    expect(allocator.next()).toBe(7)
  })

  test('rejects a start that is not a non-negative integer', function () {
    expect(() => createJournalSeqAllocator(-1)).toThrow()
    expect(() => createJournalSeqAllocator(1.5)).toThrow()
  })
})

/**
 * The executor id is stable across restarts by design, so a claim written by one
 * process and an interruption written by a later one share a writer. Resuming
 * past the highest existing seq is what keeps their operationIds distinct.
 */
describe('resumeJournalSeq', function () {
  test('starts at zero for a turn nobody has written to', function () {
    expect(resumeJournalSeq([], WRITER)).toBe(0)
  })

  test('resumes one past this writer’s highest seq', function () {
    const entries = [
      entry({ writer: WRITER, seq: 0, type: 'turn-claim', executorId: WRITER, result: 'won' }, 0),
      entry({ writer: WRITER, seq: 4, type: 'assistant-delta', text: 'hi' }, 1)
    ]
    expect(resumeJournalSeq(entries, WRITER)).toBe(5)
  })

  test('ignores another writer’s numbering', function () {
    const entries = [
      entry({ writer: 'code-other-xyz', seq: 99, type: 'assistant-delta', text: 'theirs' }, 0)
    ]
    expect(resumeJournalSeq(entries, WRITER)).toBe(0)
  })

  test('ignores an undecodable entry rather than throwing', function () {
    expect(resumeJournalSeq([{ body: Buffer.from('not json'), recordedAt: 0 }], WRITER)).toBe(0)
  })
})

/**
 * `seq` is both the operationId discriminator and the transcript's render order.
 * Giving each writing module its own numbering band keeps appends distinct while
 * silently relocating whole blocks -- an approval would render after the turn's
 * final text, detached from the tool call it actually gated, so a tool that
 * waited for consent would look like it ran unattended.
 */
describe('one shared allocator keeps the transcript in the order things happened', function () {
  test('an approval renders between the tool call it gated and the text after it', function () {
    const shared = createJournalSeqAllocator(0)
    const bodies = [
      { writer: WRITER, seq: shared.next(), type: 'turn-claim' as const, executorId: WRITER, result: 'won' as const },
      { writer: WRITER, seq: shared.next(), type: 'assistant-delta' as const, text: 'Let me edit the file. ' },
      { writer: WRITER, seq: shared.next(), type: 'tool-call' as const, callRef: 'write#0', name: 'write', summary: 'write src/a.ts' },
      {
        writer: WRITER,
        seq: shared.next(),
        type: 'approval-requested' as const,
        gateId: 'approval/code-host-abc/1',
        name: 'write',
        summary: 'write src/a.ts',
        detail: []
      },
      {
        writer: WRITER,
        seq: shared.next(),
        type: 'approval-resolved' as const,
        gateId: 'approval/code-host-abc/1',
        decision: { verdict: 'approved' as const, decidedBy: { kind: 'peer' as const, deviceRef: 'phone' } },
        reason: null
      },
      { writer: WRITER, seq: shared.next(), type: 'tool-result' as const, callRef: 'write#0', name: 'write', ok: true, summary: 'wrote 12 bytes' },
      { writer: WRITER, seq: shared.next(), type: 'assistant-delta' as const, text: 'Done.' }
    ]
    const view = projectTurn({
      work: {
        workId: 'code/s1/turn/000000',
        payload: encodeTurnPayload({
          kind: 'code-turn',
          sessionId: 's1',
          seq: 0,
          prompt: 'p',
          requestedBy: 'phone'
        }),
        createdAt: 0,
        cancelRequested: false
      },
      entries: bodies.map((body, index) => entry(body, index)),
      gates: []
    })
    expect(view.blocks.map((block) => block.kind)).toEqual([
      'assistant',
      'tool',
      'approval',
      'assistant'
    ])
    // The approval sits before the text that follows it, not after the whole turn.
    const approvalIndex = view.blocks.findIndex((block) => block.kind === 'approval')
    const lastAssistant = view.blocks.length - 1
    expect(approvalIndex).toBeLessThan(lastAssistant)
  })
})
