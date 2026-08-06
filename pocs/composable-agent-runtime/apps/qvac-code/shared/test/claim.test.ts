import { describe, expect, test } from 'bun:test'
import {
  decideClaimAction,
  formatClaimDecision,
  isClaimGateId,
  parseClaimDecision,
  type CodeClaimInput
} from '../claim.ts'
import { CODE_CLAIM_GATE_ID, CODE_TURN_FORMAT } from '../formats.ts'
import type { CodeGateRow, CodeWorkRow } from '../rows.ts'

const EXECUTOR = 'executor-1'
const OTHER_EXECUTOR = 'executor-2'

const WORK: CodeWorkRow = {
  workId: 'code/session-1/turn/000001',
  payloadFormat: CODE_TURN_FORMAT,
  target: null,
  cancelRequested: false,
  outcomeStatus: null,
  createdAt: 1000
}

const SESSION: CodeWorkRow = {
  workId: 'code/session-1',
  payloadFormat: 'application/vnd.qvac.poc.code-session+json',
  target: null,
  cancelRequested: false,
  outcomeStatus: null,
  createdAt: 900
}

function baseInput(overrides: Partial<CodeClaimInput> = {}): CodeClaimInput {
  return {
    executorId: EXECUTOR,
    work: WORK,
    session: SESSION,
    claimGate: null,
    claimedInThisProcess: false,
    ...overrides
  }
}

function gate(decision: string | null, overrides: Partial<CodeGateRow> = {}): CodeGateRow {
  return {
    gateId: CODE_CLAIM_GATE_ID,
    kind: 'qvac.poc.code.claim/v1',
    decision,
    recordedAt: 1100,
    workId: WORK.workId,
    ...overrides
  }
}

describe('decideClaimAction', function () {
  test('1. skips other-format when payloadFormat is not the turn format', function () {
    const action = decideClaimAction(
      baseInput({ work: { ...WORK, payloadFormat: 'application/vnd.qvac.harness-run+json' } })
    )
    expect(action).toEqual({ kind: 'skip', reason: 'other-format' })
  })

  test('2. skips not-targeted when work.target is set to a different executor', function () {
    const action = decideClaimAction(baseInput({ work: { ...WORK, target: OTHER_EXECUTOR } }))
    expect(action).toEqual({ kind: 'skip', reason: 'not-targeted' })
  })

  test('2b. does not skip when work.target names this executor', function () {
    const action = decideClaimAction(baseInput({ work: { ...WORK, target: EXECUTOR } }))
    expect(action).toEqual({ kind: 'open-claim-gate' })
  })

  test('3. skips terminal when the work already has an outcomeStatus', function () {
    const action = decideClaimAction(baseInput({ work: { ...WORK, outcomeStatus: 'completed' } }))
    expect(action).toEqual({ kind: 'skip', reason: 'terminal' })
  })

  test('4. skips session-closed when the owning session already has an outcomeStatus', function () {
    const action = decideClaimAction(baseInput({ session: { ...SESSION, outcomeStatus: 'cancelled' } }))
    expect(action).toEqual({ kind: 'skip', reason: 'session-closed' })
  })

  test('5. skips cancel-requested when the work has a cancellation pending', function () {
    const action = decideClaimAction(baseInput({ work: { ...WORK, cancelRequested: true } }))
    expect(action).toEqual({ kind: 'skip', reason: 'cancel-requested' })
  })

  test('6. opens the claim gate when it does not exist yet', function () {
    const action = decideClaimAction(baseInput({ claimGate: null }))
    expect(action).toEqual({ kind: 'open-claim-gate' })
  })

  test('7. skips claimed-elsewhere when the gate names a different executor', function () {
    const action = decideClaimAction(
      baseInput({ claimGate: gate(formatClaimDecision(OTHER_EXECUTOR)) })
    )
    expect(action).toEqual({ kind: 'skip', reason: 'claimed-elsewhere' })
  })

  test('8. executes when the gate names this executor and a live run backs it', function () {
    const action = decideClaimAction(
      baseInput({ claimGate: gate(formatClaimDecision(EXECUTOR)), claimedInThisProcess: true })
    )
    expect(action).toEqual({ kind: 'execute' })
  })

  test('9. records interrupted when the gate names this executor but no live run backs it', function () {
    const action = decideClaimAction(
      baseInput({ claimGate: gate(formatClaimDecision(EXECUTOR)), claimedInThisProcess: false })
    )
    expect(action).toEqual({ kind: 'record-interrupted' })
  })

  test('10. attempts the claim when the gate exists but is undecided', function () {
    const action = decideClaimAction(baseInput({ claimGate: gate(null) }))
    expect(action).toEqual({ kind: 'attempt-claim' })
  })

  test('priority: terminal wins over cancel-requested', function () {
    const action = decideClaimAction(
      baseInput({ work: { ...WORK, outcomeStatus: 'failed', cancelRequested: true } })
    )
    expect(action).toEqual({ kind: 'skip', reason: 'terminal' })
  })

  test('priority: session-closed wins over cancel-requested', function () {
    const action = decideClaimAction(
      baseInput({
        session: { ...SESSION, outcomeStatus: 'completed' },
        work: { ...WORK, cancelRequested: true }
      })
    )
    expect(action).toEqual({ kind: 'skip', reason: 'session-closed' })
  })

  test('a null session never triggers session-closed', function () {
    const action = decideClaimAction(baseInput({ session: null }))
    expect(action).toEqual({ kind: 'open-claim-gate' })
  })
})

describe('claim decision tokens', function () {
  test('formats and parses a round trip', function () {
    const token = formatClaimDecision(EXECUTOR)
    expect(token).toBe('claim/executor-1')
    expect(parseClaimDecision(token)).toEqual({ executorId: EXECUTOR })
  })

  test('parseClaimDecision returns null for null, undefined, and malformed input', function () {
    expect(parseClaimDecision(null)).toBeNull()
    expect(parseClaimDecision(undefined)).toBeNull()
    expect(parseClaimDecision('')).toBeNull()
    expect(parseClaimDecision('not-a-claim-token')).toBeNull()
    expect(parseClaimDecision('claim/')).toBeNull()
    expect(parseClaimDecision('claim/a/b')).toBeNull()
  })

  test('formatClaimDecision rejects an executorId containing a slash', function () {
    expect(() => formatClaimDecision('exec/1')).toThrow()
    expect(() => formatClaimDecision('')).toThrow()
  })
})

describe('isClaimGateId', function () {
  test('matches only the reserved claim gate id', function () {
    expect(isClaimGateId(CODE_CLAIM_GATE_ID)).toBe(true)
    expect(isClaimGateId('approval/executor-1/1')).toBe(false)
  })
})
