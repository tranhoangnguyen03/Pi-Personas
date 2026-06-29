# Phase 6 Round-table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first usable Pi Persona round-table command.

**Architecture:** Keep pi-persona as the semantic layer and pi-subagents as the execution substrate. Pi Persona selects a simple roster, builds a pi-subagents chain with two parallel specialist rounds and one generalist synthesis step, then launches that chain through the existing slash bridge.

**Tech Stack:** Node ESM, `node:test`, TypeScript Pi extension, pi-subagents chain/parallel execution.

---

## Scope

Implemented in Phase 6A:

- `/persona-roundtable "query"` command.
- Deterministic roster selection over specialist `name`, `description`, `tags`, and `docs`.
- Roster cap at five specialists.
- Round 1 independent specialist positions.
- Round 2 reveal-and-revise specialist positions using `{previous}`.
- Generalist moderator synthesis using `{previous}`.
- Visible roster preview before launch.

Deferred:

- Non-blocking interactive roster override.
- Advanced routing quality work.
- Hard tool-level blocking of specialist consults inside round-tables. Phase 6A gives explicit task instructions not to call `persona_consult` or `subagent`.

## Verification

Automated verification:

```bash
rtk npm test
rtk npm audit --omit=dev --legacy-peer-deps
rtk git diff --check HEAD
```

Manual Pi verification:

```text
/persona doctor
/persona-list
/persona-roundtable "Should brand positioning change pricing and guideline language?"
```

Pass criteria:

- `/persona-roundtable` is handled by Pi Persona, not a generic runtime command.
- The command shows a `Pi Persona Round-table` roster preview.
- The roster contains up to five specialists and excludes the generalist.
- pi-subagents receives a chain with Round 1, Round 2, and Synthesis phases.
- The final output includes the generalist synthesis.
