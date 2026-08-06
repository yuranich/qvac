import { describe, expect, test } from 'bun:test'
import {
  resolveAllowedCommand,
  SHELL_ALLOWLIST
} from '../lib/skills-impl/coding/shell-allowlist.ts'

describe('resolveAllowedCommand', function () {
  test.each(
    SHELL_ALLOWLIST.map((entry) => [entry.id, entry.executable, entry.argv] as const)
  )('resolves the allowlisted command: %s', function (_id, executable, argv) {
    const command = [executable, ...argv].join(' ')
    const result = resolveAllowedCommand(command)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.command.executable).toBe(executable)
    expect(result.command.argv).toEqual(argv)
  })

  test.each([
    ['pipe', 'git status --short | cat'],
    ['ampersand', 'git status --short & id'],
    ['semicolon', 'git status --short; id'],
    ['redirect-out', 'git diff > /tmp/out'],
    ['redirect-in', 'git diff < /tmp/in'],
    ['dollar-substitution', 'git diff $(id)'],
    ['backtick-substitution', 'git diff `id`'],
    ['parens', 'bun test (id)'],
    ['braces', 'bun test {id}'],
    ['brackets', 'bun test [id]'],
    ['star', 'bun test *'],
    ['question', 'bun test ?'],
    ['tilde', 'bun test ~'],
    ['bang', 'bun test !'],
    ['hash', 'bun test #comment'],
    ['backslash', 'bun test \\x'],
    ['newline', 'bun test\nid'],
    ['carriage-return', 'bun test\rid'],
    ['tab', 'bun test\tlint'],
    ['nul', 'bun test\0']
  ])('rejects the %s metacharacter', function (_label, command) {
    const result = resolveAllowedCommand(command)
    expect(result.ok).toBe(false)
  })

  test('rejects single and double quotes entirely', function () {
    expect(resolveAllowedCommand('git log --oneline -n "10"').ok).toBe(false)
    expect(resolveAllowedCommand("git log --oneline -n '10'").ok).toBe(false)
  })

  test('rejects an extra argument appended to an allowed command', function () {
    const result = resolveAllowedCommand('git status --short --extra')
    expect(result.ok).toBe(false)
  })

  test('rejects a prefix of an allowed command', function () {
    expect(resolveAllowedCommand('git status').ok).toBe(false)
    expect(resolveAllowedCommand('git').ok).toBe(false)
  })

  test('is case sensitive', function () {
    expect(resolveAllowedCommand('Git status --short').ok).toBe(false)
    expect(resolveAllowedCommand('GIT STATUS --SHORT').ok).toBe(false)
  })

  test('rejects an empty command', function () {
    expect(resolveAllowedCommand('').ok).toBe(false)
    expect(resolveAllowedCommand('   ').ok).toBe(false)
  })

  test('rejects runs of extra spaces even between otherwise-valid tokens', function () {
    expect(resolveAllowedCommand('git  status --short').ok).toBe(false)
  })

  test('rejects a command not on the allowlist', function () {
    const result = resolveAllowedCommand('rm -rf /')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/allowlist/)
  })
})
