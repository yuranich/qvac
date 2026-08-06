import { describe, expect, test } from 'bun:test'
import {
  createSessionId,
  formatExecutorId,
  formatSessionWorkId,
  formatTurnWorkId,
  isExecutorId,
  isTurnOfSession,
  parseCodeWorkId,
  requireExecutorId
} from '../ids.ts'
import { formatClaimDecision, parseClaimDecision } from '../claim.ts'
import { formatApprovalGateId } from '../approval.ts'

describe('ids', function () {
  test('formats and round-trips a session work id', function () {
    const workId = formatSessionWorkId('abc123')
    expect(workId).toBe('code/abc123')
    expect(parseCodeWorkId(workId)).toEqual({ kind: 'session', sessionId: 'abc123' })
  })

  test('formats and round-trips a turn work id, padding seq to 6 digits', function () {
    const workId = formatTurnWorkId({ sessionId: 'abc123', seq: 7 })
    expect(workId).toBe('code/abc123/turn/000007')
    expect(parseCodeWorkId(workId)).toEqual({ kind: 'turn', sessionId: 'abc123', seq: 7 })
  })

  test('round-trips a large seq at the padding width', function () {
    const workId = formatTurnWorkId({ sessionId: 's', seq: 999999 })
    expect(workId).toBe('code/s/turn/999999')
    expect(parseCodeWorkId(workId)).toEqual({ kind: 'turn', sessionId: 's', seq: 999999 })
  })

  test('isTurnOfSession matches only turns of the given session', function () {
    const workId = formatTurnWorkId({ sessionId: 'abc123', seq: 1 })
    expect(isTurnOfSession(workId, 'abc123')).toBe(true)
    expect(isTurnOfSession(workId, 'other')).toBe(false)
    expect(isTurnOfSession(formatSessionWorkId('abc123'), 'abc123')).toBe(false)
  })

  test('parseCodeWorkId rejects unrelated or malformed ids', function () {
    expect(parseCodeWorkId('')).toBeNull()
    expect(parseCodeWorkId('code')).toBeNull()
    expect(parseCodeWorkId('other/abc123')).toBeNull()
    expect(parseCodeWorkId('code/abc123/turn')).toBeNull()
    expect(parseCodeWorkId('code/abc123/turn/1')).toBeNull() // not zero-padded to 6
    expect(parseCodeWorkId('code/abc123/turn/00000a')).toBeNull() // not numeric
    expect(parseCodeWorkId('code/abc123/step/000001')).toBeNull() // wrong segment
    expect(parseCodeWorkId('code/abc123/turn/000001/extra')).toBeNull()
    expect(parseCodeWorkId('application/vnd.qvac.harness-run+json')).toBeNull()
  })

  test('formatSessionWorkId rejects invalid session ids', function () {
    expect(() => formatSessionWorkId('')).toThrow()
    expect(() => formatSessionWorkId('has/slash')).toThrow()
    expect(() => formatSessionWorkId('has space')).toThrow()
    expect(() => formatSessionWorkId('has\ttab')).toThrow()
  })

  test('formatTurnWorkId rejects invalid seq values', function () {
    expect(() => formatTurnWorkId({ sessionId: 's', seq: -1 })).toThrow()
    expect(() => formatTurnWorkId({ sessionId: 's', seq: 1.5 })).toThrow()
    expect(() => formatTurnWorkId({ sessionId: 's', seq: 1_000_000 })).toThrow()
    expect(() => formatTurnWorkId({ sessionId: 's', seq: Number.NaN })).toThrow()
  })

  test('createSessionId is deterministic given the same entropy', function () {
    expect(createSessionId('device-a:1')).toBe(createSessionId('device-a:1'))
  })

  test('createSessionId differs for different entropy and is url-safe', function () {
    const first = createSessionId('device-a:1')
    const second = createSessionId('device-a:2')
    expect(first).not.toBe(second)
    for (const id of [first, second]) {
      expect(id).toMatch(/^[0-9a-z]+$/)
      expect(() => formatSessionWorkId(id)).not.toThrow()
    }
  })

  test('createSessionId rejects empty entropy', function () {
    expect(() => createSessionId('')).toThrow()
  })
})

/**
 * An executor id is embedded in the slash-delimited claim decision and
 * approval gate id, so a slash in it would make those tokens unparseable. The
 * constraint lives in one place precisely so a caller cannot invent an id that
 * only fails later, at claim time, on a real mesh.
 */
describe('executor ids', function () {
  test('sanitises hostname and project hash into a slash-free id', function () {
    const id = formatExecutorId({
      hostname: 'my-mac.local',
      projectHash: 'a1b2c3'
    })
    expect(id).toBe('code-my_mac_local-a1b2c3')
    expect(isExecutorId(id)).toBe(true)
  })

  test('is stable for the same host and project', function () {
    const input = { hostname: 'host', projectHash: 'hash' }
    expect(formatExecutorId(input)).toBe(formatExecutorId(input))
  })

  test('distinguishes two projects on one host', function () {
    expect(formatExecutorId({ hostname: 'h', projectHash: 'one' })).not.toBe(
      formatExecutorId({ hostname: 'h', projectHash: 'two' })
    )
  })

  test('rejects parts that sanitise away to nothing', function () {
    expect(() => formatExecutorId({ hostname: '///', projectHash: 'x' })).toThrow(
      /hostname and a project hash/
    )
    expect(() => formatExecutorId({ hostname: 'h', projectHash: '  ' })).toThrow()
  })

  test('rejects a slash-bearing id everywhere it would break a token', function () {
    const slashed = 'code/laptop/abc'
    expect(isExecutorId(slashed)).toBe(false)
    expect(() => requireExecutorId(slashed)).toThrow(/Invalid executor id/)
    expect(() => formatClaimDecision(slashed)).toThrow(/Invalid executor id/)
    expect(() => formatApprovalGateId({ executorId: slashed, index: 1 })).toThrow(
      /Invalid executor id/
    )
  })

  test('round-trips a sanitised id through a claim decision', function () {
    const id = formatExecutorId({ hostname: 'mac.local', projectHash: 'deadbeef' })
    expect(parseClaimDecision(formatClaimDecision(id))).toEqual({ executorId: id })
  })

  test('rejects an over-long id rather than truncating it', function () {
    expect(() => requireExecutorId(`code-${'a'.repeat(200)}`)).toThrow()
  })
})
