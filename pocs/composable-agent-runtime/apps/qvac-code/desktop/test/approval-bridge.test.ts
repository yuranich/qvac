import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { AssistantFacade } from '@qvac/assistant'
import type { HarnessApprovalDecision, HarnessApprovalRequest } from '@qvac/harness'
import {
  formatApprovalDecision,
  parseApprovalDecision,
  type CodeApprovalDecision
} from '@qvac-poc/qvac-code-shared'
import type { CodeGateRecord, CodeMeshStore } from '@qvac-poc/qvac-code-shared/store'
import { createApprovalBridge, type ApprovalPrompt } from '../lib/approval-bridge.ts'

const EXECUTOR_ID = 'code-host-abc123456789'

function notImplemented(name: string) {
  return () => {
    throw new Error(`${name} is not implemented in this fake`)
  }
}

function turnWorkIdFor(sessionId: string, seq: number) {
  return `code/${sessionId}/turn/${String(seq).padStart(6, '0')}`
}

interface FakeGate {
  readonly gateId: string
  readonly kind: string
  decision: string | null
  readonly recordedAt: number
  readonly workId: string
}

function createFakeStore(
  options: {
    readonly resolveApprovalGate?: CodeMeshStore['resolveApprovalGate']
    readonly outcomeStatusByWorkId?: Readonly<Record<string, string>>
  } = {}
) {
  const gatesByWorkId = new Map<string, FakeGate[]>()
  const appended: Parameters<CodeMeshStore['appendEntry']>[0][] = []
  const openedGates: Parameters<CodeMeshStore['openApprovalGate']>[0][] = []
  const resolveCalls: Parameters<CodeMeshStore['resolveApprovalGate']>[0][] = []

  function gateList(workId: string) {
    const list = gatesByWorkId.get(workId)
    if (list) return list
    const created: FakeGate[] = []
    gatesByWorkId.set(workId, created)
    return created
  }

  const defaultResolve: CodeMeshStore['resolveApprovalGate'] = async (input) => {
    const workId = turnWorkIdFor(input.sessionId, input.seq)
    const gate = gateList(workId).find((candidate) => candidate.gateId === input.gateId)
    if (gate == null) return { kind: 'unreachable', error: new Error(`gate ${input.gateId} was never opened`) }
    if (gate.decision == null) {
      gate.decision = formatApprovalDecision(input.decision)
      return { kind: 'won', decision: input.decision }
    }
    const decided = parseApprovalDecision(gate.decision)
    if (decided == null) return { kind: 'unreachable', error: new Error('stored decision is corrupt') }
    return { kind: 'lost', decision: decided }
  }

  const store: CodeMeshStore = {
    createSession: notImplemented('createSession'),
    createTurn: notImplemented('createTurn'),
    nextTurnSeq: notImplemented('nextTurnSeq'),
    listSessions: notImplemented('listSessions'),
    async getWork(workId) {
      const status = options.outcomeStatusByWorkId?.[workId]
      if (status == null) return null
      return {
        workId,
        payload: Buffer.alloc(0),
        payloadFormat: 'application/vnd.qvac.poc.code-turn+json',
        payloadVersion: 1,
        createdAt: 0,
        outcomeStatus: status as 'completed' | 'failed' | 'cancelled'
      }
    },
    listAvailableTurns: notImplemented('listAvailableTurns'),
    listJournal: notImplemented('listJournal'),
    async listGates(turnWorkId) {
      return gateList(turnWorkId) as unknown as CodeGateRecord[]
    },
    async listOpenGates() {
      const open: CodeGateRecord[] = []
      for (const list of gatesByWorkId.values()) {
        for (const gate of list) {
          if (gate.decision == null) open.push(gate as unknown as CodeGateRecord)
        }
      }
      return open
    },
    openClaimGate: notImplemented('openClaimGate'),
    claimTurn: notImplemented('claimTurn'),
    async openApprovalGate(input) {
      openedGates.push(input)
      const workId = turnWorkIdFor(input.sessionId, input.seq)
      gateList(workId).push({
        gateId: input.gateId,
        kind: 'qvac.poc.code.approval/v1',
        decision: null,
        recordedAt: 0,
        workId
      })
    },
    async resolveApprovalGate(input) {
      resolveCalls.push(input)
      return (options.resolveApprovalGate ?? defaultResolve)(input)
    },
    async appendEntry(input) {
      appended.push(input)
    },
    requestCancel: notImplemented('requestCancel'),
    recordOutcome: notImplemented('recordOutcome'),
    advertiseExecutor: notImplemented('advertiseExecutor'),
    listExecutors: notImplemented('listExecutors'),
    watchSessions: notImplemented('watchSessions'),
    watchTurnJournal: notImplemented('watchTurnJournal'),
    watchOpenGates: notImplemented('watchOpenGates')
  }

  return { store, appended, openedGates, resolveCalls }
}

function createRequestQueue() {
  const items: HarnessApprovalRequest[] = []
  let waiting: ((result: IteratorResult<HarnessApprovalRequest>) => void) | null = null
  let ended = false

  function push(request: HarnessApprovalRequest) {
    if (waiting) {
      const resolve = waiting
      waiting = null
      resolve({ value: request, done: false })
    } else {
      items.push(request)
    }
  }

  function end() {
    ended = true
    if (waiting) {
      const resolve = waiting
      waiting = null
      resolve({ value: undefined, done: true })
    }
  }

  const iterable: AsyncIterable<HarnessApprovalRequest> = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          const next = items.shift()
          if (next) return Promise.resolve({ value: next, done: false })
          if (ended) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve) => {
            waiting = resolve
          })
        }
      }
    }
  }

  return { push, end, iterable }
}

function createFakeApprovals() {
  const queue = createRequestQueue()
  const resolveCalls: HarnessApprovalDecision[] = []
  const approvals: Pick<AssistantFacade, 'approvals'> = {
    approvals: {
      pending() {
        return queue.iterable
      },
      async resolve(decision) {
        resolveCalls.push(decision)
      }
    }
  }
  return { ...approvals, push: queue.push, end: queue.end, resolveCalls }
}

function request(overrides: Partial<HarnessApprovalRequest> = {}): HarnessApprovalRequest {
  return {
    approvalId: 'approval-1',
    agentId: 'code/session-1',
    runId: 'code/session-1/turn/000000',
    operationId: 'op-1',
    callId: 'call-1',
    name: 'write',
    args: { filePath: 'src/a.ts', content: 'x'.repeat(500) },
    ...overrides
  }
}

function neverResolves(): Promise<boolean> {
  return new Promise(() => {})
}

function resolvedWith(value: boolean): (prompt: ApprovalPrompt, signal: AbortSignal) => Promise<boolean> {
  return async () => value
}

let originalConsoleError: typeof console.error
let consoleErrors: string[]

beforeEach(function () {
  originalConsoleError = console.error
  consoleErrors = []
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(' '))
  }
})

afterEach(function () {
  console.error = originalConsoleError
})

async function waitUntil(condition: () => boolean, timeoutMs = 2_000) {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function waitUntilGateOpen(store: CodeMeshStore, turnWorkId: string, timeoutMs = 2_000) {
  const start = Date.now()
  while (true) {
    const gates = await store.listGates(turnWorkId)
    if (gates.length > 0) return
    if (Date.now() - start > timeoutMs) throw new Error('waitUntilGateOpen timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('createApprovalBridge', function () {
  test('appends the approval-requested entry before opening the gate', async function () {
    const { store, appended, openedGates } = createFakeStore()
    const approvals = createFakeApprovals()
    const bridge = createApprovalBridge({
      store,
      assistant: approvals,
      executorId: EXECUTOR_ID,
      now: () => 0,
      approvalDeadlineMs: 50_000,
      promptLocally: resolvedWith(true)
    })

    const turnWorkId = turnWorkIdFor('session-1', 0)
    const track = bridge.track({ turnWorkId, sessionId: 'session-1', seq: 0, runId: turnWorkId })
    void bridge.start(new AbortController().signal)
    approvals.push(request({ runId: turnWorkId }))
    await waitUntil(() => appended.length > 0 && openedGates.length > 0)

    expect(appended[0]?.body.type).toBe('approval-requested')
    expect(openedGates).toHaveLength(1)
    track.release()
  })

  test('an untracked runId fails closed with no gate written', async function () {
    const { store, appended, openedGates } = createFakeStore()
    const approvals = createFakeApprovals()
    const bridge = createApprovalBridge({
      store,
      assistant: approvals,
      executorId: EXECUTOR_ID,
      now: () => 0,
      approvalDeadlineMs: 50_000,
      promptLocally: resolvedWith(true)
    })

    void bridge.start(new AbortController().signal)
    approvals.push(request({ runId: 'code/unknown-session/turn/000000' }))
    await waitUntil(() => approvals.resolveCalls.length > 0)

    expect(approvals.resolveCalls).toEqual([{ approvalId: 'approval-1', approved: false }])
    expect(appended).toHaveLength(0)
    expect(openedGates).toHaveLength(0)
  })

  test('the local answer wins and writes the gate as approved/executor', async function () {
    const { store, resolveCalls } = createFakeStore()
    const approvals = createFakeApprovals()
    const bridge = createApprovalBridge({
      store,
      assistant: approvals,
      executorId: EXECUTOR_ID,
      now: () => 0,
      approvalDeadlineMs: 50_000,
      promptLocally: resolvedWith(true)
    })

    const turnWorkId = turnWorkIdFor('session-1', 0)
    const track = bridge.track({ turnWorkId, sessionId: 'session-1', seq: 0, runId: turnWorkId })
    void bridge.start(new AbortController().signal)
    approvals.push(request({ runId: turnWorkId }))
    await waitUntil(() => approvals.resolveCalls.length > 0)

    expect(resolveCalls).toHaveLength(1)
    expect(resolveCalls[0]?.decision).toEqual({
      verdict: 'approved',
      decidedBy: { kind: 'executor', executorId: EXECUTOR_ID }
    })
    expect(approvals.resolveCalls).toEqual([{ approvalId: 'approval-1', approved: true }])
    track.release()
  })

  test('a lost resolution adopts the peer decision verbatim', async function () {
    const peerDecision: CodeApprovalDecision = {
      verdict: 'denied',
      decidedBy: { kind: 'peer', deviceRef: 'device-xyz' }
    }
    const { store } = createFakeStore({
      resolveApprovalGate: async () => ({ kind: 'lost', decision: peerDecision })
    })
    const approvals = createFakeApprovals()
    const resolved: { readonly prompt: ApprovalPrompt; readonly decision: CodeApprovalDecision }[] = []
    const bridge = createApprovalBridge({
      store,
      assistant: approvals,
      executorId: EXECUTOR_ID,
      now: () => 0,
      approvalDeadlineMs: 50_000,
      promptLocally: resolvedWith(true),
      onResolved: (input) => resolved.push(input)
    })

    const turnWorkId = turnWorkIdFor('session-1', 0)
    const track = bridge.track({ turnWorkId, sessionId: 'session-1', seq: 0, runId: turnWorkId })
    void bridge.start(new AbortController().signal)
    approvals.push(request({ runId: turnWorkId }))
    await waitUntil(() => resolved.length > 0)

    expect(resolved[0]?.decision).toEqual(peerDecision)
    // The peer denied it -- the harness must be told no, even though our own
    // local answer was yes.
    expect(approvals.resolveCalls).toEqual([{ approvalId: 'approval-1', approved: false }])
    track.release()
  })

  test('an unreachable resolution honours the local verdict and reports the divergence', async function () {
    const { store } = createFakeStore({
      resolveApprovalGate: async () => ({ kind: 'unreachable', error: new Error('no quorum') })
    })
    const approvals = createFakeApprovals()
    const bridge = createApprovalBridge({
      store,
      assistant: approvals,
      executorId: EXECUTOR_ID,
      now: () => 0,
      approvalDeadlineMs: 50_000,
      promptLocally: resolvedWith(true)
    })

    const turnWorkId = turnWorkIdFor('session-1', 0)
    const track = bridge.track({ turnWorkId, sessionId: 'session-1', seq: 0, runId: turnWorkId })
    void bridge.start(new AbortController().signal)
    approvals.push(request({ runId: turnWorkId }))
    await waitUntil(() => approvals.resolveCalls.length > 0)

    expect(approvals.resolveCalls).toEqual([{ approvalId: 'approval-1', approved: true }])
    expect(consoleErrors.some((line) => line.includes('unreachable'))).toBe(true)
    track.release()
  })

  test('the deadline writes unanswered/policy/deadline and fails closed', async function () {
    const { store, resolveCalls } = createFakeStore()
    const approvals = createFakeApprovals()
    const bridge = createApprovalBridge({
      store,
      assistant: approvals,
      executorId: EXECUTOR_ID,
      now: () => 0,
      approvalDeadlineMs: 20,
      promptLocally: neverResolves
    })

    const turnWorkId = turnWorkIdFor('session-1', 0)
    const track = bridge.track({ turnWorkId, sessionId: 'session-1', seq: 0, runId: turnWorkId })
    void bridge.start(new AbortController().signal)
    approvals.push(request({ runId: turnWorkId }))
    await waitUntil(() => approvals.resolveCalls.length > 0)

    expect(resolveCalls[0]?.decision).toEqual({
      verdict: 'unanswered',
      decidedBy: { kind: 'policy', rule: 'deadline' }
    })
    expect(approvals.resolveCalls).toEqual([{ approvalId: 'approval-1', approved: false }])
    track.release()
  })

  test('closeTurn resolves outstanding gates as withdrawn/policy/run-ended', async function () {
    const { store, resolveCalls } = createFakeStore()
    const approvals = createFakeApprovals()
    const bridge = createApprovalBridge({
      store,
      assistant: approvals,
      executorId: EXECUTOR_ID,
      now: () => 0,
      approvalDeadlineMs: 50_000,
      // Never answers locally and the mesh never independently decides --
      // the gate can only be resolved by closeTurn below.
      promptLocally: neverResolves
    })

    const turnWorkId = turnWorkIdFor('session-1', 0)
    const track = bridge.track({ turnWorkId, sessionId: 'session-1', seq: 0, runId: turnWorkId })
    void bridge.start(new AbortController().signal)
    approvals.push(request({ runId: turnWorkId }))
    await waitUntilGateOpen(store, turnWorkId)

    await bridge.closeTurn(turnWorkId)
    await waitUntil(() => approvals.resolveCalls.length > 0)

    expect(approvals.resolveCalls).toEqual([{ approvalId: 'approval-1', approved: false }])
    expect(resolveCalls.some((call) => call.decision.verdict === 'withdrawn')).toBe(true)
    track.release()
  })

  test('reconcile clears gates on turns that already have an outcome', async function () {
    const turnWorkId = turnWorkIdFor('session-1', 0)
    const { store, resolveCalls } = createFakeStore({
      outcomeStatusByWorkId: { [turnWorkId]: 'completed' }
    })
    // Seed an open gate directly, as if a peer left it behind before the
    // turn finished (no live handleRequest is tracking it).
    await store.openApprovalGate({ sessionId: 'session-1', seq: 0, gateId: 'approval/other-executor/1' })

    const approvals = createFakeApprovals()
    const bridge = createApprovalBridge({
      store,
      assistant: approvals,
      executorId: EXECUTOR_ID,
      now: () => 0,
      approvalDeadlineMs: 50_000,
      promptLocally: neverResolves
    })

    await bridge.reconcile()

    expect(resolveCalls).toHaveLength(1)
    expect(resolveCalls[0]?.decision).toEqual({
      verdict: 'withdrawn',
      decidedBy: { kind: 'policy', rule: 'run-ended' }
    })
  })

  test('a withdrawn verdict resolves the harness with approved:false while the recorded decision still reads withdrawn', async function () {
    const { store, appended } = createFakeStore()
    const approvals = createFakeApprovals()
    const bridge = createApprovalBridge({
      store,
      assistant: approvals,
      executorId: EXECUTOR_ID,
      now: () => 0,
      approvalDeadlineMs: 50_000,
      promptLocally: neverResolves
    })

    const turnWorkId = turnWorkIdFor('session-1', 0)
    const track = bridge.track({ turnWorkId, sessionId: 'session-1', seq: 0, runId: turnWorkId })
    void bridge.start(new AbortController().signal)
    approvals.push(request({ runId: turnWorkId }))
    await waitUntilGateOpen(store, turnWorkId)

    await bridge.closeTurn(turnWorkId)
    await waitUntil(() => approvals.resolveCalls.length > 0)

    expect(approvals.resolveCalls).toEqual([{ approvalId: 'approval-1', approved: false }])
    const resolvedEntry = appended.find((entry) => entry.body.type === 'approval-resolved')
    expect(resolvedEntry).toBeDefined()
    if (resolvedEntry != null && resolvedEntry.body.type === 'approval-resolved') {
      expect(resolvedEntry.body.decision.verdict).toBe('withdrawn')
    }
    track.release()
  })
})
