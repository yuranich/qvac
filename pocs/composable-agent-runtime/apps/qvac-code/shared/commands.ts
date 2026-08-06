import type { DurableWorkCommand } from '@qvac/sync/profiles/durable-work'
import {
  CODE_CLAIM_GATE_ID,
  CODE_GATE_KIND,
  CODE_PAYLOAD_VERSION,
  CODE_SESSION_FORMAT,
  CODE_TURN_FORMAT
} from './formats.ts'
import { formatSessionWorkId, formatTurnWorkId } from './ids.ts'
import {
  encodeSessionPayload,
  encodeTurnPayload,
  type CodeSessionPayload,
  type CodeTurnPayload
} from './session.ts'
import { encodeJournalBody, entryTypeFor, type CodeJournalBody } from './journal.ts'
import { formatApprovalDecision, type CodeApprovalDecision } from './approval.ts'
import { formatClaimDecision } from './claim.ts'

// The single factory for every DurableWorkCommand this app issues. Nothing
// else in the app may construct a command literal directly: two devices
// building "the same" command must produce byte-identical JSON (Sync's
// operationId dedup compares raw command bytes, keyed on Object.keys
// insertion order), and that is only guaranteed if every command literal is
// built here, once, with a fixed key order.

export interface CodeCommand {
  readonly command: DurableWorkCommand
  readonly operationId: string
}

export function createSessionCommand(input: {
  readonly sessionId: string
  readonly title: string
  readonly projectLabel: string
  readonly model: string
  readonly createdBy: string
}): CodeCommand {
  const payload: CodeSessionPayload = {
    kind: 'code-session',
    title: input.title,
    projectLabel: input.projectLabel,
    model: input.model,
    createdBy: input.createdBy
  }
  return {
    command: {
      type: 'record-work',
      workId: formatSessionWorkId(input.sessionId),
      payload: encodeSessionPayload(payload),
      payloadFormat: CODE_SESSION_FORMAT,
      payloadVersion: CODE_PAYLOAD_VERSION
    },
    operationId: `code:session:create:${input.sessionId}`
  }
}

export function createTurnCommand(input: {
  readonly sessionId: string
  readonly seq: number
  readonly prompt: string
  readonly requestedBy: string
  readonly target?: string
}): CodeCommand {
  const turnWorkId = formatTurnWorkId(input)
  const payload: CodeTurnPayload = {
    kind: 'code-turn',
    sessionId: input.sessionId,
    seq: input.seq,
    prompt: input.prompt,
    requestedBy: input.requestedBy
  }
  return {
    command: {
      type: 'record-work',
      workId: turnWorkId,
      payload: encodeTurnPayload(payload),
      payloadFormat: CODE_TURN_FORMAT,
      payloadVersion: CODE_PAYLOAD_VERSION,
      ...(input.target == null ? {} : { target: input.target })
    },
    operationId: `code:turn:create:${turnWorkId}`
  }
}

// Deliberately keyed on the turn alone (no executorId): whichever device --
// the requesting phone or a claiming executor -- opens this gate first,
// both must derive the identical operationId and command bytes so the
// loser's attempt is a safe dedup no-op, not a throw.
export function openClaimGateCommand(input: {
  readonly sessionId: string
  readonly seq: number
}): CodeCommand {
  const turnWorkId = formatTurnWorkId(input)
  return {
    command: {
      type: 'open-gate',
      workId: turnWorkId,
      gateId: CODE_CLAIM_GATE_ID,
      kind: CODE_GATE_KIND.claim
    },
    operationId: `code:claim-gate:${turnWorkId}`
  }
}

export function resolveClaimGateCommand(input: {
  readonly sessionId: string
  readonly seq: number
  readonly executorId: string
}): CodeCommand {
  const turnWorkId = formatTurnWorkId(input)
  return {
    command: {
      type: 'resolve-gate',
      workId: turnWorkId,
      gateId: CODE_CLAIM_GATE_ID,
      decision: formatClaimDecision(input.executorId)
    },
    operationId: `code:claim:${turnWorkId}:${input.executorId}`
  }
}

export function appendJournalCommand(input: {
  readonly sessionId: string
  readonly seq: number
  readonly body: CodeJournalBody
}): CodeCommand {
  const turnWorkId = formatTurnWorkId(input)
  return {
    command: {
      type: 'append-journal',
      workId: turnWorkId,
      entryType: entryTypeFor(input.body),
      body: encodeJournalBody(input.body)
    },
    operationId: `code:entry:${turnWorkId}:${input.body.writer}:${input.body.seq}`
  }
}

export function openApprovalGateCommand(input: {
  readonly sessionId: string
  readonly seq: number
  readonly gateId: string
}): CodeCommand {
  const turnWorkId = formatTurnWorkId(input)
  return {
    command: {
      type: 'open-gate',
      workId: turnWorkId,
      gateId: input.gateId,
      kind: CODE_GATE_KIND.approval
    },
    operationId: `code:approval-gate:${turnWorkId}:${input.gateId}`
  }
}

export function resolveApprovalGateCommand(input: {
  readonly sessionId: string
  readonly seq: number
  readonly gateId: string
  readonly decision: CodeApprovalDecision
}): CodeCommand {
  const turnWorkId = formatTurnWorkId(input)
  const decisionToken = formatApprovalDecision(input.decision)
  return {
    command: {
      type: 'resolve-gate',
      workId: turnWorkId,
      gateId: input.gateId,
      decision: decisionToken
    },
    operationId: `code:approval:${turnWorkId}:${input.gateId}:${decisionToken}`
  }
}

export function requestCancelCommand(input: {
  readonly workId: string
  readonly reason: string
}): CodeCommand {
  return {
    command: {
      type: 'request-cancel',
      workId: input.workId,
      reason: input.reason
    },
    operationId: `code:cancel:${input.workId}`
  }
}

export function recordOutcomeCommand(input: {
  readonly workId: string
  readonly status: 'completed' | 'failed' | 'cancelled'
  readonly result?: Buffer
}): CodeCommand {
  return {
    command: {
      type: 'record-outcome',
      workId: input.workId,
      status: input.status,
      ...(input.result == null ? {} : { result: input.result })
    },
    operationId: `code:outcome:${input.workId}:${input.status}`
  }
}

export function advertiseExecutorCommand(input: {
  readonly executorId: string
  readonly capabilities: readonly string[]
  readonly expiresAt: number
}): CodeCommand {
  return {
    command: {
      type: 'advertise-executor',
      executorId: input.executorId,
      capabilities: [...input.capabilities],
      expiresAt: input.expiresAt
    },
    operationId: `code:presence:${input.executorId}:${input.expiresAt}`
  }
}
