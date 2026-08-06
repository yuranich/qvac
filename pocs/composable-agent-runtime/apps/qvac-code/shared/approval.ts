import { requireExecutorId } from './ids.ts'

export type CodeApprovalVerdict = 'approved' | 'denied' | 'withdrawn' | 'unanswered'

export type CodeDeciderRef =
  | { readonly kind: 'executor'; readonly executorId: string }
  | { readonly kind: 'peer'; readonly deviceRef: string }
  | { readonly kind: 'policy'; readonly rule: 'run-ended' | 'deadline' }

export interface CodeApprovalDecision {
  readonly verdict: CodeApprovalVerdict
  readonly decidedBy: CodeDeciderRef
}

export type CodeHarnessResolution =
  | { readonly kind: 'decided'; readonly approved: boolean }
  | { readonly kind: 'fail-closed'; readonly verdict: 'withdrawn' | 'unanswered' }

export function formatApprovalGateId(input: {
  readonly executorId: string
  readonly index: number
}): string {
  const executorId = requireExecutorId(input.executorId)
  if (!Number.isSafeInteger(input.index) || input.index <= 0) {
    throw new Error(`Invalid approval gate index: ${input.index}`)
  }
  return `approval/${executorId}/${input.index}`
}

/**
 * `resolve-gate` is create-only: the first decision written to a gate is
 * permanent for every peer. So a decision token that cannot be parsed back
 * does not merely lose information -- it jams that gate forever, and
 * `resolveApprovalGate` then reports `unreachable` on a gate that in fact
 * resolved. The decider ref is therefore the *last* field and may contain the
 * delimiter: a peer's device ref is not ours to constrain, and a base64 device
 * key contains `/` routinely.
 */
export function formatApprovalDecision(decision: CodeApprovalDecision): string {
  const decider = deciderToken(decision.decidedBy)
  if (!decider.trim()) {
    throw new Error(
      `Approval decision needs a decider reference: ${decision.decidedBy.kind}`
    )
  }
  return `${decision.verdict}/${decision.decidedBy.kind}/${decider}`
}

export function parseApprovalDecision(token: string): CodeApprovalDecision | null {
  const firstBreak = token.indexOf('/')
  if (firstBreak <= 0) return null
  const secondBreak = token.indexOf('/', firstBreak + 1)
  if (secondBreak <= firstBreak + 1) return null
  const verdict = token.slice(0, firstBreak)
  const kind = token.slice(firstBreak + 1, secondBreak)
  // Deliberately the remainder, not a third split field: see above.
  const id = token.slice(secondBreak + 1)
  if (!isVerdict(verdict)) return null
  const decidedBy = deciderFromToken(kind, id)
  if (decidedBy == null) return null
  return { verdict, decidedBy }
}

/**
 * The harness approval port is deliberately tri-state, not boolean:
 * approved/denied are real answers, but withdrawn and unanswered mean
 * nobody actually decided. Collapsing those two into "denied" would let a
 * caller consult a second authority (a broader policy, a cached default) on
 * the strength of a denial nobody made -- so they fail closed instead,
 * distinctly, and the caller must handle that as its own case.
 */
export function toHarnessResolution(verdict: CodeApprovalVerdict): CodeHarnessResolution {
  if (verdict === 'withdrawn' || verdict === 'unanswered') {
    return { kind: 'fail-closed', verdict }
  }
  return { kind: 'decided', approved: verdict === 'approved' }
}

function deciderToken(ref: CodeDeciderRef): string {
  if (ref.kind === 'executor') return ref.executorId
  if (ref.kind === 'peer') return ref.deviceRef
  return ref.rule
}

function deciderFromToken(kind: string | undefined, id: string | undefined): CodeDeciderRef | null {
  if (id == null || !id) return null
  if (kind === 'executor') return { kind, executorId: id }
  if (kind === 'peer') return { kind, deviceRef: id }
  if (kind === 'policy' && (id === 'run-ended' || id === 'deadline')) return { kind, rule: id }
  return null
}

function isVerdict(value: string | undefined): value is CodeApprovalVerdict {
  return (
    value === 'approved' ||
    value === 'denied' ||
    value === 'withdrawn' ||
    value === 'unanswered'
  )
}
