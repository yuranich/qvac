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

export function formatApprovalDecision(decision: CodeApprovalDecision): string {
  return `${decision.verdict}/${decision.decidedBy.kind}/${deciderToken(decision.decidedBy)}`
}

export function parseApprovalDecision(token: string): CodeApprovalDecision | null {
  const parts = token.split('/')
  if (parts.length !== 3) return null
  const [verdict, kind, id] = parts
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
