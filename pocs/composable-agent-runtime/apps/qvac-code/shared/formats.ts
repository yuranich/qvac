// Payload formats, journal entry-type strings, and gate kinds for the
// qvac-code app's durable-work rows. Every constant here is a wire-format
// identifier: changing a value changes what a peer running an older build
// recognises, so treat these as append-only.

export const CODE_SESSION_FORMAT = 'application/vnd.qvac.poc.code-session+json'
export const CODE_TURN_FORMAT = 'application/vnd.qvac.poc.code-turn+json'
export const CODE_PAYLOAD_VERSION = 1
export const CODE_EXECUTOR_CAPABILITY = 'qvac.poc.code/v1'
export const CODE_CLAIM_GATE_ID = 'claim'

// The delta batcher's forced-truncation path writes a `turn-error` entry
// with this exact message so transcript.ts can detect "truncated for
// budget" by matching a constant instead of parsing prose.
export const CODE_TRUNCATION_MESSAGE =
  'Turn output truncated: exceeded per-turn journal entry budget'

export const CODE_ENTRY = Object.freeze({
  turnClaim: 'qvac.poc.code.turn-claim',
  assistantDelta: 'qvac.poc.code.assistant-delta',
  thinkingDelta: 'qvac.poc.code.thinking-delta',
  toolCall: 'qvac.poc.code.tool-call',
  toolResult: 'qvac.poc.code.tool-result',
  approvalRequested: 'qvac.poc.code.approval-requested',
  approvalResolved: 'qvac.poc.code.approval-resolved',
  turnMetrics: 'qvac.poc.code.turn-metrics',
  turnError: 'qvac.poc.code.turn-error',
  turnInterrupted: 'qvac.poc.code.turn-interrupted',
  turnSuperseded: 'qvac.poc.code.turn-superseded'
} as const)

export const CODE_GATE_KIND = Object.freeze({
  claim: 'qvac.poc.code.claim/v1',
  approval: 'qvac.poc.code.approval/v1'
} as const)
