import type {
  SyncDurableWork,
  SyncDurableWorkCheckpoint,
  SyncDurableWorkExecutor,
  SyncDurableWorkGate,
  SyncDurableWorkJournalEntry
} from '../../../spec/mesh/hyperschema/types.d.ts'
import type { SyncProfileContract } from '../../runtime/types.ts'

export type DurableWorkCommand =
  | {
      readonly type: 'record-work'
      readonly workId: string
      readonly payload: Buffer
      readonly payloadFormat: string
      readonly payloadVersion: number
      readonly target?: string
    }
  | {
      readonly type: 'append-journal'
      readonly workId: string
      readonly entryType: string
      readonly body: Buffer
    }
  | {
      readonly type: 'request-cancel'
      readonly workId: string
      readonly reason: string
    }
  | {
      readonly type: 'save-checkpoint-ref'
      readonly workId: string
      readonly checkpointId: string
      readonly format: string
      readonly version: number
      readonly blobRef: string
    }
  | {
      readonly type: 'open-gate'
      readonly workId: string
      readonly gateId: string
      readonly kind: string
    }
  | {
      readonly type: 'resolve-gate'
      readonly workId: string
      readonly gateId: string
      readonly decision: string
    }
  | {
      readonly type: 'record-outcome'
      readonly workId: string
      readonly status: 'completed' | 'failed' | 'cancelled'
      readonly result?: Buffer
    }
  | {
      readonly type: 'advertise-executor'
      readonly executorId: string
      readonly capabilities: readonly string[]
      readonly expiresAt: number
    }

export type DurableWorkQuery =
  | { readonly type: 'get-work'; readonly workId: string }
  | { readonly type: 'list-work' }
  | { readonly type: 'list-available-work' }
  | { readonly type: 'get-checkpoint-ref'; readonly workId: string }
  | { readonly type: 'list-journal'; readonly workId: string }
  | { readonly type: 'list-gates'; readonly workId: string }
  /**
   * Every gate still awaiting a decision, across all work.
   *
   * The *result* is bounded by the number of undecided gates rather than by
   * history, which is what makes this cheap to watch: a watch re-serializes its
   * whole encoded result on every mesh change, and that cost stays flat here
   * while a journal watch's grows.
   *
   * The *scan* is not bounded — like every other query in this reducer, it reads
   * the whole table and filters afterwards, so it walks every gate ever recorded
   * (one claim gate per turn, plus every approval). Fine at the scale this
   * profile is exercised at, and worth revisiting before it is.
   */
  | { readonly type: 'list-open-gates' }
  | { readonly type: 'list-executor-presence' }

export interface DurableWorkResult {
  readonly work?: SyncDurableWork | null
  readonly works: SyncDurableWork[]
  readonly checkpoint?: SyncDurableWorkCheckpoint | null
  readonly entries: SyncDurableWorkJournalEntry[]
  readonly gates: SyncDurableWorkGate[]
  readonly executors: SyncDurableWorkExecutor[]
}

export const durableWorkProfile: SyncProfileContract<
  DurableWorkCommand,
  DurableWorkQuery,
  DurableWorkResult
> = {
  id: 'qvac.sync.profiles.durable-work',
  version: 1,
  capabilities: [
    'work-envelope',
    'journal',
    'cancellation',
    'checkpoint-ref',
    'gate',
    // Gates were writable but unreadable until `list-gates`/`list-open-gates`
    // existed. Declared separately so the distinction is recorded, but nothing
    // reads `capabilities` yet: this is documentation, not negotiation, and a
    // peer talking to an older runtime still finds out by having its query
    // rejected rather than by checking here first.
    'gate-read',
    'outcome',
    'executor-presence'
  ],
  visibility: 'mesh-wide'
}
