import path from '#path'

// Pure, no I/O. The single place that decides whether a path is in scope for
// the coding skill, shared by the host's validateCall and the sandbox
// executor so both halves apply the same rule independently (see host.ts for
// why that duplication is deliberate).
//
// This is defence in depth, not the security boundary: it never calls
// realpath, so a symlink that points outside the project root is not caught
// here. Symlink escape is contained by the seatbelt profile's write roots,
// which the sandbox process is launched under — that is the real boundary.
export type ResolvedPath =
  | { readonly ok: true; readonly absolute: string; readonly relative: string }
  | { readonly ok: false; readonly error: string }

export function resolveProjectPath(input: {
  readonly projectRoot: string
  readonly requested: string
}): ResolvedPath {
  const { projectRoot, requested } = input
  if (!path.isAbsolute(projectRoot)) {
    return { ok: false, error: 'project root must be an absolute path' }
  }
  if (requested.includes('\0')) {
    return { ok: false, error: 'path must not contain a NUL byte' }
  }
  if (!requested.trim()) {
    return { ok: false, error: 'path must not be empty' }
  }

  const root = stripTrailingSeparator(path.normalize(projectRoot))
  const combined = path.isAbsolute(requested)
    ? requested
    : path.join(projectRoot, requested)
  const candidate = stripTrailingSeparator(path.normalize(combined))

  if (!isWithinRoot(candidate, root)) {
    return { ok: false, error: `path escapes the project root: ${requested}` }
  }
  // Root '/' already ends in the separator, so the slice must not skip an
  // extra character the way it does for every other root.
  const rootPrefixLength = root === path.sep ? root.length : root.length + 1
  const relative = candidate === root ? '' : candidate.slice(rootPrefixLength)
  return { ok: true, absolute: candidate, relative }
}

// A boundary match, not a prefix match: `/repo-evil` must not pass for root
// `/repo`, so the root is compared with a trailing separator appended. Root
// `/` is a special case: it already ends in the separator, so appending
// another would require candidates to start with `//`, rejecting everything.
function isWithinRoot(candidate: string, root: string) {
  if (root === path.sep) return candidate.startsWith(path.sep)
  return candidate === root || candidate.startsWith(`${root}${path.sep}`)
}

function stripTrailingSeparator(value: string) {
  if (value.length > 1 && value.endsWith(path.sep)) return value.slice(0, -1)
  return value
}

// A relative path (as returned by resolveProjectPath) is version-control
// internals. Write access here is not "editing configuration": a hook under
// `.git/hooks` executes with the developer's full host privileges the next
// time they run git — entirely outside this skill's own sandbox, and outside
// the approval prompt that gated the write that planted it. There is no
// legitimate reason for this skill to write inside `.git`, so callers that
// mutate (write, edit) must refuse a path this returns true for. Read access
// is not refused here: reading `.git/config` is ordinary and harmless.
export function isVersionControlInternal(relative: string): boolean {
  return relative === '.git' || relative.startsWith(`.git${path.sep}`)
}
