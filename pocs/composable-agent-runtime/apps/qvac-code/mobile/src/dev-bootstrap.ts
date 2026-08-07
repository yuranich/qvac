// Test wiring, not product surface. An Android emulator sits behind a NAT
// that would otherwise leave replication to UDP holepunching against the
// public DHT, which is unreliable from an emulator -- so a developer can
// point a simulator at a local HyperDHT testnet instead. This must never
// become a real configuration key: @qvac/config governs product settings,
// and this env var exists only to unblock manual device testing.

export interface BootstrapNode {
  readonly host: string
  readonly port: number
}

const BOOTSTRAP_ENV_VAR = 'EXPO_PUBLIC_QVAC_BOOTSTRAP'
const MIN_PORT = 1
const MAX_PORT = 65_535

export function readDevBootstrap(
  env: Readonly<Record<string, string | undefined>>
): readonly BootstrapNode[] | undefined {
  const raw = env[BOOTSTRAP_ENV_VAR]
  if (raw == null || raw.trim().length === 0) return undefined
  return raw.split(',').map((entry) => parseBootstrapNode(entry.trim()))
}

function parseBootstrapNode(entry: string): BootstrapNode {
  const separatorIndex = entry.lastIndexOf(':')
  if (separatorIndex <= 0 || separatorIndex === entry.length - 1) {
    throw invalidEntry(entry, 'expected host:port')
  }
  const host = entry.slice(0, separatorIndex)
  const portText = entry.slice(separatorIndex + 1)
  if (!/^[0-9]+$/.test(portText)) {
    throw invalidEntry(entry, 'port must be numeric')
  }
  const port = Number(portText)
  if (!Number.isSafeInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw invalidEntry(entry, `port must be between ${MIN_PORT} and ${MAX_PORT}`)
  }
  return { host, port }
}

function invalidEntry(entry: string, reason: string) {
  return new Error(
    `Invalid ${BOOTSTRAP_ENV_VAR} entry ${JSON.stringify(entry)}: ${reason}`
  )
}
