import { describe, expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { join, sep } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const VERSION = '0.0.0-poc'
const PRODUCT_PACKAGES = [
  '@qvac/config',
  '@qvac/supervisor',
  '@qvac/agents',
  '@qvac/sync',
  '@qvac/harness',
  '@qvac/assistant'
] as const
const APP_DIRECTORIES = [
  'skill-cli',
  'task-cli',
  'task-mobile',
  'task-shared',
  'qvac-code/shared',
  'qvac-code/desktop',
  'qvac-code/mobile'
] as const
const APP_ALLOWED = new Map<string, readonly string[]>([
  ['@qvac-poc/skill-cli', ['@qvac/agents', '@qvac/harness']],
  ['@qvac-poc/task-cli', ['@qvac/assistant', '@qvac-poc/task-shared']],
  ['@qvac-poc/task-mobile', ['@qvac/assistant', '@qvac-poc/task-shared']],
  ['@qvac-poc/task-shared', ['@qvac/sync']],
  ['@qvac-poc/qvac-code-shared', ['@qvac/sync']],
  [
    '@qvac-poc/qvac-code-desktop',
    [
      '@qvac/agents',
      '@qvac/assistant',
      '@qvac/harness',
      // Test-only; see APP_TEST_ONLY. Production code here reaches replicated
      // state through Assistant, which is the point of the facade.
      '@qvac/sync',
      '@qvac-poc/qvac-code-shared'
    ]
  ],
  // Sync only. The thin client runs no inference and executes no tools, so
  // reaching @qvac/harness or @qvac/assistant from here would retract the
  // standalone-Sync claim this app exists to prove.
  ['@qvac-poc/qvac-code-mobile', ['@qvac/sync', '@qvac-poc/qvac-code-shared']]
])
/**
 * Dependencies an app may declare but must not import from shipped source. The
 * claim-chaos integration test pairs two independent Sync meshes to exercise the
 * arbitration the executor depends on, which no Assistant call can set up.
 */
const APP_TEST_ONLY = new Map<string, readonly string[]>([
  ['@qvac-poc/qvac-code-desktop', ['@qvac/sync']]
])
const INTERNAL_NAMES = new Set([
  ...PRODUCT_PACKAGES,
  ...APP_ALLOWED.keys()
])

const ALLOWED = new Map<string, readonly string[]>([
  ['@qvac/config', []],
  ['@qvac/supervisor', []],
  ['@qvac/agents', []],
  ['@qvac/sync', ['@qvac/config', '@qvac/supervisor']],
  [
    '@qvac/harness',
    ['@qvac/agents', '@qvac/config', '@qvac/supervisor', '@qvac/sync']
  ],
  [
    '@qvac/assistant',
    ['@qvac/config', '@qvac/harness', '@qvac/supervisor', '@qvac/sync']
  ]
])

interface Manifest {
  name: string
  version: string
  private: boolean
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

describe('package subsets', function () {
  test('private package manifests form the approved acyclic dependency graph', async function () {
    const manifests = await readManifests()
    const graph = new Map<string, string[]>()

    for (const manifest of manifests) {
      expect(manifest.private).toBe(true)
      expect(manifest.version).toBe(VERSION)
      const internal = Object.entries(manifest.dependencies ?? {}).filter(([name]) =>
        isProductPackage(name)
      )
      const allowed = ALLOWED.get(manifest.name) ?? []
      for (const [dependency, version] of internal) {
        expect(allowed).toContain(dependency)
        expect(version).toBe(VERSION)
      }
      graph.set(
        manifest.name,
        internal.map(([name]) => name)
      )
    }

    expect(findCycle(graph)).toBeNull()
  })

  test('source imports do not bypass manifest dependency rules', async function () {
    const manifests = await readManifests()

    for (const manifest of manifests) {
      const directory = packageDirectory(manifest.name)
      const files = await collectTypeScriptFiles(directory)
      const declared = manifest.dependencies ?? {}
      for (const file of files) {
        const source = await readFile(file, 'utf8')
        for (const dependency of productImports(source)) {
          expect(declared[dependency]).toBe(VERSION)
          expect(ALLOWED.get(manifest.name) ?? []).toContain(dependency)
        }
      }
    }
  })

  test('app source imports stay within declared package boundaries', async function () {
    const manifests = await readAppManifests()
    for (const [directoryName, manifest] of manifests) {
      expect(manifest.private).toBe(true)
      expect(manifest.version).toBe(VERSION)
      const allowed = APP_ALLOWED.get(manifest.name) ?? []
      const files = await collectTypeScriptFiles(join(ROOT, 'apps', directoryName))
      for (const file of files) {
        const source = await readFile(file, 'utf8')
        for (const dependency of internalImports(source)) {
          expect(declaredVersion(manifest, dependency)).toBe(VERSION)
          expect(allowed).toContain(dependency)
        }
      }
    }
  })

  /**
   * Some app dependencies exist only so an integration test can build a topology
   * no facade call can produce -- two independent meshes, say. Allowing those in
   * the app's dependency list without this check would silently permit its
   * production code to bypass the facade it is meant to compose through.
   */
  test('test-only app dependencies stay out of shipped source', async function () {
    for (const [name, dependencies] of APP_TEST_ONLY) {
      const directoryName = appDirectoryFor(name)
      const files = await collectTypeScriptFiles(join(ROOT, 'apps', directoryName))
      for (const file of files) {
        if (isTestFile(file)) continue
        const source = await readFile(file, 'utf8')
        for (const dependency of internalImports(source)) {
          expect(dependencies).not.toContain(dependency)
        }
      }
    }
  })

  test('standalone layers do not install unrelated product packages', async function () {
    const manifests = new Map((await readManifests()).map((manifest) => [manifest.name, manifest]))

    expect(internalDependencies(manifests.get('@qvac/agents'))).toEqual([])
    expect(internalDependencies(manifests.get('@qvac/config'))).toEqual([])
    expect(internalDependencies(manifests.get('@qvac/supervisor'))).toEqual([])
    expect(internalDependencies(manifests.get('@qvac/sync'))).toEqual([
      '@qvac/config',
      '@qvac/supervisor'
    ])
    for (const manifest of manifests.values()) {
      expect(manifest.dependencies?.['@qvac/ai-sdk-provider']).toBeUndefined()
    }
  })
})

async function readManifests() {
  return Promise.all(
    PRODUCT_PACKAGES.map(async (name) => {
      const path = join(packageDirectory(name), 'package.json')
      return JSON.parse(await readFile(path, 'utf8')) as Manifest
    })
  )
}

async function readAppManifests() {
  return Promise.all(
    APP_DIRECTORIES.map(async (directoryName) => {
      const manifestPath = join(ROOT, 'apps', directoryName, 'package.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest
      return [directoryName, manifest] as const
    })
  )
}

function packageDirectory(name: string) {
  return join(ROOT, 'packages', name.slice('@qvac/'.length))
}

function internalDependencies(manifest: Manifest | undefined) {
  if (!manifest) return []
  return Object.keys(manifest.dependencies ?? {})
    .filter(isProductPackage)
    .sort()
}

function isProductPackage(name: string): name is (typeof PRODUCT_PACKAGES)[number] {
  return PRODUCT_PACKAGES.includes(name as (typeof PRODUCT_PACKAGES)[number])
}

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') return []
        return collectTypeScriptFiles(path)
      }
      return entry.name.endsWith('.ts') ? [path] : []
    })
  )
  return nested.flat()
}

function productImports(source: string) {
  const matches = source.matchAll(/(?:from\s+|import\s*\()['"](@qvac\/[^/'"]+)/g)
  const names = [...matches]
    .map((match) => match[1])
    .filter((name): name is string => typeof name === 'string')
  return [...new Set(names.filter(isProductPackage))]
}

function internalImports(source: string) {
  const matches = source.matchAll(
    /(?:from\s+|import\s*\()['"](@qvac(?:-poc)?\/[^/'"]+)/g
  )
  return [
    ...new Set(
      [...matches]
        .map((match) => match[1])
        .filter(
          (name): name is string =>
            typeof name === 'string' && INTERNAL_NAMES.has(name)
        )
    )
  ]
}

function findCycle(graph: ReadonlyMap<string, readonly string[]>) {
  const visited = new Set<string>()
  const active = new Set<string>()

  function visit(node: string): string[] | null {
    if (active.has(node)) return [node]
    if (visited.has(node)) return null
    active.add(node)
    for (const dependency of graph.get(node) ?? []) {
      const cycle = visit(dependency)
      if (cycle) return [node, ...cycle]
    }
    active.delete(node)
    visited.add(node)
    return null
  }

  for (const node of graph.keys()) {
    const cycle = visit(node)
    if (cycle) return cycle
  }
  return null
}

function appDirectoryFor(name: string) {
  const directory = APP_DIRECTORIES.find(
    (candidate) => `@qvac-poc/${candidate.split('/').join('-')}` === name
  )
  if (!directory) throw new Error(`No app directory registered for ${name}`)
  return directory
}

function isTestFile(file: string) {
  return (
    file.includes(`${sep}test${sep}`) ||
    file.includes(`${sep}integration${sep}`) ||
    file.endsWith('.test.ts')
  )
}

/**
 * A test-only dependency belongs in devDependencies, so accept it from there for
 * exactly the apps that declare it test-only. Every other dependency must be a
 * real runtime dependency.
 */
function declaredVersion(manifest: Manifest, dependency: string) {
  const runtime = manifest.dependencies?.[dependency]
  if (runtime !== undefined) return runtime
  const testOnly = APP_TEST_ONLY.get(manifest.name) ?? []
  if (!testOnly.includes(dependency)) return undefined
  return manifest.devDependencies?.[dependency]
}
