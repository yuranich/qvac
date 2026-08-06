import type { SyncProfileClient } from '@qvac/sync'
import type {
  DurableWorkCommand,
  DurableWorkQuery,
  DurableWorkResult
} from '@qvac/sync/profiles/durable-work'
import {
  CODE_CLAIM_GATE_ID,
  CODE_EXECUTOR_CAPABILITY,
  CODE_SESSION_FORMAT,
  CODE_TURN_FORMAT
} from './formats.ts'
import { formatSessionWorkId, formatTurnWorkId, parseCodeWorkId } from './ids.ts'
import {
  advertiseExecutorCommand,
  appendJournalCommand,
  createSessionCommand,
  createTurnCommand,
  openApprovalGateCommand,
  openClaimGateCommand,
  recordOutcomeCommand,
  requestCancelCommand,
  resolveApprovalGateCommand,
  resolveClaimGateCommand
} from './commands.ts'
import { parseClaimDecision } from './claim.ts'
import { formatApprovalDecision, parseApprovalDecision, type CodeApprovalDecision } from './approval.ts'
import type { CodeJournalBody } from './journal.ts'

export type CodeWorkRecord = NonNullable<DurableWorkResult['works'][number]>
export type CodeJournalEntryRecord = NonNullable<DurableWorkResult['entries'][number]>
export type CodeGateRecord = NonNullable<DurableWorkResult['gates'][number]>
export type CodeExecutorRecord = NonNullable<DurableWorkResult['executors'][number]>

export type CodeClaimOutcome =
  | { readonly kind: 'won' }
  | { readonly kind: 'lost'; readonly winner: string }
  | { readonly kind: 'unreachable'; readonly error: Error }

export type CodeGateResolution =
  | { readonly kind: 'won'; readonly decision: CodeApprovalDecision }
  | { readonly kind: 'lost'; readonly decision: CodeApprovalDecision }
  | { readonly kind: 'unreachable'; readonly error: Error }

export type CodeFinishOutcome = { readonly kind: 'recorded' } | { readonly kind: 'superseded' }

/**
 * `created` means the stored payload is the one we sent. `superseded` means a
 * concurrent writer's row won that workId. `unconfirmed` means the row was not
 * readable back yet, which is not a failure -- the caller decides whether to
 * retry at a fresh sequence number.
 */
export type CodeCreateKind = 'created' | 'superseded' | 'unconfirmed'

export interface CodeMeshStore {
  createSession(input: {
    readonly sessionId: string
    readonly title: string
    readonly projectLabel: string
    readonly model: string
    readonly createdBy: string
  }): Promise<{ readonly workId: string; readonly kind: CodeCreateKind }>
  createTurn(input: {
    readonly sessionId: string
    readonly seq: number
    readonly prompt: string
    readonly requestedBy: string
    readonly target?: string
  }): Promise<{ readonly turnWorkId: string; readonly kind: CodeCreateKind }>
  nextTurnSeq(sessionId: string): Promise<number>
  listSessions(): Promise<readonly CodeWorkRecord[]>
  getWork(workId: string): Promise<CodeWorkRecord | null>
  listAvailableTurns(): Promise<readonly CodeWorkRecord[]>
  listJournal(turnWorkId: string): Promise<readonly CodeJournalEntryRecord[]>
  listGates(turnWorkId: string): Promise<readonly CodeGateRecord[]>
  listOpenGates(): Promise<readonly CodeGateRecord[]>
  // decideClaimAction can return 'open-claim-gate' as a distinct step before
  // 'attempt-claim'. Store.ts is the only file in this package that touches
  // SyncProfileClient, so this is the only way any caller -- including an
  // app that only depends on @qvac-poc/qvac-code-shared, never @qvac/sync
  // directly -- can perform that step. Safe to call redundantly: open-gate
  // is create-only and this command's operationId is deterministic on the
  // turn alone, so a second caller's attempt is a byte-identical no-op.
  openClaimGate(input: { readonly sessionId: string; readonly seq: number }): Promise<void>
  claimTurn(input: {
    readonly sessionId: string
    readonly seq: number
    readonly executorId: string
  }): Promise<CodeClaimOutcome>
  openApprovalGate(input: {
    readonly sessionId: string
    readonly seq: number
    readonly gateId: string
  }): Promise<void>
  resolveApprovalGate(input: {
    readonly sessionId: string
    readonly seq: number
    readonly gateId: string
    readonly decision: CodeApprovalDecision
  }): Promise<CodeGateResolution>
  appendEntry(input: {
    readonly sessionId: string
    readonly seq: number
    readonly body: CodeJournalBody
  }): Promise<void>
  requestCancel(input: { readonly workId: string; readonly reason: string }): Promise<void>
  recordOutcome(input: {
    readonly workId: string
    readonly status: 'completed' | 'failed' | 'cancelled'
    readonly result?: Buffer
  }): Promise<CodeFinishOutcome>
  advertiseExecutor(input: {
    readonly executorId: string
    readonly expiresAt: number
    readonly capabilities?: readonly string[]
  }): Promise<void>
  listExecutors(): Promise<readonly CodeExecutorRecord[]>
  watchSessions(options?: {
    readonly signal?: AbortSignal
  }): AsyncIterable<readonly CodeWorkRecord[]>
  watchTurnJournal(
    turnWorkId: string,
    options?: { readonly signal?: AbortSignal }
  ): AsyncIterable<readonly CodeJournalEntryRecord[]>
  watchOpenGates(options?: {
    readonly signal?: AbortSignal
  }): AsyncIterable<readonly CodeGateRecord[]>
}

type Profile = SyncProfileClient<DurableWorkCommand, DurableWorkQuery, DurableWorkResult>

export function createCodeMeshStore(state: { readonly work: Profile }): CodeMeshStore {
  const profile = state.work

  return {
    async createSession(input) {
      const { command, operationId } = createSessionCommand(input)
      const workId = formatSessionWorkId(input.sessionId)
      await profile.apply(command, { operationId })
      return { workId, kind: await confirmCreate(profile, workId, command) }
    },

    async createTurn(input) {
      const { command, operationId } = createTurnCommand(input)
      const turnWorkId = formatTurnWorkId(input)
      await profile.apply(command, { operationId })
      return { turnWorkId, kind: await confirmCreate(profile, turnWorkId, command) }
    },

    async nextTurnSeq(sessionId) {
      const result = await profile.query({ type: 'list-work' })
      let next = 0
      for (const work of result.works) {
        if (work.payloadFormat !== CODE_TURN_FORMAT) continue
        const parsed = parseCodeWorkId(work.workId)
        if (parsed == null || parsed.kind !== 'turn' || parsed.sessionId !== sessionId) continue
        if (parsed.seq + 1 > next) next = parsed.seq + 1
      }
      return next
    },

    async listSessions() {
      const result = await profile.query({ type: 'list-work' })
      return result.works.filter((work) => work.payloadFormat === CODE_SESSION_FORMAT)
    },

    async getWork(workId) {
      const result = await profile.query({ type: 'get-work', workId })
      const work = result.work
      if (!work) return null
      if (work.payloadFormat !== CODE_SESSION_FORMAT && work.payloadFormat !== CODE_TURN_FORMAT) {
        return null
      }
      return work
    },

    async listAvailableTurns() {
      const result = await profile.query({ type: 'list-available-work' })
      return result.works.filter((work) => work.payloadFormat === CODE_TURN_FORMAT)
    },

    async listJournal(turnWorkId) {
      const result = await profile.query({ type: 'list-journal', workId: turnWorkId })
      return result.entries
    },

    async listGates(turnWorkId) {
      const result = await profile.query({ type: 'list-gates', workId: turnWorkId })
      return result.gates
    },

    async listOpenGates() {
      const result = await profile.query({ type: 'list-open-gates' })
      return ownGates(profile, result.gates)
    },

    async openClaimGate(input) {
      const { command, operationId } = openClaimGateCommand(input)
      await profile.apply(command, { operationId })
    },

    async claimTurn(input) {
      const { command, operationId } = resolveClaimGateCommand(input)
      let applyError: Error | null = null
      try {
        await profile.apply(command, { operationId })
      } catch (error) {
        // A throw here is ambiguous: another executor may have already won
        // the gate, or this may be an unrelated transport failure. Only the
        // stored gate row can arbitrate -- never infer a verdict from the
        // throw itself.
        applyError = toError(error)
      }
      const turnWorkId = formatTurnWorkId(input)
      const gate = await readGate(profile, turnWorkId, CODE_CLAIM_GATE_ID)
      const claim = gate ? parseClaimDecision(gate.decision) : null
      if (claim == null) {
        return {
          kind: 'unreachable',
          error: applyError ?? new Error(`Claim gate for ${turnWorkId} is still undecided`)
        }
      }
      return claim.executorId === input.executorId
        ? { kind: 'won' }
        : { kind: 'lost', winner: claim.executorId }
    },

    async openApprovalGate(input) {
      const { command, operationId } = openApprovalGateCommand(input)
      await profile.apply(command, { operationId })
    },

    async resolveApprovalGate(input) {
      const { command, operationId } = resolveApprovalGateCommand(input)
      let applyError: Error | null = null
      try {
        await profile.apply(command, { operationId })
      } catch (error) {
        applyError = toError(error)
      }
      const turnWorkId = formatTurnWorkId(input)
      const gate = await readGate(profile, turnWorkId, input.gateId)
      const decided = gate?.decision != null ? parseApprovalDecision(gate.decision) : null
      if (decided == null) {
        return {
          kind: 'unreachable',
          error: applyError ?? new Error(`Approval gate ${input.gateId} for ${turnWorkId} is still undecided`)
        }
      }
      return formatApprovalDecision(decided) === formatApprovalDecision(input.decision)
        ? { kind: 'won', decision: decided }
        : { kind: 'lost', decision: decided }
    },

    async appendEntry(input) {
      const { command, operationId } = appendJournalCommand(input)
      await profile.apply(command, { operationId })
    },

    async requestCancel(input) {
      const { command, operationId } = requestCancelCommand(input)
      try {
        await profile.apply(command, { operationId })
      } catch (error) {
        // The reducer shares one branch between request-cancel and
        // record-outcome, and rejects a cancel when the row is already
        // terminal as well as when it is already cancelled. Both mean the
        // intent -- stop this turn -- is satisfied: a turn that finished a
        // moment before the cancel arrived is the common case when a phone
        // cancels a streaming turn, and it must not surface as a failure.
        // A second cancel with different reason text also lands here, because
        // the operationId is keyed on the workId alone.
        const work = await readWork(profile, input.workId)
        if (work?.cancelRequested || work?.outcomeStatus != null) return
        throw new Error(`Request cancel failed for ${input.workId}`, { cause: toError(error) })
      }
    },

    async recordOutcome(input) {
      const { command, operationId } = recordOutcomeCommand(input)
      try {
        await profile.apply(command, { operationId })
        return { kind: 'recorded' }
      } catch (error) {
        // record-outcome is outcome-null create-only: a throw means some
        // outcome for this workId is now final and this call did not author
        // it (either a race on the same status with a different result, or
        // a different status won). Re-read rather than infer from the
        // throw.
        const work = await readWork(profile, input.workId)
        if (work?.outcomeStatus != null) return { kind: 'superseded' }
        throw new Error(`Record outcome failed for ${input.workId}`, { cause: toError(error) })
      }
    },

    async advertiseExecutor(input) {
      const { command, operationId } = advertiseExecutorCommand({
        executorId: input.executorId,
        expiresAt: input.expiresAt,
        capabilities: input.capabilities ?? [CODE_EXECUTOR_CAPABILITY]
      })
      await profile.apply(command, { operationId })
    },

    async listExecutors() {
      const result = await profile.query({ type: 'list-executor-presence' })
      return result.executors.filter((executor) =>
        executor.capabilities.includes(CODE_EXECUTOR_CAPABILITY)
      )
    },

    watchSessions(options) {
      return watchQuery(
        profile,
        { type: 'list-work' },
        () => listSessionsRaw(profile),
        options
      )
    },

    watchTurnJournal(turnWorkId, options) {
      return watchQuery(
        profile,
        { type: 'list-journal', workId: turnWorkId },
        async () => (await profile.query({ type: 'list-journal', workId: turnWorkId })).entries,
        options
      )
    },

    watchOpenGates(options) {
      return watchQuery(
        profile,
        { type: 'list-open-gates' },
        async () => {
          const result = await profile.query({ type: 'list-open-gates' })
          return ownGates(profile, result.gates)
        },
        options
      )
    }
  }
}

async function listSessionsRaw(profile: Profile) {
  const result = await profile.query({ type: 'list-work' })
  return result.works.filter((work) => work.payloadFormat === CODE_SESSION_FORMAT)
}

/**
 * `record-work` is create-only, and Sync's operationId dedup drops a duplicate
 * operation during merge replay *without* comparing content. Two devices that
 * both computed the same next seq therefore both see their own `apply` succeed
 * locally, and only one payload survives linearization -- so a caller told
 * nothing but "ok" cannot know whose prompt is actually stored. Read the row
 * back and compare the payload we sent.
 */
async function confirmCreate(
  profile: Profile,
  workId: string,
  command: DurableWorkCommand
): Promise<CodeCreateKind> {
  if (command.type !== 'record-work') {
    throw new Error(`confirmCreate expects record-work, got ${command.type}`)
  }
  const work = await readWork(profile, workId)
  if (!work) return 'unconfirmed'
  return sameBytes(work.payload, command.payload) ? 'created' : 'superseded'
}

function sameBytes(left: Buffer | Uint8Array, right: Buffer | Uint8Array) {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false
  }
  return true
}

async function readWork(profile: Profile, workId: string) {
  const result = await profile.query({ type: 'get-work', workId })
  return result.work ?? null
}

/**
 * `list-open-gates` is mesh-wide, and `open-gate` only requires that some work
 * row exists at the id -- it never checks that row's format. A workId shaped
 * like ours is therefore not proof the gate is ours: another profile consumer
 * could hold a row at a colliding id. Confirm the owning row's payloadFormat,
 * the same filter every other read here applies. Cheap because the open-gate
 * set is bounded by outstanding decisions, normally none or one.
 */
async function ownGates(profile: Profile, gates: CodeGateRecord[]) {
  const candidates = gates.filter((gate) => parseCodeWorkId(gate.workId) != null)
  if (candidates.length === 0) return candidates
  const owners = new Map<string, boolean>()
  for (const workId of new Set(candidates.map((gate) => gate.workId))) {
    const work = await readWork(profile, workId)
    owners.set(
      workId,
      work?.payloadFormat === CODE_TURN_FORMAT ||
        work?.payloadFormat === CODE_SESSION_FORMAT
    )
  }
  return candidates.filter((gate) => owners.get(gate.workId) === true)
}

async function readGate(profile: Profile, workId: string, gateId: string) {
  const result = await profile.query({ type: 'list-gates', workId })
  return result.gates.find((gate) => gate.gateId === gateId) ?? null
}

// A watch frame's payload is ignored by design (Fact: a watch re-runs the
// whole query and JSON.stringifys the encoded result Buffer on every mesh
// change, so journals must stay bounded per turn) -- the frame is only a
// wake-up signal, and every wake re-issues the same bounded read.
async function* watchQuery<Value>(
  profile: Profile,
  query: DurableWorkQuery,
  read: () => Promise<Value>,
  options?: { readonly signal?: AbortSignal }
) {
  for await (const _frame of profile.watch(query, { signal: options?.signal })) {
    yield await read()
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
