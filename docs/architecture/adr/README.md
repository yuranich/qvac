# Architectural Decision Records (ADRs)

This directory holds the QVAC monorepo's architecturally significant decisions. Decisions are made via the architecture advice process and recorded here as append-only history.

## What lives here

One Markdown file per decision, named `NNNN-slug.md`, where `NNNN` is a four-digit sequence number assigned at draft time and `slug` is a kebab-case short title.

`0000-template.md` is the template every new ADR copies from. It is not itself a decision.

## When to open an ADR

Open an ADR when the change is **architecturally significant** — any of:

- Crosses a package boundary or introduces a new cross-package import
- Changes a public SDK API surface (anything an app or third-party integrator can import)
- Adds a native dependency or platform-specific code path
- Touches the addon, plugin, or model registry contract
- Introduces a new runtime, transport, or storage technology
- Changes a published NFR threshold (binary size, startup time, crash-free rate, platform coverage)
- Conflicts with a published principle

If none of these fire, decide it inside your team using whatever you already use — PR review, design doc, slack thread. No ADR needed.

## How to open one

1. Copy `0000-template.md` to `NNNN-slug.md` (next free number).
2. Fill it in. Set Status: **Proposed**.
3. Open a PR against `main` containing only that file.
4. Tag affected pods and experts as reviewers. Default advice window: **3 business days**.
5. Synthesize advice into the *Advice received* table.
6. Set the final Status (Accepted / Rejected / Withdrawn) and merge.

The agent skills under `.cursor/skills/arch-advice/` automate the repetitive parts: drafting the skeleton, running the significance checklist, suggesting advisors, transcribing PR review threads, and detecting drift on implementation PRs.

## Statuses

- **Proposed** — draft under review.
- **Accepted** — decided to proceed; implementation begins.
- **Rejected** — decided not to proceed. Still merged for the historical record.
- **Withdrawn** — decider voluntarily pulled the proposal.
- **Superseded by ADR-NNNN** — a later ADR replaced this one.
- **Retired** — the decision no longer applies (technology dropped, scope removed).

ADRs are append-only. After merge they are not edited except for typos. To change a decision, open a new ADR that supersedes the old one.

## Numbering

Pick `NNNN` as `max(existing) + 1` at the time you draft, zero-padded to four digits. The drafter agent skill (`adr-draft`) does this automatically.

## Related

- Sibling docs:
  - [`../PRINCIPLES.md`](../PRINCIPLES.md) — decision-making rules (P1-P11)
  - [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — current system architecture
- Agent skills that automate the advice process:
  - [`.cursor/skills/arch-advice/`](../../../.cursor/skills/arch-advice/)
