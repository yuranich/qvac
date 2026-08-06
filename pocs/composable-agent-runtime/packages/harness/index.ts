export type {
  HarnessAgentRegistration,
  HarnessAgentWorkflowOperation,
  HarnessToolPolicy
} from './lib/agent-registration.ts'
export {
  HARNESS_HANDSHAKE,
  createHarness,
  type CreateHarnessOptions,
  type HarnessRuntime,
  type HarnessRuntimeExit
} from './lib/runtime/create-harness.ts'
export {
  assertCompatibleHarness,
  harnessCompatibility,
  type HarnessRuntimeHandshake
} from './lib/runtime/compatibility.ts'
/**
 * Already reachable through `CreateHarnessOptions['host']`; named here so a
 * composing host can declare it without importing the skill-authoring kit.
 */
export type { HarnessHostConfig } from './lib/runtime/host-config.ts'
export type {
  DurableStatePort,
  DurableStateInput,
  DurableWorkProfileClient
} from './lib/durable-state-port.ts'
export type {
  HarnessApprovalDecision,
  HarnessApprovalRequest
} from './lib/approval-port.ts'
export type {
  HarnessRunIdentity,
  HarnessRunOutcome,
  HarnessRunRecord,
  HarnessStoredRunEvent,
  HarnessWorkChange,
  WatchHarnessWork
} from './lib/run-store.ts'
export type {
  HarnessAbortSignal,
  HarnessAgentRunInput,
  HarnessAgentRunKey,
  HarnessErrorEnvelope,
  HarnessEvent,
  HarnessJsonValue,
  HarnessLoggingConfig,
  HarnessMessage,
  HarnessSkillInfo
} from './lib/types.ts'
