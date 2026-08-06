import { createAssistantExpoPlugin } from './lib/expo/plugin.ts'

export { composeAssistantStack, createAssistantExpoPlugin } from './lib/expo/plugin.ts'
export { finalizeAssistantStack } from './lib/expo/finalize.ts'
export { readPackageContributions } from './lib/expo/contribution.ts'
export {
  ASSISTANT_CONFIG_FILENAMES,
  resolveAssistantAppConfig
} from './lib/expo/app-config.ts'
export { capabilityCatalog, capabilityNames } from './lib/expo/capabilities.ts'
export { ASSISTANT_INFERENCE_ACCELERATORS } from './lib/expo/types.ts'
export type {
  AcceleratorSelection,
  AssistantAccelerator,
  AssistantAppConfig,
  ComposeAssistantStackOptions,
  CreateAssistantExpoPluginOptions,
  PackageContribution,
  ResolvedAssistantAppConfig,
  SdkPluginSelection
} from './lib/expo/types.ts'

export default createAssistantExpoPlugin()
