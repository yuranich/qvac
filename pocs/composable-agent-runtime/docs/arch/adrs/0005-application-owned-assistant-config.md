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
  from what the installed SDK publishes: canonical names from the specifiers in
  `SDK_DEFAULT_PLUGINS` (`@qvac/sdk/llamacpp-completion/plugin` →
  `llamacpp-completion`, which is SDK's own `ModelType` value), and aliases
  from `MODEL_TYPES` minus `ModelType` (`llm`, `ocr`, `diffusion`, …). A plugin
  a future SDK adds is selectable the moment SDK ships it, with no change here.
  A name ending in `/plugin` is passed through verbatim, so the third-party
  plugins SDK documents (`<package>/plugin`) work without Assistant knowing
  them. Coupling is inventoried in
  [TD-PACKAGING-SELECTION-COUPLING](../tech-debt/TD-PACKAGING-SELECTION-COUPLING.md).
- **Propagation is generation, not reach-in.** A new first step in the Assistant
  Expo plugin (`resolve-assistant-app-config`) resolves the YAML and writes a
  generated `qvac.config.json`. The SDK plugin then runs unmodified and finds
  the file it already looks for. Execution order becomes
  `app-config → sync → harness → sdk → finalize`.
- **The generated file is Assistant's artifact.** It carries a `"//"` marker,
  is gitignored, and Assistant refuses to overwrite a `qvac.config.json` it did
  not write. A higher-precedence `qvac.config.{ts,mjs,js}` is a hard error
  rather than a silently-ignored generated file.
- **Accelerators are declared, not inferred.** `inference.accelerators` names
  the GPU backends the app ships. An addon publishes one prebuilt library per
  backend and ggml selects among them at runtime from device capability, so
  these are not dead code — dropping `vulkan` means the app runs on the CPU
  even where a Vulkan driver exists. ggml's CPU backend is its base and is
  always linked; `cpu` is accepted as an entry so `[cpu]` reads as "CPU only",
  and an unrecognised `-ggml-*.so` is never removed, so a backend introduced
  after this list cannot silently vanish from a build.
- **Backend pruning is Android-only.** `bare-link` copies loose `.so` files on
  Android but builds signed `.framework`s around `.dylib`s on Apple platforms.
  Pruning a signed framework is a different operation and is not attempted, so
  an iOS build still ships every backend. The linker patch is therefore applied
  to `android/link.mjs` only, rather than shipping a no-op on iOS.
- **Absence means today's behaviour.** No `qvac.assistant.yaml` keeps every
  built-in capability and every backend, as does a file with no `inference`
  section or no `accelerators` list. An empty `accelerators: []` is a
  deliberate CPU-only build and is not the same as absence. Selection is
  opt-in; nothing silently shrinks an existing app's build.
- **The selection is recorded.** `assistant-stack.manifest.json` gains
  `sdkPluginSelection` (config path, capabilities, plugin specifiers), so what a
  binary contains is auditable after the fact rather than inferred from its size.

Out of scope: propagating the file into the *runtime* config snapshot on device
(the YAML is a build-host artifact and is not shipped); per-model or per-device
inference tuning, which stays SDK's `deviceDefaults`; and any Sync or Harness
key — neither package needs one yet, and adding a section for a key nobody reads
would be inventing surface.

## Evidence

Same app, same commit, `expo prebuild --clean` plus `assembleRelease` on
arm64-v8a, measured with `bun run report:apk`:

| | Baseline (no config) | `capabilities: [completion]` | `+ accelerators: [cpu]` |
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
one plugin module (`.../plugins/llamacpp-completion/plugin.js`) out of eleven,
and `@qvac/llm-llamacpp` as the only inference addon among the `@qvac` packages
present. Grepping the bundle for plugin paths is *not* evidence — every
specifier still appears in the module map; only the decoded file inventory
distinguishes an included module from a recorded path.

The ten unselected inference addons and `bare-ffmpeg` are gone, taking their
sidecar backends with them — the largest single removals are
`libqvac-speech-ggml-vulkan.so` (57.7 MB), `libqvac-diffusion-ggml-vulkan.so`
(48.3 MB), `libqvac__diffusion-cpp` (34.4 MB), and `libbare-ffmpeg` (26.0 MB).

**Capability selection alone was not sufficient.** After it, two files held two
thirds of the remaining 243.4 MB: `libqvac-ggml-vulkan.so` (103.0 MB, shipped by
`@qvac/llm-llamacpp` itself, so no capability choice removes it) and
`libbare-kit.so` (61.9 MB, the Bare host runtime). Declaring `accelerators:
[cpu]` removes the first, and the build log shows the linker doing it:

```
[QVAC] Dropped undeclared opencl backend libqvac-ggml-opencl.so
[QVAC] Dropped undeclared vulkan backend libqvac-ggml-vulkan.so
```

`libbare-kit.so` remains the single largest file at 61.9 MB — 45% of the final
APK — and nothing in this ADR addresses it. The seven CPU microarchitecture
variants (9.6 MB total) are also kept: ggml dispatches among them by CPU feature
detection, so pinning one would silently exclude devices. Both are recorded, not
claimed.

For reference, the
[assistant app](https://github.com/tetherto/qvac-app/tree/main/mobile)
hand-writes the same five-plugin `qvac.config.json` this ADR generates, and
does *not* strip backends — it needs Vulkan at runtime (`backendDevice:
"vulkan"` for Android OCR, `hwCapability.device` for the LLM), which is exactly
why the choice is declared per app rather than optimised automatically.

## Consequences

### Positive

- An app ships the capabilities and backends it declares. A completion-only,
  CPU-only assistant is a 138.6 MB APK instead of a 461.0 MB one, and the
  residue is attributable to one named file (`libbare-kit.so`) rather than to
  eleven unused capabilities and three GPU backends.
- The facade is honest: configuring Assistant configures what Assistant
  composes, with no second config file to discover.
- Capability names read as product vocabulary, not as bundler internals.
- What a binary contains is recorded in the stack manifest.

### Trade-offs

- Assistant reads SDK's plugin list and model-type vocabulary at build time.
  That is a composer's job and it costs nothing per plugin, but it does bind
  Assistant to two SDK exports (`SDK_DEFAULT_PLUGINS`, `MODEL_TYPES`) and to
  the `@qvac/sdk/<type>/plugin` specifier shape. All three fail loudly.
- Backend selection has no such data source. The backend list and the
  `-ggml-<backend>.so` filename convention are Assistant's guesses, and both
  fail *silently* toward shipping too much. This is the debt the tech-debt note
  exists to track.
- Generating a file another package reads is weaker than passing it options.
  The seam exists because the SDK Expo plugin accepts no props; if SDK ever
  takes a `plugins` option, this generation step should collapse into it.
- One more generated artifact in the project root for developers to recognise.
- A YAML parser (`yaml`) joins Assistant's dependencies.
- Assistant now appends generated code to a third-party file
  (`react-native-bare-kit/android/link.mjs`). It already rewrote that file's
  project root, so the seam is not new, but the appended block is larger and
  the pruning is by filename convention (`-ggml-<backend>`). If an addon ever
  names a backend library differently, the prune misses it — it fails toward
  shipping too much, not too little.
- Backend selection is a real capability decision. A CPU-only build is slower
  on every device that had a usable GPU, and that trade-off is now one line of
  YAML away from being made accidentally. The measured saving is large enough
  that the temptation is real.

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
- **JSON or TypeScript instead of YAML.** Rejected for the authored file: this
  is a hand-written declaration that wants comments. The generated file stays
  JSON because that is what SDK reads.

## Acceptance criteria

Change this ADR to Accepted only after:

1. The same selection drives an iOS build, not only Android — capability
   selection already does; backend pruning does not (see above).
2. A device run confirms a completion-only, CPU-only build still completes a
   real model run. A smaller binary that cannot infer proves nothing, and this
   is the gate that matters most for `accelerators`: nothing here has yet shown
   that a Vulkan-less build loads a model on a real device.

Already met: `bun run test:pack` builds a clean Expo consumer from packed
tarballs whose only QVAC configuration is a `qvac.assistant.yaml` declaring
`capabilities: [completion]`, and asserts the generated SDK config, the recorded
selection, and that `@qvac/llm-llamacpp` is the only inference addon reaching
the linker. The propagation therefore survives package extraction and does not
depend on the workspace layout. The Sync-only and Harness-only consumers in the
same run confirm independent adoptability is unaffected.

## Related material

- [QIP: Composable Agent Runtime](../qip/agentic-sdk-p2p-layering.md)
- [ADR 0001](0001-package-owned-workers-and-compatibility.md)
- [ADR 0004](0004-separate-bare-runtimes-for-sync-harness-and-sdk.md)
