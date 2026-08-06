// Structural row shapes for the fields decideClaimAction actually reads.
// Deliberately independent of `@qvac/sync` -- claim.ts is pure decision
// logic and must be testable without importing Sync's hyperschema types.
// `test/rows.test.ts` carries compile-time Assert<Extends<>> checks proving
// Sync's real DurableWork/DurableWorkGate rows still satisfy these shapes,
// so drift between the two is a type error, not a silent runtime mismatch.

export interface CodeWorkRow {
  readonly workId: string
  readonly payloadFormat: string
  readonly target?: string | null
  readonly cancelRequested?: boolean
  readonly outcomeStatus?: string | null
  readonly createdAt: number
}

export interface CodeGateRow {
  readonly gateId: string
  readonly kind: string
  readonly decision?: string | null
  readonly recordedAt: number
  readonly workId: string
}
