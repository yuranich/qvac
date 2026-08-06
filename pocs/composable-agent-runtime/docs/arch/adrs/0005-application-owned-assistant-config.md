# ADR 0005: One Application-Owned Assistant Config File

Status: Proposed  
Date: 2026-08-06

## Context

An application that installs `@qvac/assistant` configures one plugin and gets
the whole stack. Until now it also got *every* built-in inference capability:
the SDK worker bundle carried all eleven plugins and the linker copied every
addon's native prebuilds into the binary. The task-mobile release APK measured
**461.0 MB, of which 424.8 MB (92%) was native libraries** for capabilities the
app never calls.

SDK already solves the selection half: `withMobileBundle` tree-shakes the worker
bundle when it finds a `qvac.config.*` in the Expo project root, and the patched
BareKit linkers copy only the addons the resulting bundle needs. What was missing
is the composition half. Assistant's promise is *one* entry point, and an app
that configured Assistant still had to reach past it and hand-write SDK's own
config file to get a smaller build. That is the boundary violation this PoC
exists to catch: a facade that cannot express what it composes is not a facade.

The SDK Expo plugin takes no props. Its only configuration channel is a file at
the project root, discovered by name.

## Proposed decision

An application writes exactly one QVAC config file, `qvac.assistant.yaml`, and
`@qvac/assistant` propagates it to the packages it composes.

```yaml
version: 1

logging:
  level: info

inference:
  capabilities:
    - llm
  accelerators:
    - cpu
```

- **Assistant owns the file and its schema; SDK owns the vocabulary.**
  Assistant invents no capability names. The catalog is derived at build time
  from the installed SDK: canonical names from the `SDK_DEFAULT_PLUGINS`
  specifiers (`@qvac/sdk/llamacpp-completion/plugin` → `llamacpp-completion`,
  SDK's own `ModelType` value), aliases from `MODEL_TYPES` minus `ModelType`
  (`llm`, `ocr`, …). A plugin a future SDK ships is selectable with no change
  here, and a name ending in `/plugin` passes through verbatim, so third-party
  plugins work without Assistant knowing them.
- **Propagation is generation, not reach-in.** A first plugin step
  (`resolve-assistant-app-config`) writes a generated `qvac.config.json`, which
  the unmodified SDK plugin then finds. Execution order becomes
  `app-config → sync → harness → sdk → finalize`. The generated file carries a
  `"//"` marker and is gitignored; Assistant refuses to overwrite one it did not
  write, and treats a higher-precedence `qvac.config.{ts,mjs,js}` as a hard
  error rather than silently generating a file that would be ignored.
- **Accelerators are declared, not inferred.** An addon publishes one prebuilt
  library per backend and ggml selects among them at runtime from device
  capability, so these are not dead code: dropping `vulkan` means the app runs
  on the CPU even where a Vulkan driver exists. ggml's CPU backend is always
  linked (`cpu` is accepted so `[cpu]` reads as "CPU only"), and an
  unrecognised `-ggml-*` library is reported rather than removed.
- **Backend pruning is Android-only.** `bare-link` copies loose shared objects
  on Android but builds signed `.framework`s around `.dylib`s on Apple
  platforms. Rewriting a signed framework is a different operation and is not
  attempted, so the patch applies to `android/link.mjs` only rather than
  shipping a no-op on iOS, and an iOS build still ships every backend.
- **Absence means today's behaviour.** No file, no `inference` section, or no
  `accelerators` list each keep everything. An empty `accelerators: []` is a
  deliberate CPU-only build, not absence. Nothing silently shrinks an existing
  app's build.
- **The selection is recorded.** `assistant-stack.manifest.json` gains
  `sdkPluginSelection` and `acceleratorSelection`, so what a binary contains is
  auditable rather than inferred from its size.

Out of scope: propagating the file into the *runtime* config snapshot on device
(the YAML is a build-host artifact and is not shipped); per-model or per-device
inference tuning, which stays SDK's `deviceDefaults`; and any Sync or Harness
key — neither package needs one yet, and adding a section for a key nobody reads
would be inventing surface.

## Evidence

Same app, same commit, `expo prebuild --clean` plus `assembleRelease` on
arm64-v8a, measured with `bun run report:apk`:

| | no config | `capabilities: [llm]` | `+ accelerators: [cpu]` |
|---|---|---|---|
| APK | 461.0 MB | 243.4 MB | **138.6 MB (−69.9%)** |
| Native libraries | 424.8 MB | 210.3 MB | 105.5 MB |
| Native library files | 72 | 50 | 48 |
| Linked addons | 39 | 28 | 28 |
| Inference addons | 11 | 1 | 1 |
| ggml backends | vulkan, opencl, cpu | vulkan, opencl, cpu | cpu |
| `@qvac/llm-llamacpp` bytes | 8.8 MB (+shared) | 123.1 MB | 18.4 MB |
| SDK worker bundle | 11.2 MB | 8.7 MB | 8.7 MB |

Decoding the worker bundle's file inventory confirms the selection reached it:
one plugin module out of eleven, and `@qvac/llm-llamacpp` as the only inference
addon present. Grepping the bundle for plugin paths is *not* evidence — every
specifier still appears in the module map; only the decoded file inventory
distinguishes an included module from a recorded path.

**Capability selection alone was not sufficient.** After it, two files held two
thirds of the remaining 243.4 MB. Declaring `accelerators: [cpu]` removes the
first:

```
[QVAC] Dropped undeclared opencl backend libqvac-ggml-opencl.so
[QVAC] Dropped undeclared vulkan backend libqvac-ggml-vulkan.so
```

`libqvac-ggml-vulkan.so` (103.0 MB) is shipped by `@qvac/llm-llamacpp` itself,
so no capability choice reaches it. The other is `libbare-kit.so` (61.9 MB, the
Bare host runtime), which survives both selections and is now 45% of the final
APK. The seven CPU microarchitecture variants (9.6 MB) are kept deliberately:
ggml dispatches among them by feature detection, so pinning one would silently
exclude devices.

That the [assistant app](https://github.com/tetherto/qvac-app/tree/main/mobile)
needs Vulkan at runtime (`backendDevice: "vulkan"` for Android OCR,
`hwCapability.device` for the LLM) is exactly why backends are declared per app
rather than optimised automatically.

## Consequences

### Positive

- An app ships the capabilities and backends it declares, and the residue is
  attributable to one named file rather than to eleven unused capabilities and
  three GPU backends.
- Configuring Assistant configures what Assistant composes; there is no second
  config file to discover.
- Capability names are SDK's own, so the vocabulary cannot drift from the
  plugins that implement it.

### Trade-offs

- Assistant reads SDK's plugin list and model-type vocabulary at build time.
  That is a composer's job and costs nothing per plugin, but it binds Assistant
  to two SDK exports and to the `@qvac/sdk/<type>/plugin` specifier shape.
- Backend selection has no such data source. The backend list and the
  `-ggml-<backend>` filename convention are Assistant's guesses, applied by
  appending generated code to `react-native-bare-kit/android/link.mjs`.
  Assistant already rewrote that file's project root, so the seam is not new,
  but the block is larger and the convention fails *silently* toward shipping
  too much.
- Generating a file another package reads is weaker than passing it options. If
  SDK ever takes a `plugins` prop, this generation step should collapse into it.
- One more generated artifact in the project root, and a YAML parser (`yaml`)
  in Assistant's dependencies.
- A CPU-only build is slower on every device that had a usable GPU, and that
  trade-off is now one line of YAML away from being made accidentally. The
  measured saving is large enough that the temptation is real.

Every coupling above is inventoried, with its failure mode and the upstream
change that would remove it, in
[TD-PACKAGING-SELECTION-COUPLING](../tech-debt/TD-PACKAGING-SELECTION-COUPLING.md).

## Alternatives considered

- **Leave apps to write `qvac.config.json` themselves.** Rejected: it defeats
  the single-entry-point promise and leaves the 461.0 MB default in place for
  anyone who does not know the file exists.
- **Put the capability list in `app.json` plugin props.** Rejected: Expo props
  are Expo's; the same declaration must serve non-Expo hosts later, and nesting
  product config inside a build tool's config file inverts ownership.
- **Add the key to `@qvac/config`.** Rejected outright: `@qvac/config` must not
  know any specific key. It resolves snapshots; it does not own vocabulary.
- **Call `bundleSdk` directly from Assistant instead of generating a file.**
  Rejected: it would fork SDK's bundling path and make Assistant responsible for
  verification, hosts, and deferred modules that SDK already owns.
- **Assistant-invented capability names.** Rejected after review: it produced a
  third vocabulary alongside SDK's canonical types and aliases, and cost one
  Assistant edit per SDK plugin addition.
- **JSON or TypeScript instead of YAML.** Rejected for the authored file: this
  is a hand-written declaration that wants comments. The generated file stays
  JSON because that is what SDK reads.

## Acceptance criteria

Change this ADR to Accepted only after:

1. The same selection drives an iOS build. Capability selection already does;
   backend pruning does not.
2. A device run confirms a completion-only, CPU-only build still completes a
   real model run. This is the gate that matters most for `accelerators`:
   nothing here has yet shown that a Vulkan-less build loads a model on real
   hardware, and a smaller binary that cannot infer proves nothing.

Already met: `bun run test:pack` builds a clean Expo consumer from packed
tarballs whose only QVAC configuration is a `qvac.assistant.yaml`, and asserts
the generated SDK config, the recorded selection, the Android prune step, and
that `@qvac/llm-llamacpp` is the only inference addon reaching the linker. The
Sync-only and Harness-only consumers in the same run confirm independent
adoptability is unaffected.

## Related material

- [QIP: Composable Agent Runtime](../qip/agentic-sdk-p2p-layering.md)
- [ADR 0001](0001-package-owned-workers-and-compatibility.md)
- [ADR 0004](0004-separate-bare-runtimes-for-sync-harness-and-sdk.md)
