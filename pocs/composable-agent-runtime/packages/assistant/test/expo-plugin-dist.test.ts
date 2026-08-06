import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((entry) => rm(entry, { force: true, recursive: true }))
  )
})

describe('assistant expo plugin bundle', () => {
  /**
   * `./expo-plugin` resolves to `dist/expo-plugin.js`, so that committed bundle
   * — not the TypeScript beside it — is what runs during a consumer's prebuild.
   * Every other suite exercises `lib/*.ts` directly, so without this a stale
   * bundle would leave the reviewed source and the shipped behaviour to diverge
   * silently until someone ran a full `test:pack`.
   */
  it('is in sync with its source', async () => {
    const outputDirectory = await mkdtemp(path.join(tmpdir(), 'assistant-dist-'))
    temporaryPaths.push(outputDirectory)
    const rebuiltPath = path.join(outputDirectory, 'expo-plugin.js')

    const result = spawnSync(
      'bun',
      [
        'build',
        'expo-plugin.ts',
        '--target=node',
        '--format=esm',
        `--outfile=${rebuiltPath}`,
        '--external=@expo/config-plugins',
        '--external=@expo/config-types',
        '--external=@qvac/sdk',
        '--external=@qvac/sync',
        '--external=@qvac/harness',
        '--external=bare-bundle',
        '--external=react-native-bare-kit',
        '--external=yaml'
      ],
      { cwd: packageRoot, encoding: 'utf8' }
    )
    if (result.status !== 0) throw new Error(`bun build failed: ${result.stderr}`)

    const [committed, rebuilt] = await Promise.all([
      readFile(path.join(packageRoot, 'dist', 'expo-plugin.js'), 'utf8'),
      readFile(rebuiltPath, 'utf8')
    ])

    expect(
      rebuilt === committed || 'dist/expo-plugin.js is stale — run bun run build:expo-plugin'
    ).toBe(true)
  })
})
