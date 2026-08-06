import { CODE_CLAIM_GATE_ID, CODE_TRUNCATION_MESSAGE } from './formats.ts'
import { decodeUtf8Text } from './codec.ts'
import { decodeSessionPayload, decodeTurnPayload } from './session.ts'
import { decodeJournalBody, type CodeJournalBody } from './journal.ts'
import { parseClaimDecision, type CodeClaim } from './claim.ts'
import type { CodeApprovalDecision } from './approval.ts'

export type CodeTurnStatus =
  | 'queued'
  | 'claimed'
  | 'running'
  | 'awaiting-approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'superseded'

export type CodeTranscriptBlock =
  | { readonly kind: 'assistant'; readonly text: string }
  | { readonly kind: 'thinking'; readonly text: string }
  | {
      readonly kind: 'tool'
      readonly callRef: string
      readonly name: string
      readonly request: string
      readonly outcome: { readonly ok: boolean; readonly summary: string } | null
    }
  | {
      readonly kind: 'approval'
      readonly gateId: string
      readonly name: string
      readonly summary: string
      readonly detail: readonly string[]
      readonly decision: CodeApprovalDecision | null
      readonly stale: boolean
    }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'notice'; readonly text: string }

export interface CodeTurnView {
  readonly turnWorkId: string
  readonly sessionId: string
  readonly seq: number
  readonly prompt: string
  readonly status: CodeTurnStatus
  readonly claimedBy: string | null
  readonly blocks: readonly CodeTranscriptBlock[]
  readonly openApproval: Extract<CodeTranscriptBlock, { kind: 'approval' }> | null
  readonly finalText: string | null
  readonly truncated: boolean
  readonly updatedAt: number
}

// Structural inputs, not Sync's row types: projectTurn is pure projection
// logic and must be testable with plain fixtures. Whatever store.ts reads
// back from Sync satisfies these shapes structurally.
export interface CodeTranscriptWorkInput {
  readonly workId: string
  readonly payload: Buffer
  readonly outcomeStatus?: string | null
  readonly outcomeResult?: Buffer | null
  readonly cancelRequested?: boolean
  readonly createdAt: number
}

export interface CodeTranscriptEntryInput {
  readonly body: Buffer
  readonly recordedAt: number
}

export interface CodeTranscriptGateInput {
  readonly gateId: string
  readonly decision?: string | null
  readonly recordedAt: number
}

export interface CodeSessionSummary {
  readonly sessionId: string
  readonly workId: string
  readonly title: string
  readonly projectLabel: string
  readonly model: string
  readonly createdBy: string
  readonly status: 'open' | 'closed'
  readonly createdAt: number
}

export function projectTurn(input: {
  readonly work: CodeTranscriptWorkInput
  readonly entries: readonly CodeTranscriptEntryInput[]
  readonly gates: readonly CodeTranscriptGateInput[]
}): CodeTurnView {
  const payload = decodeTurnPayload(input.work.payload)
  const terminal = input.work.outcomeStatus != null

  const decodedEntries = input.entries
    .map((entry) => decodeJournalBody(entry.body))
    .filter((body): body is CodeJournalBody => body != null)

  const claimGate = input.gates.find((gate) => gate.gateId === CODE_CLAIM_GATE_ID) ?? null
  const claim = claimGate ? parseClaimDecision(claimGate.decision) : null
  const winner = claim?.executorId ?? null

  // Order the winner's stream by its own seq, never by recordedAt --
  // list-journal sorts by recordedAt, which is the writing device's wall
  // clock, and clock skew between two devices would reorder tokens.
  const byWriter = new Map<string, CodeJournalBody[]>()
  for (const body of decodedEntries) {
    const bucket = byWriter.get(body.writer)
    if (bucket) {
      bucket.push(body)
    } else {
      byWriter.set(body.writer, [body])
    }
  }
  for (const bucket of byWriter.values()) {
    bucket.sort((left, right) => left.seq - right.seq)
  }

  const blocks: CodeTranscriptBlock[] = []
  for (const writer of [...byWriter.keys()].sort()) {
    const bucket = byWriter.get(writer)
    if (bucket == null) continue
    if (winner != null && writer !== winner) {
      // Both writers' entries survive a partition merge -- append-journal
      // never arbitrates between them -- but only the winner's stream reads
      // as the live transcript. The loser collapses to one greyed notice
      // instead of being interleaved with the winner's blocks.
      blocks.push({
        kind: 'notice',
        text: `Superseded by ${winner} (writer ${writer} did not win the claim)`
      })
      continue
    }
    appendWriterBlocks(bucket, blocks, terminal)
  }

  const status = deriveStatus({ work: input.work, claim, gates: input.gates, decodedEntries })

  const openApproval =
    blocks.find(
      (block): block is Extract<CodeTranscriptBlock, { kind: 'approval' }> =>
        block.kind === 'approval' && block.decision == null && !block.stale
    ) ?? null

  const finalText = input.work.outcomeResult != null ? decodeUtf8Text(input.work.outcomeResult) : null

  const truncated = decodedEntries.some(
    (body) => body.type === 'turn-error' && body.recoverable && body.message === CODE_TRUNCATION_MESSAGE
  )

  const updatedAt = Math.max(
    input.work.createdAt,
    ...input.entries.map((entry) => entry.recordedAt),
    ...input.gates.map((gate) => gate.recordedAt)
  )

  return {
    turnWorkId: input.work.workId,
    sessionId: payload.sessionId,
    seq: payload.seq,
    prompt: payload.prompt,
    status,
    claimedBy: claim?.executorId ?? null,
    blocks,
    openApproval,
    finalText,
    truncated,
    updatedAt
  }
}

export function projectSessionList(
  works: readonly CodeTranscriptWorkInput[]
): readonly CodeSessionSummary[] {
  const summaries: CodeSessionSummary[] = []
  for (const work of works) {
    const sessionId = sessionIdFromWorkId(work.workId)
    if (sessionId == null) continue
    const payload = decodeSessionPayload(work.payload)
    summaries.push({
      sessionId,
      workId: work.workId,
      title: payload.title,
      projectLabel: payload.projectLabel,
      model: payload.model,
      createdBy: payload.createdBy,
      status: work.outcomeStatus != null ? 'closed' : 'open',
      createdAt: work.createdAt
    })
  }
  return summaries.sort((left, right) => right.createdAt - left.createdAt)
}

function sessionIdFromWorkId(workId: string): string | null {
  const segments = workId.split('/')
  if (segments.length !== 2 || segments[0] !== 'code') return null
  return segments[1] ?? null
}

function appendWriterBlocks(
  bucket: readonly CodeJournalBody[],
  blocks: CodeTranscriptBlock[],
  terminal: boolean
) {
  const toolCallIndex = new Map<string, number>()
  // A writer's first block must never coalesce into whatever the previous
  // writer's bucket left at the tail of `blocks` -- only entries produced
  // within *this* bucket are safe to merge with each other.
  let atBucketStart = true
  for (const body of bucket) {
    const startingBucket = atBucketStart
    atBucketStart = false
    if (body.type === 'assistant-delta') {
      appendCoalescedText(blocks, 'assistant', body.text, startingBucket)
      continue
    }
    if (body.type === 'thinking-delta') {
      appendCoalescedText(blocks, 'thinking', body.text, startingBucket)
      continue
    }
    if (body.type === 'tool-call') {
      blocks.push({
        kind: 'tool',
        callRef: body.callRef,
        name: body.name,
        request: body.summary,
        outcome: null
      })
      toolCallIndex.set(body.callRef, blocks.length - 1)
      continue
    }
    if (body.type === 'tool-result') {
      const index = toolCallIndex.get(body.callRef)
      const existing = index != null ? blocks[index] : undefined
      if (index != null && existing != null && existing.kind === 'tool') {
        blocks[index] = { ...existing, outcome: { ok: body.ok, summary: body.summary } }
      }
      // An unpaired tool-result (no matching call in this writer's stream)
      // is dropped rather than rendered as a synthetic call: the call entry
      // is the source of truth for what ran.
      continue
    }
    if (body.type === 'approval-requested') {
      blocks.push({
        kind: 'approval',
        gateId: body.gateId,
        name: body.name,
        summary: body.summary,
        detail: body.detail,
        decision: null,
        stale: false
      })
      continue
    }
    if (body.type === 'approval-resolved') {
      const index = findApprovalBlockIndex(blocks, body.gateId)
      const existing = index != null ? blocks[index] : undefined
      if (index != null && existing != null && existing.kind === 'approval') {
        blocks[index] = {
          ...existing,
          decision: body.decision,
          // A decision made by the harness's own fail-closed policy
          // (run-ended / deadline) never gated a live tool: it is the
          // system closing an abandoned gate, not a real answer. Once the
          // turn is terminal, that kind of decision must not be rendered as
          // though it gated a tool run.
          stale: terminal && body.decision.decidedBy.kind === 'policy'
        }
      }
      continue
    }
    if (body.type === 'turn-error') {
      blocks.push({ kind: 'error', message: body.message })
      continue
    }
    // 'turn-claim', 'turn-metrics', 'turn-interrupted', 'turn-superseded'
    // drive status derivation below and render no block of their own.
  }
}

function appendCoalescedText(
  blocks: CodeTranscriptBlock[],
  kind: 'assistant' | 'thinking',
  text: string,
  startingBucket: boolean
) {
  const last = blocks.at(-1)
  if (!startingBucket && last != null && last.kind === kind) {
    blocks[blocks.length - 1] = { kind, text: last.text + text }
    return
  }
  blocks.push({ kind, text })
}

function findApprovalBlockIndex(blocks: readonly CodeTranscriptBlock[], gateId: string): number | null {
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index]
    if (block != null && block.kind === 'approval' && block.gateId === gateId) return index
  }
  return null
}

function deriveStatus(input: {
  readonly work: CodeTranscriptWorkInput
  readonly claim: CodeClaim | null
  readonly gates: readonly CodeTranscriptGateInput[]
  readonly decodedEntries: readonly CodeJournalBody[]
}): CodeTurnStatus {
  const { work, claim, gates, decodedEntries } = input
  if (work.outcomeStatus === 'completed') return 'completed'
  if (work.outcomeStatus === 'failed') return 'failed'
  if (work.outcomeStatus === 'cancelled') return 'cancelled'
  if (work.cancelRequested) return 'cancelled'

  const hasUndecidedApproval = gates.some(
    (gate) => gate.gateId !== CODE_CLAIM_GATE_ID && gate.decision == null
  )
  if (hasUndecidedApproval) return 'awaiting-approval'

  if (claim != null) {
    const supersededBySurvivor = decodedEntries.some(
      (body) => body.type === 'turn-superseded' && body.writer === claim.executorId
    )
    if (supersededBySurvivor) return 'superseded'
    const hasActivity = decodedEntries.some(
      (body) => body.writer === claim.executorId && body.type !== 'turn-claim'
    )
    return hasActivity ? 'running' : 'claimed'
  }

  return 'queued'
}
