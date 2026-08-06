// Pure, no I/O. The shell tool runs no shell: a requested command is matched
// against a fixed set of argv shapes and, on a match, the matched argv is
// spawned directly (see sandbox.ts). Matching is exact-list-membership rather
// than a shell-syntax parser on purpose — a parser that understands quoting,
// escaping, and operators is itself an attack surface, and this demo only
// ever needs to run the commands below.
export interface AllowedCommand {
  readonly id: string
  readonly executable: string
  readonly argv: readonly string[]
  readonly summary: string
}

export const SHELL_ALLOWLIST: readonly AllowedCommand[] = [
  {
    id: 'git-status',
    executable: 'git',
    argv: ['status', '--short'],
    summary: 'Show the working tree status (short form).'
  },
  {
    id: 'git-diff',
    executable: 'git',
    argv: ['diff'],
    summary: 'Show unstaged changes.'
  },
  {
    id: 'git-diff-stat',
    executable: 'git',
    argv: ['diff', '--stat'],
    summary: 'Show a diffstat of unstaged changes.'
  },
  {
    id: 'git-log',
    executable: 'git',
    argv: ['log', '--oneline', '-n', '10'],
    summary: 'Show the last 10 commits, one line each.'
  },
  {
    id: 'bun-test',
    executable: 'bun',
    argv: ['test'],
    summary: 'Run the project test suite.'
  },
  {
    id: 'bun-typecheck',
    executable: 'bun',
    argv: ['run', 'typecheck'],
    summary: 'Run the TypeScript type checker.'
  },
  {
    id: 'bun-lint',
    executable: 'bun',
    argv: ['run', 'lint'],
    summary: 'Run the linter.'
  },
  {
    id: 'node-version',
    executable: 'node',
    argv: ['--version'],
    summary: 'Print the installed Node.js version.'
  },
  {
    id: 'bun-version',
    executable: 'bun',
    argv: ['--version'],
    summary: 'Print the installed Bun version.'
  }
]

export type ShellResolution =
  | { readonly ok: true; readonly command: AllowedCommand }
  | { readonly ok: false; readonly error: string }

// Everything a shell would treat specially, plus quotes (accepted nowhere —
// there is no argument that ever needs one) and control characters.
const FORBIDDEN_CHARACTERS = /[|&;<>$`(){}[\]*?~!#\\'"\n\r\t\0]/

export function resolveAllowedCommand(requested: string): ShellResolution {
  if (!requested.trim()) {
    return { ok: false, error: 'command is required' }
  }
  if (FORBIDDEN_CHARACTERS.test(requested)) {
    return { ok: false, error: 'command contains a disallowed character' }
  }
  // Runs of more than one space produce empty tokens that cannot match any
  // allowlist entry, so no separate whitespace-normalisation step is needed.
  const tokens = requested.split(' ')
  for (const entry of SHELL_ALLOWLIST) {
    if (tokensMatch(tokens, [entry.executable, ...entry.argv])) {
      return { ok: true, command: entry }
    }
  }
  return { ok: false, error: `command is not on the allowlist: ${requested}` }
}

function tokensMatch(actual: readonly string[], expected: readonly string[]) {
  if (actual.length !== expected.length) return false
  return actual.every((token, index) => token === expected[index])
}
