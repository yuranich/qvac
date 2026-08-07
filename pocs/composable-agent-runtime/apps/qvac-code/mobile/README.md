# qvac-code — mobile thin client

The phone half of a coding agent whose sessions run on a laptop. It creates
sessions, submits turns, renders the live transcript, decides the approvals the
agent needs before writing a file or running a command, and cancels turns.

It runs **no inference and executes no tools**. It configures
`@qvac/sync/expo-plugin` and nothing else: no Assistant, no Harness, no
`@qvac/sdk`, no model. Everything it shows arrives by replication.

That makes it the first standalone-Sync consumer app in this repo.
`bun run test:pack` has always proved a Sync-only Expo consumer can be built from
tarballs, but no application here was one. `test/subsets.test.ts` holds this
package to `@qvac/sync` and `@qvac-poc/qvac-code-shared` alone, so a later import
of Harness or Assistant fails the suite rather than quietly retracting the claim.

## Running it

```sh
bun run --cwd apps/qvac-code/mobile ios
```

```sh
bun run --cwd apps/qvac-code/mobile android
```

Both are simulator/emulator targets. On the desktop side, run
`qvac-code serve --project <repo>`, copy the `qvac-poc://pair?invite=…` URI it
prints into the app's pairing field, and approve the writer fingerprint in the
terminal.

`ready()` on a first pairing does not resolve until the desktop approves, so the
UI shows an explicit *awaiting approval* state around that wait rather than
appearing to hang.

The Android emulator sits behind a NAT that would otherwise leave replication to
UDP holepunching, so for a local demo point both sides at a HyperDHT testnet
bootstrap. The override is read from `EXPO_PUBLIC_QVAC_BOOTSTRAP` as a
comma-separated `host:port` list, gated behind `__DEV__` so it cannot reach a
release bundle, and it falls back to the public DHT when unset. Use `127.0.0.1`
from the iOS Simulator and `10.0.2.2` from the Android emulator.

## Two rules the UI is built around

Both are ways a replicated client can lie about state it does not own.

**Render only from watch frames.** A resolve the phone issues lands in its own
Autobase view first and can still lose the merge, so the sheet shows `sending`
and never `decided` until a frame says so. A decision arriving for a turn that
already has an outcome renders as *this turn already finished*, never as a check
mark implying a tool ran.

**A `withdrawn` or `unanswered` verdict renders as exactly that word.** They mean
nobody decided, which is a different fact from "denied". The harness approval
port is tri-state for this reason, and collapsing the distinction here would let a
reader believe a denial was made that nobody made.

## What running on a simulator does not prove

Recorded here so the evidence is not overstated:

- **iOS code signing and the `ios-arm64` device slice.** Simulator builds need no
  team, and there is no Apple Team ID anywhere in this repo. No device build is
  claimed.
- **A real Android device install.** The emulator image must be arm64-v8a, since
  `requiredMobileHosts` has no `android-x64`; that is the default on Apple
  Silicon but it is a constraint, not a preference.
- **Background retention, suspend/resume and force-stop fidelity.** The iOS
  Simulator models app suspension poorly.
- **Real-network NAT traversal.** A same-host local bootstrap is the easy case.

`apps/task-mobile` already carries physical iOS and Android evidence for the full
Assistant stack. What this app adds is different: standalone-Sync adoption,
remote coding sessions, and remote approvals — and a simulator exercises all
three.

## Tests

```sh
bun run test:qvac-code-mobile
```

Controllers and pure helpers, not the React tree, following `apps/task-mobile`:
the connect/awaiting-approval/ready transitions against an injected fake Sync and
fake store, a `superseded` create surfaced rather than swallowed, `submitTurn`
retrying once at a fresh sequence then failing clearly, all three
`resolveApprovalGate` outcomes mapped distinctly, watches stopped on disconnect,
the transcript view model's incremental merge, and the two rules above.
