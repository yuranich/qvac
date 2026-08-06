import { describe, expect, it } from 'vitest'
import type { HarnessSkillInfo } from '@qvac/harness'
import { createAssistantFacade } from '../lib/facade.ts'
import { startHarnessComponent } from '../lib/adapters.ts'
import type {
  AssistantComponent,
  AssistantHarnessComponent,
  AssistantSyncComponent,
  CreateAssistantOptions
} from '../lib/contracts.ts'

/**
 * Skills belong to applications, so an application composing through this
 * facade has to be able to name the worker entries that import them and read
 * back what those entries made available. Before `workers`/`host` were carried
 * through, the only way to reach an application's own skills was to bypass
 * Assistant and drive Harness directly.
 */
describe('application-owned skills through the facade', () => {
  it('reports the skills the harness component exposes', async () => {
    const skills: readonly HarnessSkillInfo[] = [
      { name: 'qvac-code', description: 'Read, search and edit a project.' }
    ]
    const assistant = createAssistantFacade(
      {},
      {
        startSync: async () => syncComponent(),
        startHarness: async () =>
          harnessComponent({
            listSkills: async () => skills
          })
      }
    )

    await assistant.ready()
    expect(await assistant.listSkills()).toEqual(skills)
    await assistant.close()
  })

  it('carries worker entries and per-skill host configuration to Harness', async () => {
    const calls: Array<Record<string, unknown>> = []
    const options: CreateAssistantOptions = {
      workers: {
        harnessChildEntry: '/entries/harness.js',
        toolSandboxChildEntry: '/entries/sandbox.js'
      },
      host: {
        platform: 'darwin',
        skills: { 'qvac-code': { projectRoot: '/repo' } }
      }
    }

    await startHarnessComponent(fakeSyncRuntime(), {
      inference: { kind: 'deterministic' },
      ...(options.workers ? { workers: options.workers } : {}),
      ...(options.host ? { host: options.host } : {}),
      // Injected so the assertion does not depend on spawning a Bare worker.
      createHarness: (input) => {
        calls.push(input as unknown as Record<string, unknown>)
        return fakeHarnessRuntime()
      }
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.workers).toEqual(options.workers)
    expect(calls[0]?.host).toEqual(options.host)
  })

  it('omits both when the application supplies neither', async () => {
    const calls: Array<Record<string, unknown>> = []
    await startHarnessComponent(fakeSyncRuntime(), {
      inference: { kind: 'deterministic' },
      createHarness: (input) => {
        calls.push(input as unknown as Record<string, unknown>)
        return fakeHarnessRuntime()
      }
    })
    expect(calls[0]).not.toHaveProperty('workers')
    expect(calls[0]).not.toHaveProperty('host')
  })
})

function syncComponent(): AssistantSyncComponent {
  return {
    ...baseComponent('sync'),
    state: fakeSyncRuntime()
  } as AssistantSyncComponent
}

function harnessComponent(
  harness: Partial<AssistantHarnessComponent['harness']>
): AssistantHarnessComponent {
  return {
    ...baseComponent('harness'),
    harness: harness as AssistantHarnessComponent['harness']
  } as AssistantHarnessComponent
}

function baseComponent(name: 'sync' | 'harness'): AssistantComponent {
  return {
    handshake: {
      contract: `qvac.${name}`,
      protocolVersion: name === 'sync' ? 1 : 2,
      capabilities:
        name === 'sync'
          ? [
              'profile-protocol',
              'durable-work',
              'passive-replication',
              'writer-pairing'
            ]
          : [
              'agent.register',
              'agent.run',
              'agent.cancel',
              'run.read',
              'work.watch',
              'state.port'
            ],
      requiredPeerCapabilities: [],
      buildVersion: '0.0.0-poc'
    },
    close: async () => {}
  }
}

function fakeSyncRuntime() {
  return {
    openDurableWorkProfile: () => ({
      apply: async () => ({ revision: 'r1' }),
      query: async () => ({ works: [], entries: [], gates: [], executors: [] }),
      watch: () => (async function* () {})()
    })
  } as unknown as AssistantSyncComponent['state']
}

function fakeHarnessRuntime() {
  return {
    exited: new Promise(() => {}),
    lifecycle: { suspend: async () => {}, resume: async () => {} },
    runtime: {
      describe: async () => ({
        component: 'harness' as const,
        runtime: 'bare' as const,
        instanceId: 'harness-test',
        processId: 1,
        protocolVersion: 2,
        buildVersion: '0.0.0-poc',
        contract: 'qvac.harness',
        capabilities: [
          'agent.register',
          'agent.run',
          'agent.cancel',
          'run.read',
          'work.watch',
          'state.port'
        ],
        requiredPeerCapabilities: []
      })
    },
    ready: async () => {},
    listSkills: async () => [],
    registerAgent: async () => {},
    runAgent: () => (async function* () {})(),
    cancelAgentRun: async () => {},
    readRun: async () => null,
    watchWork: () => (async function* () {})(),
    watchApprovals: () => (async function* () {})(),
    resolveApproval: async () => {},
    close: async () => {}
  } as unknown as ReturnType<typeof import('@qvac/harness').createHarness>
}
