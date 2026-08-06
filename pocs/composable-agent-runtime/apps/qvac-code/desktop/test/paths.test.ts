import { describe, expect, test } from 'bun:test'
import { isVersionControlInternal, resolveProjectPath } from '../lib/skills-impl/coding/paths.ts'

const ROOT = '/repo'

describe('resolveProjectPath', function () {
  test('accepts a relative path inside the root', function () {
    expect(resolveProjectPath({ projectRoot: ROOT, requested: 'src/index.ts' })).toEqual({
      ok: true,
      absolute: '/repo/src/index.ts',
      relative: 'src/index.ts'
    })
  })

  test('accepts an absolute path inside the root', function () {
    expect(
      resolveProjectPath({ projectRoot: ROOT, requested: '/repo/src/index.ts' })
    ).toEqual({
      ok: true,
      absolute: '/repo/src/index.ts',
      relative: 'src/index.ts'
    })
  })

  test('accepts the root itself', function () {
    expect(resolveProjectPath({ projectRoot: ROOT, requested: '.' })).toEqual({
      ok: true,
      absolute: '/repo',
      relative: ''
    })
  })

  test('rejects a relative .. that escapes the root', function () {
    const result = resolveProjectPath({ projectRoot: ROOT, requested: '../secret' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/escapes/)
  })

  test('rejects a relative path whose .. segments net outside the root', function () {
    const result = resolveProjectPath({
      projectRoot: ROOT,
      requested: 'src/../../etc/passwd'
    })
    expect(result.ok).toBe(false)
  })

  test('rejects an absolute sibling that merely shares the root as a string prefix', function () {
    // '/repo-evil' starts with the literal string '/repo' but is not inside
    // it; only a '/'-bounded prefix match may pass.
    const result = resolveProjectPath({ projectRoot: ROOT, requested: '/repo-evil' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/escapes/)
  })

  test('rejects a relative sibling that merely shares the root as a string prefix', function () {
    const result = resolveProjectPath({
      projectRoot: ROOT,
      requested: '../repo-evil/secret'
    })
    expect(result.ok).toBe(false)
  })

  test('rejects a path containing a NUL byte', function () {
    const result = resolveProjectPath({ projectRoot: ROOT, requested: 'a\0b' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/NUL/)
  })

  test('rejects an empty path', function () {
    const result = resolveProjectPath({ projectRoot: ROOT, requested: '' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/empty/)
  })

  test('rejects a whitespace-only path', function () {
    const result = resolveProjectPath({ projectRoot: ROOT, requested: '   ' })
    expect(result.ok).toBe(false)
  })

  test('rejects a non-absolute project root', function () {
    const result = resolveProjectPath({ projectRoot: 'repo', requested: 'file.ts' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/absolute/)
  })

  test('accepts an in-scope path when the project root is the filesystem root', function () {
    // The '/repo' + '/' boundary check does not generalize to root '/'
    // without a special case: appending another separator would require
    // every candidate to start with '//', rejecting everything.
    expect(resolveProjectPath({ projectRoot: '/', requested: 'etc/passwd' })).toEqual({
      ok: true,
      absolute: '/etc/passwd',
      relative: 'etc/passwd'
    })
    expect(resolveProjectPath({ projectRoot: '/', requested: '/etc/passwd' })).toEqual({
      ok: true,
      absolute: '/etc/passwd',
      relative: 'etc/passwd'
    })
  })
})

describe('isVersionControlInternal', function () {
  test('flags the .git directory and anything under it', function () {
    expect(isVersionControlInternal('.git')).toBe(true)
    expect(isVersionControlInternal('.git/config')).toBe(true)
    expect(isVersionControlInternal('.git/hooks/pre-commit')).toBe(true)
  })

  test('does not flag ordinary paths, including ones that merely start with .git', function () {
    expect(isVersionControlInternal('src/index.ts')).toBe(false)
    expect(isVersionControlInternal('.gitignore')).toBe(false)
    expect(isVersionControlInternal('.github/workflows/ci.yml')).toBe(false)
    expect(isVersionControlInternal('')).toBe(false)
  })
})
