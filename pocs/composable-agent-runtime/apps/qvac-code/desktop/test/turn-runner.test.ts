import { describe, expect, test } from 'bun:test'
import { createJournalSeqAllocator } from '@qvac-poc/qvac-code-shared'
import type { AssistantFacade } from '@qvac/assistant'
import type { HarnessEvent } from '@qvac/harness'
import type { CodeMeshStore } from '@qvac-poc/qvac-code-shared/store'
import { createTurnRunner, type TurnRunnerEvent, type TurnRunnerInput } from '../lib/turn-runner.ts'

const EXECUTOR_ID = 'code-host-abc123456789'

type AppendedEntry = Parameters<CodeMeshStore['appendEntry']>[0]
type RecordOutcomeCall = Parameters<CodeMeshStore['recordOutcome']>[0]

function notImplemented(name: string) {
  return () => {
    throw new Error(`${name} is not implemented in this fake`)
  }
}

function createFakeStore(
  options: {
    readonly appendEntry?: CodeMeshStore['appendEntry']
    readonly recordOutcome?: CodeMeshStore['recordOutcome']
  } = {}
) {
  const appended: AppendedEntry[] = []
  const recordOutcomeCalls: RecordOutcomeCall[] = []
  const appendEntryImpl = options.appendEntry
  const recordOutcomeImpl = options.recordOutcome

  const store: CodeMeshStore = {
    createSession: notImplemented('createSession'),
    createTurn: notImplemented('createTurn'),
    nextTurnSeq: notImplemented('nextTurnSeq'),
    listSessions: notImplemented('listSessions'),
    getWork: notImplemented('getWork'),
    listAvailableTurns: notImplemented('listAvailableTurns'),
    listJournal: notImplemented('listJournal'),
    listGates: notImplemented('listGates'),
    listOpenGates: notImplemented('listOpenGates'),
    openClaimGate: notImplemented('openClaimGate'),
    claimTurn: notImplemented('claimTurn'),
    openApprovalGate: notImplemented('openApprovalGate'),
    resolveApprovalGate: notImplemented('resolveApprovalGate'),
    async appendEntry(input) {
      if (appendEntryImpl) await appendEntryImpl(input)
      appended.push(input)
    },
    requestCancel: notImplemented('requestCancel'),
    async recordOutcome(input) {
      recordOutcomeCalls.push(input)
      if (recordOutcomeImpl) return recordOutcomeImpl(input)
      return { kind: 'recorded' }
    },
    advertiseExecutor: notImplemented('advertiseExecutor'),
    listExecutors: notImplemented('listExecutors'),
    watchSessions: notImplemented('watchSessions'),
    watchTurnJournal: notImplemented('watchTurnJournal'),
    watchOpenGates: notImplemented('watchOpenGates')
  }

  return { store, appended, recordOutcomeCalls }
}

function createFakeAssistant(input: {
  readonly events: readonly HarnessEvent[]
  readonly throwAfter?: number
}) {
  const cancelCalls: { agentId: string; runId: string; reason?: string }[] = []
  const assistant: Pick<AssistantFacade, 'run' | 'cancelRun'> = {
    run(runInput) {
      return {
        id: runInput.runId ?? 'run',
        [Symbol.asyncIterator]() {
          return (async function* () {
            let index = 0
            for (const event of input.events) {
              yield event
              index++
              if (input.throwAfter != null && index === input.throwAfter) {
                throw new Error('transport failure')
              }
            }
          })()
        }
      }
    },
    async cancelRun(cancelInput) {
      cancelCalls.push(cancelInput)
    }
  }
  return { assistant, cancelCalls }
}

function baseInput(overrides: Partial<TurnRunnerInput> = {}): TurnRunnerInput {
  return {
    sessionId: 'session-1',
    seq: 0,
    turnWorkId: 'code/session-1/turn/000000',
    prompt: 'do the thing',
    agentId: 'code/session-1',
    signal: new AbortController().signal,
    entrySeq: createJournalSeqAllocator(0),
    ...overrides
  }
}

function bodiesOf(appended: readonly AppendedEntry[]) {
  return appended.map((entry) => entry.body)
}

describe('createTurnRunner', function () {
  test('batches content deltas into a single journal entry, drained at the end', async function () {
    const { store, appended } = createFakeStore()
    const { assistant } = createFakeAssistant({
      events: [
        { type: 'content', text: 'Hello ' },
        { type: 'content', text: 'World' }
      ]
    })
    const runner = createTurnRunner({ store, assistant, executorId: EXECUTOR_ID, now: () => 0 })

    const result = await runner.run(baseInput())

    expect(result.status).toBe('completed')
    expect(result.finalText).toBe('Hello World')
    expect(bodiesOf(appended)).toEqual([{ type: 'assistant-delta', text: 'Hello World', writer: EXECUTOR_ID, seq: 0 }])
  })

  test('forces a drain before a tool-call entry so ordering stays correct', async function () {
    const { store, appended } = createFakeStore()
    const { assistant } = createFakeAssistant({
      events: [
        { type: 'content', text: 'Reading the file' },
        { type: 'tool-call', name: 'read', args: { filePath: 'src/a.ts' } },
        { type: 'tool-result', name: 'read', result: { path: 'src/a.ts', content: 'ok' } }
      ]
    })
    const runner = createTurnRunner({ store, assistant, executorId: EXECUTOR_ID, now: () => 0 })

    await runner.run(baseInput())

    const bodies = bodiesOf(appended)
    expect(bodies).toEqual([
      { type: 'assistant-delta', text: 'Reading the file', writer: EXECUTOR_ID, seq: 0 },
      { type: 'tool-call', callRef: 'read#0', name: 'read', summary: 'read src/a.ts', writer: EXECUTOR_ID, seq: 1 },
      {
        type: 'tool-result',
        callRef: 'read#0',
        name: 'read',
        ok: true,
        summary: '{ path, content }',
        writer: EXECUTOR_ID,
        seq: 2
      }
    ])
  })

  test('pairs repeated tool-call/tool-result events by callRef in announced order', async function () {
    const { store, appended } = createFakeStore()
    const { assistant } = createFakeAssistant({
      events: [
        { type: 'tool-call', name: 'read', args: { filePath: 'a.ts' } },
        { type: 'tool-call', name: 'read', args: { filePath: 'b.ts' } },
        { type: 'tool-result', name: 'read', result: { path: 'a.ts' } },
        { type: 'tool-result', name: 'read', result: { path: 'b.ts' } }
      ]
    })
    const runner = createTurnRunner({ store, assistant, executorId: EXECUTOR_ID, now: () => 0 })

    await runner.run(baseInput())

    const bodies = bodiesOf(appended)
    const calls = bodies.filter((body) => body.type === 'tool-call')
    const results = bodies.filter((body) => body.type === 'tool-result')
    expect(calls.map((call) => call.callRef)).toEqual(['read#0', 'read#1'])
    // The first announced call resolves with the first result: agent.ts
    // executes and yields results in the same order it announced the calls.
    expect(results.map((result) => result.callRef)).toEqual(['read#0', 'read#1'])
  })

  test('an error event appends turn-error{recoverable:false} and fails the turn', async function () {
    const { store, appended, recordOutcomeCalls } = createFakeStore()
    const { assistant } = createFakeAssistant({
      events: [
        { type: 'content', text: 'partial' },
        { type: 'error', message: 'boom' }
      ]
    })
    const runner = createTurnRunner({ store, assistant, executorId: EXECUTOR_ID, now: () => 0 })

    const result = await runner.run(baseInput())

    expect(result.status).toBe('failed')
    const bodies = bodiesOf(appended)
    expect(bodies).toContainEqual({ type: 'assistant-delta', text: 'partial', writer: EXECUTOR_ID, seq: 0 })
    expect(bodies).toContainEqual({
      type: 'turn-error',
      message: 'boom',
      recoverable: false,
      writer: EXECUTOR_ID,
      seq: 1
    })
    expect(recordOutcomeCalls).toEqual([{ workId: baseInput().turnWorkId, status: 'failed', result: Buffer.from('partial') }])
  })

  test('an aborted event maps to a cancelled result', async function () {
    const { store, recordOutcomeCalls } = createFakeStore()
    const { assistant } = createFakeAssistant({ events: [{ type: 'aborted' }] })
    const runner = createTurnRunner({ store, assistant, executorId: EXECUTOR_ID, now: () => 0 })

    const result = await runner.run(baseInput())

    expect(result.status).toBe('cancelled')
    expect(recordOutcomeCalls[0]?.status).toBe('cancelled')
  })

  test('an aborted event after an error keeps the failed status', async function () {
    const { store, recordOutcomeCalls } = createFakeStore()
    const { assistant } = createFakeAssistant({
      events: [
        { type: 'error', message: 'boom' },
        { type: 'aborted' }
      ]
    })
    const runner = createTurnRunner({ store, assistant, executorId: EXECUTOR_ID, now: () => 0 })

    const result = await runner.run(baseInput())

    // A reported failure outranks a same-moment abort: the turn genuinely
    // failed, and recording it as 'cancelled' would hide the error from every
    // surface that reads the work row's outcome.
    expect(result.status).toBe('failed')
    expect(recordOutcomeCalls[0]?.status).toBe('failed')
  })

  test('a superseded outcome appends turn-superseded and resolves without throwing', async function () {
    const { store, appended } = createFakeStore({
      recordOutcome: async () => ({ kind: 'superseded' })
    })
    const { assistant } = createFakeAssistant({ events: [{ type: 'content', text: 'hi' }] })
    const runner = createTurnRunner({ store, assistant, executorId: EXECUTOR_ID, now: () => 0 })

    const result = await runner.run(baseInput())

    expect(result.outcome).toEqual({ kind: 'superseded' })
    const bodies = bodiesOf(appended)
    const last = bodies.at(-1)
    expect(last).toEqual({
      type: 'turn-superseded',
      executorId: EXECUTOR_ID,
      winner: EXECUTOR_ID,
      writer: EXECUTOR_ID,
      seq: 1
    })
  })

  test('a journal-append failure is reported but does not abort the run', async function () {
    const events: TurnRunnerEvent[] = []
    const { store, recordOutcomeCalls } = createFakeStore({
      appendEntry: async () => {
        throw new Error('mesh unavailable')
      }
    })
    const { assistant } = createFakeAssistant({ events: [{ type: 'content', text: 'still works' }] })
    const runner = createTurnRunner({
      store,
      assistant,
      executorId: EXECUTOR_ID,
      now: () => 0,
      onEvent: (event) => events.push(event)
    })

    const result = await runner.run(baseInput())

    expect(result.status).toBe('completed')
    expect(result.finalText).toBe('still works')
    expect(recordOutcomeCalls).toHaveLength(1)
    expect(events.some((event) => event.kind === 'error' && event.message.includes('journal append failed'))).toBe(
      true
    )
  })

  test('the iterator throwing mid-run is caught, cancels the run, and still records an outcome', async function () {
    const { store, appended, recordOutcomeCalls } = createFakeStore()
    const { assistant, cancelCalls } = createFakeAssistant({
      events: [{ type: 'content', text: 'partial' }],
      throwAfter: 1
    })
    const runner = createTurnRunner({ store, assistant, executorId: EXECUTOR_ID, now: () => 0 })

    const result = await runner.run(baseInput())

    expect(result.status).toBe('failed')
    expect(cancelCalls).toHaveLength(1)
    const bodies = bodiesOf(appended)
    expect(bodies.some((body) => body.type === 'turn-error' && body.message.includes('transport failure'))).toBe(
      true
    )
    expect(recordOutcomeCalls).toHaveLength(1)
  })
})
