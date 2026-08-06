import { SDK_DEFAULT_PLUGINS } from '@qvac/sdk/plugin-utils'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GENERATED_SDK_CONFIG_MARKER,
  resolveAssistantAppConfig,
  writeGeneratedSdkConfig
} from '../lib/expo/app-config.ts'
import {
  buildCapabilityCatalog,
  capabilityCatalog,
  resolveCapability
} from '../lib/expo/capabilities.ts'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((entry) => rm(entry, { force: true, recursive: true }))
  )
})

describe('assistant app config', () => {
  it('selects every built-in SDK plugin without an Assistant-owned entry', () => {
    // The catalog is derived from the installed SDK, so a plugin SDK adds is
    // selectable with no change here. This asserts the derivation, not a list.
    for (const specifier of SDK_DEFAULT_PLUGINS) {
      const canonical = specifier.replace('@qvac/sdk/', '').replace('/plugin', '')
      expect(resolveCapability(canonical)).toEqual({ capability: canonical, specifier })
    }
    expect(capabilityCatalog().specifiers.size).toBe(SDK_DEFAULT_PLUGINS.length)
  })

  it('accepts SDK aliases and resolves them to the canonical capability', () => {
    expect(resolveCapability('llm')).toEqual({
      capability: 'llamacpp-completion',
      specifier: '@qvac/sdk/llamacpp-completion/plugin'
    })
    expect(resolveCapability('ocr')?.specifier).toBe('@qvac/sdk/ggml-ocr/plugin')

    // Every alias must point at a plugin that is actually bundled.
    for (const [alias, canonical] of capabilityCatalog().aliases) {
      expect(capabilityCatalog().specifiers.has(canonical)).toBe(true)
      expect(resolveCapability(alias)?.capability).toBe(canonical)
    }
  })

  it('picks up a plugin a future SDK adds, with no code change', () => {
    const catalog = buildCapabilityCatalog(
      [...SDK_DEFAULT_PLUGINS, '@qvac/sdk/webgpu-imagination/plugin'],
      { webgpuImagination: 'webgpu-imagination', dream: 'webgpu-imagination' },
      { webgpuImagination: 'webgpu-imagination' }
    )

    expect(resolveCapability('webgpu-imagination', catalog)).toEqual({
      capability: 'webgpu-imagination',
      specifier: '@qvac/sdk/webgpu-imagination/plugin'
    })
    expect(resolveCapability('dream', catalog)?.capability).toBe('webgpu-imagination')
  })

  it('passes a third-party plugin specifier through verbatim', async () => {
    const projectRoot = await createProject(`
      version: 1
      inference:
        capabilities:
          - llm
          - qvac-echo-plugin/plugin
    `)

    const resolved = await resolveAssistantAppConfig(projectRoot)

    expect(resolved?.capabilities).toEqual(['llamacpp-completion', 'qvac-echo-plugin/plugin'])
    expect(resolved?.plugins).toEqual([
      '@qvac/sdk/llamacpp-completion/plugin',
      'qvac-echo-plugin/plugin'
    ])
  })

  it('resolves a capability list to SDK plugin specifiers', async () => {
    const projectRoot = await createProject(`
      version: 1
      logging:
        level: debug
      inference:
        capabilities:
          - llamacpp-completion
    `)

    const resolved = await resolveAssistantAppConfig(projectRoot)

    expect(resolved?.capabilities).toEqual(['llamacpp-completion'])
    expect(resolved?.plugins).toEqual(['@qvac/sdk/llamacpp-completion/plugin'])
    expect(resolved?.loggerLevel).toBe('debug')
  })

  it('treats an alias and its canonical name as one selection', async () => {
    const projectRoot = await createProject(`
      version: 1
      inference:
        capabilities:
          - llm
          - llamacpp-completion
    `)
    await expect(resolveAssistantAppConfig(projectRoot)).rejects.toThrow(
      /duplicate inference capability llamacpp-completion/i
    )
  })

  it('sorts and rejects duplicate capabilities so the bundle is deterministic', async () => {
    const projectRoot = await createProject(`
      version: 1
      inference:
        capabilities:
          - whisper
          - llm
    `)
    const resolved = await resolveAssistantAppConfig(projectRoot)
    expect(resolved?.capabilities).toEqual(['llamacpp-completion', 'whispercpp-transcription'])

    const duplicated = await createProject(`
      version: 1
      inference:
        capabilities:
          - llm
          - llm
    `)
    await expect(resolveAssistantAppConfig(duplicated)).rejects.toThrow(
      /duplicate inference capability llamacpp-completion/i
    )
  })

  it('returns null when the project has no assistant config', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'assistant-app-config-absent-'))
    temporaryPaths.push(projectRoot)
    expect(await resolveAssistantAppConfig(projectRoot)).toBeNull()
  })

  it('keeps every capability when the inference section is omitted', async () => {
    const projectRoot = await createProject(`
      version: 1
      logging:
        level: warn
    `)
    const resolved = await resolveAssistantAppConfig(projectRoot)
    expect(resolved?.capabilities).toBeNull()
    expect(resolved?.plugins).toBeNull()
    expect(resolved?.loggerLevel).toBe('warn')
  })

  it('writes a generated SDK config the SDK plugin can read', async () => {
    const projectRoot = await createProject(`
      version: 1
      logging:
        level: info
      inference:
        capabilities:
          - llm
        bareRuntimeVersion: 1.30.0
    `)
    const resolved = await resolveAssistantAppConfig(projectRoot)
    if (resolved === null) throw new Error('expected a resolved config')

    const generatedPath = await writeGeneratedSdkConfig(projectRoot, resolved)

    expect(generatedPath).toBe(path.join(projectRoot, 'qvac.config.json'))
    expect(await readJson(generatedPath)).toEqual({
      '//': GENERATED_SDK_CONFIG_MARKER,
      plugins: ['@qvac/sdk/llamacpp-completion/plugin'],
      loggerLevel: 'info',
      bareRuntimeVersion: '1.30.0'
    })
  })

  it('overwrites its own generated config but never a hand-written one', async () => {
    const projectRoot = await createProject(`
      version: 1
      inference:
        capabilities:
          - llm
    `)
    const resolved = await resolveAssistantAppConfig(projectRoot)
    if (resolved === null) throw new Error('expected a resolved config')

    await writeGeneratedSdkConfig(projectRoot, resolved)
    await expect(writeGeneratedSdkConfig(projectRoot, resolved)).resolves.toBeTruthy()

    await writeFile(
      path.join(projectRoot, 'qvac.config.json'),
      `${JSON.stringify({ plugins: [] }, null, 2)}\n`
    )
    await expect(writeGeneratedSdkConfig(projectRoot, resolved)).rejects.toThrow(
      /refusing to overwrite hand-written qvac\.config\.json/i
    )
  })

  it('fails closed when a higher-precedence SDK config would win', async () => {
    const projectRoot = await createProject(`
      version: 1
      inference:
        capabilities:
          - llm
    `)
    await writeFile(path.join(projectRoot, 'qvac.config.js'), 'export default {}\n')
    const resolved = await resolveAssistantAppConfig(projectRoot)
    if (resolved === null) throw new Error('expected a resolved config')

    await expect(writeGeneratedSdkConfig(projectRoot, resolved)).rejects.toThrow(
      /conflicting sdk configuration: qvac\.config\.js/i
    )
  })

  it('rejects an unknown capability and lists the valid names', async () => {
    const projectRoot = await createProject(`
      version: 1
      inference:
        capabilities:
          - transcribe
    `)
    await expect(resolveAssistantAppConfig(projectRoot)).rejects.toThrow(
      /unknown inference capability "transcribe".*llamacpp-completion.*my-plugin\/plugin/is
    )
  })

  it('rejects an empty capability list rather than bundling nothing', async () => {
    const projectRoot = await createProject(`
      version: 1
      inference:
        capabilities: []
    `)
    await expect(resolveAssistantAppConfig(projectRoot)).rejects.toThrow(
      /must name at least one capability/i
    )
  })

  it('rejects a misspelled key instead of silently ignoring it', async () => {
    const projectRoot = await createProject(`
      version: 1
      inferance:
        capabilities:
          - llm
    `)
    await expect(resolveAssistantAppConfig(projectRoot)).rejects.toThrow(
      /unknown assistant config key "inferance"/i
    )
  })

  it('resolves declared accelerators and distinguishes absence from CPU-only', async () => {
    const declared = await createProject(`
      version: 1
      inference:
        capabilities:
          - llm
        accelerators:
          - vulkan
          - cpu
    `)
    expect((await resolveAssistantAppConfig(declared))?.accelerators).toEqual(['cpu', 'vulkan'])

    const cpuOnly = await createProject(`
      version: 1
      inference:
        capabilities:
          - llm
        accelerators: []
    `)
    expect((await resolveAssistantAppConfig(cpuOnly))?.accelerators).toEqual([])

    const unspecified = await createProject(`
      version: 1
      inference:
        capabilities:
          - llm
    `)
    expect((await resolveAssistantAppConfig(unspecified))?.accelerators).toBeNull()
  })

  it('rejects an unknown or duplicated accelerator', async () => {
    const unknown = await createProject(`
      version: 1
      inference:
        capabilities:
          - llm
        accelerators:
          - cuda
    `)
    await expect(resolveAssistantAppConfig(unknown)).rejects.toThrow(
      /unknown inference accelerator "cuda".*vulkan/is
    )

    const duplicated = await createProject(`
      version: 1
      inference:
        capabilities:
          - llm
        accelerators:
          - vulkan
          - vulkan
    `)
    await expect(resolveAssistantAppConfig(duplicated)).rejects.toThrow(
      /duplicate inference accelerator vulkan/i
    )
  })

  it('rejects a project carrying both config filenames', async () => {
    const projectRoot = await createProject('version: 1\n')
    await writeFile(path.join(projectRoot, 'qvac.assistant.yml'), 'version: 1\n')

    await expect(resolveAssistantAppConfig(projectRoot)).rejects.toThrow(
      /multiple assistant config files.*keep exactly one/is
    )
  })

  it('rejects an unsupported version, a bad log level, and malformed YAML', async () => {
    const wrongVersion = await createProject('version: 2\n')
    await expect(resolveAssistantAppConfig(wrongVersion)).rejects.toThrow(
      /unsupported assistant config version/i
    )

    const badLevel = await createProject(`
      version: 1
      logging:
        level: chatty
    `)
    await expect(resolveAssistantAppConfig(badLevel)).rejects.toThrow(
      /logging\.level must be one of/i
    )

    const malformed = await createProject('version: 1\n  bad: [indent\n')
    await expect(resolveAssistantAppConfig(malformed)).rejects.toThrow(
      /malformed assistant config yaml/i
    )
  })
})

async function createProject(yamlSource: string) {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'assistant-app-config-'))
  temporaryPaths.push(projectRoot)
  await writeFile(path.join(projectRoot, 'qvac.assistant.yaml'), dedent(yamlSource))
  return projectRoot
}

/** Test fixtures are indented to match their call site; YAML is not. */
function dedent(source: string) {
  const lines = source.replace(/^\n/, '').replace(/\s+$/, '').split('\n')
  const indent = Math.min(
    ...lines
      .filter((line) => line.trim().length > 0)
      .map((line) => line.length - line.trimStart().length)
  )
  return `${lines.map((line) => line.slice(indent)).join('\n')}\n`
}

async function readJson(filePath: string) {
  return JSON.parse(await readFile(filePath, 'utf8')) as unknown
}
