---
name: adr-draft
description: Step 1 of the QVAC architecture advice process. Turn a problem statement into an ADR draft at `docs/architecture/adr/NNNN-slug.md` with options, trade-offs, and a principle trace pre-filled from PRINCIPLES.md. Invoke when starting a new architecturally significant decision.
disable-model-invocation: true
---

# adr-draft

Generate a new ADR draft from a free-form problem statement. Output is a Markdown file at `docs/architecture/adr/NNNN-slug.md` matching the template, with the principle trace pre-populated by reading `PRINCIPLES.md`. All paths are relative to the qvac repo root, which is the working directory.

## Inputs

- **Required**: a problem statement (1-3 paragraphs). Plain prose. No need for a pre-baked solution.
- **Optional**: target package(s) under `packages/<x>/`. If omitted, infer from the problem statement.
- **Optional**: candidate options the decider already has in mind. If omitted, the skill seeds two — the status quo and one alternative — and leaves the decider to expand.

## Workflow

Copy this checklist and track progress:

```
- [ ] 1. Pick the next ADR number
- [ ] 2. Derive a slug from the problem statement
- [ ] 3. Read PRINCIPLES.md
- [ ] 4. Identify likely principles in play
- [ ] 5. Seed Options considered
- [ ] 6. Read 0000-template.md and apply substitutions
- [ ] 7. Write the file
- [ ] 8. Print path + next steps to the user
```

### 1. Pick the next ADR number

Use Glob to list existing ADRs:

```
Glob: docs/architecture/adr/[0-9][0-9][0-9][0-9]-*.md
```

The next number is `max(N) + 1`, zero-padded to 4 digits. `0000-template.md` is excluded — it's the template, not a decision. If only the template exists, start at `0001`.

### 2. Derive a slug

From the problem statement, pick a 2-5 word kebab-case slug that names the decision (not the problem). Examples: `replace-hyperdrive-with-blob-store`, `addon-interface-unification`, `mobile-gpu-fallback-policy`.

### 3. Read the canonical source

Read `docs/architecture/PRINCIPLES.md` — 11 principles (P1-P11) with rationale, trade-offs, and implications. PRINCIPLES.md is the actionable form of the architectural manifesto; the manifesto itself is not used in this process.

Do not summarize the principles in the draft. The draft references them by ID.

### 4. Identify likely principles in play

Pick the 1-3 principles most likely to constrain or motivate the decision. Heuristic mapping (not exhaustive):

| Problem theme | Principles to consider |
| --- | --- |
| offline / network dependency / phone-home | P1 Device-First, P7 Observable Without Phoning Home |
| platform fragmentation, mobile vs desktop | P2 Cross-Platform Parity, P9 Reach Every Device That Matters |
| package boundaries, repo structure, DX | P3 Modular at the Interface, P6 Developer Experience is Architecture |
| P2P, sync, distribution, model delivery | P4 P2P as Infrastructure |
| security, trust, attestation, signing | P5 Verifiable Trust Boundaries |
| crash recovery, addon failure, error handling | P8 Resilient at the SDK Boundary |
| SDK API surface, what belongs in the SDK | P10 Inference Platform, Not Application Framework |
| forking upstream, vendoring, engine divergence | P11 Strategic Depth Over Wholesale Forking |

If the decision conflicts with a principle (rather than aligning), still list it in Trace — the decider must explicitly explain the trade-off in Consequences and create a tech debt ticket.

### 5. Seed Options considered

Produce two options minimum:

- **Option A — Status quo**: what happens if we do nothing. State the trade-offs of inaction.
- **Option B — <name>**: the most obvious alternative based on the problem statement.

If the user supplied candidate options, list them all. Number per the template (Option A, B, C, ...). For each option, write a 1-2 sentence summary and 2-4 bullet trade-offs. Do not pretend to know consequences you can't infer — leave `<TODO: ...>` placeholders rather than fabricating.

### 6. Compose the draft

Read `docs/architecture/adr/0000-template.md` as the structural source of truth. Do not redefine the section structure here — it lives in the template file. Apply the following substitutions and pre-fills on top of it:

| Template fragment | Replace with |
| --- | --- |
| `# ADR-NNNN: <Title>` | `# ADR-NNNN: <real title from step 2's slug, title-cased>` |
| `- Status: Proposed \| Accepted \| ...` | `- Status: Proposed` |
| `- Date: YYYY-MM-DD` | today's date in `YYYY-MM-DD`. Get it from the system; do not guess |
| `- Decider: @handle` | `- Decider: <TODO: @handle>` |
| `- Advisors requested: @handle1, @handle2, ...` | `- Advisors requested: <TODO: run adr-advisor-suggest to populate>` |
| `## Context` body | The problem statement polished into 1-2 paragraphs of plain prose. Link relevant code paths, prior ADRs, or external references using markdown links. State assumptions explicitly |
| `### Option A — <name>` and `### Option B — <name>` | Seeded per step 5 — `Option A — Status quo` plus the strongest alternative. Each gets a 1-2 sentence Summary and 2-4 Trade-off bullets. If you cannot infer, use `<TODO: ...>` rather than fabricating |
| `## Decision` body | `<TODO: chosen option, in one paragraph of plain prose. Fill in after advice.>` |
| `## Consequences` bullets | Keep all four bullets (Positive / Negative / Open risks / Tech debt). Replace each value with `<TODO: ...>`. Tech debt note: `<TODO: link to debt ticket if a principle is knowingly broken; otherwise "none">` |
| `## Out of scope` body | `<TODO: things that look related but are not part of this decision>` |
| `## Advice received` table rows | One placeholder row: `\| <TODO> \| <TODO> \| <TODO> \| <TODO> \|` |
| `- Principles: P<N> <name>, P<N> <name>` | Pre-filled from step 4. If no principle applies, use `<TODO: none apparent — confirm>` |
| `- NFRs: <id> — threshold relevant` | `- NFRs: <TODO: id and threshold if relevant; otherwise "none">` |
| `- Supersedes: ADR-XXXX (if any)` | `- Supersedes: <TODO: ADR-XXXX if applicable; otherwise omit>` |

Use `<TODO: ...>` (not `<...>`) for fields the decider must fill, so they grep cleanly. Preserve all other template structure verbatim.

If the template's structure changes (sections added, removed, reordered), this skill picks up the change automatically — the substitutions above touch values, not structure. Add new substitution rows here only if a new placeholder shape is introduced.

### 7. Write the file

Path: `docs/architecture/adr/NNNN-slug.md` — using the values from steps 1 and 2.

Do not commit. The decider commits after editing.

### 8. Print path + next steps

Output to the user:

```
Drafted ADR-NNNN at docs/architecture/adr/NNNN-slug.md.

Next steps:
1. Edit the draft until it reflects YOUR thinking. The seeds are starting points, not final answers.
2. Run adr-significance-classify to confirm this is genuinely architecturally significant.
3. Run adr-principle-review to check the trace against PRINCIPLES.md.
4. Run adr-advisor-suggest to identify advisors.
5. Open a PR against main with Status: Proposed.
```

## Output format

A single new file at `docs/architecture/adr/NNNN-slug.md`. No edits to other files. No git operations.

## Safety rules

- **Do not commit, push, or branch.** Decider does that.
- **Do not invent facts about consequences.** Use `<TODO: ...>` placeholders. The decider knows things the agent doesn't.
- **Do not cite principles that aren't in PRINCIPLES.md.** P1-P11 only. If the decision touches none of them, leave Trace's Principles line as `<TODO: none apparent — confirm>`.
- **Do not skip the slug derivation.** Numbered-only filenames (e.g. `0001.md`) make the directory unreadable.
