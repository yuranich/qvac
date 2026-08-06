import type { ConfigPlugin } from '@expo/config-plugins'
import type { ExecutionRealm, PackageInstance } from '../artifact-validation.ts'
import type { ResolvedCapability } from './capabilities.ts'

/**
 * GPU backends an application can declare. These are *product* choices, not
 * dead code: an addon ships one prebuilt `.so` per backend and ggml picks
 * among them at runtime from device capability, so dropping one removes a
 * path the app could otherwise have taken on some device.
 *
 * `cpu` is accepted so `accelerators: [cpu]` reads naturally, but it is a
 * no-op: the CPU backend is ggml's base and is always linked.
 */
export const ASSISTANT_INFERENCE_ACCELERATORS = Object.freeze([
  'vulkan',
  'opencl',
  'metal',
  'cpu'
] as const)

export type AssistantAccelerator = (typeof ASSISTANT_INFERENCE_ACCELERATORS)[number]

export const ASSISTANT_STACK_MANIFEST_VERSION = 4
export const ASSISTANT_MANIFEST_PROVENANCE_VERSION = 1
export const WORKER_ADAPTER_VERSION = 1

export const PLUGIN_EXECUTION_ORDER = Object.freeze([
  'resolve-assistant-app-config',
  'sync-contributor-plugin',
  'harness-contributor-plugin',
  'invoke-sdk-expo-plugin',
  'finalize-assistant-stack'
] as const)

export const SDK_PLUGIN_ID = '@qvac/sdk/expo-plugin'
export const SYNC_PLUGIN_ID = '@qvac/sync/expo-plugin'
export const HARNESS_PLUGIN_ID = '@qvac/harness/expo-plugin'
export const ASSISTANT_PLUGIN_ID = '@qvac/assistant/expo-plugin'
export const ASSISTANT_FINALIZE_RUN_ONCE = '@qvac/assistant/expo-plugin/finalize'
export const ASSISTANT_APP_CONFIG_RUN_ONCE = '@qvac/assistant/expo-plugin/app-config'

export const REQUIRED_MOBILE_HOSTS = Object.freeze([
  'android-arm64',
  'ios-arm64',
  'ios-arm64-simulator',
  'ios-x64-simulator'
] as const)

export interface AssistantAddon {
  readonly name: string
  readonly version: string
}

/** Validated shape of the application's `qvac.assistant.yaml`. */
export interface AssistantAppConfig {
  readonly version: 1
  readonly logging?: {
    readonly level: 'error' | 'warn' | 'info' | 'debug' | 'off'
  }
  readonly inference?: {
    readonly capabilities: readonly ResolvedCapability[]
    readonly accelerators?: readonly AssistantAccelerator[]
    readonly bareRuntimeVersion?: string
  }
}

/**
 * The application config after resolution. `capabilities` and `plugins` are
 * `null` when the app declared no `inference` section, which keeps every
 * built-in SDK plugin — the same result as having no config file at all.
 */
export interface ResolvedAssistantAppConfig {
  readonly configPath: string
  readonly capabilities: readonly string[] | null
  readonly plugins: readonly string[] | null
  /** `null` keeps every backend an addon ships; a list keeps only those GPU backends. */
  readonly accelerators: readonly AssistantAccelerator[] | null
  readonly loggerLevel?: string
  readonly bareRuntimeVersion?: string
}

/** What the app config selected, recorded in the stack manifest as evidence. */
export interface SdkPluginSelection {
  readonly configPath: string
  readonly capabilities: readonly string[]
  readonly plugins: readonly string[]
}

/** Which GPU backends survived linking, recorded in the stack manifest. */
export interface AcceleratorSelection {
  readonly configPath: string
  readonly accelerators: readonly string[]
}

export interface PackageIdentity {
  readonly name: string
  readonly version: string
  readonly packagePath: string
  readonly singleton: boolean
}

export interface PackageContribution {
  readonly schemaVersion: number
  readonly packageName: string
  readonly packageVersion: string
  readonly contract: string
  readonly protocolVersion: number
  readonly bundleId: string
  readonly hosts: readonly string[]
  readonly nativeAddons: readonly AssistantAddon[]
  readonly packages: readonly PackageIdentity[]
  readonly harnessPath: string
  readonly metadataPath: string
  readonly bundlePath: string
}

export interface SdkAddonsManifest {
  readonly version: number
  readonly bundleId: string | null
  readonly addons: readonly string[]
  readonly assistantProvenance?: AssistantManifestProvenance
}

export interface AssistantManifestProvenance {
  readonly schemaVersion: number
  readonly sourcePlugin: string
  readonly sourcePluginVersion: string
  readonly sdkSourceAddons: readonly AssistantAddon[]
}

export interface WorkerAddonInventory {
  readonly role: 'sync' | 'harness'
  readonly contract: string
  readonly protocolVersion: number
  readonly bundleId: string
  readonly hosts: readonly string[]
  readonly nativeAddons: readonly AssistantAddon[]
  readonly packages: readonly PackageInstance[]
}

export interface BuiltWorkerArtifacts {
  readonly sync: WorkerAddonInventory
  readonly harness: WorkerAddonInventory
}

export interface AssistantStackManifest {
  readonly manifestVersion: number
  readonly pluginExecutionOrder: readonly string[]
  readonly requiredHosts: readonly string[]
  readonly packageVersions: {
    readonly assistant: string
    readonly sync: string
    readonly harness: string
    readonly sdk: string
  }
  readonly bundles: {
    readonly sync: string
    readonly harness: string
    readonly sdk: string | null
  }
  readonly sdkSource: {
    readonly manifestVersion: number
    readonly bundleId: string | null
    readonly addons: readonly AssistantAddon[]
  }
  readonly workers: {
    readonly sync: {
      readonly contract: string
      readonly protocolVersion: number
      readonly hosts: readonly string[]
      readonly nativeAddons: readonly AssistantAddon[]
    }
    readonly harness: {
      readonly contract: string
      readonly protocolVersion: number
      readonly hosts: readonly string[]
      readonly nativeAddons: readonly AssistantAddon[]
    }
  }
  readonly mergedAddons: readonly AssistantAddon[]
  /** `null` when the app selected no capabilities and kept every SDK plugin. */
  readonly sdkPluginSelection: SdkPluginSelection | null
  /** `null` when the app declared no accelerators and kept every backend. */
  readonly acceleratorSelection: AcceleratorSelection | null
  readonly realms: readonly ExecutionRealm[]
  readonly singletonPackages: readonly string[]
}

export interface CreateAssistantExpoPluginOptions {
  readonly sdkPlugin?: ConfigPlugin
  readonly syncPlugin?: ConfigPlugin
  readonly harnessPlugin?: ConfigPlugin
  readonly syncBuild?: () => Promise<unknown>
  readonly harnessBuild?: () => Promise<unknown>
}

export interface ComposeAssistantStackOptions {
  readonly projectRoot: string
  readonly pinLinkerRoot?: boolean
  readonly syncContribution?: PackageContribution
  readonly harnessContribution?: PackageContribution
}

export interface FinalizeAssistantStackOptions {
  readonly pinLinkerRoot?: boolean
  readonly syncContribution?: PackageContribution
  readonly harnessContribution?: PackageContribution
}
