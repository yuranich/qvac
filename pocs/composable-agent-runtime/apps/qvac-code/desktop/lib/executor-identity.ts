import crypto from '#crypto'
import fs from '#fs-promises'
import path from '#path'
import { formatExecutorId } from '@qvac-poc/qvac-code-shared'

/** Hex characters of the sha256(realpath) kept in the executor id. Short
 * enough to keep the id readable, long enough that two different project
 * paths on one host will not collide in practice. */
const PROJECT_HASH_LENGTH = 12

export interface ExecutorIdentity {
  readonly executorId: string
  readonly hostname: string
  readonly projectRoot: string
  readonly projectLabel: string
}

/**
 * Derives this executor's identity from the host machine and the project it
 * serves -- nothing else. That is deliberate: the id must be stable across
 * process restarts so a crashed executor's orphaned claim is recognisable as
 * "ours" the next time this machine starts an executor for the same project
 * (see claim.ts's `claimedInThisProcess` doc comment and executor.ts's
 * `recoverOrphans`). Deriving it from anything that changes across restarts
 * (a random id, a pid, a boot timestamp) would make crash recovery
 * impossible: a fresh identity could never reclaim, and thus never mark
 * failed, a turn an earlier process abandoned mid-run.
 *
 * The project root is realpath'd before hashing so that two different
 * spellings of the same directory (e.g. a macOS `/tmp` path and its
 * `/private/tmp` resolution) produce one identity, not two.
 */
export async function resolveExecutorIdentity(input: {
  readonly projectRoot: string
  readonly hostname: string
}): Promise<ExecutorIdentity> {
  const realProjectRoot = await fs.realpath(input.projectRoot)
  const projectHash = crypto
    .createHash('sha256')
    .update(realProjectRoot)
    .digest('hex')
    .slice(0, PROJECT_HASH_LENGTH)
  const executorId = formatExecutorId({ hostname: input.hostname, projectHash })
  return {
    executorId,
    hostname: input.hostname,
    projectRoot: realProjectRoot,
    projectLabel: path.basename(realProjectRoot)
  }
}
