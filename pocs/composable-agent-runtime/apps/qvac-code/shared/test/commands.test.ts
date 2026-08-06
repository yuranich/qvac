import { describe, expect, test } from 'bun:test'
import {
  advertiseExecutorCommand,
  appendJournalCommand,
  createSessionCommand,
  createTurnCommand,
  openApprovalGateCommand,
  openClaimGateCommand,
  recordOutcomeCommand,
  requestCancelCommand,
  resolveApprovalGateCommand,
  resolveClaimGateCommand
} from '../commands.ts'
// Deep import, deliberately outside this app's declared `@qvac/sync` export
// surface: this is a test-only check that our command bytes match exactly
// what real Sync hashes for operationId dedup (see packages/sync/lib/mesh.ts
// `applyProfile`, which compares `encodeProfileValue(command)` output byte
// for byte). It mirrors the precedent in
// packages/assistant/test/durable-state-composition.test.ts, which reaches
// into a sibling package's source the same way for a compile-time contract
// check.
import { encodeProfileValue } from '../../../../packages/sync/lib/profiles/codec.ts'

describe('command factories: operationId shapes', function () {
  test('createSessionCommand', function () {
    const { operationId } = createSessionCommand({
      sessionId: 's1',
      title: 't',
      projectLabel: 'p',
      model: 'm',
      createdBy: 'device-a'
    })
    expect(operationId).toBe('code:session:create:s1')
  })

  test('createTurnCommand', function () {
    const { operationId } = createTurnCommand({
      sessionId: 's1',
      seq: 2,
      prompt: 'p',
      requestedBy: 'device-a'
    })
    expect(operationId).toBe('code:turn:create:code/s1/turn/000002')
  })

  test('openClaimGateCommand is identical for the requesting phone and the claiming executor', function () {
    const fromPhone = openClaimGateCommand({ sessionId: 's1', seq: 2 })
    const fromExecutor = openClaimGateCommand({ sessionId: 's1', seq: 2 })
    expect(fromPhone.operationId).toBe('code:claim-gate:code/s1/turn/000002')
    expect(fromPhone.operationId).toBe(fromExecutor.operationId)
    expect(fromPhone.command).toEqual(fromExecutor.command)
  })

  test('resolveClaimGateCommand', function () {
    const { operationId } = resolveClaimGateCommand({ sessionId: 's1', seq: 2, executorId: 'executor-1' })
    expect(operationId).toBe('code:claim:code/s1/turn/000002:executor-1')
  })

  test('appendJournalCommand', function () {
    const { operationId } = appendJournalCommand({
      sessionId: 's1',
      seq: 2,
      body: { writer: 'executor-1', seq: 5, type: 'assistant-delta', text: 'x' }
    })
    expect(operationId).toBe('code:entry:code/s1/turn/000002:executor-1:5')
  })

  test('openApprovalGateCommand', function () {
    const { operationId } = openApprovalGateCommand({
      sessionId: 's1',
      seq: 2,
      gateId: 'approval/executor-1/1'
    })
    expect(operationId).toBe('code:approval-gate:code/s1/turn/000002:approval/executor-1/1')
  })

  test('resolveApprovalGateCommand', function () {
    const { operationId } = resolveApprovalGateCommand({
      sessionId: 's1',
      seq: 2,
      gateId: 'approval/executor-1/1',
      decision: { verdict: 'approved', decidedBy: { kind: 'executor', executorId: 'executor-1' } }
    })
    expect(operationId).toBe(
      'code:approval:code/s1/turn/000002:approval/executor-1/1:approved/executor/executor-1'
    )
  })

  test('requestCancelCommand', function () {
    const { operationId } = requestCancelCommand({ workId: 'code/s1/turn/000002', reason: 'user asked' })
    expect(operationId).toBe('code:cancel:code/s1/turn/000002')
  })

  test('recordOutcomeCommand', function () {
    const { operationId } = recordOutcomeCommand({ workId: 'code/s1/turn/000002', status: 'completed' })
    expect(operationId).toBe('code:outcome:code/s1/turn/000002:completed')
  })

  test('advertiseExecutorCommand', function () {
    const { operationId } = advertiseExecutorCommand({
      executorId: 'executor-1',
      capabilities: ['qvac.poc.code/v1'],
      expiresAt: 12345
    })
    expect(operationId).toBe('code:presence:executor-1:12345')
  })
})

describe('command factories: byte-identical determinism', function () {
  test('openClaimGateCommand produces byte-identical encodeProfileValue output across two calls', function () {
    const first = openClaimGateCommand({ sessionId: 's1', seq: 2 })
    const second = openClaimGateCommand({ sessionId: 's1', seq: 2 })
    const firstBytes = encodeProfileValue(first.command)
    const secondBytes = encodeProfileValue(second.command)
    expect(firstBytes.equals(secondBytes)).toBe(true)
  })

  test('key order is stable: encodeProfileValue output matches a literal built in the documented order', function () {
    const { command } = openClaimGateCommand({ sessionId: 's1', seq: 2 })
    const literal = {
      type: 'open-gate',
      workId: 'code/s1/turn/000002',
      gateId: 'claim',
      kind: 'qvac.poc.code.claim/v1'
    }
    expect(encodeProfileValue(command).equals(encodeProfileValue(literal))).toBe(true)
  })

  test('createSessionCommand is byte-identical across two devices deriving it from the same data', function () {
    const input = {
      sessionId: 's1',
      title: 'Fix the bug',
      projectLabel: 'proj',
      model: 'local-model',
      createdBy: 'device-a'
    }
    const first = createSessionCommand(input)
    const second = createSessionCommand(input)
    expect(encodeProfileValue(first.command).equals(encodeProfileValue(second.command))).toBe(true)
    expect(first.operationId).toBe(second.operationId)
  })

  test('resolveApprovalGateCommand is byte-identical for the same decision object built independently', function () {
    const build = () =>
      resolveApprovalGateCommand({
        sessionId: 's1',
        seq: 2,
        gateId: 'approval/executor-1/1',
        decision: { verdict: 'denied', decidedBy: { kind: 'peer', deviceRef: 'device-b' } }
      })
    const first = build()
    const second = build()
    expect(encodeProfileValue(first.command).equals(encodeProfileValue(second.command))).toBe(true)
    expect(first.operationId).toBe(second.operationId)
  })
})
