export {
  createMobileHarness as createHarness,
  type CreateMobileHarnessOptions as CreateHarnessOptions
} from './lib/runtime/create-harness-mobile.ts'
// Types only: the value side of create-harness.ts is the desktop launcher,
// which uses import.meta and cannot enter a Hermes bundle.
export type {
  HarnessRuntime,
  HarnessRuntimeExit
} from './lib/runtime/create-harness.ts'
export {
  HARNESS_HANDSHAKE,
  assertCompatibleHarness,
  harnessCompatibility,
  type HarnessRuntimeHandshake
} from './lib/runtime/compatibility.ts'
// Type only, and not accepted by `createMobileHarness`: on mobile the worker
// bundle and its skills are fixed at prebuild by the Expo plugin, so there is
// no launch-time host config. Exported so contracts shared with the desktop
// realm still resolve under the react-native condition.
export type { HarnessHostConfig } from './lib/runtime/host-config.ts'
export type {
  DurableStatePort,
  DurableStateInput,
  DurableWorkProfileClient
} from './lib/durable-state-port.ts'
export type {
  HarnessAgentRegistration,
  HarnessAgentWorkflowOperation,
  HarnessToolPolicy
} from './lib/agent-registration.ts'
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
