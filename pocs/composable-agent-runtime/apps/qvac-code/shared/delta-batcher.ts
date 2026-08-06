// Pure delta coalescer for assistant/thinking streams. No timers, no
// Date.now() -- the caller drives the clock via `now` on every call, which
// is what makes this deterministic under test and usable from a runtime
// that already owns its own event loop.

export interface DeltaBatcherPolicy {
  readonly maxBytes: number
  readonly maxDelayMs: number
  readonly maxEntriesPerTurn: number
}

const DEFAULT_POLICY: DeltaBatcherPolicy = {
  maxBytes: 1024,
  maxDelayMs: 400,
  maxEntriesPerTurn: 400
}

export type DeltaBatcherAction =
  | { readonly kind: 'buffer' }
  | { readonly kind: 'flush'; readonly text: string }
  | { readonly kind: 'truncate'; readonly text: string }
  | { readonly kind: 'suppress' }

export interface DeltaBatcher {
  push(text: string, now: number): DeltaBatcherAction
  tick(now: number): DeltaBatcherAction
  drain(now: number): DeltaBatcherAction
}

export function createDeltaBatcher(policy?: Partial<DeltaBatcherPolicy>): DeltaBatcher {
  const resolved: DeltaBatcherPolicy = { ...DEFAULT_POLICY, ...policy }
  let buffer = ''
  let firstBufferedAt: number | null = null
  let emittedEntries = 0
  let truncated = false

  function resetBuffer() {
    buffer = ''
    firstBufferedAt = null
  }

  // Never emit a flush with empty text: an empty write still costs every
  // device in the mesh a wake and a re-serialize of the watched journal.
  function flushAction(): DeltaBatcherAction {
    const text = buffer
    resetBuffer()
    if (!text) return { kind: 'buffer' }
    emittedEntries++
    return applyBudget({ kind: 'flush', text })
  }

  // One verbose turn must not degrade every watcher in the mesh: once the
  // per-turn entry budget is reached, the entry that reaches it is emitted
  // as a single 'truncate' action, and every action after that is
  // 'suppress' until a new batcher is created for the next turn.
  function applyBudget(action: DeltaBatcherAction): DeltaBatcherAction {
    if (action.kind !== 'flush') return action
    if (emittedEntries < resolved.maxEntriesPerTurn) return action
    truncated = true
    return { kind: 'truncate', text: action.text }
  }

  return {
    push(text, now) {
      if (truncated) return { kind: 'suppress' }
      if (text) {
        if (buffer === '') firstBufferedAt = now
        buffer += text
      }
      if (buffer === '') return { kind: 'buffer' }
      const byteLength = Buffer.byteLength(buffer, 'utf8')
      const elapsed = firstBufferedAt == null ? 0 : now - firstBufferedAt
      if (byteLength >= resolved.maxBytes || elapsed >= resolved.maxDelayMs) {
        return flushAction()
      }
      return { kind: 'buffer' }
    },
    tick(now) {
      if (truncated) return { kind: 'suppress' }
      if (buffer === '' || firstBufferedAt == null) return { kind: 'buffer' }
      if (now - firstBufferedAt >= resolved.maxDelayMs) return flushAction()
      return { kind: 'buffer' }
    },
    drain(now) {
      void now
      if (truncated) return { kind: 'suppress' }
      if (buffer === '') return { kind: 'buffer' }
      return flushAction()
    }
  }
}
