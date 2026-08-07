import {
  decodeJournalBody,
  projectTurn,
  type CodeJournalBody,
  type CodeTurnView
} from '@qvac-poc/qvac-code-shared'
import type {
  CodeGateRecord,
  CodeJournalEntryRecord,
  CodeWorkRecord
} from '@qvac-poc/qvac-code-shared/store'

export interface TranscriptViewModelOptions {
  // Injectable purely so a test can count decode calls without depending on
  // the exact bytes a real journal entry carries.
  readonly decode?: (body: Buffer) => CodeJournalBody | null
}

export interface TranscriptViewModel {
  apply(
    entries: readonly CodeJournalEntryRecord[],
    gates: readonly CodeGateRecord[],
    work: CodeWorkRecord
  ): CodeTurnView
  reset(): void
}

/**
 * A `change` frame from Sync is a full snapshot (see AGENTS.md), so every
 * mesh-wide write -- including ones that touch a different turn entirely --
 * redelivers every entry this turn has ever had. `projectTurn` is a thin,
 * pure projection; it is not reimplemented here (that would fork the shared
 * package's block-coalescing and status-derivation logic, which is exactly
 * the kind of drift the PoC's package boundaries exist to prevent). What
 * this adapter owns is recognising a no-op wake before paying for a
 * recompute: a `Map<entryId, decoded>` tracks which entries have already
 * been seen, so decoding only ever happens for an entry this view has not
 * looked at before, and a wake carrying the same entries/gates/work as last
 * time returns the previous `CodeTurnView` by reference instead of asking
 * `projectTurn` to rebuild an identical result.
 */
export function createTranscriptViewModel(
  options: TranscriptViewModelOptions = {}
): TranscriptViewModel {
  const decode = options.decode ?? decodeJournalBody
  const decoded = new Map<string, CodeJournalBody | null>()
  let lastEntryCount = -1
  let lastGateSignature: string | null = null
  let lastWorkSignature: string | null = null
  let cachedView: CodeTurnView | null = null

  function apply(
    entries: readonly CodeJournalEntryRecord[],
    gates: readonly CodeGateRecord[],
    work: CodeWorkRecord
  ): CodeTurnView {
    const incomingIds = new Set(entries.map((entry) => entry.id))
    let sawNewEntry = false
    for (const entry of entries) {
      if (decoded.has(entry.id)) continue
      sawNewEntry = true
      decoded.set(entry.id, decode(entry.body))
    }
    for (const id of decoded.keys()) {
      if (!incomingIds.has(id)) decoded.delete(id)
    }

    const gateSignature = signGates(gates)
    const workSignature = signWork(work)
    const entriesChanged = sawNewEntry || entries.length !== lastEntryCount
    const unchanged =
      cachedView != null &&
      !entriesChanged &&
      gateSignature === lastGateSignature &&
      workSignature === lastWorkSignature
    lastEntryCount = entries.length
    lastGateSignature = gateSignature
    lastWorkSignature = workSignature
    if (unchanged && cachedView != null) return cachedView

    const view = projectTurn({
      work,
      entries: entries.map((entry) => ({
        body: entry.body,
        recordedAt: entry.recordedAt
      })),
      gates
    })
    cachedView = view
    return view
  }

  function reset() {
    decoded.clear()
    lastEntryCount = -1
    lastGateSignature = null
    lastWorkSignature = null
    cachedView = null
  }

  return { apply, reset }
}

// Both signatures must cover every field `projectTurn` reads, or the cache
// returns a view built from stale inputs. `recordedAt` feeds the projection's
// `updatedAt`, and `outcomeResult` its `finalText` -- keying only on
// gateId/decision/outcomeStatus would miss a write that moved either.
function signGates(gates: readonly CodeGateRecord[]) {
  return gates
    .map((gate) => `${gate.gateId}:${gate.decision ?? ''}:${gate.recordedAt}`)
    .sort()
    .join('|')
}

function signWork(work: CodeWorkRecord) {
  const result = work.outcomeResult == null ? '' : String(work.outcomeResult.length)
  return `${work.outcomeStatus ?? ''}:${work.cancelRequested ? '1' : '0'}:${result}`
}
