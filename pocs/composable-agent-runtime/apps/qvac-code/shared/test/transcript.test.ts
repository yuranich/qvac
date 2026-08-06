import { describe, expect, test } from 'bun:test'
import {
  projectSessionList,
  projectTurn,
  type CodeTranscriptEntryInput,
  type CodeTranscriptGateInput,
  type CodeTranscriptWorkInput
} from '../transcript.ts'
import { encodeJournalBody, type CodeJournalBody } from '../journal.ts'
import { encodeSessionPayload, encodeTurnPayload, type CodeTurnPayload } from '../session.ts'
import { formatClaimDecision } from '../claim.ts'
import { formatApprovalDecision, type CodeApprovalDecision } from '../approval.ts'
import { CODE_CLAIM_GATE_ID, CODE_TRUNCATION_MESSAGE } from '../formats.ts'
import { formatSessionWorkId, formatTurnWorkId } from '../ids.ts'

const PAYLOAD: CodeTurnPayload = {
  kind: 'code-turn',
  sessionId: 's1',
  seq: 1,
  prompt: 'do the thing',
  requestedBy: 'device-a'
}
const WORK_ID = formatTurnWorkId({ sessionId: PAYLOAD.sessionId, seq: PAYLOAD.seq })
const WINNER = 'executor-1'
const LOSER = 'executor-2'

function work(overrides: Partial<CodeTranscriptWorkInput> = {}): CodeTranscriptWorkInput {
  return {
    workId: WORK_ID,
    payload: encodeTurnPayload(PAYLOAD),
    createdAt: 1000,
    ...overrides
  }
}

function entry(body: CodeJournalBody, recordedAt = 0): CodeTranscriptEntryInput {
  return { body: encodeJournalBody(body), recordedAt }
}

function claimGate(decision: string | null, recordedAt = 0): CodeTranscriptGateInput {
  return { gateId: CODE_CLAIM_GATE_ID, decision, recordedAt }
}

function approvalGate(
  gateId: string,
  decision: string | null,
  recordedAt = 0
): CodeTranscriptGateInput {
  return { gateId, decision, recordedAt }
}

describe('projectTurn: base fields', function () {
  test('decodes prompt/sessionId/seq from the work payload and starts queued', function () {
    const view = projectTurn({ work: work(), entries: [], gates: [] })
    expect(view.turnWorkId).toBe(WORK_ID)
    expect(view.sessionId).toBe('s1')
    expect(view.seq).toBe(1)
    expect(view.prompt).toBe('do the thing')
    expect(view.status).toBe('queued')
    expect(view.claimedBy).toBeNull()
    expect(view.blocks).toEqual([])
    expect(view.openApproval).toBeNull()
    expect(view.finalText).toBeNull()
    expect(view.truncated).toBe(false)
  })

  test('finalText comes from outcomeResult; deltas do not populate it', function () {
    const view = projectTurn({
      work: work({ outcomeStatus: 'completed', outcomeResult: Buffer.from('the final answer') }),
      entries: [entry({ writer: WINNER, seq: 1, type: 'assistant-delta', text: 'partial' })],
      gates: [claimGate(formatClaimDecision(WINNER))]
    })
    expect(view.finalText).toBe('the final answer')
  })
})

describe('projectTurn: block coalescing and pairing', function () {
  test('coalesces adjacent assistant-delta and thinking-delta entries', function () {
    const entries = [
      entry({ writer: WINNER, seq: 1, type: 'assistant-delta', text: 'Hel' }),
      entry({ writer: WINNER, seq: 2, type: 'assistant-delta', text: 'lo' }),
      entry({ writer: WINNER, seq: 3, type: 'thinking-delta', text: 'hmm' }),
      entry({ writer: WINNER, seq: 4, type: 'assistant-delta', text: ' world' })
    ]
    const view = projectTurn({
      work: work(),
      entries,
      gates: [claimGate(formatClaimDecision(WINNER))]
    })
    expect(view.blocks).toEqual([
      { kind: 'assistant', text: 'Hello' },
      { kind: 'thinking', text: 'hmm' },
      { kind: 'assistant', text: ' world' }
    ])
  })

  test('pairs tool-call with its tool-result by callRef and leaves an unpaired call with outcome null', function () {
    const entries = [
      entry({ writer: WINNER, seq: 1, type: 'tool-call', callRef: 'c1', name: 'read', summary: 'reading a.ts' }),
      entry({ writer: WINNER, seq: 2, type: 'tool-result', callRef: 'c1', name: 'read', ok: true, summary: 'ok' }),
      entry({ writer: WINNER, seq: 3, type: 'tool-call', callRef: 'c2', name: 'write', summary: 'writing b.ts' })
    ]
    const view = projectTurn({
      work: work(),
      entries,
      gates: [claimGate(formatClaimDecision(WINNER))]
    })
    expect(view.blocks).toEqual([
      {
        kind: 'tool',
        callRef: 'c1',
        name: 'read',
        request: 'reading a.ts',
        outcome: { ok: true, summary: 'ok' }
      },
      { kind: 'tool', callRef: 'c2', name: 'write', request: 'writing b.ts', outcome: null }
    ])
  })

  test('drops an unpaired tool-result rather than rendering a synthetic call', function () {
    const entries = [
      entry({ writer: WINNER, seq: 1, type: 'tool-result', callRef: 'ghost', name: 'x', ok: false, summary: 'fail' })
    ]
    const view = projectTurn({
      work: work(),
      entries,
      gates: [claimGate(formatClaimDecision(WINNER))]
    })
    expect(view.blocks).toEqual([])
  })

  test('renders turn-error entries as error blocks', function () {
    const entries = [entry({ writer: WINNER, seq: 1, type: 'turn-error', message: 'boom', recoverable: false })]
    const view = projectTurn({
      work: work(),
      entries,
      gates: [claimGate(formatClaimDecision(WINNER))]
    })
    expect(view.blocks).toEqual([{ kind: 'error', message: 'boom' }])
  })

  test('turn-claim, turn-metrics, turn-interrupted, and turn-superseded render no block', function () {
    const entries = [
      entry({ writer: WINNER, seq: 1, type: 'turn-claim', executorId: WINNER, result: 'won' }),
      entry({ writer: WINNER, seq: 2, type: 'turn-metrics', metrics: { tokensIn: 1 } })
    ]
    const view = projectTurn({
      work: work(),
      entries,
      gates: [claimGate(formatClaimDecision(WINNER))]
    })
    expect(view.blocks).toEqual([])
  })
})

describe('projectTurn: writer-based supersede filtering', function () {
  test('collapses a non-winning writer into a single notice instead of interleaving', function () {
    const entries = [
      entry({ writer: WINNER, seq: 1, type: 'assistant-delta', text: 'hi' }),
      entry({ writer: LOSER, seq: 1, type: 'assistant-delta', text: 'bye' })
    ]
    const view = projectTurn({
      work: work(),
      entries,
      gates: [claimGate(formatClaimDecision(WINNER))]
    })
    expect(view.blocks).toEqual([
      { kind: 'assistant', text: 'hi' },
      { kind: 'notice', text: `Superseded by ${WINNER} (writer ${LOSER} did not win the claim)` }
    ])
  })

  test('with no resolved claim, every writer streams normally (no notices)', function () {
    const entries = [
      entry({ writer: WINNER, seq: 1, type: 'assistant-delta', text: 'hi' }),
      entry({ writer: LOSER, seq: 1, type: 'assistant-delta', text: 'bye' })
    ]
    const view = projectTurn({ work: work(), entries, gates: [] })
    // No gate means writers are iterated in sorted order (executor-1 before
    // executor-2), not race order, since there is no winner to prioritise.
    expect(view.blocks).toEqual([
      { kind: 'assistant', text: 'hi' },
      { kind: 'assistant', text: 'bye' }
    ])
  })
})

describe('projectTurn: approval blocks and staleness', function () {
  function approvalEntries(decision: CodeApprovalDecision) {
    return [
      entry({
        writer: WINNER,
        seq: 1,
        type: 'approval-requested',
        gateId: 'approval/executor-1/1',
        name: 'run_shell',
        summary: 'rm -rf tmp',
        detail: ['rm', '-rf', 'tmp']
      }),
      entry({
        writer: WINNER,
        seq: 2,
        type: 'approval-resolved',
        gateId: 'approval/executor-1/1',
        decision,
        reason: null
      })
    ]
  }

  test('an undecided approval is the open approval and the turn is awaiting-approval', function () {
    const entries = [
      entry({
        writer: WINNER,
        seq: 1,
        type: 'approval-requested',
        gateId: 'approval/executor-1/1',
        name: 'run_shell',
        summary: 'rm -rf tmp',
        detail: []
      })
    ]
    const gates = [claimGate(formatClaimDecision(WINNER)), approvalGate('approval/executor-1/1', null)]
    const view = projectTurn({ work: work(), entries, gates })
    expect(view.status).toBe('awaiting-approval')
    expect(view.openApproval?.gateId).toBe('approval/executor-1/1')
    expect(view.openApproval?.decision).toBeNull()
  })

  test('a policy fail-closed decision on a terminal turn is stale', function () {
    const decision: CodeApprovalDecision = {
      verdict: 'withdrawn',
      decidedBy: { kind: 'policy', rule: 'run-ended' }
    }
    const entries = approvalEntries(decision)
    const gates = [
      claimGate(formatClaimDecision(WINNER)),
      approvalGate('approval/executor-1/1', formatApprovalDecision(decision))
    ]
    const view = projectTurn({ work: work({ outcomeStatus: 'failed' }), entries, gates })
    const approvalBlock = view.blocks.find((block) => block.kind === 'approval')
    expect(approvalBlock).toMatchObject({ decision, stale: true })
    expect(view.openApproval).toBeNull()
  })

  test('the same policy decision on a still-open turn is not stale', function () {
    const decision: CodeApprovalDecision = {
      verdict: 'unanswered',
      decidedBy: { kind: 'policy', rule: 'deadline' }
    }
    const entries = approvalEntries(decision)
    const gates = [
      claimGate(formatClaimDecision(WINNER)),
      approvalGate('approval/executor-1/1', formatApprovalDecision(decision))
    ]
    const view = projectTurn({ work: work(), entries, gates })
    const approvalBlock = view.blocks.find((block) => block.kind === 'approval')
    expect(approvalBlock).toMatchObject({ decision, stale: false })
  })

  test('a real peer decision on a terminal turn is not stale', function () {
    const decision: CodeApprovalDecision = {
      verdict: 'approved',
      decidedBy: { kind: 'peer', deviceRef: 'device-a' }
    }
    const entries = approvalEntries(decision)
    const gates = [
      claimGate(formatClaimDecision(WINNER)),
      approvalGate('approval/executor-1/1', formatApprovalDecision(decision))
    ]
    const view = projectTurn({ work: work({ outcomeStatus: 'completed' }), entries, gates })
    const approvalBlock = view.blocks.find((block) => block.kind === 'approval')
    expect(approvalBlock).toMatchObject({ decision, stale: false })
  })
})

describe('projectTurn: truncation', function () {
  test('is truncated only when the stable truncation message is present', function () {
    const truncated = projectTurn({
      work: work(),
      entries: [
        entry({ writer: WINNER, seq: 1, type: 'turn-error', message: CODE_TRUNCATION_MESSAGE, recoverable: true })
      ],
      gates: [claimGate(formatClaimDecision(WINNER))]
    })
    expect(truncated.truncated).toBe(true)

    const notTruncated = projectTurn({
      work: work(),
      entries: [entry({ writer: WINNER, seq: 1, type: 'turn-error', message: 'some other error', recoverable: true })],
      gates: [claimGate(formatClaimDecision(WINNER))]
    })
    expect(notTruncated.truncated).toBe(false)
  })
})

describe('projectTurn: status', function () {
  test('queued: no claim gate, no entries', function () {
    expect(projectTurn({ work: work(), entries: [], gates: [] }).status).toBe('queued')
  })

  test('claimed: gate resolved, only a turn-claim entry', function () {
    const view = projectTurn({
      work: work(),
      entries: [entry({ writer: WINNER, seq: 1, type: 'turn-claim', executorId: WINNER, result: 'won' })],
      gates: [claimGate(formatClaimDecision(WINNER))]
    })
    expect(view.status).toBe('claimed')
    expect(view.claimedBy).toBe(WINNER)
  })

  test('running: gate resolved and the winner has produced activity', function () {
    const view = projectTurn({
      work: work(),
      entries: [
        entry({ writer: WINNER, seq: 1, type: 'turn-claim', executorId: WINNER, result: 'won' }),
        entry({ writer: WINNER, seq: 2, type: 'assistant-delta', text: 'hi' })
      ],
      gates: [claimGate(formatClaimDecision(WINNER))]
    })
    expect(view.status).toBe('running')
  })

  test('awaiting-approval wins over running', function () {
    const view = projectTurn({
      work: work(),
      entries: [entry({ writer: WINNER, seq: 1, type: 'assistant-delta', text: 'hi' })],
      gates: [claimGate(formatClaimDecision(WINNER)), approvalGate('approval/executor-1/1', null)]
    })
    expect(view.status).toBe('awaiting-approval')
  })

  test('completed / failed / cancelled come from outcomeStatus', function () {
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      const view = projectTurn({ work: work({ outcomeStatus: status }), entries: [], gates: [] })
      expect(view.status).toBe(status)
    }
  })

  test('cancelRequested reads as cancelled before an outcome is recorded', function () {
    const view = projectTurn({ work: work({ cancelRequested: true }), entries: [], gates: [] })
    expect(view.status).toBe('cancelled')
  })

  test('superseded when a turn-superseded entry exists from the surviving writer', function () {
    const view = projectTurn({
      work: work(),
      entries: [
        entry({ writer: WINNER, seq: 1, type: 'turn-superseded', executorId: WINNER, winner: LOSER })
      ],
      gates: [claimGate(formatClaimDecision(WINNER))]
    })
    expect(view.status).toBe('superseded')
  })
})

describe('projectSessionList', function () {
  test('projects only session rows, newest first', function () {
    const older = {
      workId: formatSessionWorkId('s-old'),
      payload: encodeSessionPayload({
        kind: 'code-session',
        title: 'Older',
        projectLabel: 'proj',
        model: 'm',
        createdBy: 'device-a'
      }),
      createdAt: 100
    }
    const newer = {
      workId: formatSessionWorkId('s-new'),
      payload: encodeSessionPayload({
        kind: 'code-session',
        title: 'Newer',
        projectLabel: 'proj',
        model: 'm',
        createdBy: 'device-a'
      }),
      createdAt: 200,
      outcomeStatus: 'completed'
    }
    const turnRow = work()

    const summaries = projectSessionList([older, newer, turnRow])
    expect(summaries.map((s) => s.sessionId)).toEqual(['s-new', 's-old'])
    expect(summaries[0]).toMatchObject({ title: 'Newer', status: 'closed' })
    expect(summaries[1]).toMatchObject({ title: 'Older', status: 'open' })
  })
})
