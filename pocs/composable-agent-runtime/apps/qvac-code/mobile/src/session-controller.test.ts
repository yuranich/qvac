import { describe, expect, test } from 'bun:test'
import type {
  CodeCreateKind,
  CodeExecutorRecord,
  CodeGateRecord,
  CodeMeshStore,
  CodeWorkRecord
} from '@qvac-poc/qvac-code-shared/store'
import type { CodeSessionSummary } from '@qvac-poc/qvac-code-shared'
import {
  createSessionController,
  type MobileSyncRuntime
} from './session-controller.ts'

const VALID_PAIRING_URI =
  'qvac-poc://pair?invite=Ab-_89&expiresAt=9999999999999'

describe('session controller: connect transitions', () => {
  test('connecting without a pairing uri goes connecting -> ready, never awaiting-approval', async () => {
    const states: string[] = []
    const sync = fakeSync()
    const controller = createSessionController({
      storagePath: '/tmp/qvac-code-mobile',
      createSync: sync.createSync,
      createStore: () => fakeStore(),
      onState: (snapshot) => states.push(snapshot.state)
    })
    await controller.connect()
    expect(states).toEqual(['connecting', 'ready'])
    expect(controller.snapshot().state).toBe('ready')
    expect(controller.deviceRef()).toBe(sync.deviceIdHex)
  })

  test('connecting with a pairing uri waits in awaiting-approval until ready() resolves', async () => {
    const states: string[] = []
    const sync = fakeSync({ deferReady: true })
    const controller = createSessionController({
      storagePath: '/tmp/qvac-code-mobile',
      createSync: sync.createSync,
      createStore: () => fakeStore(),
      onState: (snapshot) => states.push(snapshot.state)
    })
    const connecting = controller.connect(VALID_PAIRING_URI)
    await flush()
    expect(states).toEqual(['connecting', 'awaiting-approval'])
    expect(controller.snapshot().state).toBe('awaiting-approval')

    sync.resolveReady()
    await connecting
    expect(states).toEqual(['connecting', 'awaiting-approval', 'ready'])
  })

  test('a failed connect reports the error state and rethrows', async () => {
    const sync = fakeSync({ readyError: new Error('mesh unreachable') })
    const controller = createSessionController({
      storagePath: '/tmp/qvac-code-mobile',
      createSync: sync.createSync,
      createStore: () => fakeStore()
    })
    await expect(controller.connect()).rejects.toThrow('mesh unreachable')
    expect(controller.snapshot().state).toBe('error')
  })

  // connect() claims its generation before awaiting teardown. Reading the
  // generation back afterwards let two overlapping attempts observe the same
  // value, so both passed every fence: two runtimes ended up open on one
  // storagePath and the superseded one was never closed.
  test('a second connect supersedes an in-flight one instead of opening a second runtime', async () => {
    const sync = fakeSync({ deferReady: true })
    const controller = createSessionController({
      storagePath: '/tmp/qvac-code-mobile',
      createSync: sync.createSync,
      createStore: () => fakeStore()
    })

    const superseded = controller.connect()
    const winner = controller.connect()
    await flush()

    // The superseded attempt bails at its fence before constructing anything.
    expect(sync.createCalls()).toBe(1)

    sync.resolveReady()
    await Promise.all([superseded, winner])

    expect(controller.snapshot().state).toBe('ready')
    // Nothing was left open behind the winner.
    expect(sync.closeCalls()).toBe(0)
  })

  test('a disconnect during an in-flight connect wins and leaves nothing open', async () => {
    const sync = fakeSync({ deferReady: true })
    const controller = createSessionController({
      storagePath: '/tmp/qvac-code-mobile',
      createSync: sync.createSync,
      createStore: () => fakeStore()
    })

    const connecting = controller.connect()
    await flush()
    await controller.disconnect()

    sync.resolveReady()
    await connecting

    // The connect noticed it lost the generation and closed the runtime it
    // had already built rather than publishing it over the disconnect.
    expect(controller.snapshot().state).toBe('offline')
    expect(controller.store()).toBeNull()
    expect(sync.closeCalls()).toBe(1)
  })
})

describe('session controller: createSession surfaces CodeCreateKind', () => {
  test('reports created when both the session and turn land', async () => {
    const controller = await connectedController({})
    const outcome = await controller.createSession({
      title: 'Fix the bug',
      prompt: 'find the off-by-one',
      executorId: 'code-laptop-abc',
      projectLabel: 'demo',
      model: 'demo-model'
    })
    expect(outcome).toEqual({
      kind: 'created',
      sessionId: expect.any(String),
      turnWorkId: expect.any(String)
    })
  })

  test('tells the caller its prompt lost the id when the turn write is superseded', async () => {
    const controller = await connectedController({
      createTurnKind: 'superseded'
    })
    const outcome = await controller.createSession({
      title: 'Fix the bug',
      prompt: 'find the off-by-one',
      executorId: 'code-laptop-abc',
      projectLabel: 'demo',
      model: 'demo-model'
    })
    expect(outcome.kind).toBe('lost')
    if (outcome.kind !== 'lost') throw new Error('expected lost')
    expect(outcome.stage).toBe('turn')
    expect(outcome.reason).toBe('superseded')
  })

  test('reports a lost session write without ever attempting the turn', async () => {
    let turnAttempted = false
    const controller = await connectedController({
      createSessionKind: 'superseded',
      onCreateTurn: () => {
        turnAttempted = true
      }
    })
    const outcome = await controller.createSession({
      title: 'Fix the bug',
      prompt: 'find the off-by-one',
      executorId: 'code-laptop-abc',
      projectLabel: 'demo',
      model: 'demo-model'
    })
    expect(outcome.kind).toBe('lost')
    if (outcome.kind !== 'lost') throw new Error('expected lost')
    expect(outcome.stage).toBe('session')
    expect(turnAttempted).toBe(false)
  })
})

describe('session controller: submitTurn retries once then gives up', () => {
  test('succeeds without retrying when the first attempt lands', async () => {
    let attempts = 0
    const controller = await connectedController({
      onCreateTurn: () => {
        attempts += 1
      }
    })
    const result = await controller.submitTurn({
      sessionId: 's1',
      prompt: 'continue',
      executorId: 'code-laptop-abc'
    })
    expect(result.turnWorkId).toEqual(expect.any(String))
    expect(attempts).toBe(1)
  })

  test('retries once at a fresh seq after a superseded write, then succeeds', async () => {
    let attempts = 0
    const controller = await connectedController({
      createTurnKindSequence: ['superseded', 'created'],
      onCreateTurn: () => {
        attempts += 1
      }
    })
    const result = await controller.submitTurn({
      sessionId: 's1',
      prompt: 'continue',
      executorId: 'code-laptop-abc'
    })
    expect(result.turnWorkId).toEqual(expect.any(String))
    expect(attempts).toBe(2)
  })

  test('gives up with a clear error after the retry also fails', async () => {
    let attempts = 0
    const controller = await connectedController({
      createTurnKind: 'superseded',
      onCreateTurn: () => {
        attempts += 1
      }
    })
    await expect(
      controller.submitTurn({
        sessionId: 's1',
        prompt: 'continue',
        executorId: 'code-laptop-abc'
      })
    ).rejects.toThrow(/did not land after 2 attempts/)
    expect(attempts).toBe(2)
  })
})

describe('session controller: resolveApproval maps every CodeGateResolution', () => {
  test('won maps to resolved', async () => {
    const controller = await connectedController({
      resolveApprovalGateResult: {
        kind: 'won',
        decision: { verdict: 'approved', decidedBy: { kind: 'peer', deviceRef: 'phone-1' } }
      }
    })
    const outcome = await controller.resolveApproval({
      turnWorkId: 'code/s1/turn/000000',
      gateId: 'approval/exec/1',
      approved: true,
      deviceRef: 'phone-1'
    })
    expect(outcome).toEqual({
      kind: 'resolved',
      decision: { verdict: 'approved', decidedBy: { kind: 'peer', deviceRef: 'phone-1' } }
    })
  })

  test('lost adopts the peer decision and reports it as decided elsewhere, not an error', async () => {
    const controller = await connectedController({
      resolveApprovalGateResult: {
        kind: 'lost',
        decision: { verdict: 'denied', decidedBy: { kind: 'executor', executorId: 'code-laptop-abc' } }
      }
    })
    const outcome = await controller.resolveApproval({
      turnWorkId: 'code/s1/turn/000000',
      gateId: 'approval/exec/1',
      approved: true,
      deviceRef: 'phone-1'
    })
    expect(outcome).toEqual({
      kind: 'decided-elsewhere',
      decision: { verdict: 'denied', decidedBy: { kind: 'executor', executorId: 'code-laptop-abc' } }
    })
  })

  test('unreachable is a real error the caller sees', async () => {
    const controller = await connectedController({
      resolveApprovalGateResult: {
        kind: 'unreachable',
        error: new Error('gate still undecided')
      }
    })
    await expect(
      controller.resolveApproval({
        turnWorkId: 'code/s1/turn/000000',
        gateId: 'approval/exec/1',
        approved: true,
        deviceRef: 'phone-1'
      })
    ).rejects.toThrow('gate still undecided')
  })
})

describe('session controller: listExecutors filters expired presence', () => {
  test('drops executors whose expiresAt has passed and sorts the rest', async () => {
    const controller = await connectedController(
      {
        listExecutorsResult: [
          executor('code-zeta', 20_000),
          executor('code-alpha', 50_000),
          executor('code-expired', 9_999)
        ]
      },
      { now: () => 10_000 }
    )
    const executors = await controller.listExecutors()
    expect(executors.map((item) => item.executorId)).toEqual([
      'code-alpha',
      'code-zeta'
    ])
  })
})

describe('session controller: watches stop on disconnect', () => {
  test('stops the underlying iterator and delivers no further values', async () => {
    const watch = controllableWatch<readonly CodeWorkRecord[]>()
    const controller = await connectedController({ watchSessionsSource: watch.iterable })
    const seen: (readonly CodeSessionSummary[])[] = []
    controller.watchSessions((sessions) => seen.push(sessions))
    await flush()

    await controller.disconnect()
    expect(watch.returnCalls()).toBe(1)

    watch.push([])
    await flush()
    expect(seen.length).toBe(0)
  })
})

// ---- test harness ----------------------------------------------------

interface StoreBehavior {
  readonly createSessionKind?: CodeCreateKind
  readonly createTurnKind?: CodeCreateKind
  readonly createTurnKindSequence?: readonly CodeCreateKind[]
  readonly resolveApprovalGateResult?: Awaited<ReturnType<CodeMeshStore['resolveApprovalGate']>>
  readonly watchSessionsSource?: AsyncIterable<readonly CodeWorkRecord[]>
  readonly listExecutorsResult?: readonly CodeExecutorRecord[]
  readonly onCreateTurn?: () => void
}

function executor(executorId: string, expiresAt: number): CodeExecutorRecord {
  return {
    executorId,
    capabilities: ['qvac.poc.code/v1'],
    expiresAt,
    recordedAt: 1
  } as CodeExecutorRecord
}

function fakeStore(behavior: StoreBehavior = {}): CodeMeshStore {
  let sessionCounter = 0
  let turnCounter = 0
  const turnKinds = behavior.createTurnKindSequence
    ? [...behavior.createTurnKindSequence]
    : undefined

  return {
    async createSession(input) {
      sessionCounter += 1
      return {
        workId: `code/${input.sessionId}`,
        kind: behavior.createSessionKind ?? 'created'
      }
    },
    async createTurn(input) {
      behavior.onCreateTurn?.()
      turnCounter += 1
      const kind = turnKinds ? turnKinds.shift() ?? 'created' : behavior.createTurnKind ?? 'created'
      return {
        turnWorkId: `code/${input.sessionId}/turn/${String(input.seq).padStart(6, '0')}`,
        kind
      }
    },
    async nextTurnSeq() {
      return turnCounter
    },
    async listSessions() {
      return []
    },
    async getWork() {
      return null
    },
    async listAvailableTurns() {
      return []
    },
    async listJournal() {
      return []
    },
    async listGates() {
      return []
    },
    async listOpenGates() {
      return []
    },
    async openClaimGate() {},
    async claimTurn() {
      throw new Error('claimTurn is not used by the phone client')
    },
    async openApprovalGate() {},
    async resolveApprovalGate() {
      if (behavior.resolveApprovalGateResult) return behavior.resolveApprovalGateResult
      throw new Error('resolveApprovalGateResult was not configured for this test')
    },
    async appendEntry() {
      throw new Error('the phone never appends a journal entry')
    },
    async requestCancel() {},
    async recordOutcome() {
      throw new Error('recordOutcome is not used by the phone client')
    },
    async advertiseExecutor() {
      throw new Error('advertiseExecutor is not used by the phone client')
    },
    async listExecutors() {
      return behavior.listExecutorsResult ?? []
    },
    watchSessions() {
      return behavior.watchSessionsSource ?? emptyWatch<readonly CodeWorkRecord[]>()
    },
    watchTurnJournal() {
      return emptyWatch()
    },
    watchOpenGates() {
      return emptyWatch<readonly CodeGateRecord[]>()
    }
  }
}

interface SyncBehavior {
  readonly deferReady?: boolean
  readonly readyError?: Error
  readonly deviceIdHex?: string
  readonly peerCount?: number
}

function fakeSync(behavior: SyncBehavior = {}) {
  const deviceIdHex = behavior.deviceIdHex ?? 'aa'
  let resolveReady = () => {}
  let closeCalls = 0
  let createCalls = 0
  const readyPromise = behavior.deferReady
    ? new Promise<void>((resolve) => {
        resolveReady = resolve
      })
    : Promise.resolve()

  // The fake only implements the narrow slice `MobileSyncRuntime` declares;
  // one cast at this boundary stands in for the rest of `SyncRuntime`'s
  // surface, which the controller never touches.
  function createSync(_options: object): MobileSyncRuntime {
    createCalls += 1
    return {
      async ready() {
        if (behavior.readyError) throw behavior.readyError
        await readyPromise
      },
      async close() {
        closeCalls += 1
      },
      // The generic profile client shape is never exercised in these
      // tests -- createStore is injected independently and never reads
      // this value -- so one cast at this boundary stands in for it rather
      // than reproducing SyncProfileClient's generics here.
      openProfile() {
        return {
          async apply() {
            return { revision: '0' }
          },
          async query() {
            throw new Error('fake profile query is not used in this test')
          },
          watch() {
            return emptyWatch()
          }
        }
      },
      mesh: {
        async identity() {
          return { deviceId: Buffer.from(deviceIdHex, 'hex') }
        },
        async status() {
          return {
            state: 'joined' as const,
            generation: '1',
            writable: true,
            peerCount: behavior.peerCount ?? 0,
            network: 'online' as const
          }
        },
        watchStatus() {
          return emptyWatch()
        }
      }
    } as unknown as MobileSyncRuntime
  }

  return {
    createSync,
    resolveReady: () => resolveReady(),
    deviceIdHex,
    closeCalls: () => closeCalls,
    createCalls: () => createCalls
  }
}

async function connectedController(
  behavior: StoreBehavior,
  controllerOverrides: { readonly now?: () => number } = {}
) {
  const controller = createSessionController({
    storagePath: '/tmp/qvac-code-mobile',
    createSync: fakeSync().createSync,
    createStore: () => fakeStore(behavior),
    ...controllerOverrides
  })
  await controller.connect()
  return controller
}

function controllableWatch<Value>() {
  let pending: ((value: IteratorResult<Value>) => void) | null = null
  const queue: Value[] = []
  let returnCalls = 0
  const iterable: AsyncIterable<Value> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          const queued = queue.shift()
          if (queued !== undefined) return { done: false, value: queued }
          return new Promise<IteratorResult<Value>>((resolve) => {
            pending = resolve
          })
        },
        async return() {
          returnCalls += 1
          return { done: true as const, value: undefined as unknown as Value }
        }
      }
    }
  }
  function push(value: Value) {
    if (pending) {
      const resolve = pending
      pending = null
      resolve({ done: false, value })
      return
    }
    queue.push(value)
  }
  return { iterable, push, returnCalls: () => returnCalls }
}

function emptyWatch<Value>(): AsyncIterable<Value> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          return { done: true as const, value: undefined as unknown as Value }
        }
      }
    }
  }
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
