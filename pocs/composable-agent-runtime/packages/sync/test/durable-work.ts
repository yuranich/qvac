import path from 'path'
import test from 'brittle'
import crypto from 'hypercore-crypto'
import { createSync } from '../index.ts'
import { durableWorkProfile } from '../profiles/durable-work.ts'
import { testContext, waitFor } from './helpers.ts'

test('sync: durable-work persists ledger state through reopen', async (t) => {
  const { dir, testnet } = await testContext(t)
  const storagePath = path.join(dir, 'durable-work')
  const first = createSync({ storagePath, bootstrap: testnet.bootstrap })
  await first.ready()
  const state = first.openProfile(durableWorkProfile)

  await state.apply(
    {
      type: 'record-work',
      workId: 'work-1',
      payload: Buffer.from('{"run":1}'),
      payloadFormat: 'application/json',
      payloadVersion: 1
    },
    { operationId: 'work-create-1' }
  )
  await state.apply(
    {
      type: 'append-journal',
      workId: 'work-1',
      entryType: 'progress',
      body: Buffer.from('10')
    },
    { operationId: 'work-event-1' }
  )
  await state.apply(
    {
      type: 'save-checkpoint-ref',
      workId: 'work-1',
      checkpointId: 'checkpoint-1',
      format: 'qvac.agents.checkpoint',
      version: 1,
      blobRef: 'blob:checkpoint-1'
    },
    { operationId: 'work-checkpoint-1' }
  )
  await state.apply(
    {
      type: 'record-outcome',
      workId: 'work-1',
      status: 'completed',
      result: Buffer.from('ok')
    },
    { operationId: 'work-outcome-1' }
  )
  await first.close()

  const second = createSync({ storagePath, bootstrap: testnet.bootstrap })
  t.teardown(() => second.close())
  await second.ready()
  const reopened = second.openProfile(durableWorkProfile)
  const work = await reopened.query({ type: 'get-work', workId: 'work-1' })
  t.is(work.work?.workId, 'work-1')
  t.is(work.work?.outcomeStatus, 'completed')
  t.alike(work.work?.outcomeResult, Buffer.from('ok'))
  const allWork = await reopened.query({ type: 'list-work' })
  t.alike(allWork.works.map(({ workId }) => workId), ['work-1'])
  const checkpoint = await reopened.query({
    type: 'get-checkpoint-ref',
    workId: 'work-1'
  })
  t.is(checkpoint.checkpoint?.checkpointId, 'checkpoint-1')
  const journal = await reopened.query({
    type: 'list-journal',
    workId: 'work-1'
  })
  t.is(journal.entries.length, 1)
  t.alike(journal.entries[0]?.body, Buffer.from('10'))
  await t.exception(
    reopened.apply(
      {
        type: 'record-outcome',
        workId: 'work-1',
        status: 'failed',
        result: Buffer.from('late')
      },
      { operationId: 'work-outcome-late' }
    ),
    /invalid.*transition/i
  )
  await t.exception(
    reopened.apply(
      { type: 'request-cancel', workId: 'work-1', reason: 'too late' },
      { operationId: 'work-cancel-late' }
    ),
    /invalid.*transition/i
  )
  const terminal = await reopened.query({ type: 'get-work', workId: 'work-1' })
  t.is(terminal.work?.outcomeStatus, 'completed')
  t.is(terminal.work?.cancelRequested, false)
})

test('sync: durable-work cancellation is durable and idempotent', async (t) => {
  const { dir, testnet } = await testContext(t)
  const sync = createSync({
    storagePath: path.join(dir, 'durable-cancel'),
    bootstrap: testnet.bootstrap
  })
  t.teardown(() => sync.close())
  await sync.ready()
  const state = sync.openProfile(durableWorkProfile)
  await state.apply(
    {
      type: 'record-work',
      workId: 'work-2',
      payload: Buffer.from('x'),
      payloadFormat: 'text/plain',
      payloadVersion: 1
    },
    { operationId: 'cancel-create' }
  )
  const first = await state.apply(
    { type: 'request-cancel', workId: 'work-2', reason: 'user' },
    { operationId: 'cancel-request' }
  )
  const second = await state.apply(
    { type: 'request-cancel', workId: 'work-2', reason: 'user' },
    { operationId: 'cancel-request' }
  )
  t.is(second.revision, first.revision)
  const work = await state.query({ type: 'get-work', workId: 'work-2' })
  t.is(work.work?.cancelRequested, true)
  t.is(work.work?.cancelReason, 'user')
})

test('sync: durable-work gates are readable and decided exactly once', async (t) => {
  const { dir, testnet } = await testContext(t)
  const sync = createSync({
    storagePath: path.join(dir, 'durable-gates'),
    bootstrap: testnet.bootstrap
  })
  t.teardown(() => sync.close())
  await sync.ready()
  const state = sync.openProfile(durableWorkProfile)
  await state.apply(
    {
      type: 'record-work',
      workId: 'work-3',
      payload: Buffer.from('x'),
      payloadFormat: 'text/plain',
      payloadVersion: 1
    },
    { operationId: 'gate-create' }
  )

  await state.apply(
    { type: 'open-gate', workId: 'work-3', gateId: 'approval/1', kind: 'write' },
    { operationId: 'gate-open-1' }
  )
  const opened = await state.query({ type: 'list-gates', workId: 'work-3' })
  t.is(opened.gates.length, 1)
  t.is(opened.gates[0]?.gateId, 'approval/1')
  t.is(opened.gates[0]?.kind, 'write')
  t.is(opened.gates[0]?.decision ?? null, null)

  const open = await state.query({ type: 'list-open-gates' })
  t.alike(open.gates.map(({ gateId }) => gateId), ['approval/1'])

  // Re-opening must not clear a decision: the reducer inserts by key, so
  // without a create-only guard a second open would silently reset the gate.
  await state.apply(
    {
      type: 'resolve-gate',
      workId: 'work-3',
      gateId: 'approval/1',
      decision: 'approved/executor/a'
    },
    { operationId: 'gate-resolve-1' }
  )
  await t.exception(
    state.apply(
      { type: 'open-gate', workId: 'work-3', gateId: 'approval/1', kind: 'write' },
      { operationId: 'gate-reopen-1' }
    ),
    /invalid.*transition/i
  )
  const decided = await state.query({ type: 'list-gates', workId: 'work-3' })
  t.is(decided.gates[0]?.decision, 'approved/executor/a')

  // A second decision loses. This is the only test-and-set the claim protocol
  // and the approval race both rely on.
  await t.exception(
    state.apply(
      {
        type: 'resolve-gate',
        workId: 'work-3',
        gateId: 'approval/1',
        decision: 'denied/peer/phone'
      },
      { operationId: 'gate-resolve-2' }
    ),
    /invalid.*transition/i
  )
  const settled = await state.query({ type: 'list-gates', workId: 'work-3' })
  t.is(settled.gates[0]?.decision, 'approved/executor/a')

  const remaining = await state.query({ type: 'list-open-gates' })
  t.is(remaining.gates.length, 0)

  // list-gates is scoped to one work id; list-open-gates spans the mesh.
  await state.apply(
    {
      type: 'record-work',
      workId: 'work-4',
      payload: Buffer.from('y'),
      payloadFormat: 'text/plain',
      payloadVersion: 1
    },
    { operationId: 'gate-create-2' }
  )
  await state.apply(
    { type: 'open-gate', workId: 'work-4', gateId: 'approval/1', kind: 'shell' },
    { operationId: 'gate-open-2' }
  )
  const scoped = await state.query({ type: 'list-gates', workId: 'work-4' })
  t.alike(scoped.gates.map(({ workId }) => workId), ['work-4'])
  const across = await state.query({ type: 'list-open-gates' })
  t.alike(across.gates.map(({ workId }) => workId), ['work-4'])
})

test('sync: gate decisions replicate between paired writers', async (t) => {
  const { dir, testnet } = await testContext(t)
  const host = createSync({
    storagePath: path.join(dir, 'gate-host'),
    bootstrap: testnet.bootstrap
  })
  t.teardown(() => host.close())
  await host.ready()

  const invite = await host.mesh.createInvite({ expiresInMs: 5 * 60_000 })
  const peer = createSync({
    storagePath: path.join(dir, 'gate-peer'),
    bootstrap: testnet.bootstrap,
    pairingInvite: invite.invite
  })
  t.teardown(() => peer.close())

  // ready() on a first-pairing client does not resolve until the host approves,
  // so the approval loop must run concurrently with it.
  const approving = waitFor(async () => {
    const iterator = host.mesh.watchPairingRequests()[Symbol.asyncIterator]()
    const next = await iterator.next()
    await iterator.return?.()
    if (next.done) return null
    const pending = next.value.requests.filter(
      (request) => request.status === 'pending'
    )
    if (pending.length === 0) return null
    for (const request of pending) await host.mesh.approvePairingRequest(request.id)
    return pending.length
  })
  await peer.ready()
  t.is(await approving, 1)
  const writable = await waitFor(async () => {
    const status = await peer.mesh.status()
    return status.writable ? status : null
  })
  t.ok(writable?.writable, 'the peer was admitted as a writer')

  const hostState = host.openProfile(durableWorkProfile)
  const peerState = peer.openProfile(durableWorkProfile)

  await hostState.apply(
    {
      type: 'record-work',
      workId: 'gated-work',
      payload: Buffer.from('x'),
      payloadFormat: 'text/plain',
      payloadVersion: 1
    },
    { operationId: 'gated-create' }
  )
  await hostState.apply(
    { type: 'open-gate', workId: 'gated-work', gateId: 'approval/h/1', kind: 'write' },
    { operationId: 'gated-open' }
  )

  const visible = await waitFor(async () => {
    const result = await peerState.query({ type: 'list-open-gates' })
    return result.gates.length > 0 ? result : null
  })
  t.is(visible?.gates[0]?.gateId, 'approval/h/1')

  await peerState.apply(
    {
      type: 'resolve-gate',
      workId: 'gated-work',
      gateId: 'approval/h/1',
      decision: 'approved/peer/remote'
    },
    { operationId: 'gated-resolve' }
  )
  const decided = await waitFor(async () => {
    const result = await hostState.query({
      type: 'list-gates',
      workId: 'gated-work'
    })
    return result.gates[0]?.decision ? result : null
  })
  t.is(decided?.gates[0]?.decision, 'approved/peer/remote')
  const cleared = await hostState.query({ type: 'list-open-gates' })
  t.is(cleared.gates.length, 0)
})

test('sync: durable-work replicates to a real passive peer', async (t) => {
  t.timeout(120_000)
  const { dir, testnet } = await testContext(t)
  const meshSeed = crypto.randomBytes(32)
  const creator = createSync({
    storagePath: path.join(dir, 'durable-creator'),
    bootstrap: testnet.bootstrap,
    meshSeed
  })
  t.teardown(() => creator.close())
  await creator.ready()
  const creatorMesh = await creator.mesh.status()
  if (!creatorMesh.meshKey) throw new Error('Creator mesh key is unavailable')

  const peer = createSync({
    storagePath: path.join(dir, 'durable-peer'),
    bootstrap: testnet.bootstrap,
    meshSeed,
    meshKey: creatorMesh.meshKey
  })
  t.teardown(() => peer.close())
  await peer.ready()

  await creator.openProfile(durableWorkProfile).apply(
    {
      type: 'record-work',
      workId: 'replicated-work',
      payload: Buffer.from('peer'),
      payloadFormat: 'text/plain',
      payloadVersion: 1
    },
    { operationId: 'replicated-create' }
  )

  const replicated = await waitFor(async () => {
    const result = await peer
      .openProfile(durableWorkProfile)
      .query({ type: 'get-work', workId: 'replicated-work' })
    return result.work?.workId === 'replicated-work' ? result : null
  })
  t.is(replicated?.work?.workId, 'replicated-work')
})
