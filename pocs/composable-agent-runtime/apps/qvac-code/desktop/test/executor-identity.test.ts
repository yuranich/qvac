import { describe, expect, test } from 'bun:test'
import { basename } from 'node:path'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isExecutorId } from '@qvac-poc/qvac-code-shared'
import { resolveExecutorIdentity } from '../lib/executor-identity.ts'

function tempProject(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('resolveExecutorIdentity', function () {
  test('is stable across calls for the same realpath', async function () {
    const root = tempProject('qvac-code-identity-stable-')
    try {
      const first = await resolveExecutorIdentity({ projectRoot: root, hostname: 'my-host' })
      const second = await resolveExecutorIdentity({ projectRoot: root, hostname: 'my-host' })
      expect(second.executorId).toBe(first.executorId)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('differs per project', async function () {
    const rootA = tempProject('qvac-code-identity-a-')
    const rootB = tempProject('qvac-code-identity-b-')
    try {
      const a = await resolveExecutorIdentity({ projectRoot: rootA, hostname: 'my-host' })
      const b = await resolveExecutorIdentity({ projectRoot: rootB, hostname: 'my-host' })
      expect(a.executorId).not.toBe(b.executorId)
    } finally {
      rmSync(rootA, { recursive: true, force: true })
      rmSync(rootB, { recursive: true, force: true })
    }
  })

  test('differs per hostname for the same project', async function () {
    const root = tempProject('qvac-code-identity-host-')
    try {
      const a = await resolveExecutorIdentity({ projectRoot: root, hostname: 'host-a' })
      const b = await resolveExecutorIdentity({ projectRoot: root, hostname: 'host-b' })
      expect(a.executorId).not.toBe(b.executorId)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('produces an id accepted by isExecutorId', async function () {
    const root = tempProject('qvac-code-identity-valid-')
    try {
      const identity = await resolveExecutorIdentity({ projectRoot: root, hostname: 'my-host' })
      expect(isExecutorId(identity.executorId)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('resolves projectRoot and projectLabel from the realpath, not the raw input', async function () {
    const root = tempProject('qvac-code-identity-label-')
    try {
      const identity = await resolveExecutorIdentity({ projectRoot: root, hostname: 'my-host' })
      const expectedRoot = realpathSync(root)
      expect(identity.projectRoot).toBe(expectedRoot)
      expect(identity.projectLabel).toBe(basename(expectedRoot))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('two different spellings of the same directory produce one identity', async function () {
    // /tmp and its realpath (e.g. /private/tmp on macOS) must resolve to the
    // same executor id -- that is the whole reason resolveExecutorIdentity
    // realpaths before hashing.
    const root = tempProject('qvac-code-identity-alias-')
    try {
      const viaRaw = await resolveExecutorIdentity({ projectRoot: root, hostname: 'my-host' })
      const viaRealpath = await resolveExecutorIdentity({
        projectRoot: realpathSync(root),
        hostname: 'my-host'
      })
      expect(viaRaw.executorId).toBe(viaRealpath.executorId)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
