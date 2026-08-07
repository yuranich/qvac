import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import { createSync, type SyncRuntime } from '@qvac/sync'
import { durableWorkProfile } from '@qvac/sync/profiles/durable-work'
import {
  CODE_CLAIM_GATE_ID,
  createSessionId,
  decodeJournalBody,
  formatExecutorId,
  formatTurnWorkId,
  parseClaimDecision,
  projectTurn
} from '@qvac-poc/qvac-code-shared'
import { createCodeMeshStore, type CodeMeshStore } from '@qvac-poc/qvac-code-shared/store'
import { createExecutor } from '../lib/executor.ts'
import type { ExecutorIdentity } from '../lib/executor-identity.ts'
import type { TurnRunResult } from '../lib/turn-runner.ts'

/**
 * Two executors, one turn, over real HyperDHT replication.
 *
 * This test exists to *document* the races that
 * docs/arch/tech-debt/TD-DURABLE-WORK-CLAIM-GUARANTEES.md records, not to assert
 * they are absent. What it pins down is the property the claim protocol actually
 * buys: whatever the two executors each believed locally, the mesh converges on
 * exactly one claim and exactly one outcome, and the transcript renders only the
 * winner's entries.
 *
 * It deliberately does not assert that only one executor ran. R1 -- a claim
 * accepted against a local Autobase view before a peer's competing block has
 * linearized -- means both can start, and no assertion here could make that
 * false. If this test ever begins failing because two outcomes survived, that is
 * a real regression in the arbitration, not flakiness.
 *
 * Observed on a local testnet: one executor claims and the other correctly skips
 * with `claimed-elsewhere`, so the printed line usually reports a single runner.
 * That is evidence the confirmation barrier does its job when replication is
 * fast, and nothing more -- a loaded or partitioned link is exactly the condition
 * the barrier cannot cover, and this harness cannot manufacture one.
 *
 * Excluded from the package's default suite: it pairs two real Sync runtimes on
 * a DHT testnet and takes tens of seconds. Run it with `bun run test:chaos`.
 *
 * Runs under vitest rather than `bun test` because HyperDHT's native module
 * calls `uv_interface_addresses`, which Bun does not implement -- `bun test`
 * panics on it. packages/assistant's durable-state composition test pairs real
 * Sync runtimes under vitest for the same reason.
 */

const CLAIM_SETTLE_MS = 8_000
const PAIRING_TIMEOUT_MS = 60_000

interface Peer {
  readonly sync: SyncRuntime
  readonly store: CodeMeshStore
}

describe('two executors racing for one turn', () => {
  it('converge on one claim and one outcome', async () => {
    const cleanups: Array<() => void | Promise<void>> = []
    const dir = await mkdtemp(path.join(tmpdir(), 'qvac-code-chaos-'))
    const testnet = await createTestnet(3, {
      teardown: (cleanup: () => void | Promise<void>) => {
        cleanups.push(cleanup)
      }
    })
    const runtimes: SyncRuntime[] = []
    try {
      const host = createSync({
        storagePath: path.join(dir, 'host'),
        bootstrap: testnet.bootstrap
      })
      runtimes.push(host)
      await host.ready()

      const invite = await host.mesh.createInvite({ expiresInMs: 5 * 60_000 })
      const joiner = createSync({
        storagePath: path.join(dir, 'joiner'),
        bootstrap: testnet.bootstrap,
        pairingInvite: invite.invite
      })
      runtimes.push(joiner)

      // ready() on a first-pairing client does not resolve until the host
      // approves, so approval has to run concurrently with it.
      const approving = approvePairing(host)
      await joiner.ready()
      expect(await approving).toBeGreaterThan(0)
      await waitFor(async () => (await joiner.mesh.status()).writable, PAIRING_TIMEOUT_MS)

      const first: Peer = { sync: host, store: storeFor(host) }
      const second: Peer = { sync: joiner, store: storeFor(joiner) }

      // One turn, no `target`, so both executors consider themselves eligible.
      const sessionId = createSessionId('chaos:1')
      await first.store.createSession({
        sessionId,
        title: 'chaos',
        projectLabel: 'chaos-project',
        model: 'deterministic',
        createdBy: 'tester'
      })
      await first.store.createTurn({
        sessionId,
        seq: 0,
        prompt: 'race for me',
        requestedBy: 'tester'
      })
      const turnWorkId = formatTurnWorkId({ sessionId, seq: 0 })
      await waitFor(
        async () => (await second.store.getWork(turnWorkId)) != null,
        PAIRING_TIMEOUT_MS
      )

      const controller = new AbortController()
      const ranOn: string[] = []
      const executors = [first, second].map((peer, index) => {
        const identity = identityFor(index)
        return {
          identity,
          executor: createExecutor({
            store: peer.store,
            assistant: {
              registerAgent: async () => {},
              run: () => Object.assign((async function* () {})(), { id: 'unused' }),
              cancelRun: async () => {}
            },
            identity,
            model: 'deterministic',
            // A fake runner: this test is about the claim, not about inference.
            // It still records the outcome, which is what has to converge.
            turnRunner: {
              async run(input) {
                ranOn.push(identity.executorId)
                const outcome = await peer.store.recordOutcome({
                  workId: input.turnWorkId,
                  status: 'completed',
                  result: Buffer.from(`ran on ${identity.executorId}`)
                })
                return {
                  status: 'completed',
                  finalText: `ran on ${identity.executorId}`,
                  outcome
                } satisfies TurnRunResult
              }
            },
            approvals: {
              track: () => ({ release: () => {} }),
              start: async () => {},
              closeTurn: async () => {},
              reconcile: async () => {}
            },
            now: () => Date.now(),
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            allowSecondExecutor: true
          })
        }
      })

      await Promise.all(
        executors.map(({ executor }) => executor.run(controller.signal))
          .map((running) => Promise.race([running, delay(CLAIM_SETTLE_MS)]))
      )
      controller.abort('chaos test finished')
      await delay(1_000)

      // What must hold: the mesh converged on one claim and one outcome.
      const claims = await Promise.all(
        [first, second].map(async (peer) => {
          const gates = await peer.store.listGates(turnWorkId)
          const claim = gates.find((gate) => gate.gateId === CODE_CLAIM_GATE_ID)
          return parseClaimDecision(claim?.decision)?.executorId ?? null
        })
      )
      const winner = claims[0] ?? null
      expect(winner).not.toBeNull()
      expect(claims[1] ?? null).toBe(winner)

      const outcomes = await Promise.all(
        [first, second].map(async (peer) => (await peer.store.getWork(turnWorkId))?.outcomeStatus ?? null)
      )
      expect(outcomes[0]).toBe('completed')
      expect(outcomes[1]).toBe('completed')

      // The transcript shows only the surviving claim owner's entries; a losing
      // writer's entries survive the merge because append-journal never
      // arbitrates, so they must be filtered out at projection time.
      const [work, entries, gates] = await Promise.all([
        first.store.getWork(turnWorkId),
        first.store.listJournal(turnWorkId),
        first.store.listGates(turnWorkId)
      ])
      if (!work) throw new Error('turn work row disappeared')
      const view = projectTurn({ work, entries, gates })
      expect(view.claimedBy).toBe(winner)

      const writers = new Set(
        entries
          .map((entry) => decodeJournalBody(entry.body)?.writer)
          .filter((value): value is string => typeof value === 'string')
      )
      // Recorded, not asserted: how many executors actually believed they won
      // and started work is exactly what R1 leaves open.
      console.log(
        `▸ chaos: winner=${winner} ran=${JSON.stringify(ranOn)} journalWriters=${JSON.stringify([...writers])}`
      )
      expect(ranOn.length).toBeGreaterThan(0)
    } finally {
      for (const runtime of runtimes) await runtime.close().catch(() => {})
      for (const cleanup of cleanups.reverse()) await cleanup()
      await rm(dir, { recursive: true, force: true })
    }
  }, 180_000)
})

function storeFor(sync: SyncRuntime) {
  return createCodeMeshStore({ work: sync.openProfile(durableWorkProfile) })
}

function identityFor(index: number): ExecutorIdentity {
  return {
    executorId: formatExecutorId({ hostname: `chaos-host-${index}`, projectHash: 'chaoshash' }),
    hostname: `chaos-host-${index}`,
    projectRoot: '/tmp/chaos-project',
    projectLabel: 'chaos-project'
  }
}

async function approvePairing(host: SyncRuntime) {
  return waitFor(async () => {
    const iterator = host.mesh.watchPairingRequests()[Symbol.asyncIterator]()
    const next = await iterator.next()
    await iterator.return?.()
    if (next.done) return null
    const pending = next.value.requests.filter((request) => request.status === 'pending')
    if (pending.length === 0) return null
    for (const request of pending) await host.mesh.approvePairingRequest(request.id)
    return pending.length
  }, PAIRING_TIMEOUT_MS)
}

async function waitFor<T>(query: () => Promise<T>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await query()
    if (value !== false && value != null) return value
    await delay(100)
  }
  throw new Error('waitFor timed out')
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}
