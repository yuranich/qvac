# qvac-code — desktop executor

The laptop half of a coding agent whose sessions are created on a phone. It runs
a terminal UI, Qwen3.5 9B through `@qvac/sdk`, and a sandboxed coding skill
scoped to one project directory. Sessions, turns, transcripts and approvals all
live in `@qvac/sync`'s durable-work profile, so the phone sees them by
replication rather than by an RPC to this process.

See [ADR 0006](../../../docs/arch/adrs/0006-coding-sessions-on-durable-work.md)
for why a session is one work envelope and each turn is another, and why the
claim is a gate.

## Running it

```sh
bun apps/qvac-code/desktop/index.ts serve --project ~/dev/scratch/demo-repo --storage /tmp/qvac-code
```

It prints a `qvac-poc://pair?invite=…` URI. Pair the phone with it and approve
the writer fingerprint in the terminal. The model is fetched from the SDK
registry on first use — about 5.5 GB, so the first run needs network and takes a
while before anything else happens.

For a single prompt with no mesh and no phone, which is the fast way to exercise
the skill:

```sh
bun apps/qvac-code/desktop/index.ts once --project ~/dev/scratch/demo-repo --storage /tmp/qvac-code --prompt "add a test for expired pairing invites"
```

Flags: `--project` (required), `--storage`, `--model`, `--bare`,
`--approval-deadline`, `--allow-second-executor`.

`bare` is found automatically from `QVAC_BARE_EXECUTABLE`, then
`node_modules/.bin/bare`, then `PATH`.

## What the agent can do

Seven tools, all inside the project root: `read`, `write`, `edit`, `glob`,
`grep`, `ls`, and `shell`. `write`, `edit` and `shell` always require approval —
the skill marks them `requiresApproval`, so it is not left to the agent's own
policy.

`shell` runs no shell. A request is matched **exactly** against a fixed list of
argv shapes and spawned as argv with a scrubbed environment; anything containing
a shell metacharacter is rejected rather than parsed, because a parser is the
attack surface. The list is `git status --short`, `git diff`, `git diff --stat`,
`git log --oneline -n 10`, `bun test`, `bun run typecheck`, `bun run lint`,
`node --version`, `bun --version`.

`write` and `edit` refuse anything under `.git` while `read` still allows it: a
hook planted in `.git/hooks` would run with your full privileges outside the
sandbox, whereas reading `.git/config` is ordinary. `edit` requires the file to
have been read first in the same sandbox.

The real boundary is the macOS seatbelt profile the harness builds from the
skill's declared permissions — the project root is the only write root. The
in-process path checks are defence in depth, and they run in both halves of the
skill.

## Observed with Qwen3.5 9B Q4: tool calls arrive as prose

On the runs recorded so far, the model reasons correctly about which tools to use
— its thinking block says as much — and then writes the calls as text in a code
fence instead of emitting a structured tool call. Nothing executes, and the turn
completes with an empty transcript of tool activity.

The wiring around it is verified, layer by layer, so this is a model-behaviour
result rather than a plumbing one:

- the skill bundle resolves to seven tool grants;
- the host provider contributes seven `AgentTool` schemas;
- `createToolGate` yields all seven for the registered policy;
- each schema validates against `@qvac/sdk`'s own `toolSchema`;
- `assistant.listSkills()` returns `qvac-code`, so the application's worker entry
  and its bundle really are what the harness loaded;
- the registration is JSON round-tripped whole across the harness wire, so
  `toolPolicy` arrives intact;
- and the brokered adapter forwards `tools` and sets `toolSupport: true` on load,
  which is what switches the model's tool template on.

So **the end-to-end path is proven up to the model, and not through it.** Treat
"an agent edits files on the laptop from a phone" as demonstrated for the
transport, the claim, the approval gates and the sandbox, and as *not yet*
demonstrated for autonomous tool use by this particular model at this quantisation.

Levers worth trying next, in order of expected value: a larger or less quantised
model; the SDK's `dynamic` tools mode, which anchors the tool block after the last
user message rather than once after the system prompt (the harness does not set
`toolsMode` today, so it gets `static`); and a shorter system prompt, since
SKILL.md currently *describes* the tools in prose and a small model may be
imitating that style.

## One executor per project

`serve` refuses to start when another live executor advertises the same project,
and says so. `--allow-second-executor` overrides it. That flag exists so the
chaos test can provoke the races below; it is not a supported way to run two
executors.

## What claiming a turn does and does not guarantee

**Guaranteed: one executor never runs one turn twice, even across a crash.** The
claim precedes the run, the executor id is stable across restarts, a turn whose
claim names us with no outcome is marked `failed` at startup rather than resumed,
and `record-outcome` is exactly-once. Interrupted turns are never auto-resumed —
the skill has already written to disk and there is no effect-level idempotency,
so retry means a *new* turn you can watch diverge.

**Not guaranteed: two laptops never run the same turn.** Four open problems,
recorded in full in
[TD-DURABLE-WORK-CLAIM-GUARANTEES](../../../docs/arch/tech-debt/TD-DURABLE-WORK-CLAIM-GUARANTEES.md):

- **R1 — replication latency.** A claim is accepted against the local Autobase
  view before a peer's competing block has linearized, so both executors can
  believe they won. A confirmation barrier after winning shrinks the window; only
  a fencing token presented on every side-effecting write would close it.
- **R2 — partition.** Both executors claim, both finish, both record an outcome.
  One claim and one outcome survive the merge, but both journals do, because
  `append-journal` never arbitrates. The transcript renders only the surviving
  claim owner's entries and greys the rest. The loser's file changes on its own
  machine are real and unrecoverable.
- **R3 — no stale reclaim.** A claim held by a laptop that never comes back
  wedges that turn forever. `resolve-gate` is one-shot with no un-resolve and
  presence has no reaper. Recovery is manual: cancel the turn and submit a new
  one. A heuristic timeout was deliberately not added — reclaim without fencing
  turns a possible double execution into a guaranteed one.
- **R4** — `expectedRevision` cannot help; it is a profile-wide CAS that loses to
  unrelated traffic and fails silently.

A journal entry's `writer` is also self-declared: `append-journal` neither checks
that the caller won the claim nor stamps an authenticated identity. Turn status
is therefore derived only from the work row and the arbitrated gates, so a forged
entry cannot retire a live turn — but forged transcript *content* is not
detectable here. The fix is a Sync-level writer identity.

## Tests

```sh
bun run test:qvac-code-desktop
```

Unit tests only: pure path scoping, the edit algorithm, the shell allowlist, glob
matching, the render layer, the claim loop, the approval bridge, and the sandbox
executor driven against a temp directory with an injected fake spawn. No test
here starts a model, a Bare runtime or a mesh; those paths are exercised by the
end-to-end demo.
