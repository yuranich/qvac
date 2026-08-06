# Composable Agent Runtime PoC

This private workspace tests the package and runtime boundaries proposed by the
Composable Agent Runtime QIP. It is evidence, not a production package source.

## Boundaries

- `@qvac/assistant` is the application facade and root lifecycle owner.
- `@qvac/sync` owns cryptographic device identity and replicated state.
- `@qvac/harness` owns ready-to-run agent execution: where tools come from and
  how they run (skills, grants, sandboxing, brokers, transports, persistence).
- `@qvac/agents` contains transport-free agent primitives: what a tool is and
  how a run consumes one (the tool loop, guards, approval semantics, turn
  budget, events, checkpoints).
- `@qvac/sdk` owns inference through its standard public client and worker path.
- `@qvac/supervisor` supplies lifecycle mechanics without product policy.

Skills belong to applications. `apps/skill-cli` owns the weather, obsidian, and
image-generation skills, their worker entries, and the generated skill bundle.
Harness supplies only the generic machinery, through `@qvac/harness/skill-host`
and `@qvac/harness/skill-sandbox`.

Sync and Harness are siblings in Assistant's package and artifact hierarchy.
Each exposes a standalone Expo plugin (`@qvac/sync/expo-plugin`,
`@qvac/harness/expo-plugin`) that packages its own worker, writes a contribution
manifest, and can finalize its own linker artifacts. The Assistant Expo plugin
composes those packages in contributor mode with the existing SDK Expo plugin
without reimplementing SDK bundling.

## Run the desktop slice

Install once from this directory:

```sh
bun install --ignore-scripts
```

Use separate commands so storage is closed and reopened between host runs:

```sh
node --experimental-strip-types apps/task-cli/index.ts seed --storage /tmp/qvac-task-poc --name Ada --age 37
node --experimental-strip-types apps/task-cli/index.ts observe --storage /tmp/qvac-task-poc --once
node --experimental-strip-types apps/task-cli/index.ts execute --storage /tmp/qvac-task-poc --trace
```

Run package, graph, clean-consumer, and type verification with:

```sh
bun run verify
```

## Configure the stack from one file

An application writes one QVAC config file, `qvac.assistant.yaml`, next to its
`app.json`. `@qvac/assistant/expo-plugin` resolves it during prebuild and
propagates it to the packages it composes, so the build produces only what the
app declares:

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

Capability names come from the installed `@qvac/sdk`, not from a list Assistant
maintains: either a canonical model type (`llamacpp-completion`, `ggml-ocr`, …)
or one of SDK's own aliases (`llm`, `ocr`, `diffusion`, …), both derived at
build time from `SDK_DEFAULT_PLUGINS` and `MODEL_TYPES`. A plugin a future SDK
adds is selectable with no change to Assistant. A third-party plugin is named
by its specifier, as in `my-plugin/plugin`. Omit the `inference` section — or
the file — to keep every built-in capability.

`accelerators` names the GPU backends to ship: `vulkan`, `opencl`, `metal`.
Each addon publishes one prebuilt library per backend and ggml picks among them
at runtime from device capability, so this is a product choice, not an
optimisation — `[cpu]` means the app runs on the CPU even where a Vulkan driver
exists. ggml's CPU backend is always linked. Omit the list to keep every
backend. Pruning applies to Android only; Apple platforms ship signed
frameworks that are not pruned.

Assistant generates a `qvac.config.json` from it for the SDK Expo plugin, which
takes no props and reads only that file. The generated file is gitignored, and
Assistant refuses to overwrite a `qvac.config.json` it did not write. What a
build selected is recorded in `qvac/assistant-stack.manifest.json` under
`sdkPluginSelection` and `acceleratorSelection`. See
[ADR 0005](docs/arch/adrs/0005-application-owned-assistant-config.md).

Measured on `apps/task-mobile`, arm64-v8a release, with `bun run report:apk`:

| | No config | `capabilities: [llm]` | `+ accelerators: [cpu]` |
|---|---|---|---|
| APK | 461.0 MB | 243.4 MB | 138.6 MB |
| Native libraries | 424.8 MB / 72 files | 210.3 MB / 50 files | 105.5 MB / 48 files |
| Linked addons | 39 | 28 | 28 |
| ggml backends | vulkan, opencl, cpu | vulkan, opencl, cpu | cpu |

The largest remaining file is `libbare-kit.so` at 61.9 MB — the Bare host
runtime, 45% of the final APK, which no configuration here affects. The seven
CPU microarchitecture variants (9.6 MB) are kept deliberately: ggml dispatches
among them by CPU feature detection, so pinning one would exclude devices.

```sh
bun run report:apk
bun run report:apk --project-root apps/task-mobile --apk path/to/app.apk --json /tmp/apk.json
```

## Run the mobile clean consumer

`apps/task-mobile` configures only `@qvac/assistant/expo-plugin`. It owns
pairing input, storage path, and UI state, not worker packaging, native linking,
or process isolation. Apps that need Sync or Harness alone can instead configure
only that package's Expo plugin.

SDK 0.15 currently permits `bare-process@4.5.1`, whose native
`bare-signals@5` conflicts with SDK's `bare-signals@4`. `bare-tty@5.1.2`
introduces the same split through `bare-stdio`. Until the dependency ranges are
aligned, the application root must override `bare-process` to `4.5.0` and
`bare-tty` to `5.1.1`; final-artifact validation rejects the split if those
constraints are missing.

```sh
bun run android
```

This clean-prebuilds, builds, installs, launches, and starts Metro. Build APKs
without installing them, or install the release variant, with:

```sh
bun run android:build
bun run android:release
bun run android:release:device
```

The release APK uses the demo debug signing key and does not require Metro.

The Android packaging PoC passed clean prebuild, debug APK validation, and a
physical arm64 device run on 2026-07-29. The device run covered Sync and
Harness readiness, restart, continued Sync writability, cancellation, and a
real Qwen completion through the Harness-to-SDK bridge.

`bun run test:pack` packs the current packages and verifies three independent
clean Expo Android consumers from tarballs: Sync-only, Harness-only, and the
Assistant one-plugin full stack.

After prebuild, validate the recorded execution realms and merged addon set:

```sh
bun run validate:artifacts --project-root apps/task-mobile
```

Validate an Android final artifact or a staged desktop distribution with:

```sh
bun run validate:artifacts --project-root apps/task-mobile --mode android --artifact apps/task-mobile/android/app/build/outputs/apk/debug/app-debug.apk --json /tmp/qvac-android-artifacts.json
bun run validate:artifacts --project-root apps/task-mobile --mode desktop --artifact /path/to/staged-dist --json /tmp/qvac-desktop-artifacts.json
```

The validator writes its complete JSON report to stdout and to `--json` when
provided. It exits nonzero for duplicate singleton versions within one realm,
native addon conflicts, linker-manifest drift, or missing staged prebuilds.

## Evidence policy

Fast tests use deterministic adapters. Separate integration tests exercise real
HRPC sessions, HyperDHT testnet replication, spawned Bare runtimes, and a
pre-provisioned Qwen model. A stub may not replace a boundary that the PoC
claims to validate.
