import { describe, expect, test } from 'bun:test'
import { applyEdit } from '../lib/skills-impl/coding/edit.ts'

describe('applyEdit', function () {
  test('replaces a single occurrence', function () {
    expect(
      applyEdit({
        contents: 'const a = 1\nconst b = 2\n',
        oldString: 'const a = 1',
        newString: 'const a = 100',
        replaceAll: false
      })
    ).toEqual({
      ok: true,
      contents: 'const a = 100\nconst b = 2\n',
      replacements: 1
    })
  })

  test('rejects an ambiguous match and names the count', function () {
    const result = applyEdit({
      contents: 'x\nx\nx\n',
      oldString: 'x',
      newString: 'y',
      replaceAll: false
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('3')
    expect(result.error).toMatch(/replaceAll/)
  })

  test('replaceAll replaces every occurrence and counts them', function () {
    expect(
      applyEdit({ contents: 'x\nx\nx\n', oldString: 'x', newString: 'y', replaceAll: true })
    ).toEqual({ ok: true, contents: 'y\ny\ny\n', replacements: 3 })
  })

  test('rejects an oldString that is not found', function () {
    const result = applyEdit({
      contents: 'hello world',
      oldString: 'missing',
      newString: 'x',
      replaceAll: false
    })
    expect(result).toEqual({ ok: false, error: 'oldString not found in content' })
  })

  test('rejects identical oldString and newString', function () {
    const result = applyEdit({
      contents: 'hello world',
      oldString: 'hello',
      newString: 'hello',
      replaceAll: false
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/identical/)
  })

  test('treats regex metacharacters in oldString literally', function () {
    const contents = 'price: $5 (was $10.00)\nother: $5x\n'
    const result = applyEdit({
      contents,
      oldString: '$5 (was $10.00)',
      newString: '$5 (was $12.00)',
      replaceAll: false
    })
    expect(result).toEqual({
      ok: true,
      contents: 'price: $5 (was $12.00)\nother: $5x\n',
      replacements: 1
    })
  })

  test('a metacharacter-heavy oldString that matches nowhere literally still reports not-found', function () {
    const result = applyEdit({
      contents: 'abc',
      oldString: 'a.c',
      newString: 'x',
      replaceAll: false
    })
    // '.' is not a wildcard here: 'abc' does not literally contain 'a.c'.
    expect(result).toEqual({ ok: false, error: 'oldString not found in content' })
  })
})
