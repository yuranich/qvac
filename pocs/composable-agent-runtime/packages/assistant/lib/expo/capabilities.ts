import { MODEL_TYPES, ModelType } from '@qvac/sdk'
import { SDK_DEFAULT_PLUGINS } from '@qvac/sdk/plugin-utils'

/**
 * The capability vocabulary an application writes, derived entirely from what
 * SDK publishes. Assistant invents no names of its own, so an SDK release that
 * adds, renames, or removes a plugin needs no change here — a new plugin is
 * selectable by its canonical name the moment SDK ships it.
 *
 * Two spellings resolve to the same plugin:
 *  - canonical, taken from the plugin specifier itself
 *    (`@qvac/sdk/llamacpp-completion/plugin` -> `llamacpp-completion`), which
 *    is SDK's `ModelType` value for that plugin;
 *  - alias, taken from SDK's own published backward-compatible names
 *    (`llm`, `ocr`, `diffusion`, ...).
 */
export interface CapabilityCatalog {
  /** Canonical capability name -> SDK plugin specifier. */
  readonly specifiers: ReadonlyMap<string, string>
  /** SDK alias -> canonical capability name. */
  readonly aliases: ReadonlyMap<string, string>
}

const SPECIFIER_PATTERN = /^@qvac\/sdk\/(.+)\/plugin$/

let catalog: CapabilityCatalog | null = null

export function capabilityCatalog(): CapabilityCatalog {
  if (catalog === null) catalog = buildCapabilityCatalog()
  return catalog
}

export function buildCapabilityCatalog(
  specifierList: readonly string[] = SDK_DEFAULT_PLUGINS,
  modelTypes: Readonly<Record<string, string>> = MODEL_TYPES,
  canonicalModelTypes: Readonly<Record<string, string>> = ModelType
): CapabilityCatalog {
  const specifiers = new Map<string, string>()
  for (const specifier of specifierList) {
    const canonical = SPECIFIER_PATTERN.exec(specifier)?.[1]
    if (canonical === undefined || canonical.includes('/')) {
      throw new Error(
        `Unrecognised SDK plugin specifier: ${specifier}. ` +
          'Assistant derives capability names from the specifier, so this ' +
          'must be reviewed against the installed @qvac/sdk.'
      )
    }
    specifiers.set(canonical, specifier)
  }

  // MODEL_TYPES is ModelType merged with its aliases, so an entry whose key is
  // not a ModelType key is an alias. Aliases for plugins SDK does not bundle
  // are skipped rather than offered and then rejected.
  const canonicalKeys = new Set(Object.keys(canonicalModelTypes))
  const aliases = new Map<string, string>()
  for (const [key, value] of Object.entries(modelTypes)) {
    if (canonicalKeys.has(key) || !specifiers.has(value)) continue
    aliases.set(key, value)
  }

  return { specifiers, aliases }
}

/** Every name an application may write, for error messages and documentation. */
export function capabilityNames(source: CapabilityCatalog = capabilityCatalog()) {
  return [...source.specifiers.keys(), ...source.aliases.keys()].sort()
}

export interface ResolvedCapability {
  /** Canonical name, or the specifier itself for a third-party plugin. */
  readonly capability: string
  readonly specifier: string
}

/**
 * Resolves a written name to the plugin it selects, or `null` if unknown.
 *
 * A name ending in `/plugin` is a plugin specifier and is passed through
 * verbatim: SDK documents third-party plugins as `<package-name>/plugin`
 * installed from npm, and Assistant cannot have a catalog entry for a package
 * it has never heard of. Assistant does not verify that such a package is
 * installed — the SDK bundler already fails on a specifier it cannot resolve,
 * and duplicating that check here would only add a second, staler opinion.
 */
export function resolveCapability(
  name: string,
  source: CapabilityCatalog = capabilityCatalog()
): ResolvedCapability | null {
  if (name.endsWith('/plugin')) return { capability: name, specifier: name }
  const specifier = source.specifiers.get(name)
  if (specifier !== undefined) return { capability: name, specifier }
  const canonical = source.aliases.get(name)
  if (canonical === undefined) return null
  const aliased = source.specifiers.get(canonical)
  if (aliased === undefined) return null
  return { capability: canonical, specifier: aliased }
}
