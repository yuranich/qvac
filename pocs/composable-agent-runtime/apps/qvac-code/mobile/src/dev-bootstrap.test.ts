import { describe, expect, test } from 'bun:test'
import { readDevBootstrap } from './dev-bootstrap.ts'

describe('dev bootstrap override', () => {
  test('falls back to the public DHT when the env var is unset', () => {
    expect(readDevBootstrap({})).toBeUndefined()
  })

  test('falls back to the public DHT when the env var is blank', () => {
    expect(readDevBootstrap({ EXPO_PUBLIC_QVAC_BOOTSTRAP: '   ' })).toBeUndefined()
  })

  test('parses a single host:port entry', () => {
    expect(
      readDevBootstrap({ EXPO_PUBLIC_QVAC_BOOTSTRAP: '10.0.2.2:49737' })
    ).toEqual([{ host: '10.0.2.2', port: 49737 }])
  })

  test('parses a comma-separated list and trims whitespace', () => {
    expect(
      readDevBootstrap({
        EXPO_PUBLIC_QVAC_BOOTSTRAP: '10.0.2.2:49737, localhost:49738 ,127.0.0.1:1'
      })
    ).toEqual([
      { host: '10.0.2.2', port: 49737 },
      { host: 'localhost', port: 49738 },
      { host: '127.0.0.1', port: 1 }
    ])
  })

  test('throws on an entry missing a port', () => {
    expect(() =>
      readDevBootstrap({ EXPO_PUBLIC_QVAC_BOOTSTRAP: '10.0.2.2' })
    ).toThrow(/expected host:port/)
  })

  test('throws on an entry with a trailing colon and no port', () => {
    expect(() =>
      readDevBootstrap({ EXPO_PUBLIC_QVAC_BOOTSTRAP: '10.0.2.2:' })
    ).toThrow(/expected host:port/)
  })

  test('throws on a non-numeric port', () => {
    expect(() =>
      readDevBootstrap({ EXPO_PUBLIC_QVAC_BOOTSTRAP: '10.0.2.2:abc' })
    ).toThrow(/port must be numeric/)
  })

  test('throws on a port out of range', () => {
    expect(() =>
      readDevBootstrap({ EXPO_PUBLIC_QVAC_BOOTSTRAP: '10.0.2.2:70000' })
    ).toThrow(/port must be between/)
    expect(() =>
      readDevBootstrap({ EXPO_PUBLIC_QVAC_BOOTSTRAP: '10.0.2.2:0' })
    ).toThrow(/port must be between/)
  })

  test('throws on one malformed entry within an otherwise valid list', () => {
    expect(() =>
      readDevBootstrap({ EXPO_PUBLIC_QVAC_BOOTSTRAP: '10.0.2.2:49737,garbage' })
    ).toThrow(/expected host:port/)
  })
})
