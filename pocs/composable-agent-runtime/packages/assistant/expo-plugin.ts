import { createAssistantExpoPlugin } from './lib/expo/plugin.ts'

export { composeAssistantStack, createAssistantExpoPlugin } from './lib/expo/plugin.ts'
export { finalizeAssistantStack } from './lib/expo/finalize.ts'
export { readPackageContributions } from './lib/expo/contribution.ts'
// The app config resolver, the capability catalog, and the accelerator list are
// deliberately not exported. They are how this package reads its own
// configuration, not a contract for consumers, and the catalog in particular is
// derivation detail that TD-PACKAGING-SELECTION-COUPLING expects to replace with
// SDK-owned data. Tests reach them through lib/.
export type {
  AcceleratorSelection,
  ComposeAssistantStackOptions,
  CreateAssistantExpoPluginOptions,
  PackageContribution,
  SdkPluginSelection
} from './lib/expo/types.ts'

export default createAssistantExpoPlugin()
