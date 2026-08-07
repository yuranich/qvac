import { describe, expect, test } from 'bun:test'
import type { DurableWorkResult } from '@qvac/sync/profiles/durable-work'
import { decideClaimAction } from '../claim.ts'
import { CODE_TURN_FORMAT } from '../formats.ts'
import type { CodeGateRow, CodeWorkRow } from '../rows.ts'

// Compile-time only: if Sync's real durable-work row shapes ever drop or
// retype a field claim.ts reads, these fail to compile instead of failing
// silently at runtime. Mirrors the Assert<Extends<>> pattern in
// packages/assistant/test/durable-state-composition.test.ts.
type Assert<T extends true> = T
type Extends<Left, Right> = [Left] extends [Right] ? true : false

type SyncWorkFitsCodeWorkRow = Assert<
  Extends<NonNullable<DurableWorkResult['work']>, CodeWorkRow>
>
type SyncGateFitsCodeGateRow = Assert<
  Extends<NonNullable<DurableWorkResult['gates'][number]>, CodeGateRow>
>

void (null as SyncWorkFitsCodeWorkRow | null)
void (null as SyncGateFitsCodeGateRow | null)

describe('CodeWorkRow / CodeGateRow structural shape', function () {
  test('a minimal object satisfying only the declared fields is usable by decideClaimAction', function () {
    const work: CodeWorkRow = {
      workId: 'code/s1/turn/000001',
      payloadFormat: CODE_TURN_FORMAT,
      createdAt: 1
    }
    const action = decideClaimAction({
      executorId: 'executor-1',
      work,
      session: null,
      claimGate: null,
      claimedInThisProcess: false
    })
    expect(action).toEqual({ kind: 'open-claim-gate' })
  })

  test('a gate row satisfying only the declared fields round-trips through decideClaimAction', function () {
    const work: CodeWorkRow = {
      workId: 'code/s1/turn/000001',
      payloadFormat: CODE_TURN_FORMAT,
      createdAt: 1
    }
    const gate: CodeGateRow = {
      gateId: 'claim',
      kind: 'qvac.poc.code.claim/v1',
      decision: 'claim/executor-1',
      recordedAt: 2,
      workId: work.workId
    }
    const action = decideClaimAction({
      executorId: 'executor-1',
      work,
      session: null,
      claimGate: gate,
      claimedInThisProcess: true
    })
    expect(action).toEqual({ kind: 'execute' })
  })
})
