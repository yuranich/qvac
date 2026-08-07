import { describe, expect, test } from 'bun:test'
import {
  formatApprovalDecision,
  formatApprovalGateId,
  parseApprovalDecision,
  toHarnessResolution,
  type CodeApprovalDecision
} from '../approval.ts'

describe('approval gate ids', function () {
  test('formats a gate id from executorId and a positive index', function () {
    expect(formatApprovalGateId({ executorId: 'executor-1', index: 1 })).toBe('approval/executor-1/1')
    expect(formatApprovalGateId({ executorId: 'executor-1', index: 42 })).toBe('approval/executor-1/42')
  })

  test('rejects an executorId containing a slash', function () {
    expect(() => formatApprovalGateId({ executorId: 'exec/1', index: 1 })).toThrow()
  })

  test('rejects a non-positive or non-integer index', function () {
    expect(() => formatApprovalGateId({ executorId: 'e', index: 0 })).toThrow()
    expect(() => formatApprovalGateId({ executorId: 'e', index: -1 })).toThrow()
    expect(() => formatApprovalGateId({ executorId: 'e', index: 1.5 })).toThrow()
  })
})

describe('approval decision tokens', function () {
  const cases: readonly CodeApprovalDecision[] = [
    { verdict: 'approved', decidedBy: { kind: 'executor', executorId: 'executor-1' } },
    { verdict: 'denied', decidedBy: { kind: 'peer', deviceRef: 'device-a' } },
    { verdict: 'withdrawn', decidedBy: { kind: 'policy', rule: 'run-ended' } },
    { verdict: 'unanswered', decidedBy: { kind: 'policy', rule: 'deadline' } }
  ]

  for (const decision of cases) {
    test(`round-trips ${decision.verdict}/${decision.decidedBy.kind}`, function () {
      const token = formatApprovalDecision(decision)
      expect(parseApprovalDecision(token)).toEqual(decision)
    })
  }

  test('rejects a malformed token', function () {
    expect(parseApprovalDecision('')).toBeNull()
    expect(parseApprovalDecision('approved')).toBeNull()
    expect(parseApprovalDecision('approved/executor')).toBeNull()
    expect(parseApprovalDecision('not-a-verdict/executor/e1')).toBeNull()
    expect(parseApprovalDecision('approved/not-a-kind/e1')).toBeNull()
    expect(parseApprovalDecision('approved/policy/not-a-rule')).toBeNull()
    expect(parseApprovalDecision('approved/executor/')).toBeNull()
    expect(parseApprovalDecision('/executor/e1')).toBeNull()
  })

  /**
   * resolve-gate is create-only, so a decision that cannot be parsed back is
   * not a lost field -- it jams that gate permanently and makes
   * resolveApprovalGate report `unreachable` on a gate that did resolve. A
   * peer's device ref is not ours to constrain and a base64 device key
   * contains '/' routinely, so the ref is the remainder of the token.
   */
  test('round-trips a decider reference containing the delimiter', function () {
    const decision = {
      verdict: 'approved' as const,
      decidedBy: { kind: 'peer' as const, deviceRef: 'zY3+k/9w==' }
    }
    const token = formatApprovalDecision(decision)
    expect(token).toBe('approved/peer/zY3+k/9w==')
    expect(parseApprovalDecision(token)).toEqual(decision)
  })

  test('refuses to mint a token with an empty decider reference', function () {
    expect(() =>
      formatApprovalDecision({
        verdict: 'approved',
        decidedBy: { kind: 'peer', deviceRef: '' }
      })
    ).toThrow(/needs a decider reference/)
  })
})

describe('toHarnessResolution', function () {
  test('approved and denied are decided, not fail-closed', function () {
    expect(toHarnessResolution('approved')).toEqual({ kind: 'decided', approved: true })
    expect(toHarnessResolution('denied')).toEqual({ kind: 'decided', approved: false })
  })

  test('withdrawn and unanswered fail closed and are never treated as a denial', function () {
    const withdrawn = toHarnessResolution('withdrawn')
    const unanswered = toHarnessResolution('unanswered')
    expect(withdrawn).toEqual({ kind: 'fail-closed', verdict: 'withdrawn' })
    expect(unanswered).toEqual({ kind: 'fail-closed', verdict: 'unanswered' })
    expect(withdrawn.kind).not.toBe('decided')
    expect(unanswered.kind).not.toBe('decided')
    // Neither resolution carries an `approved` field at all -- a caller
    // cannot accidentally read `approved: false` off a fail-closed result.
    expect('approved' in withdrawn).toBe(false)
    expect('approved' in unanswered).toBe(false)
  })
})
