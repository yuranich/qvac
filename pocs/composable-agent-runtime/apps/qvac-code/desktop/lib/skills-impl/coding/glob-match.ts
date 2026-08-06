// Pure, no I/O. A minimal glob matcher for the coding skill's `glob` tool and
// `grep`'s `include` filter — not a general globbing library. Supports `*`
// (any run of characters within one path segment), `**` (any run of
// characters, including path separators), and `?` (exactly one character).
// Character classes (`[abc]`) are intentionally not supported: `[` and `]`
// are matched as literal characters.
export function matchesGlob(pattern: string, candidate: string): boolean {
  return compileGlob(pattern).test(candidate)
}

// Exposed separately so a caller matching many candidates against the same
// pattern (glob's directory walk, grep's include filter) compiles once
// instead of recompiling per file.
export function compileGlob(pattern: string): RegExp {
  let source = '^'
  let index = 0
  while (index < pattern.length) {
    const char = pattern.charAt(index)
    if (char === '*' && pattern.charAt(index + 1) === '*') {
      if (pattern.charAt(index + 2) === '/') {
        // '**/' matches zero or more *whole* path segments: either nothing
        // (so '**/foo' also matches 'foo' at the root), or some prefix that
        // lands exactly on a '/' boundary. A plain '.*' here would let
        // '**/build' match 'notbuild', since '.*' has no notion of segment
        // boundaries in the candidate — only the optional group's trailing
        // literal '/' enforces one.
        source += '(?:.*/)?'
        index += 3
        continue
      }
      // A bare '**' with nothing after it (or not followed by '/') has no
      // boundary to anchor to, so it stays an unanchored run.
      source += '.*'
      index += 2
      continue
    }
    if (char === '*') {
      source += '[^/]*'
      index += 1
      continue
    }
    if (char === '?') {
      source += '[^/]'
      index += 1
      continue
    }
    source += escapeRegExpChar(char)
    index += 1
  }
  source += '$'
  return new RegExp(source)
}

const REGEXP_SPECIAL = /[.+^${}()|[\]\\]/

function escapeRegExpChar(char: string) {
  return REGEXP_SPECIAL.test(char) ? `\\${char}` : char
}
