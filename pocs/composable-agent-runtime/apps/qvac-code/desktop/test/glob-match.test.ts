import { describe, expect, test } from 'bun:test'
import { matchesGlob } from '../lib/skills-impl/coding/glob-match.ts'

describe('matchesGlob', function () {
  test('* matches within one path segment only', function () {
    expect(matchesGlob('*.ts', 'index.ts')).toBe(true)
    expect(matchesGlob('*.ts', 'src/index.ts')).toBe(false)
  })

  test('* matches an empty run', function () {
    expect(matchesGlob('a*b', 'ab')).toBe(true)
    expect(matchesGlob('a*b', 'axxxb')).toBe(true)
  })

  test('** matches across path segments, including none', function () {
    expect(matchesGlob('**/*.ts', 'index.ts')).toBe(true)
    expect(matchesGlob('**/*.ts', 'src/lib/index.ts')).toBe(true)
    expect(matchesGlob('src/**/index.ts', 'src/a/b/index.ts')).toBe(true)
    expect(matchesGlob('src/**/index.ts', 'src/index.ts')).toBe(true)
  })

  test('**/ only matches on a path-segment boundary, not a partial segment', function () {
    // A naive '**' -> '.*' translation would let '**/build' match
    // 'notbuild', since '.*' has no notion of segment boundaries.
    expect(matchesGlob('**/build', 'notbuild')).toBe(false)
    expect(matchesGlob('**/build', 'src/notbuild')).toBe(false)
    expect(matchesGlob('**/build', 'build')).toBe(true)
    expect(matchesGlob('**/build', 'src/build')).toBe(true)
    expect(matchesGlob('**/build', 'src/nested/build')).toBe(true)
  })

  test('? matches exactly one character', function () {
    expect(matchesGlob('a?c', 'abc')).toBe(true)
    expect(matchesGlob('a?c', 'ac')).toBe(false)
    expect(matchesGlob('a?c', 'abbc')).toBe(false)
  })

  test('rejects a non-matching path', function () {
    expect(matchesGlob('*.ts', 'index.js')).toBe(false)
    expect(matchesGlob('src/*.ts', 'lib/index.ts')).toBe(false)
  })

  test('a literal path with no wildcard must match exactly', function () {
    expect(matchesGlob('README.md', 'README.md')).toBe(true)
    expect(matchesGlob('README.md', 'docs/README.md')).toBe(false)
  })

  test('character classes are not supported: brackets are literal characters', function () {
    // A conventional glob library would treat '[tj]s' as "t or j, then s".
    // This matcher does not: '[' and ']' only match themselves.
    expect(matchesGlob('index.[tj]s', 'index.ts')).toBe(false)
    expect(matchesGlob('index.[tj]s', 'index.js')).toBe(false)
    expect(matchesGlob('index.[tj]s', 'index.[tj]s')).toBe(true)
  })
})
