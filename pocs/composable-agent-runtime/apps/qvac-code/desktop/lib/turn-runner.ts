import { Buffer } from 'node:buffer'
import type { AssistantFacade } from '@qvac/assistant'
import type { HarnessEvent, HarnessJsonValue } from '@qvac/harness'
import {
  type JournalSeqAllocator,
  CODE_TRUNCATION_MESSAGE,
  createDeltaBatcher,
  type CodeJournalBody,
  type DeltaBatcherAction
} from '@qvac-poc/qvac-code-shared'
import type { CodeFinishOutcome, CodeMeshStore } from '@qvac-poc/qvac-code-shared/store'

const TOOL_SUMMARY_MAX_LENGTH = 120
// Which argument to show in a one-line tool-call summary, in priority order.
// Matches the coding skill's own argument names (see
// lib/skills-impl/coding/host.ts) -- this runner is not coding-specific in
// principle, but the coding skill is the only one this app ships, so its
// argument shapes are what a summary needs to read naturally.
const PRIMARY_SUMMARY_ARG_KEYS = ['filePath', 'command', 'pattern', 'path'] as const

export interface TurnRunnerDeps {
  readonly store: CodeMeshStore
  readonly assistant: Pick<AssistantFacade, 'run' | 'cancelRun'>
  readonly executorId: string
  readonly now: () => number
  readonly onEvent?: (event: TurnRunnerEvent) => void
}

export type TurnRunnerEvent =
  | { readonly kind: 'content'; readonly text: string }
  | { readonly kind: 'thinking'; readonly text: string }
  | { readonly kind: 'tool-call'; readonly name: string; readonly summary: string }
  | { readonly kind: 'tool-result'; readonly name: string; readonly ok: boolean; readonly summary: string }
  | { readonly kind: 'error'; readonly message: string }

export interface TurnRunResult {
  readonly status: 'completed' | 'failed' | 'cancelled'
  readonly finalText: string
  readonly outcome: CodeFinishOutcome
}

// Plain `Omit<CodeJournalBody, 'writer' | 'seq'>` does not distribute over
// CodeJournalBody's union: `keyof` of a union is the *intersection* of its
// members' keys, so a plain Omit collapses every variant-specific field
// (executorId, text, callRef, ...) away, leaving only `type`. The
// `T extends unknown ? ... : never` form forces the conditional to
// distribute across each union member first, then Omits from each one
// individually.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type JournalEntryBody = DistributiveOmit<CodeJournalBody, 'writer' | 'seq'>

export interface TurnRunnerInput {
  readonly sessionId: string
  readonly seq: number
  readonly turnWorkId: string
  readonly prompt: string
  readonly agentId: string
  readonly signal: AbortSignal
  /**
   * Shared with every other module that appends to this turn as this executor.
   * `seq` is both the operationId discriminator and the transcript's render
   * order, so a private counter here would either collide with the approval
   * bridge's entries or, if given a disjoint band to avoid that, silently
   * relocate them in the rendered transcript.
   */
  readonly entrySeq: JournalSeqAllocator
}

export function createTurnRunner(deps: TurnRunnerDeps): {
  run(input: TurnRunnerInput): Promise<TurnRunResult>
} {
  return {
    async run(input) {
      let toolCallSequence = 0
      const pendingCallRefs = new Map<string, string[]>()
      const contentBatcher = createDeltaBatcher()
      const thinkingBatcher = createDeltaBatcher()
      let finalText = ''
      let status: TurnRunResult['status'] = 'completed'

      async function appendJournalEntry(body: JournalEntryBody) {
        const seq = input.entrySeq.next()
        try {
          await deps.store.appendEntry({
            sessionId: input.sessionId,
            seq: input.seq,
            body: { ...body, writer: deps.executorId, seq }
          })
        } catch (error) {
          // A dropped transcript line must never take the turn down with it:
          // the model's actual work (files written, commands run) already
          // happened, and losing one journal line is a far smaller problem
          // than losing that work by aborting the run over a write failure.
          deps.onEvent?.({ kind: 'error', message: `journal append failed: ${describeError(error)}` })
        }
      }

      async function applyBatcherAction(kind: 'assistant' | 'thinking', action: DeltaBatcherAction) {
        if (action.kind === 'flush') {
          await appendJournalEntry(deltaBody(kind, action.text))
          return
        }
        if (action.kind === 'truncate') {
          await appendJournalEntry(deltaBody(kind, action.text))
          await appendJournalEntry({
            type: 'turn-error',
            recoverable: true,
            message: CODE_TRUNCATION_MESSAGE
          })
          return
        }
        // 'buffer' and 'suppress' need no journal write.
      }

      async function drainBoth() {
        const now = deps.now()
        await applyBatcherAction('assistant', contentBatcher.drain(now))
        await applyBatcherAction('thinking', thinkingBatcher.drain(now))
      }

      try {
        for await (const event of deps.assistant.run({
          agentId: input.agentId,
          runId: input.turnWorkId,
          input: input.prompt,
          signal: input.signal
        })) {
          await handleEvent(event)
        }
      } catch (error) {
        // The iterator itself threw -- a transport failure, not a
        // HarnessEvent the harness chose to emit. The harness-side run may
        // still be active, so ask it to stop rather than leaving it running
        // unobserved; best effort, since the harness may already be gone for
        // the same reason this threw.
        status = 'failed'
        const message = describeError(error)
        await drainBoth()
        await appendJournalEntry({ type: 'turn-error', recoverable: false, message })
        deps.onEvent?.({ kind: 'error', message })
        await deps.assistant
          .cancelRun({ agentId: input.agentId, runId: input.turnWorkId, reason: message })
          .catch(() => {
            // Already gone; nothing further to signal.
          })
      }

      await drainBoth()
      // The harness normally emits its own 'aborted' event when the signal
      // fires (handled in handleEvent below); this is a defensive fallback
      // for the narrow window where the signal aborts after the last event
      // but before the iterator formally completes. A prior failure still
      // wins: a reported error is more informative than a same-moment abort.
      if (status === 'completed' && input.signal.aborted) status = 'cancelled'

      const outcome = await deps.store.recordOutcome({
        workId: input.turnWorkId,
        status,
        ...(finalText ? { result: Buffer.from(finalText, 'utf8') } : {})
      })

      if (outcome.kind === 'superseded') {
        deps.onEvent?.({
          kind: 'error',
          message: `turn ${input.turnWorkId} outcome was already recorded by another writer`
        })
        // record-outcome is create-only and executeTurn only reaches this
        // runner after the confirmation barrier in executor.ts has verified
        // the (immutable, create-only) claim gate still names this
        // executor -- so the only writer that could ever beat us to
        // recordOutcome for this turn is an earlier, crashed instance of
        // this same executor identity, recovered by recoverOrphans(). Never
        // a different device. Naming this executor as both fields is
        // therefore accurate, not a placeholder.
        await appendJournalEntry({
          type: 'turn-superseded',
          executorId: deps.executorId,
          winner: deps.executorId
        })
      }

      return { status, finalText, outcome }

      async function handleEvent(event: HarnessEvent) {
        if (event.type === 'content') {
          finalText += event.text
          await applyBatcherAction('assistant', contentBatcher.push(event.text, deps.now()))
          return
        }
        if (event.type === 'thinking') {
          await applyBatcherAction('thinking', thinkingBatcher.push(event.text, deps.now()))
          return
        }
        if (event.type === 'tool-call') {
          // Drain first so the call entry lands after any narration that
          // preceded it, not interleaved mid-buffer.
          await drainBoth()
          const callRef = `${event.name}#${toolCallSequence++}`
          trackCall(pendingCallRefs, event.name, callRef)
          const summary = summarizeToolCall(event.name, event.args)
          await appendJournalEntry({ type: 'tool-call', callRef, name: event.name, summary })
          deps.onEvent?.({ kind: 'tool-call', name: event.name, summary })
          return
        }
        if (event.type === 'tool-result') {
          const callRef = takeCallRef(pendingCallRefs, event.name)
          const { ok, summary } = classifyToolResult(event.result)
          // An unpaired result (no matching call tracked -- should not
          // happen given the harness always calls before it results, but a
          // defensive check costs nothing) is still surfaced to onEvent but
          // has no callRef to pair in the journal, so it is dropped there
          // rather than written with a synthetic one.
          if (callRef != null) {
            await appendJournalEntry({ type: 'tool-result', callRef, name: event.name, ok, summary })
          }
          deps.onEvent?.({ kind: 'tool-result', name: event.name, ok, summary })
          return
        }
        if (event.type === 'tool-progress') {
          // Deliberately no journal entry: progress ticks fire repeatedly
          // while a tool runs and carry no lasting information once it
          // finishes (the eventual tool-result already reports the
          // outcome). Writing one per tick would flood every mesh peer's
          // watch with noise for zero benefit to the transcript.
          return
        }
        if (event.type === 'metrics') {
          await appendJournalEntry({ type: 'turn-metrics', metrics: event.metrics })
          return
        }
        if (event.type === 'error') {
          await drainBoth()
          await appendJournalEntry({ type: 'turn-error', recoverable: false, message: event.message })
          deps.onEvent?.({ kind: 'error', message: event.message })
          status = 'failed'
          return
        }
        // event.type === 'aborted'
        // Same precedence rule the post-loop fallback applies: a reported
        // failure is more informative than a same-moment abort, so an
        // 'aborted' arriving after an 'error' must not downgrade the turn's
        // recorded outcome from 'failed' to 'cancelled'.
        if (status !== 'failed') status = 'cancelled'
      }
    }
  }
}

function deltaBody(kind: 'assistant' | 'thinking', text: string): JournalEntryBody {
  return kind === 'assistant' ? { type: 'assistant-delta', text } : { type: 'thinking-delta', text }
}

function trackCall(pending: Map<string, string[]>, name: string, callRef: string) {
  const list = pending.get(name)
  if (list) {
    list.push(callRef)
  } else {
    pending.set(name, [callRef])
  }
}

function takeCallRef(pending: Map<string, string[]>, name: string): string | null {
  const list = pending.get(name)
  if (!list || list.length === 0) return null
  // FIFO, not LIFO: the agent tool loop (packages/agents/lib/agent.ts)
  // yields every tool-call for a round before yielding any of that round's
  // tool-results, then executes and resolves those calls in the order they
  // were announced -- so for a repeated tool name, the oldest still-unpaired
  // callRef is always the one the next result belongs to.
  return list.shift() ?? null
}

function summarizeToolCall(name: string, args: Readonly<Record<string, HarnessJsonValue>>): string {
  for (const key of PRIMARY_SUMMARY_ARG_KEYS) {
    const value = args[key]
    if (typeof value !== 'string' || !value) continue
    const rendered = key === 'pattern' ? `"${value}"` : value
    return truncateSummary(`${name} ${rendered}`)
  }
  return truncateSummary(name)
}

function classifyToolResult(result: HarnessJsonValue): { readonly ok: boolean; readonly summary: string } {
  if (isPlainObject(result) && typeof result.error === 'string') {
    return { ok: false, summary: truncateSummary(result.error) }
  }
  // Some tool wrappers convert a caught exception straight into a bare
  // string result instead of the { error } shape above. No legitimate tool
  // in this app ever returns a bare string as a *successful* result --
  // every real result is an object -- so a bare string here is treated as
  // the error message it almost certainly is.
  if (typeof result === 'string') {
    return { ok: false, summary: truncateSummary(result) }
  }
  return { ok: true, summary: truncateSummary(describeResult(result)) }
}

function isPlainObject(value: HarnessJsonValue): value is { readonly [key: string]: HarnessJsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describeResult(result: HarnessJsonValue): string {
  if (result === null) return 'null'
  if (typeof result !== 'object') return String(result)
  if (Array.isArray(result)) return `[${result.length} item${result.length === 1 ? '' : 's'}]`
  const keys = Object.keys(result)
  return keys.length > 0 ? `{ ${keys.join(', ')} }` : '{}'
}

function truncateSummary(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= TOOL_SUMMARY_MAX_LENGTH) return normalized
  return `${normalized.slice(0, TOOL_SUMMARY_MAX_LENGTH - 1)}…`
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
