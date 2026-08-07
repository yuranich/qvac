import { describe, expect, test } from 'bun:test'
import { createDeltaBatcher } from '../delta-batcher.ts'

describe('delta batcher', function () {
  test('buffers below both thresholds', function () {
    const batcher = createDeltaBatcher({ maxBytes: 100, maxDelayMs: 1000 })
    expect(batcher.push('hello', 0)).toEqual({ kind: 'buffer' })
    expect(batcher.push(' world', 10)).toEqual({ kind: 'buffer' })
  })

  test('flushes once buffered byte length reaches maxBytes', function () {
    const batcher = createDeltaBatcher({ maxBytes: 10, maxDelayMs: 1000 })
    expect(batcher.push('12345', 0)).toEqual({ kind: 'buffer' })
    expect(batcher.push('67890', 1)).toEqual({ kind: 'flush', text: '1234567890' })
    // The buffer is reset after a flush.
    expect(batcher.push('x', 2)).toEqual({ kind: 'buffer' })
  })

  test('flushes once the delay ceiling is reached even under the byte threshold', function () {
    const batcher = createDeltaBatcher({ maxBytes: 1000, maxDelayMs: 100 })
    expect(batcher.push('a', 0)).toEqual({ kind: 'buffer' })
    expect(batcher.push('b', 150)).toEqual({ kind: 'flush', text: 'ab' })
  })

  test('tick only flushes once the delay ceiling is reached, and only if something is buffered', function () {
    const batcher = createDeltaBatcher({ maxBytes: 1000, maxDelayMs: 100 })
    expect(batcher.tick(50)).toEqual({ kind: 'buffer' }) // nothing buffered yet
    batcher.push('a', 0)
    expect(batcher.tick(50)).toEqual({ kind: 'buffer' }) // under the ceiling
    expect(batcher.tick(100)).toEqual({ kind: 'flush', text: 'a' })
  })

  test('drain flushes whatever is buffered regardless of thresholds', function () {
    const batcher = createDeltaBatcher({ maxBytes: 1000, maxDelayMs: 1000 })
    batcher.push('partial', 0)
    expect(batcher.drain(1)).toEqual({ kind: 'flush', text: 'partial' })
  })

  test('never emits a flush with empty text', function () {
    const batcher = createDeltaBatcher({ maxBytes: 1, maxDelayMs: 1 })
    expect(batcher.push('', 0)).toEqual({ kind: 'buffer' })
    expect(batcher.tick(1000)).toEqual({ kind: 'buffer' })
    expect(batcher.drain(1000)).toEqual({ kind: 'buffer' })
  })

  test('counts multi-byte UTF-8 characters by bytes, not string length', function () {
    // Each emoji is 4 UTF-8 bytes but 2 UTF-16 code units in a JS string.
    const emoji = '🎉'
    expect(emoji.length).toBe(2)
    const batcher = createDeltaBatcher({ maxBytes: 8, maxDelayMs: 100000 })
    expect(batcher.push(emoji, 0)).toEqual({ kind: 'buffer' }) // 4 bytes, under 8
    expect(batcher.push(emoji, 1)).toEqual({ kind: 'flush', text: emoji + emoji }) // 8 bytes, reaches threshold
  })

  test('after the per-turn entry budget is reached, emits one truncate then suppresses the rest', function () {
    const batcher = createDeltaBatcher({ maxBytes: 1, maxDelayMs: 100000, maxEntriesPerTurn: 3 })
    expect(batcher.push('a', 0)).toEqual({ kind: 'flush', text: 'a' })
    expect(batcher.push('b', 1)).toEqual({ kind: 'flush', text: 'b' })
    expect(batcher.push('c', 2)).toEqual({ kind: 'truncate', text: 'c' })
    expect(batcher.push('d', 3)).toEqual({ kind: 'suppress' })
    expect(batcher.tick(100000)).toEqual({ kind: 'suppress' })
    expect(batcher.drain(200000)).toEqual({ kind: 'suppress' })
  })
})
