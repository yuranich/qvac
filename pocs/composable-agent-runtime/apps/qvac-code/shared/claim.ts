import { CODE_CLAIM_GATE_ID, CODE_TURN_FORMAT } from './formats.ts'
import { isExecutorId, requireExecutorId } from './ids.ts'
import type { CodeGateRow, CodeWorkRow } from './rows.ts'

export interface CodeClaim {
  readonly executorId: string
}

export function formatClaimDecision(executorId: string): string {
  return `claim/${requireExecutorId(executorId)}`
}

export function parseClaimDecision(decision: string | null | undefined): CodeClaim | null {
  if (decision == null) return null
  if (!decision.startsWith('claim/')) return null
  const executorId = decision.slice('claim/'.length)
  if (!isExecutorId(executorId)) return null
  return { executorId }
}

export function isClaimGateId(gateId: string): boolean {
  return gateId === CODE_CLAIM_GATE_ID
}

export type CodeClaimAction =
  | {
      readonly kind: 'skip'
      readonly reason:
        | 'other-format'
        | 'not-targeted'
        | 'terminal'
        | 'cancel-requested'
        | 'session-closed'
        | 'claimed-elsewhere'
    }
  | { readonly kind: 'open-claim-gate' }
  | { readonly kind: 'attempt-claim' }
  /**
   * Never returned by decideClaimAction itself. It names the caller's next
   * step after a successful attempt-claim: per the "never infer a verdict
   * from a throw" rule (profileClient.apply() throwing is ambiguous), the
   * caller does not branch on whether resolve-gate threw. It re-reads the
   * claim gate and calls decideClaimAction again, which then reports
   * 'execute' / 'record-interrupted' (mine) or 'skip: claimed-elsewhere'
   * (not mine) from the freshly read state.
   */
  | { readonly kind: 'confirm-claim' }
  | { readonly kind: 'execute' }
  | { readonly kind: 'record-interrupted' }

export interface CodeClaimInput {
  readonly executorId: string
  readonly work: CodeWorkRow
  readonly session: CodeWorkRow | null
  readonly claimGate: CodeGateRow | null
  /**
   * Whether *this process* authored the claim now on the gate, not whether a
   * run is currently streaming. The executorId is stable across restarts, so a
   * claim bearing our own id is either ours from this process lifetime or an
   * orphan left by a process that crashed mid-turn, and only the caller's own
   * bookkeeping can tell those apart. A caller that sets this from "is a run
   * streaming right now" will mark its own freshly won claim as interrupted in
   * the window between winning the gate and starting the run.
   */
  readonly claimedInThisProcess: boolean
}

/**
 * The state machine an executor runs before touching a turn's work row.
 * Pure and total: every input produces exactly one of the ten outcomes
 * below, in this priority order. Branch 9 ('record-interrupted') is the
 * crash-recovery case -- a claim this executor process itself owns, on a
 * turn with no in-memory run backing it, meaning a previous process
 * crashed mid-turn. That claim must never be re-executed; it can only be
 * marked interrupted.
 */
export function decideClaimAction(input: CodeClaimInput): CodeClaimAction {
  const { executorId, work, session, claimGate, claimedInThisProcess } = input

  if (work.payloadFormat !== CODE_TURN_FORMAT) {
    return { kind: 'skip', reason: 'other-format' }
  }
  if (work.target != null && work.target !== executorId) {
    return { kind: 'skip', reason: 'not-targeted' }
  }
  if (work.outcomeStatus != null) {
    return { kind: 'skip', reason: 'terminal' }
  }
  if (session != null && session.outcomeStatus != null) {
    return { kind: 'skip', reason: 'session-closed' }
  }
  if (work.cancelRequested) {
    return { kind: 'skip', reason: 'cancel-requested' }
  }
  if (claimGate == null) {
    return { kind: 'open-claim-gate' }
  }
  const claim = parseClaimDecision(claimGate.decision)
  if (claim != null && claim.executorId !== executorId) {
    return { kind: 'skip', reason: 'claimed-elsewhere' }
  }
  if (claim != null && claim.executorId === executorId) {
    return claimedInThisProcess
      ? { kind: 'execute' }
      : { kind: 'record-interrupted' }
  }
  return { kind: 'attempt-claim' }
}
