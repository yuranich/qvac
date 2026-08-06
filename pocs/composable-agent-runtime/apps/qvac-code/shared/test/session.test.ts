import { describe, expect, test } from 'bun:test'
import {
  decodeSessionPayload,
  decodeTurnPayload,
  encodeSessionPayload,
  encodeTurnPayload,
  type CodeSessionPayload,
  type CodeTurnPayload
} from '../session.ts'
import { decodeJsonBytes, encodeJsonBytes } from '../codec.ts'

describe('session payloads', function () {
  test('round-trips a session payload', function () {
    const payload: CodeSessionPayload = {
      kind: 'code-session',
      title: 'Fix the parser',
      projectLabel: 'composable-agent-runtime',
      model: 'local-model',
      createdBy: 'device-a'
    }
    expect(decodeSessionPayload(encodeSessionPayload(payload))).toEqual(payload)
  })

  test('round-trips a turn payload', function () {
    const payload: CodeTurnPayload = {
      kind: 'code-turn',
      sessionId: 'abc123',
      seq: 3,
      prompt: 'run the tests',
      requestedBy: 'device-a'
    }
    expect(decodeTurnPayload(encodeTurnPayload(payload))).toEqual(payload)
  })

  test('projectLabel may be an empty string (display-only)', function () {
    const payload: CodeSessionPayload = {
      kind: 'code-session',
      title: 'title',
      projectLabel: '',
      model: 'model',
      createdBy: 'device-a'
    }
    expect(decodeSessionPayload(encodeSessionPayload(payload)).projectLabel).toBe('')
  })

  test('rejects a session payload with the wrong kind discriminant', function () {
    const bytes = encodeJsonBytes({
      kind: 'code-turn',
      title: 't',
      projectLabel: 'p',
      model: 'm',
      createdBy: 'c'
    })
    expect(() => decodeSessionPayload(bytes)).toThrow('Invalid code session payload')
  })

  test('rejects a session payload missing required string fields', function () {
    expect(() =>
      decodeSessionPayload(
        encodeJsonBytes({ kind: 'code-session', title: '', projectLabel: 'p', model: 'm', createdBy: 'c' })
      )
    ).toThrow()
    expect(() =>
      decodeSessionPayload(
        encodeJsonBytes({ kind: 'code-session', title: 't', projectLabel: 'p', model: '', createdBy: 'c' })
      )
    ).toThrow()
    expect(() =>
      decodeSessionPayload(
        encodeJsonBytes({ kind: 'code-session', title: 't', projectLabel: 'p', model: 'm', createdBy: '' })
      )
    ).toThrow()
  })

  test('rejects a session payload that is not an object', function () {
    expect(() => decodeSessionPayload(encodeJsonBytes('not-an-object'))).toThrow()
    expect(() => decodeSessionPayload(encodeJsonBytes(null))).toThrow()
  })

  test('rejects a turn payload with a negative or non-integer seq', function () {
    const base = { kind: 'code-turn', sessionId: 's', prompt: 'p', requestedBy: 'r' }
    expect(() => decodeTurnPayload(encodeJsonBytes({ ...base, seq: -1 }))).toThrow(
      'Invalid code turn payload'
    )
    expect(() => decodeTurnPayload(encodeJsonBytes({ ...base, seq: 1.5 }))).toThrow(
      'Invalid code turn payload'
    )
    expect(() => decodeTurnPayload(encodeJsonBytes({ ...base, seq: '1' }))).toThrow(
      'Invalid code turn payload'
    )
  })

  test('rejects a turn payload missing sessionId or requestedBy', function () {
    const base = { kind: 'code-turn', seq: 1, prompt: 'p' }
    expect(() => decodeTurnPayload(encodeJsonBytes({ ...base, sessionId: '', requestedBy: 'r' }))).toThrow()
    expect(() => decodeTurnPayload(encodeJsonBytes({ ...base, sessionId: 's', requestedBy: '' }))).toThrow()
  })

  test('turn payload prompt may be an empty string', function () {
    const payload: CodeTurnPayload = {
      kind: 'code-turn',
      sessionId: 's',
      seq: 0,
      prompt: '',
      requestedBy: 'r'
    }
    expect(decodeJsonBytes<CodeTurnPayload>(encodeTurnPayload(payload))).toEqual(payload)
  })
})
