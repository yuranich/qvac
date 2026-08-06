import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { pinBareKitLinkerProjectRoot } from '../lib/packaging/barekit-linker.ts'

const temporaryPaths: string[] = []
const pocRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

/**
 * Filenames a real arm64-v8a link produces for a completion-only build, taken
 * from `bun run report:apk` output: the addon itself, its ggml backends, and
 * an unrelated native dependency.
 */
const LINKED_LIBRARIES = [
  'libqvac__llm-llamacpp.0.36.4.so',
  'libqvac-ggml-vulkan.so',
  'libqvac-ggml-opencl.so',
  'libqvac-ggml-cpu-android_armv8.0_1.so',
  'libqvac-ggml-cpu-android_armv9.2_2.so',
  'libqvac-speech-ggml-vulkan.so',
  'libqvac-ggml-future-backend.so',
  'librocksdb-native.3.17.3.so'
]

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((entry) => rm(entry, { force: true, recursive: true }))
  )
})

describe('barekit linker accelerator filter', () => {
  it('matches the bindings the real SDK linker template declares', async () => {
    // The prune block is appended to SDK's template and uses its `fs`, `path`,
    // and `addonsDir` bindings. Everything else here runs against STUB_LINKER,
    // so without this the coupling would only ever be checked against a copy:
    // an SDK rename would keep those tests green and break every real build.
    const template = await readFile(
      path.resolve(
        pocRoot,
        'node_modules/@qvac/sdk/expo/plugins/patches/android-link.mjs'
      ),
      'utf8'
    )

    expect(template).toMatch(/^import fs from ['"]fs['"]$/m)
    expect(template).toMatch(/^import path from ['"]path['"]$/m)
    expect(template).toMatch(/^const addonsDir = /m)
    expect(template).toMatch(/^const projectRoot = /m)
    // Top-level await in the appended block requires the template to be an
    // ES module that already uses it.
    expect(template).toContain('for await (')
  })

  it('classifies the same shared objects bare-link copies', async () => {
    const projectRoot = await createProject([
      'libqvac-ggml-vulkan.so.1.2.3',
      'libqvac-ggml-cpu-android_armv8.0_1.so',
      'libplain.so.4'
    ])

    await pinBareKitLinkerProjectRoot(projectRoot, [])
    const remaining = await runLinker(projectRoot)

    // bare-link's android handler copies `\.so(\.N(\.N)*)?$`, so a versioned
    // backend must be prunable rather than skipped and shipped unreported.
    expect(remaining).toEqual([
      'libplain.so.4',
      'libqvac-ggml-cpu-android_armv8.0_1.so'
    ])
  })

  it('keeps only declared GPU backends, CPU, and unrecognised backends', async () => {
    const projectRoot = await createProject()

    await pinBareKitLinkerProjectRoot(projectRoot, ['vulkan'])
    const remaining = await runLinker(projectRoot)

    expect(remaining).toEqual([
      'libqvac-ggml-cpu-android_armv8.0_1.so',
      'libqvac-ggml-cpu-android_armv9.2_2.so',
      'libqvac-ggml-future-backend.so',
      'libqvac-ggml-vulkan.so',
      'libqvac-speech-ggml-vulkan.so',
      'libqvac__llm-llamacpp.0.36.4.so',
      'librocksdb-native.3.17.3.so'
    ])
  })

  it('drops every GPU backend for a CPU-only build', async () => {
    const projectRoot = await createProject()

    await pinBareKitLinkerProjectRoot(projectRoot, [])
    const remaining = await runLinker(projectRoot)

    expect(remaining).toEqual([
      'libqvac-ggml-cpu-android_armv8.0_1.so',
      'libqvac-ggml-cpu-android_armv9.2_2.so',
      'libqvac-ggml-future-backend.so',
      'libqvac__llm-llamacpp.0.36.4.so',
      'librocksdb-native.3.17.3.so'
    ])
  })

  it('keeps every backend when the app declared no accelerators', async () => {
    const projectRoot = await createProject()

    await pinBareKitLinkerProjectRoot(projectRoot, null)
    const remaining = await runLinker(projectRoot)

    expect(remaining).toEqual([...LINKED_LIBRARIES].sort())
  })

  it('replaces its filter instead of stacking one per prebuild', async () => {
    const projectRoot = await createProject()

    await pinBareKitLinkerProjectRoot(projectRoot, ['vulkan'])
    await pinBareKitLinkerProjectRoot(projectRoot, [])
    const remaining = await runLinker(projectRoot)

    expect(remaining).not.toContain('libqvac-ggml-vulkan.so')
    expect(remaining).toContain('libqvac-ggml-cpu-android_armv8.0_1.so')
  })

  it('reports an unrecognised backend instead of deleting it', async () => {
    const projectRoot = await createProject()

    await pinBareKitLinkerProjectRoot(projectRoot, [])
    const output = runLinkerOutput(projectRoot)

    expect(output).toContain('Kept unrecognised ggml backend(s): future')
  })

  it('leaves the iOS linker unfiltered because Apple ships signed frameworks', async () => {
    const projectRoot = await createProject()

    await pinBareKitLinkerProjectRoot(projectRoot, [])

    const source = await readFile(
      path.join(projectRoot, 'node_modules', 'react-native-bare-kit', 'ios', 'link.mjs'),
      'utf8'
    )
    expect(source).not.toContain('pruneUndeclaredAccelerators')
    expect(source).toContain(`const projectRoot = ${JSON.stringify(projectRoot)}`)
  })

  it('still pins the project root', async () => {
    const projectRoot = await createProject()

    await pinBareKitLinkerProjectRoot(projectRoot, ['vulkan'])

    const source = await readFile(
      path.join(projectRoot, 'node_modules', 'react-native-bare-kit', 'android', 'link.mjs'),
      'utf8'
    )
    expect(source).toContain(`const projectRoot = ${JSON.stringify(projectRoot)}`)
  })
})

async function createProject(libraries: readonly string[] = LINKED_LIBRARIES) {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'assistant-accelerator-'))
  temporaryPaths.push(projectRoot)
  await writeFile(
    path.join(projectRoot, 'package.json'),
    `${JSON.stringify({ name: 'accelerator-consumer', version: '0.0.0' }, null, 2)}\n`
  )
  const bareKitRoot = path.join(projectRoot, 'node_modules', 'react-native-bare-kit')
  await mkdir(path.join(bareKitRoot, 'android'), { recursive: true })
  await mkdir(path.join(bareKitRoot, 'ios'), { recursive: true })
  await writeFile(
    path.join(bareKitRoot, 'package.json'),
    `${JSON.stringify({ name: 'react-native-bare-kit', version: '0.14.0' }, null, 2)}\n`
  )
  for (const platform of ['android', 'ios']) {
    await writeFile(path.join(bareKitRoot, platform, 'link.mjs'), stubLinker(libraries))
  }
  return projectRoot
}

/**
 * Runs the patched linker for real. The stub stands in for `bare-link`: it
 * writes the files a link would have copied, using the same variable names
 * (`fs`, `path`, `addonsDir`) the SDK's linker template declares, so the
 * appended filter has to work against the file it will actually run in.
 */
async function runLinker(projectRoot: string) {
  runLinkerOutput(projectRoot)
  const addonsDirectory = path.join(
    projectRoot,
    'node_modules',
    'react-native-bare-kit',
    'android',
    'src',
    'main',
    'addons',
    'arm64-v8a'
  )
  return (await readdir(addonsDirectory)).sort()
}

function runLinkerOutput(projectRoot: string) {
  const linkerPath = path.join(
    projectRoot,
    'node_modules',
    'react-native-bare-kit',
    'android',
    'link.mjs'
  )
  const result = spawnSync('node', [linkerPath], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`patched linker failed: ${result.stderr}`)
  }
  return result.stdout
}

/**
 * Stands in for `bare-link`: writes the files a link would have copied, using
 * the same bindings the SDK template declares. The
 * "matches the bindings the real SDK linker template declares" case is what
 * keeps this replica honest.
 */
function stubLinker(libraries: readonly string[]) {
  return `import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.join(__dirname, '..', '..', '..')
const addonsDir = path.join(__dirname, 'src', 'main', 'addons')

const architectureDir = path.join(addonsDir, 'arm64-v8a')
fs.rmSync(addonsDir, { recursive: true, force: true })
fs.mkdirSync(architectureDir, { recursive: true })
for (const name of ${JSON.stringify(libraries)}) {
  fs.writeFileSync(path.join(architectureDir, name), name)
}
`
}
