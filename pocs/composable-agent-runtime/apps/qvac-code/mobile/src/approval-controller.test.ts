import { describe, expect, test } from 'bun:test'
import {
  encodeJournalBody,
  encodeTurnPayload,
  formatTurnWorkId,
  type CodeJournalBody
} from '@qvac-poc/qvac-code-shared'
import type {
  CodeGateRecord,
  CodeJournalEntryRecord,
  CodeMeshStore,
  CodeWorkRecord
} from '@qvac-poc/qvac-code-shared/store'
import {
  createApprovalController,
  type ApprovalControllerStore,
  type ApprovalSheetSnapshot
} from './approval-controller.ts'

const SESSION_ID = 's1'
const SEQ = 0
const TURN_WORK_ID = formatTurnWorkId({ sessionId: SESSION_ID, seq: SEQ })
const GATE_ID = 'approval/code-laptop-abc/1'
const PHONE_REF = 'phone-1'

function gateRow(overrides: Partial<CodeGateRecord> = {}): CodeGateRecord {
  return {
    id: `${TURN_WORK_ID}:${GATE_ID}`,
    workId: TURN_WORK_ID,
    gateId: GATE_ID,
    kind: 'qvac.poc.code.approval/v1',
    recordedAt: 1,
    ...overrides
  } as CodeGateRecord
}

function workRow(overrides: Partial<CodeWorkRecord> = {}): CodeWorkRecord {
  return {
    workId: TURN_WORK_ID,
    payload: encodeTurnPayload({
      kind: 'code-turn',
      sessionId: SESSION_ID,
      seq: SEQ,
      prompt: 'run the migration',
      requestedBy: PHONE_REF
    }),
    payloadFormat: 'application/vnd.qvac.poc.code-turn+json',
    payloadVersion: 1,
    createdAt: 1,
    ...overrides
  } as CodeWorkRecord
}

function entryRow(id: string, body: CodeJournalBody): CodeJournalEntryRecord {
  return {
    id,
    workId: TURN_WORK_ID,
    entryType: body.type,
    body: encodeJournalBody(body),
    recordedAt: 1
  } as CodeJournalEntryRecord
}

function requestEntry() {
  return entryRow('e-request', {
    writer: 'code-laptop-abc',
    seq: 0,
    type: 'approval-requested',
    gateId: GATE_ID,
    name: 'shell',
    summary: 'git status --short',
    detail: ['cwd: /repo']
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

interface FakeStore {
  readonly store: ApprovalControllerStore
  push(gates: readonly CodeGateRecord[]): void
  setWork(work: CodeWorkRecord | null): void
  setJournal(entries: readonly CodeJournalEntryRecord[]): void
  setResolveImpl(impl: CodeMeshStore['resolveApprovalGate']): void
  stopCalls(): number
}

function fakeStore(): FakeStore {
  // Mirrors CodeMeshStore.watchOpenGates's real shape: an AsyncIterable that
  // ends when the caller's AbortSignal fires, not a listener/stop pair.
  let pendingNext:
    | ((value: IteratorResult<readonly CodeGateRecord[]>) => void)
    | null = null
  const queue: (readonly CodeGateRecord[])[] = []
  let stopCalls = 0
  let work: CodeWorkRecord | null = workRow()
  let entries: readonly CodeJournalEntryRecord[] = []
  let resolveImpl: CodeMeshStore['resolveApprovalGate'] = async () => {
    throw new Error('resolveApprovalGate was not configured for this test')
  }

  const store: ApprovalControllerStore = {
    watchOpenGates(options) {
      const signal = options?.signal
      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<readonly CodeGateRecord[]>> {
              if (signal?.aborted) {
                return { done: true, value: undefined as unknown as readonly CodeGateRecord[] }
              }
              const queued = queue.shift()
              if (queued !== undefined) return { done: false, value: queued }
              return new Promise<IteratorResult<readonly CodeGateRecord[]>>((resolve) => {
                pendingNext = resolve
                signal?.addEventListener(
                  'abort',
                  () => {
                    pendingNext = null
                    stopCalls += 1
                    resolve({ done: true, value: undefined as unknown as readonly CodeGateRecord[] })
                  },
                  { once: true }
                )
              })
            }
          }
        }
      }
    },
    async getWork(workId) {
      return workId === TURN_WORK_ID ? work : null
    },
    async listJournal() {
      return entries
    },
    resolveApprovalGate(input) {
      return resolveImpl(input)
    }
  }

  return {
    store,
    push(gates) {
      if (pendingNext) {
        const resolve = pendingNext
        pendingNext = null
        resolve({ done: false, value: gates })
        return
      }
      queue.push(gates)
    },
    setWork(nextWork) {
      work = nextWork
    },
    setJournal(nextEntries) {
      entries = nextEntries
    },
    setResolveImpl(impl) {
      resolveImpl = impl
    },
    stopCalls: () => stopCalls
  }
}

describe('approval controller: renders only from watch frames', () => {
  test('a local resolve marks the gate sending, never decided, until the next watch frame', async () => {
    const fake = fakeStore()
    fake.setJournal([requestEntry()])
    const snapshots: ApprovalSheetSnapshot[] = []
    const controller = createApprovalController({
      store: fake.store,
      deviceRef: () => PHONE_REF,
      onState: (snapshot) => snapshots.push(snapshot)
    })

    fake.push([gateRow()])
    await flush()
    expect(controller.snapshot()).toMatchObject({
      kind: 'visible',
      gateId: GATE_ID,
      status: { kind: 'pending' }
    })

    const gate = deferred<Awaited<ReturnType<CodeMeshStore['resolveApprovalGate']>>>()
    fake.setResolveImpl(() => gate.promise)

    const resolving = controller.resolve(true)
    // Synchronous part of resolve() runs up to its first await, so the
    // sending state is already visible without waiting on a microtask.
    expect(controller.snapshot()).toMatchObject({ status: { kind: 'sending' } })

    gate.resolve({
      kind: 'won',
      decision: { verdict: 'approved', decidedBy: { kind: 'peer', deviceRef: PHONE_REF } }
    })
    await resolving

    // The apply() succeeding locally must not, by itself, render "approved":
    // only a subsequent watch frame may do that.
    expect(controller.snapshot()).toMatchObject({ status: { kind: 'sending' } })
    expect(snapshots.some((s) => s.kind === 'visible' && s.status.kind === 'decided')).toBe(
      false
    )

    // The gate is now decided mesh-wide, so the next open-gates frame omits
    // it -- that is what actually changes what the sheet shows.
    fake.push([])
    await flush()
    expect(controller.snapshot()).toEqual({ kind: 'hidden' })
  })

  test('an unreachable resolve surfaces an error and returns to pending, without inventing a decision', async () => {
    const fake = fakeStore()
    fake.setJournal([requestEntry()])
    const controller = createApprovalController({ store: fake.store, deviceRef: () => PHONE_REF })
    fake.push([gateRow()])
    await flush()

    fake.setResolveImpl(async () => ({
      kind: 'unreachable',
      error: new Error('gate still undecided')
    }))
    await controller.resolve(false)

    expect(controller.snapshot()).toMatchObject({
      status: { kind: 'pending' },
      error: 'gate still undecided'
    })
  })

  // resolveApprovalGate folds an `apply` failure into 'unreachable', but it
  // reads the gate back outside that try -- so a closing session rejects
  // instead. Unhandled, the prompt stayed disabled on 'sending' forever.
  test('a rejected resolve returns to pending with the reason, never stuck sending', async () => {
    const fake = fakeStore()
    fake.setJournal([requestEntry()])
    const snapshots: ApprovalSheetSnapshot[] = []
    const controller = createApprovalController({
      store: fake.store,
      deviceRef: () => PHONE_REF,
      onState: (snapshot) => snapshots.push(snapshot)
    })
    fake.push([gateRow()])
    await flush()

    fake.setResolveImpl(async () => {
      throw new Error('HRPC session closed')
    })
    await controller.resolve(true)

    expect(controller.snapshot()).toMatchObject({
      status: { kind: 'pending' },
      error: 'HRPC session closed'
    })
    // A failure is the one case where the verdict is least known, so it must
    // never be painted as decided.
    expect(snapshots.some((s) => s.kind === 'visible' && s.status.kind === 'decided')).toBe(
      false
    )
  })

  test('a second resolve while one is in flight does not dispatch a second decision', async () => {
    const fake = fakeStore()
    fake.setJournal([requestEntry()])
    const controller = createApprovalController({
      store: fake.store,
      deviceRef: () => PHONE_REF
    })
    fake.push([gateRow()])
    await flush()

    let dispatches = 0
    const gate = deferred<Awaited<ReturnType<CodeMeshStore['resolveApprovalGate']>>>()
    fake.setResolveImpl(() => {
      dispatches += 1
      return gate.promise
    })

    // The sheet disables both buttons on 'sending', but the native touch
    // target stays live until that re-render lands -- so a double-tap has to
    // be refused by the controller itself.
    const first = controller.resolve(true)
    const second = controller.resolve(false)
    expect(dispatches).toBe(1)

    gate.resolve({
      kind: 'won',
      decision: { verdict: 'approved', decidedBy: { kind: 'peer', deviceRef: PHONE_REF } }
    })
    await Promise.all([first, second])
    expect(dispatches).toBe(1)
  })

  test('stop() releases the underlying watch', () => {
    const fake = fakeStore()
    const controller = createApprovalController({ store: fake.store, deviceRef: () => PHONE_REF })
    controller.stop()
    expect(fake.stopCalls()).toBe(1)
  })
})

describe('approval controller: a turn that already finished renders as stale', () => {
  test('an undecided gate on a terminal turn is stale, not pending', async () => {
    const fake = fakeStore()
    fake.setJournal([requestEntry()])
    fake.setWork(workRow({ outcomeStatus: 'completed' }))
    const controller = createApprovalController({ store: fake.store, deviceRef: () => PHONE_REF })

    fake.push([gateRow()])
    await flush()

    expect(controller.snapshot()).toMatchObject({
      kind: 'visible',
      status: { kind: 'stale' }
    })
  })
})

describe('approval controller: withdrawn/unanswered are never rendered as denied', () => {
  test('a policy withdrawal observed while the gate still reads as open renders the exact word', async () => {
    const fake = fakeStore()
    fake.setJournal([
      requestEntry(),
      entryRow('e-resolved', {
        writer: 'code-laptop-abc',
        seq: 1,
        type: 'approval-resolved',
        gateId: GATE_ID,
        decision: { verdict: 'withdrawn', decidedBy: { kind: 'policy', rule: 'run-ended' } },
        reason: null
      })
    ])
    const controller = createApprovalController({ store: fake.store, deviceRef: () => PHONE_REF })

    fake.push([gateRow()])
    await flush()

    expect(controller.snapshot()).toMatchObject({
      kind: 'visible',
      status: { kind: 'decided', verdict: 'withdrawn' }
    })
    const status = (controller.snapshot() as { status: { verdict?: string } }).status
    expect(status.verdict).not.toBe('denied')
  })

  test('unanswered renders as unanswered, not denied', async () => {
    const fake = fakeStore()
    fake.setJournal([
      requestEntry(),
      entryRow('e-resolved', {
        writer: 'code-laptop-abc',
        seq: 1,
        type: 'approval-resolved',
        gateId: GATE_ID,
        decision: { verdict: 'unanswered', decidedBy: { kind: 'policy', rule: 'deadline' } },
        reason: null
      })
    ])
    const controller = createApprovalController({ store: fake.store, deviceRef: () => PHONE_REF })

    fake.push([gateRow()])
    await flush()

    expect(controller.snapshot()).toMatchObject({
      kind: 'visible',
      status: { kind: 'decided', verdict: 'unanswered' }
    })
  })
})
