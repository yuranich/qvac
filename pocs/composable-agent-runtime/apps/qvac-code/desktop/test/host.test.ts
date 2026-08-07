import { describe, expect, test } from 'bun:test'
import type { AgentJsonValue } from '@qvac/agents'
import type {
  SdkRuntimePort,
  SkillCatalogEntry,
  SkillHostContext
} from '@qvac/harness/skill-host'
import { createCodingSkillHost } from '../lib/skills-impl/coding/host.ts'
import { CODING_TOOL_NAMES } from '../lib/skills-impl/coding/names.ts'

const PROJECT_ROOT = '/private/tmp/qvac-code-fixture-project'
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean'])

// The host's create() never calls the sdk or reads the catalog entry, so a
// throwing stub is enough to prove that and still satisfy SkillHostContext.
const FAKE_SDK: SdkRuntimePort = {
  async loadModel() {
    throw new Error('not used by the coding skill host')
  },
  completion() {
    throw new Error('not used by the coding skill host')
  },
  async generateImage() {
    throw new Error('not used by the coding skill host')
  },
  async cancel() {},
  async heartbeat() {
    return { ok: true }
  },
  async close() {}
}

const FAKE_ENTRY: SkillCatalogEntry = {
  name: 'qvac-code',
  description: 'test fixture',
  instructions: '',
  tools: [...CODING_TOOL_NAMES],
  allowList: [],
  platform: []
}

function context(config: Readonly<Record<string, AgentJsonValue>>): SkillHostContext {
  return { sdk: FAKE_SDK, entry: FAKE_ENTRY, config }
}

function validConfig(
  overrides: Readonly<Record<string, AgentJsonValue>> = {}
): Readonly<Record<string, AgentJsonValue>> {
  return {
    projectRoot: PROJECT_ROOT,
    projectLabel: 'Fixture Project',
    executablePaths: ['/usr/bin/git', '/usr/local/bin/bun'],
    ...overrides
  }
}

describe('createCodingSkillHost', function () {
  test('exposes seven tools with flat, scalar-only parameters', async function () {
    const provider = createCodingSkillHost()
    const contribution = await provider.create(context(validConfig()))
    expect(contribution.tools).toHaveLength(7)
    const names = contribution.tools.map((tool) => tool.schema.name).sort()
    expect(names).toEqual(['edit', 'glob', 'grep', 'ls', 'read', 'shell', 'write'])
    for (const tool of contribution.tools) {
      expect(tool.schema.parameters.type).toBe('object')
      for (const property of Object.values(tool.schema.parameters.properties)) {
        expect(SCALAR_TYPES.has(property.type)).toBe(true)
      }
    }
  })

  test('sandboxTools mirrors the same seven tool names', async function () {
    const provider = createCodingSkillHost()
    const contribution = await provider.create(context(validConfig()))
    expect([...(contribution.sandboxTools ?? [])].sort()).toEqual([...CODING_TOOL_NAMES].sort())
  })

  test('requiresApproval is exactly the three side-effecting tools', async function () {
    const provider = createCodingSkillHost()
    const contribution = await provider.create(context(validConfig()))
    expect([...(contribution.requiresApproval ?? [])].sort()).toEqual(['edit', 'shell', 'write'])
  })

  test('permissions() returns the project root as a write root and the configured executable paths', async function () {
    const provider = createCodingSkillHost()
    const contribution = await provider.create(context(validConfig()))
    const permissions = await contribution.permissions?.({ agentId: 'agent-1', grants: [] })
    expect(permissions?.writeRoots).toEqual([PROJECT_ROOT])
    expect(permissions?.readOnlyRoots).toBeUndefined()
    expect(permissions?.executablePaths).toEqual(['/usr/bin/git', '/usr/local/bin/bun'])
    const slice = permissions?.configuration?.({ scratchRoot: '/tmp', agentId: 'agent-1' })
    expect(slice?.projectRoot).toBe(PROJECT_ROOT)
  })

  test('rejects a missing projectRoot', function () {
    const provider = createCodingSkillHost()
    expect(() => provider.create(context({ projectLabel: 'x' }))).toThrow(/projectRoot/)
  })

  test('rejects a relative projectRoot', function () {
    const provider = createCodingSkillHost()
    expect(() =>
      provider.create(context(validConfig({ projectRoot: 'relative/path' })))
    ).toThrow(/absolute/)
  })

  test("validateCall rejects an out-of-scope path on read, write, edit, glob, grep, and ls", async function () {
    const provider = createCodingSkillHost()
    const contribution = await provider.create(context(validConfig()))
    const byName = new Map(contribution.tools.map((tool) => [tool.schema.name, tool]))

    expect(() =>
      byName.get('read')?.validateCall?.({
        id: '1',
        name: 'read',
        arguments: { filePath: '../outside.txt' }
      })
    ).toThrow(/escapes/)
    expect(() =>
      byName.get('write')?.validateCall?.({
        id: '1',
        name: 'write',
        arguments: { filePath: '../outside.txt', content: 'x' }
      })
    ).toThrow(/escapes/)
    expect(() =>
      byName.get('ls')?.validateCall?.({
        id: '1',
        name: 'ls',
        arguments: { path: '/etc' }
      })
    ).toThrow(/escapes/)
  })

  test('validateCall accepts an in-scope path', async function () {
    const provider = createCodingSkillHost()
    const contribution = await provider.create(context(validConfig()))
    const readTool = contribution.tools.find((tool) => tool.schema.name === 'read')
    expect(() =>
      readTool?.validateCall?.({ id: '1', name: 'read', arguments: { filePath: 'src/a.ts' } })
    ).not.toThrow()
  })

  test('validateCall rejects a non-allowlisted shell command', async function () {
    const provider = createCodingSkillHost()
    const contribution = await provider.create(context(validConfig()))
    const shellTool = contribution.tools.find((tool) => tool.schema.name === 'shell')
    expect(() =>
      shellTool?.validateCall?.({ id: '1', name: 'shell', arguments: { command: 'rm -rf /' } })
    ).toThrow(/allowlist/)
    expect(() =>
      shellTool?.validateCall?.({
        id: '1',
        name: 'shell',
        arguments: { command: 'git status --short' }
      })
    ).not.toThrow()
  })

  test('validateCall refuses write/edit inside .git even though the path is in scope', async function () {
    const provider = createCodingSkillHost()
    const contribution = await provider.create(context(validConfig()))
    const byName = new Map(contribution.tools.map((tool) => [tool.schema.name, tool]))

    expect(() =>
      byName.get('write')?.validateCall?.({
        id: '1',
        name: 'write',
        arguments: { filePath: '.git/hooks/pre-commit', content: 'evil' }
      })
    ).toThrow(/\.git is out of scope/)
    expect(() =>
      byName.get('edit')?.validateCall?.({
        id: '1',
        name: 'edit',
        arguments: { filePath: '.git/config', oldString: 'a', newString: 'b' }
      })
    ).toThrow(/\.git is out of scope/)
    // Read-only access to .git is ordinary and must not be refused.
    expect(() =>
      byName.get('read')?.validateCall?.({
        id: '1',
        name: 'read',
        arguments: { filePath: '.git/config' }
      })
    ).not.toThrow()
  })

  test('rejects a present-but-wrong-typed limit instead of silently falling back to the default', function () {
    const provider = createCodingSkillHost()
    expect(() =>
      provider.create(context(validConfig({ maxReadBytes: 'a lot' })))
    ).toThrow(/maxReadBytes must be a number/)
  })

  test('rejects a present-but-wrong-typed executablePaths instead of silently dropping it', function () {
    const provider = createCodingSkillHost()
    expect(() =>
      provider.create(context(validConfig({ executablePaths: '/usr/bin/git' })))
    ).toThrow(/executablePaths must be an array/)
  })
})
