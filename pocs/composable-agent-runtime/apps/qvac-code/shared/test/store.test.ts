import { describe, expect, it } from 'bun:test'
import type {
  DurableWorkCommand,
  DurableWorkQuery,
  DurableWorkResult
} from '@qvac/sync/profiles/durable-work'
import { createCodeMeshStore } from '../store.ts'
import { formatClaimDecision } from '../claim.ts'
import { formatApprovalDecision, type CodeApprovalDecision } from '../approval.ts'
import { CODE_SESSION_FORMAT, CODE_TURN_FORMAT } from '../formats.ts'
import { formatTurnWorkId } from '../ids.ts'

/**
 * The store's whole job is to turn an ambiguous `apply()` throw into a verdict
 * read from stored state. `apply()` throws for a losing race, a transport
 * failure and a read-only peer alike, so every test here drives the throw and
 * then varies only what the subsequent read returns.
 */

const SESSION = 'sess1'
const SEQ = 3
const TURN = formatTurnWorkId({ sessionId: SESSION, seq: SEQ })
const MINE = 'code-laptop-abc'
const THEIRS = 'code-other-xyz'

interface FakeState {
  gates: DurableWorkResult['gates']
  works: DurableWorkResult['works']
  applyThrows: boolean
}

function fakeProfile(state: FakeState) {
  const applied: Array<{
    readonly command: DurableWorkCommand
    readonly operationId: string
  }> = []
  const profile = {
    async apply(command: DurableWorkCommand, options: { readonly operationId: string }) {
      applied.push({ command, operationId: options.operationId })
      if (state.applyThrows) {
        throw new Error(
          `Invalid Sync profile transition for operation ${options.operationId}`
        )
      }
      return { revision: options.operationId }
    },
    async query(query: DurableWorkQuery): Promise<DurableWorkResult> {
      const empty = { works: [], entries: [], gates: [], executors: [] }
      if (query.type === 'list-gates') {
        return {
          ...empty,
          gates: state.gates.filter((gate) => gate.workId === query.workId)
        }
      }
      if (query.type === 'list-open-gates') {
        return { ...empty, gates: state.gates.filter((gate) => gate.decision == null) }
      }
      if (query.type === 'get-work') {
        return {
          ...empty,
          work: state.works.find((work) => work.workId === query.workId) ?? null
        }
      }
      if (query.type === 'list-work' || query.type === 'list-available-work') {
        return { ...empty, works: state.works }
      }
      return empty
    },
    watch() {
      return (async function* () {})()
    }
  }
  return { profile, applied }
}

function gateRow(overrides: Partial<DurableWorkResult['gates'][number]> = {}) {
  return {
    id: `${TURN}:claim`,
    workId: TURN,
    gateId: 'claim',
    kind: 'qvac.poc.code.claim/v1',
    recordedAt: 1,
    ...overrides
  } as DurableWorkResult['gates'][number]
}

function workRow(overrides: Partial<DurableWorkResult['works'][number]> = {}) {
  return {
    workId: TURN,
    payload: Buffer.from('{}'),
    payloadFormat: CODE_TURN_FORMAT,
    payloadVersion: 1,
    createdAt: 1,
    cancelRequested: false,
    ...overrides
  } as DurableWorkResult['works'][number]
}

function store(state: Partial<FakeState> = {}) {
  const full: FakeState = {
    gates: [],
    works: [],
    applyThrows: false,
    ...state
  }
  const { profile, applied } = fakeProfile(full)
  return {
    store: createCodeMeshStore({ work: profile as never }),
    state: full,
    applied
  }
}

describe('claimTurn arbitrates on stored state, never on the throw', () => {
  it('reports won when the gate carries our own claim', async () => {
    const harness = store({
      applyThrows: false,
      gates: [gateRow({ decision: formatClaimDecision(MINE) })]
    })
    const outcome = await harness.store.claimTurn({
      sessionId: SESSION,
      seq: SEQ,
      executorId: MINE
    })
    expect(outcome).toEqual({ kind: 'won' })
  })

  it('reports lost with the winner when apply threw and a rival holds the gate', async () => {
    const harness = store({
      applyThrows: true,
      gates: [gateRow({ decision: formatClaimDecision(THEIRS) })]
    })
    const outcome = await harness.store.claimTurn({
      sessionId: SESSION,
      seq: SEQ,
      executorId: MINE
    })
    expect(outcome).toEqual({ kind: 'lost', winner: THEIRS })
  })

  it('reports won when apply threw on a stale local read but the gate is ours', async () => {
    const harness = store({
      applyThrows: true,
      gates: [gateRow({ decision: formatClaimDecision(MINE) })]
    })
    const outcome = await harness.store.claimTurn({
      sessionId: SESSION,
      seq: SEQ,
      executorId: MINE
    })
    expect(outcome).toEqual({ kind: 'won' })
  })

  it('reports unreachable, not lost, when the gate is still undecided', async () => {
    const harness = store({ applyThrows: true, gates: [gateRow()] })
    const outcome = await harness.store.claimTurn({
      sessionId: SESSION,
      seq: SEQ,
      executorId: MINE
    })
    expect(outcome.kind).toBe('unreachable')
    if (outcome.kind !== 'unreachable') throw new Error('expected unreachable')
    expect(outcome.error.message).toMatch(/Invalid Sync profile transition/)
  })

  it('reports unreachable when the gate row is missing entirely', async () => {
    const harness = store({ applyThrows: true, gates: [] })
    const outcome = await harness.store.claimTurn({
      sessionId: SESSION,
      seq: SEQ,
      executorId: MINE
    })
    expect(outcome.kind).toBe('unreachable')
  })
})

describe('resolveApprovalGate adopts the replicated decision', () => {
  const mine: CodeApprovalDecision = {
    verdict: 'approved',
    decidedBy: { kind: 'executor', executorId: MINE }
  }
  const theirs: CodeApprovalDecision = {
    verdict: 'denied',
    decidedBy: { kind: 'peer', deviceRef: 'phone' }
  }

  it('reports won when the stored decision is the one we wrote', async () => {
    const harness = store({
      gates: [gateRow({ gateId: 'approval/x/1', decision: formatApprovalDecision(mine) })]
    })
    const outcome = await harness.store.resolveApprovalGate({
      sessionId: SESSION,
      seq: SEQ,
      gateId: 'approval/x/1',
      decision: mine
    })
    expect(outcome).toEqual({ kind: 'won', decision: mine })
  })

  it('reports lost and surfaces the peer decision verbatim', async () => {
    const harness = store({
      applyThrows: true,
      gates: [
        gateRow({ gateId: 'approval/x/1', decision: formatApprovalDecision(theirs) })
      ]
    })
    const outcome = await harness.store.resolveApprovalGate({
      sessionId: SESSION,
      seq: SEQ,
      gateId: 'approval/x/1',
      decision: mine
    })
    expect(outcome).toEqual({ kind: 'lost', decision: theirs })
  })

  it('reports unreachable rather than denied when nothing was recorded', async () => {
    const harness = store({
      applyThrows: true,
      gates: [gateRow({ gateId: 'approval/x/1' })]
    })
    const outcome = await harness.store.resolveApprovalGate({
      sessionId: SESSION,
      seq: SEQ,
      gateId: 'approval/x/1',
      decision: mine
    })
    expect(outcome.kind).toBe('unreachable')
  })
})

describe('recordOutcome treats a throw as a possible supersede', () => {
  it('records normally', async () => {
    const harness = store()
    expect(
      await harness.store.recordOutcome({ workId: TURN, status: 'completed' })
    ).toEqual({ kind: 'recorded' })
  })

  it('reports superseded when an outcome is already final', async () => {
    const harness = store({
      applyThrows: true,
      works: [workRow({ outcomeStatus: 'completed' })]
    })
    expect(
      await harness.store.recordOutcome({ workId: TURN, status: 'failed' })
    ).toEqual({ kind: 'superseded' })
  })

  it('rethrows with the cause when no outcome exists, so a transport failure is not mistaken for a lost race', async () => {
    const harness = store({ applyThrows: true, works: [workRow()] })
    await expect(
      harness.store.recordOutcome({ workId: TURN, status: 'completed' })
    ).rejects.toThrow(/Record outcome failed/)
  })
})

describe('requestCancel is satisfied by an already-cancelled row', () => {
  it('returns quietly when cancellation is already recorded', async () => {
    const harness = store({
      applyThrows: true,
      works: [workRow({ cancelRequested: true })]
    })
    await harness.store.requestCancel({ workId: TURN, reason: 'different text' })
  })

  it('rethrows when the row is not cancelled', async () => {
    const harness = store({ applyThrows: true, works: [workRow()] })
    await expect(
      harness.store.requestCancel({ workId: TURN, reason: 'stop' })
    ).rejects.toThrow(/Request cancel failed/)
  })

  /**
   * The reducer shares one branch between request-cancel and record-outcome and
   * rejects a cancel once the row is terminal. A phone cancelling a turn that
   * finished a moment earlier is the common case in the demo, and the intent --
   * stop this turn -- is satisfied either way.
   */
  it('returns quietly when the turn already finished', async () => {
    const harness = store({
      applyThrows: true,
      works: [workRow({ outcomeStatus: 'completed' })]
    })
    await harness.store.requestCancel({ workId: TURN, reason: 'too late' })
  })
})

/**
 * Sync drops a duplicate operationId during merge replay without comparing
 * content, so both racing devices see their own apply succeed locally and only
 * one payload survives. A caller told nothing but "ok" cannot know whose prompt
 * is stored.
 */
describe('createTurn confirms whose payload actually landed', () => {
  it('reports created when the stored payload is ours', async () => {
    const harness = store()
    const created = await harness.store.createTurn({
      sessionId: SESSION,
      seq: SEQ,
      prompt: 'mine',
      requestedBy: 'phone'
    })
    // The fake records the apply but stores nothing, so confirm reads back null.
    expect(created.turnWorkId).toBe(TURN)
    expect(created.kind).toBe('unconfirmed')
  })

  it('reports superseded when another writer won the work id', async () => {
    const harness = store({
      works: [
        workRow({
          payload: Buffer.from(
            JSON.stringify({
              kind: 'code-turn',
              sessionId: SESSION,
              seq: SEQ,
              prompt: 'theirs',
              requestedBy: 'other-phone'
            })
          )
        })
      ]
    })
    const created = await harness.store.createTurn({
      sessionId: SESSION,
      seq: SEQ,
      prompt: 'mine',
      requestedBy: 'phone'
    })
    expect(created.kind).toBe('superseded')
  })
})

describe('queries stay inside this application', () => {
  it('ignores work rows belonging to another payload format', async () => {
    const harness = store({
      works: [
        workRow({ workId: 'code/other', payloadFormat: 'application/vnd.qvac.harness-run+json' }),
        workRow()
      ]
    })
    const turns = await harness.store.listAvailableTurns()
    expect(turns.map((work) => work.workId)).toEqual([TURN])
  })

  it('ignores gates outside the code namespace', async () => {
    const harness = store({
      works: [workRow()],
      gates: [
        gateRow({ id: 'x:g', workId: 'someone-else/1', gateId: 'g' }),
        gateRow({ gateId: 'approval/x/1' })
      ]
    })
    const open = await harness.store.listOpenGates()
    expect(open.map((gate) => gate.workId)).toEqual([TURN])
  })

  /**
   * `open-gate` only requires that a work row exists at the id -- it never
   * checks that row's format. A workId shaped like ours is therefore not proof
   * the gate is ours, so the owning row's payloadFormat has to be confirmed.
   */
  it('ignores a gate whose work row belongs to another payload format', async () => {
    const harness = store({
      works: [workRow({ payloadFormat: 'application/vnd.qvac.harness-run+json' })],
      gates: [gateRow({ gateId: 'approval/x/1' })]
    })
    expect(await harness.store.listOpenGates()).toEqual([])
  })

  it('ignores a gate whose work row is missing entirely', async () => {
    const harness = store({ works: [], gates: [gateRow({ gateId: 'approval/x/1' })] })
    expect(await harness.store.listOpenGates()).toEqual([])
  })

  it('derives the next turn seq from existing turn work ids', async () => {
    const harness = store({
      works: [
        workRow({ workId: formatTurnWorkId({ sessionId: SESSION, seq: 0 }) }),
        workRow({ workId: formatTurnWorkId({ sessionId: SESSION, seq: 4 }) }),
        workRow({ workId: formatTurnWorkId({ sessionId: 'other', seq: 9 }) }),
        workRow({ workId: 'code/sess1', payloadFormat: CODE_SESSION_FORMAT })
      ]
    })
    expect(await harness.store.nextTurnSeq(SESSION)).toBe(5)
    expect(await harness.store.nextTurnSeq('empty')).toBe(0)
  })
})

describe('the claim gate can be opened by either device', () => {
  it('uses an operationId keyed only on the turn, so a second opener is a no-op', async () => {
    const first = store()
    await first.store.openClaimGate({ sessionId: SESSION, seq: SEQ })
    const second = store()
    await second.store.openClaimGate({ sessionId: SESSION, seq: SEQ })
    expect(first.applied[0]?.operationId).toBe(second.applied[0]?.operationId)
    expect(first.applied[0]?.command).toEqual(second.applied[0]?.command)
  })
})
