import {
  decodeJournalBody,
  parseCodeWorkId,
  type CodeApprovalVerdict
} from '@qvac-poc/qvac-code-shared'
import type {
  CodeGateRecord,
  CodeJournalEntryRecord,
  CodeMeshStore,
  CodeWorkRecord
} from '@qvac-poc/qvac-code-shared/store'

// Drives the single approval sheet from the mesh-wide open-gates watch.
//
// THE ONE RULE THAT MATTERS: this file renders only from watch frames.
// Calling `resolveApprovalGate` applies to this device's own local Autobase
// view first -- before any peer has seen it, and before the merge that
// decides whether it actually wins -- so trusting that local success would
// show "approved" for a decision that can still lose the merge. A resolve
// marks the affected gate `sending` (in this controller's own bookkeeping)
// and nothing else; only the next `watchOpenGates()` frame is allowed to
// change what the sheet shows as decided.
//
// A gate can also still be open (undecided) while its owning turn's journal
// already carries an `approval-resolved` entry for it -- the harness's own
// fail-closed policy writes the journal entry and the gate resolution as two
// separate operations, so a watch frame can observe the window between them.
// When that happens the recorded verdict (withdrawn/unanswered, never
// invented as "denied") is shown, not a pending prompt.

export type ApprovalPromptStatus =
  | { readonly kind: 'pending' }
  | { readonly kind: 'sending' }
  | { readonly kind: 'decided'; readonly verdict: CodeApprovalVerdict }
  | { readonly kind: 'stale' }

export type ApprovalSheetSnapshot =
  | { readonly kind: 'hidden' }
  | {
      readonly kind: 'visible'
      readonly turnWorkId: string
      readonly gateId: string
      readonly name: string
      readonly summary: string
      readonly detail: readonly string[]
      readonly status: ApprovalPromptStatus
      readonly error: string | null
    }

export type ApprovalControllerStore = Pick<
  CodeMeshStore,
  'watchOpenGates' | 'getWork' | 'listJournal' | 'resolveApprovalGate'
>

export interface ApprovalControllerOptions {
  readonly store: ApprovalControllerStore
  readonly deviceRef: () => string | null
  readonly onState?: (snapshot: ApprovalSheetSnapshot) => void
}

export interface ApprovalController {
  snapshot(): ApprovalSheetSnapshot
  resolve(approved: boolean): Promise<void>
  stop(): void
}

export function createApprovalController(
  options: ApprovalControllerOptions
): ApprovalController {
  const store = options.store
  let current: ApprovalSheetSnapshot = { kind: 'hidden' }
  let latestGates: readonly CodeGateRecord[] = []
  const sending = new Set<string>()
  let refreshToken = 0
  const abortController = new AbortController()

  void consume()

  async function consume() {
    try {
      for await (const gates of store.watchOpenGates({ signal: abortController.signal })) {
        latestGates = gates
        await refresh()
      }
    } catch (error) {
      if (abortController.signal.aborted) return
      // The watch itself failed (not a resolve failure -- see resolve()'s
      // own 'unreachable' handling for that case). There is no open gate to
      // attribute this to, so it is logged rather than silently dropped.
      console.error('[qvac-code-mobile] approval controller watch failed', error)
    }
  }

  function stop() {
    abortController.abort()
  }

  async function refresh() {
    const token = ++refreshToken
    for (const gateId of [...sending]) {
      if (!latestGates.some((gate) => gate.gateId === gateId)) sending.delete(gateId)
    }
    const ordered = [...latestGates].sort((left, right) => left.recordedAt - right.recordedAt)
    for (const gate of ordered) {
      const prompt = await loadPrompt(gate)
      if (token !== refreshToken) return
      if (prompt == null) continue
      update({
        kind: 'visible',
        turnWorkId: gate.workId,
        gateId: gate.gateId,
        name: prompt.name,
        summary: prompt.summary,
        detail: prompt.detail,
        status: prompt.status,
        error: null
      })
      return
    }
    if (token !== refreshToken) return
    update({ kind: 'hidden' })
  }

  async function loadPrompt(gate: CodeGateRecord) {
    const [work, entries] = await Promise.all([
      store.getWork(gate.workId),
      store.listJournal(gate.workId)
    ])
    const requested = findApprovalRequest(entries, gate.gateId)
    if (requested == null) return null
    const resolvedElsewhere = findApprovalResolution(entries, gate.gateId)
    const status: ApprovalPromptStatus = resolvedElsewhere
      ? { kind: 'decided', verdict: resolvedElsewhere }
      : work?.outcomeStatus != null
        ? { kind: 'stale' }
        : sending.has(gate.gateId)
          ? { kind: 'sending' }
          : { kind: 'pending' }
    return { ...requested, status }
  }

  async function resolve(approved: boolean) {
    // Only a pending prompt can be resolved. The sheet also disables its
    // buttons for every other status, but a native touch target stays live
    // until the re-render reaches it, so the guard belongs here too --
    // otherwise a double-tap dispatches a second decision for one gate.
    if (current.kind !== 'visible' || current.status.kind !== 'pending') return
    const { turnWorkId, gateId } = current
    const parsed = parseCodeWorkId(turnWorkId)
    if (parsed == null || parsed.kind !== 'turn') {
      throw new Error(`Cannot resolve approval for malformed turn work id: ${turnWorkId}`)
    }
    const ref = options.deviceRef()
    if (ref == null) {
      throw new Error('Cannot resolve an approval while disconnected')
    }

    sending.add(gateId)
    update({ ...current, status: { kind: 'sending' }, error: null })
    // A rejected write says exactly what 'unreachable' says -- nothing is
    // known to be decided -- so it is folded into that outcome and handled
    // once below. The store turns an `apply` failure into 'unreachable'
    // itself, but it reads the gate back *outside* that guard, so a session
    // closing mid-tap rejects here instead. Left unhandled, `sending` was
    // never cleared and the sheet stayed on 'Sending decision...' forever
    // with both buttons disabled: no way to retry, no way to dismiss.
    const outcome = await store
      .resolveApprovalGate({
        sessionId: parsed.sessionId,
        seq: parsed.seq,
        gateId,
        decision: {
          verdict: approved ? 'approved' : 'denied',
          decidedBy: { kind: 'peer', deviceRef: ref }
        }
      })
      .catch((error: unknown) => ({
        kind: 'unreachable' as const,
        error: error instanceof Error ? error : new Error(String(error))
      }))
    if (outcome.kind !== 'unreachable') {
      // 'won' or 'lost': the next watchOpenGates frame carries the merged
      // truth. Do not touch `current` here -- see the module doc comment.
      return
    }
    sending.delete(gateId)
    if (current.kind === 'visible' && current.gateId === gateId) {
      update({ ...current, status: { kind: 'pending' }, error: outcome.error.message })
    }
  }

  function snapshot() {
    return current
  }

  function update(next: ApprovalSheetSnapshot) {
    current = next
    options.onState?.(next)
  }

  return { snapshot, resolve, stop }
}

function findApprovalRequest(entries: readonly CodeJournalEntryRecord[], gateId: string) {
  for (const entry of entries) {
    const body = decodeJournalBody(entry.body)
    if (body?.type === 'approval-requested' && body.gateId === gateId) {
      return { name: body.name, summary: body.summary, detail: body.detail }
    }
  }
  return null
}

function findApprovalResolution(
  entries: readonly CodeJournalEntryRecord[],
  gateId: string
): CodeApprovalVerdict | null {
  for (const entry of entries) {
    const body = decodeJournalBody(entry.body)
    if (body?.type === 'approval-resolved' && body.gateId === gateId) {
      return body.decision.verdict
    }
  }
  return null
}
