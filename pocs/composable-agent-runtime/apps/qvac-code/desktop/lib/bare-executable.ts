import { access, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, join } from 'node:path'

/**
 * The harness launches each per-agent tool sandbox by spawning `bare` directly,
 * so it needs an absolute path rather than a name to look up. Resolution order
 * puts an explicit choice first and the workspace's own pinned runtime ahead of
 * whatever happens to be on PATH, because a globally installed `bare` of a
 * different major would load prebuilds this workspace never built.
 */
export async function resolveBareExecutable(explicit?: string) {
  const candidates = [
    explicit,
    process.env.QVAC_BARE_EXECUTABLE,
    ...workspaceCandidates(),
    ...pathCandidates()
  ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate !== '')

  for (const candidate of candidates) {
    const resolved = await executableAt(candidate)
    if (resolved) return resolved
  }
  throw new Error(
    'Could not find a bare executable. Pass --bare <path> or set QVAC_BARE_EXECUTABLE.'
  )
}

function workspaceCandidates() {
  // This file sits at apps/qvac-code/desktop/lib, so the workspace root is four
  // levels up. Checked before PATH so a monorepo checkout is self-contained.
  const workspaceRoot = new URL('../../../../', import.meta.url)
  return [join(workspaceRoot.pathname, 'node_modules', '.bin', 'bare')]
}

function pathCandidates() {
  const path = process.env.PATH
  if (!path) return []
  return path.split(delimiter).map((directory) => join(directory, 'bare'))
}

async function executableAt(candidate: string) {
  try {
    await access(candidate, constants.X_OK)
    return await realpath(candidate)
  } catch {
    // A candidate that is absent or not executable is not an error: the list is
    // deliberately a fallback chain, and the caller reports only total failure.
    return null
  }
}
