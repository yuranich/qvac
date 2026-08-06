import {
  createSync as createMobileSyncRuntime,
  type CreateSyncOptions,
  type SyncRuntime
} from '@qvac/sync/react-native'
import { durableWorkProfile } from '@qvac/sync/profiles/durable-work'
import {
  createCodeMeshStore,
  type CodeCreateKind,
  type CodeExecutorRecord,
  type CodeGateRecord,
  type CodeMeshStore
} from '@qvac-poc/qvac-code-shared/store'
import {
  createSessionId,
  parseCodeWorkId,
  projectSessionList,
  type CodeApprovalDecision,
  type CodeSessionSummary,
  type CodeTurnView
} from '@qvac-poc/qvac-code-shared'
import { createTranscriptViewModel } from './transcript-view-model.ts'
import { parsePairingUri } from './pairing-uri.ts'
import type { BootstrapNode } from './dev-bootstrap.ts'

const CANCEL_REASON = 'Cancelled from the mobile app'
// One retry: the first attempt races another writer for the next sequence
// number, and a lost race is expected under concurrent submission. A second
// loss means something is wrong beyond an ordinary race, so this gives up
// with a clear error instead of retrying forever.
const MAX_SUBMIT_ATTEMPTS = 2

export type SessionControllerState =
  | 'idle'
  | 'connecting'
  | 'awaiting-approval'
  | 'ready'
  | 'offline'
  | 'error'

export interface SessionControllerSnapshot {
  readonly state: SessionControllerState
  readonly error: string | null
  readonly deviceCount: number
}

// The narrow slice of SyncRuntime this controller actually drives, so a test
// double never has to implement the full mesh/runtime/profile surface.
export type MobileSyncRuntime = Pick<SyncRuntime, 'ready' | 'close' | 'openProfile'> & {
  readonly mesh: Pick<SyncRuntime['mesh'], 'identity' | 'status' | 'watchStatus'>
}

export interface SessionControllerOptions {
  readonly storagePath: string
  readonly bootstrap?: readonly BootstrapNode[]
  readonly onState?: (snapshot: SessionControllerSnapshot) => void
  readonly createSync?: (options: object) => MobileSyncRuntime
  readonly createStore?: (state: object) => CodeMeshStore
  readonly hasPersistentPairing?: () => boolean
  readonly entropy?: () => string
  readonly now?: () => number
}

export interface CreateSessionInput {
  readonly title: string
  readonly prompt: string
  readonly executorId: string
  // Required by CodeSessionPayload but not knowable from executor presence
  // alone (SyncDurableWorkExecutor carries only executorId/capabilities/
  // expiresAt/recordedAt -- no project or model field). The composer collects
  // these from the user rather than inventing a value.
  readonly projectLabel: string
  readonly model: string
}

export interface SubmitTurnInput {
  readonly sessionId: string
  readonly prompt: string
  readonly executorId: string
}

export interface ResolveApprovalInput {
  readonly turnWorkId: string
  readonly gateId: string
  readonly approved: boolean
  readonly deviceRef: string
}

export type SessionCreateOutcome =
  | { readonly kind: 'created'; readonly sessionId: string; readonly turnWorkId: string }
  | {
      readonly kind: 'lost'
      readonly stage: 'session'
      readonly sessionId: string
      readonly reason: CodeCreateKind
    }
  | {
      readonly kind: 'lost'
      readonly stage: 'turn'
      readonly sessionId: string
      readonly turnWorkId: string
      readonly reason: CodeCreateKind
    }

export type ResolveApprovalOutcome =
  | { readonly kind: 'resolved'; readonly decision: CodeApprovalDecision }
  | { readonly kind: 'decided-elsewhere'; readonly decision: CodeApprovalDecision }

export interface SessionController {
  snapshot(): SessionControllerSnapshot
  connect(pairingUri?: string): Promise<void>
  reconnect(): Promise<void>
  disconnect(): Promise<void>
  close(): Promise<void>
  listExecutors(): Promise<readonly CodeExecutorRecord[]>
  createSession(input: CreateSessionInput): Promise<SessionCreateOutcome>
  submitTurn(input: SubmitTurnInput): Promise<{ readonly turnWorkId: string }>
  cancelTurn(turnWorkId: string): Promise<void>
  // A data-layer write, not a UI state source: it performs one resolve-gate
  // attempt and reports the honest outcome of that one call. Its return
  // value must never be painted into the approval sheet directly -- a local
  // 'resolved' here can still lose the mesh-wide merge, which is exactly
  // what approval-controller.ts's "render only from watch frames" rule
  // guards against. App.tsx does not call this method for that reason; it
  // goes through approval-controller.ts instead. This method exists for the
  // same reason `store.resolveApprovalGate` does -- something needs to be
  // able to attempt the write at all -- and is covered directly by
  // session-controller.test.ts's three-way CodeGateResolution mapping.
  resolveApproval(input: ResolveApprovalInput): Promise<ResolveApprovalOutcome>
  watchSessions(
    listener: (sessions: readonly CodeSessionSummary[]) => void
  ): () => void
  watchTurn(turnWorkId: string, listener: (view: CodeTurnView) => void): () => void
  watchOpenGates(listener: (gates: readonly CodeGateRecord[]) => void): () => void
  // The local device's own identity, hex-encoded. Exposed because
  // `resolveApproval` and `createSession` both need a caller-known device
  // reference and nothing else in this module can source one.
  deviceRef(): string | null
  // Exposes the live store so approval-controller.ts -- which correlates
  // open gates against turn/journal state the session controller itself
  // never needs -- can be composed from the same connection without this
  // controller growing gate-detail-reading responsibilities of its own.
  store(): CodeMeshStore | null
}

export function createSessionController(
  options: SessionControllerOptions
): SessionController {
  let current: SessionControllerSnapshot = { state: 'idle', error: null, deviceCount: 0 }
  let client: MobileSyncRuntime | null = null
  let activeStore: CodeMeshStore | null = null
  let localDeviceRef: string | null = null
  let generation = 0
  const stopWatches = new Set<() => void>()
  const now = options.now ?? Date.now
  const entropy = options.entropy ?? defaultEntropy
  const createClient = options.createSync ?? defaultCreateSync
  const createStoreFactory = options.createStore ?? defaultCreateStore

  function snapshot() {
    return current
  }

  async function connect(pairingUri?: string) {
    // Claim this attempt's generation *before* awaiting teardown. Reading it
    // back afterwards would let two overlapping connects both observe the
    // higher number and both pass every fence below -- installing two
    // runtimes on one storagePath and leaking the superseded one.
    const currentGeneration = ++generation
    await teardown(currentGeneration)
    if (currentGeneration !== generation) return
    const invite = pairingUri ? parsePairingUri(pairingUri, now()).invite : undefined
    update({ state: 'connecting', error: null, deviceCount: 0 })
    if (invite) {
      // A first-pairing client's ready() does not resolve until the desktop
      // approves the pairing request, so the wait needs its own state rather
      // than leaving 'connecting' -- an unexplained spinner -- on screen.
      update({ state: 'awaiting-approval', error: null, deviceCount: 0 })
    }

    const started = createClient({
      storagePath: options.storagePath,
      ...(options.bootstrap ? { bootstrap: options.bootstrap } : {}),
      ...(invite ? { pairingInvite: decodeBase64Url(invite) } : {})
    })
    try {
      await started.ready()
      if (currentGeneration !== generation) {
        await started.close().catch(logAbandonedClose)
        return
      }
      const identity = await started.mesh.identity()
      const openedStore = createStoreFactory({
        work: started.openProfile(durableWorkProfile)
      })
      const status = await started.mesh.status()
      if (currentGeneration !== generation) {
        await started.close().catch(logAbandonedClose)
        return
      }
      client = started
      activeStore = openedStore
      localDeviceRef = identity.deviceId.toString('hex')
      watchMeshStatus(started, currentGeneration)
      update({ state: 'ready', error: null, deviceCount: status.peerCount })
    } catch (error) {
      await started.close().catch(logAbandonedClose)
      if (currentGeneration === generation) {
        update({ state: 'error', error: errorMessage(error), deviceCount: 0 })
      }
      throw error
    }
  }

  async function reconnect() {
    if (!(options.hasPersistentPairing?.() ?? false)) {
      update({ state: 'idle', error: null, deviceCount: 0 })
      return
    }
    await connect()
  }

  async function disconnect() {
    await teardown(++generation)
    update({ state: 'offline', error: null, deviceCount: 0 })
  }

  async function close() {
    // Same teardown as disconnect(), but the caller is discarding this
    // controller entirely (component unmount) rather than going offline
    // with the expectation of a later reconnect(), so there is no snapshot
    // left for anyone to observe.
    await teardown(++generation)
  }

  async function listExecutors() {
    const meshStore = requireStore()
    const executors = await meshStore.listExecutors()
    const cutoff = now()
    return executors
      .filter((executor) => executor.expiresAt > cutoff)
      .sort((left, right) => left.executorId.localeCompare(right.executorId))
  }

  async function createSession(input: CreateSessionInput): Promise<SessionCreateOutcome> {
    const meshStore = requireStore()
    const createdBy = requireDeviceRef()
    const sessionId = createSessionId(entropy())
    const session = await meshStore.createSession({
      sessionId,
      title: input.title,
      projectLabel: input.projectLabel,
      model: input.model,
      createdBy
    })
    if (session.kind !== 'created') {
      return { kind: 'lost', stage: 'session', sessionId, reason: session.kind }
    }
    const turn = await meshStore.createTurn({
      sessionId,
      seq: 0,
      prompt: input.prompt,
      requestedBy: createdBy,
      target: input.executorId
    })
    if (turn.kind !== 'created') {
      return {
        kind: 'lost',
        stage: 'turn',
        sessionId,
        turnWorkId: turn.turnWorkId,
        reason: turn.kind
      }
    }
    return { kind: 'created', sessionId, turnWorkId: turn.turnWorkId }
  }

  async function submitTurn(input: SubmitTurnInput) {
    const meshStore = requireStore()
    const requestedBy = requireDeviceRef()
    let lastKind: CodeCreateKind = 'unconfirmed'
    for (let attempt = 0; attempt < MAX_SUBMIT_ATTEMPTS; attempt++) {
      const seq = await meshStore.nextTurnSeq(input.sessionId)
      const result = await meshStore.createTurn({
        sessionId: input.sessionId,
        seq,
        prompt: input.prompt,
        requestedBy,
        target: input.executorId
      })
      if (result.kind === 'created') return { turnWorkId: result.turnWorkId }
      lastKind = result.kind
    }
    throw new Error(
      `Submitting the turn for session ${input.sessionId} did not land after ${MAX_SUBMIT_ATTEMPTS} attempts (${lastKind})`
    )
  }

  async function cancelTurn(turnWorkId: string) {
    await requireStore().requestCancel({ workId: turnWorkId, reason: CANCEL_REASON })
  }

  async function resolveApproval(input: ResolveApprovalInput): Promise<ResolveApprovalOutcome> {
    const meshStore = requireStore()
    const parsed = parseCodeWorkId(input.turnWorkId)
    if (parsed == null || parsed.kind !== 'turn') {
      throw new Error(`Cannot resolve approval for malformed turn work id: ${input.turnWorkId}`)
    }
    const decision: CodeApprovalDecision = {
      verdict: input.approved ? 'approved' : 'denied',
      decidedBy: { kind: 'peer', deviceRef: input.deviceRef }
    }
    const outcome = await meshStore.resolveApprovalGate({
      sessionId: parsed.sessionId,
      seq: parsed.seq,
      gateId: input.gateId,
      decision
    })
    if (outcome.kind === 'unreachable') throw outcome.error
    if (outcome.kind === 'won') return { kind: 'resolved', decision: outcome.decision }
    // The gate now holds a peer's decision, not ours -- that is a normal
    // merge outcome, not a failure, so it is reported distinctly rather than
    // thrown.
    return { kind: 'decided-elsewhere', decision: outcome.decision }
  }

  function watchSessions(listener: (sessions: readonly CodeSessionSummary[]) => void) {
    const meshStore = requireStore()
    return registerWatch(meshStore.watchSessions(), (works) => {
      listener(projectSessionList(works))
    })
  }

  function watchTurn(turnWorkId: string, listener: (view: CodeTurnView) => void) {
    const meshStore = requireStore()
    const viewModel = createTranscriptViewModel()
    // The journal watch is used only as a mesh-wide wake-up signal -- see
    // store.ts's watchQuery -- because a full CodeTurnView needs the work
    // row and gates too, not only the journal.
    return registerWatch(meshStore.watchTurnJournal(turnWorkId), async () => {
      const [work, entries, gates] = await Promise.all([
        meshStore.getWork(turnWorkId),
        meshStore.listJournal(turnWorkId),
        meshStore.listGates(turnWorkId)
      ])
      if (!work) return
      listener(viewModel.apply(entries, gates, work))
    })
  }

  function watchOpenGates(listener: (gates: readonly CodeGateRecord[]) => void) {
    const meshStore = requireStore()
    return registerWatch(meshStore.watchOpenGates(), listener)
  }

  function deviceRef() {
    return localDeviceRef
  }

  function store() {
    return activeStore
  }

  function watchMeshStatus(runtime: MobileSyncRuntime, watchGeneration: number) {
    registerWatch(runtime.mesh.watchStatus(), (status) => {
      if (watchGeneration !== generation) return
      update({ ...current, deviceCount: status.peerCount })
    })
  }

  function registerWatch<Value>(
    source: AsyncIterable<Value>,
    onValue: (value: Value) => void | Promise<void>
  ) {
    const iterator = source[Symbol.asyncIterator]()
    let stopped = false

    async function consume() {
      while (!stopped) {
        const next = await iterator.next()
        if (stopped || next.done) return
        await onValue(next.value)
      }
    }

    void consume().catch((error) => {
      if (stopped) return
      update({ ...current, state: 'error', error: errorMessage(error) })
    })

    function stop() {
      if (stopped) return
      stopped = true
      stopWatches.delete(stop)
      // A pending HRPC `next()` is not cancellable by `return()` -- the
      // in-flight call still settles, but `stopped` keeps its value from
      // ever reaching `onValue`. `return()` is still called so a fresh
      // iterator is not left dangling once that call does settle. It runs
      // the generator's own cleanup, which can reject (the underlying
      // stream is being destroyed), so the rejection is logged rather than
      // left to surface as an unhandled one.
      void iterator.return?.().catch((error: unknown) => {
        console.error('[qvac-code-mobile] releasing a watch iterator failed', error)
      })
    }

    stopWatches.add(stop)
    return stop
  }

  async function teardown(nextGeneration: number) {
    generation = nextGeneration
    stopAllWatches()
    activeStore = null
    localDeviceRef = null
    const closing = client
    client = null
    if (closing) await closing.close()
  }

  function stopAllWatches() {
    for (const stop of [...stopWatches]) stop()
  }

  function update(next: SessionControllerSnapshot) {
    current = next
    options.onState?.(next)
  }

  function requireStore() {
    if (!activeStore || current.state !== 'ready') {
      throw new Error('Session controller is not ready')
    }
    return activeStore
  }

  function requireDeviceRef() {
    if (!localDeviceRef) throw new Error('Session controller is not connected')
    return localDeviceRef
  }

  return {
    snapshot,
    connect,
    reconnect,
    disconnect,
    close,
    listExecutors,
    createSession,
    submitTurn,
    cancelTurn,
    resolveApproval,
    watchSessions,
    watchTurn,
    watchOpenGates,
    deviceRef,
    store
  }
}

// The injected factory type is deliberately widened to `object` (see
// SessionControllerOptions) so a test double never has to satisfy
// CreateSyncOptions's full shape. The default wiring bridges back to the
// real type here, once, the same pattern task-controller.ts uses for its own
// injectable repository factory.
function defaultCreateSync(syncOptions: object) {
  return createMobileSyncRuntime(syncOptions as CreateSyncOptions)
}

function defaultCreateStore(state: object) {
  return createCodeMeshStore(state as Parameters<typeof createCodeMeshStore>[0])
}

function defaultEntropy() {
  const random = Math.floor(Math.random() * 0x1_0000_0000).toString(36)
  return `${Date.now().toString(36)}-${random}`
}

/**
 * Hermes has no global Buffer, and the shim applications polyfill it with
 * does not implement the 'base64url' encoding Node added in v15. Translate
 * to plain base64 first so an invite decodes the same on every host.
 */
function decodeBase64Url(value: string) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const remainder = padded.length % 4
  return Buffer.from(
    remainder === 0 ? padded : padded.padEnd(padded.length + (4 - remainder), '='),
    'base64'
  )
}

/**
 * A runtime this connect is abandoning -- superseded by a newer generation, or
 * built before a failure. Its close is best-effort, but a close that fails
 * means the runtime is still holding the storage path, which is exactly the
 * thing worth knowing about later. Logged, never dropped.
 */
function logAbandonedClose(error: unknown) {
  console.error('[qvac-code-mobile] closing an abandoned sync runtime failed', error)
}

function errorMessage(error: unknown) {
  if (!(error instanceof Error)) return String(error)
  // A component start failure wraps the reason it failed. Showing only the
  // outer message leaves "sync failed to start" with no way to find out why.
  const causes: string[] = []
  let cause: unknown = error.cause
  while (cause instanceof Error && causes.length < 4) {
    causes.push(cause.message)
    cause = cause.cause
  }
  if (causes.length > 0) console.error('[qvac-code-mobile]', error.message, causes)
  return causes.length > 0 ? `${error.message}: ${causes.join(': ')}` : error.message
}
