# Composable Agent Runtime PoC — Agent Context

Private workspace that tests the package and runtime boundaries proposed by the
Composable Agent Runtime QIP. It is **evidence, not a production package source**.
Self-contained: work here without reference to the rest of the monorepo.

This file is the shared context for every coding agent. Claude Code reads it through
`CLAUDE.md`; Cursor reads it natively and through `.cursor/rules/poc-context.mdc`. Put
tool-neutral facts here and tool-specific wiring in those files.

## Which rules apply here

- The monorepo root config is written for the shipping packages (SDK, native addons,
  registry). **It does not govern this folder.**
- No Asana ticket, no PR template, no CI gate applies to work in this folder.
- Commit subjects still use the repo-wide `prefix[tags]?: subject` form
  (`feat`, `fix`, `doc`, `test`, `chore`, `infra`, `mod`) since these commits land in
  `tetherto/qvac`. No `QVAC-###` prefix is needed on a PoC branch.

## Stack

Bun workspaces (`packages/*`, `apps/*`), TypeScript ESM, no build step for most
packages — sources are executed directly by Bun, by Node with
`--experimental-strip-types`, or by Bare. `packages/supervisor` is deliberately plain
JavaScript with hand-written `.d.ts`; do not convert it to TypeScript.

## Package boundaries

These are the invariants the PoC exists to prove. A change that blurs one of them is a
finding, not a detail.

| Package | Owns | Must not own |
|---|---|---|
| `@qvac/assistant` | Application facade, root lifecycle | Transport details, tool policy |
| `@qvac/sync` | Cryptographic device identity, replicated state | Agent execution |
| `@qvac/harness` | Ready-to-run agent execution: skills, grants, sandboxing, brokers, transports, persistence | Any concrete skill; any direct knowledge of Sync |
| `@qvac/agents` | Transport-free primitives: tool loop, guards, approval semantics, turn budget, events, checkpoints | Transports, I/O, storage |
| `@qvac/supervisor` | Lifecycle mechanics | Product policy |
| `@qvac/config` | Resolving and propagating one immutable process config snapshot | Any specific key, its aliases, defaults, or allowed values; secrets; live mutation |
| `@qvac/sdk` | Inference via its public client/worker path | — |

Additional standing rules:

- **Skills belong to applications.** `apps/skill-cli` owns the weather, obsidian, and
  image-generation skills plus their worker entries and generated bundle;
  `apps/qvac-code/desktop` owns the `qvac-code` coding skill and its two halves. Harness
  supplies only generic machinery via `@qvac/harness/skill-host` and
  `@qvac/harness/skill-sandbox`. Never move a concrete skill into `packages/harness`.
  An application reaches its own skills **through** Assistant via
  `CreateAssistantOptions.workers` and `.host`, and reads them back with
  `assistant.listSkills()`; before those existed the facade contradicted this rule.
- **Sync and Harness are siblings, not layers.** Neither may depend on the other.
  Harness reaches persistent state through `DurableStatePort`, a narrow
  in-process durable-work boundary it owns, satisfied by an injected,
  structurally compatible client; Assistant does the wiring. The existing
  `packages/harness/lib/state-port.ts` is a separate HRPC bridge for
  `HarnessRunStore` and must not be confused with this in-process port. Each
  package exposes a standalone Expo plugin that packages its own worker and
  writes its own contribution manifest, so a consumer can adopt Sync alone or
  Harness alone; `bun run test:pack` proves it.
- **One application config file, owned by Assistant.** An app writes
  `qvac.assistant.yaml`; Assistant resolves it and propagates it to the packages it
  composes. Capability names are **derived from the installed SDK** in
  `lib/expo/capabilities.ts` — canonical names from `SDK_DEFAULT_PLUGINS`, aliases from
  `MODEL_TYPES`. Do not add a hand-written name table: a plugin SDK adds must be
  selectable with no Assistant change, and `<package>/plugin` passes through for
  third-party plugins. The generated
  `qvac.config.json` is Assistant's artifact and the seam to the SDK Expo plugin, which
  accepts no props — do not hand-write it, and do not add a config section for a key no
  package reads. `inference.accelerators` prunes ggml GPU backends from the Android link
  step via `lib/packaging/barekit-linker.ts`; those backends are runtime-dispatched, so
  the list is a declared product choice and must never be inferred or defaulted to a
  subset. See [ADR 0005](docs/arch/adrs/0005-application-owned-assistant-config.md).
- **Config is a leaf utility, not a seventh runtime component.** `@qvac/config` sits
  alongside `@qvac/logging` and `@qvac/error`: it resolves a versioned, JSON-safe
  snapshot and carries it across launch boundaries, and it knows nothing about any
  individual key. A key's name, env aliases, defaults, parsing, and allowed values are
  declared with `defineConfigKey` **by the package that owns the key** — adding one to
  `packages/config` is a boundary violation. Install the snapshot before constructing
  runtime services or loggers, and let standalone Sync and Harness resolve their own
  when the host process has none.
- **Dependency direction.** `agents`, `supervisor`, and `config` depend on nothing in
  the workspace; `sync` → `supervisor`, `config`; `harness` → `agents`, `supervisor`,
  `config`, `@qvac/sdk`; `assistant` composes them all and nothing depends on
  `assistant`. No cycles, and no new edge that reverses one of these arrows.
- **No Harness-to-Sync package edge.** `packages/harness` must not import
  `@qvac/sync`, including type-only imports, and must not depend on it in
  `package.json`. Sync-backed state access in Harness goes through
  `DurableStatePort` and a structurally compatible injected client. Tests that
  need real Sync composition live outside `packages/harness`.
- **Every entry added to a package's `exports` is a contract** this PoC will be judged
  on. An export that exists only to let one package reach into another's internals is a
  boundary violation wearing a public name.
- **App package boundaries are machine-checked.** `test/subsets.test.ts` holds the
  allowed workspace dependency set for every app as well as every package. Adding an app
  means adding it there. `apps/qvac-code/mobile` is allowed `@qvac/sync` only: it is the
  repo's one standalone-Sync consumer app, and reaching Harness or Assistant from a thin
  client would retract the claim it exists to prove. Note the check matches bare
  specifiers, so a test that deep-imports a sibling package by relative path to assert a
  wire or compile contract is a bounded, intentional exception — `packages/assistant` and
  `apps/qvac-code/shared` both do it, and both say why at the import.
- **Application state on `durableWorkProfile` arbitrates on stored rows, not on errors.**
  `apply()` throws identically for a lost race, a transport failure, and a read-only
  peer, so a contended write must re-read and report won/lost/unreachable —
  `unreachable` is never a denial. `operationId` dedup compares raw command bytes, so
  commands belong in one factory with a fixed key order. `expectedRevision` is
  profile-wide and unusable for per-row arbitration. A journal `writer` is
  self-declared, so it may group and display but never confer authority. See
  [ADR 0006](docs/arch/adrs/0006-coding-sessions-on-durable-work.md) and
  [TD-DURABLE-WORK-CLAIM-GUARANTEES](docs/arch/tech-debt/TD-DURABLE-WORK-CLAIM-GUARANTEES.md).
- Review against these invariants before finishing a change that adds an export, moves
  a file between packages, or adds a cross-package import — via the `boundary-reviewer`
  agent in Claude Code, or the `boundary-review` skill in Cursor.

## Execution realms

The most common source of subtle breakage. Every file belongs to a realm; check before
you write an import.

| Realm | Entered via | Stdlib |
|---|---|---|
| Bun | `bun …`, most tests, `scripts/*.ts`, `apps/qvac-code/desktop` | Node-compatible |
| Node | `node --experimental-strip-types` (`apps/task-cli`) | Node |
| Bare | `bare …`, worker/entry files: `worker.ts`, `*-entry.ts`, `schema/build.ts`, `skill-sandbox.ts`, spawned children | `bare-*` only |
| React Native / Expo | `react-native.ts`, `mobile-entry.ts`, `apps/task-mobile`, `apps/qvac-code/mobile` | RN + bare-kit |

- Code shared with a Bare realm reaches platform APIs through the `imports` map in the
  owning `package.json` (`#fs-promises`, `#path`, `#process`, `#env`, …), which resolves
  to a `bare-*` module under the `bare` condition and to a `lib/node-*.ts` shim
  otherwise. Add a new subpath there rather than importing `node:*` directly.
- Prefer `b4a` over `Buffer` in anything that can run under Bare. This binds `packages/*`.
  An app-level `*-shared` package consumed from RN rather than from a worklet may use
  `Buffer` where the RN host polyfills it — `apps/task-shared` and
  `apps/qvac-code/shared` both do, with the `Uint8Array`-versus-`Buffer` handling that
  the worklet boundary and Hermes's missing `TextDecoder` require.
- The `react-native` export condition selects a different entry per package — when you
  add a public export, decide what the RN variant does.

## Commands

```sh
bun install --ignore-scripts   # from this directory
bun run test                   # every package suite in sequence
bun run test:harness           # one package (also :sync :agents :config :assistant
                               # :supervisor :task-shared :task-cli :skill-cli
                               # :task-mobile :qvac-code-shared :qvac-code-desktop
                               # :qvac-code-mobile)
bun run typecheck
bun run verify                 # typecheck, lint, all tests, artifact + subset + pack checks
```

`bun run verify` is the gate before declaring a change done. It is slow — run the
targeted `test:<package>` while iterating.

One suite is red at HEAD and is not yours: `sync: durable-work replicates to a real
passive peer` fails deterministically in `test:sync`'s node mode. It exercises a
`meshKey` passive join through spawned workers and writes before the swarm connects; the
creator's `peerCount` never rises, so nothing replicates. The invite-plus-writer-admission
path every app actually uses passes, in-process and through spawned workers alike. Check
against that baseline before attributing a replication failure to your change.

Mobile (`bun run android`, `bun run test:pack`, `bun run validate:artifacts`) needs a
device or a full prebuild; only run it when the change actually touches packaging.
`bun run report:apk` reports a built APK's size, its native libraries, and which addon
ships each one — use it whenever a change is meant to affect what ships.

`expo prebuild` rewrites `packages/{sync,harness}/generated/react-native/*.js` and
reformats `apps/task-mobile/android/settings.gradle`. Those are tracked placeholders;
restore them with `git checkout` after a build, or the Assistant React Native suites
fail on the filled-in bundles.

## Testing

- Three frameworks coexist by realm: **brittle** for anything that must also run on Bare
  (`supervisor`, `agents`, `sync`, `config` — each with `test:node` / `test:bun` /
  `test:bare` variants), **vitest** for `assistant` and `task-cli`, and **`bun test`**
  for `task-shared`, `skill-cli` and all three `apps/qvac-code/*` packages. Match the
  package you are in.
- **Evidence policy:** fast tests may use deterministic adapters, but *a stub may not
  replace a boundary the PoC claims to validate*. Real HRPC sessions, HyperDHT testnet
  replication, spawned Bare runtimes, and real model completions belong in the
  integration tests that exercise them.
- Never delete, skip, or weaken an existing test to make a change pass.

## CLI output conventions

`apps/task-cli`, `apps/skill-cli`, `apps/qvac-code/desktop`, and `scripts/*` follow one
convention:

- Status/progress lines: `console.log` prefixed with `▸ `.
- Errors: `console.error` prefixed with `✖ `. Reserve `console.error` for errors only.
- Genuine results stay unprefixed so they read apart from the commentary — stream tokens
  with `process.stdout.write`, print final results with plain `console.log`.
- Download/long-running progress renders as one in-place line on stderr, not a raw
  progress-object dump.
- Only `▸` and `✖`; no other decorative emoji.

## Security

Never fetch code from a remote URL and execute it — `curl … | bash`, download-then-run,
`eval` over an HTTP response body, remote bootstrap installers. This is a hard stop with
no confirmation path, and it matters here specifically: this PoC builds a sandbox that
executes skill code, so the pattern must never appear in its own tooling or fixtures.
Installing pinned dependencies through `bun`/`npm` with a lockfile is fine.

## Misc

- Every file ends with a newline.
- `docs/arch/` holds the design record (ADRs, QIP drafts, tech-debt notes). Read the
  relevant one before changing a boundary; add to it when a decision changes.
