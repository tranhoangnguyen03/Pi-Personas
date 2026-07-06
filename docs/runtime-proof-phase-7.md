# Phase 7 Runtime Proof

Date: 2026-06-29 to 2026-06-30
Workspace: `/Users/davidus-tranus/Github/Pi-Personas`
Evidence export: `pi-session-2026-06-29T14-54-13-689Z_019f13df-acb9-757e-9305-a869a63605af.html`
Session id: `019f13df-acb9-757e-9305-a869a63605af`

## Verdict

Status: pass with accepted follow-up.

The exported Pi session proves that the Phase 7 persona workflow ran in the
live Pi runtime with `pi-subagents` and `pi-intercom`, including doctor,
discovery, direct launch, nested consult, round-table chain execution,
progress updates, intercom supervisor clarification, scaffolded agent creation,
and duplicate-generalist detection.

The duplicate-generalist behavior in this export is historical: at the time of
the manual run, a second `role: generalist` caused doctor and round-table
errors. The design has since been superseded by the primary-generalist rule:
multiple generalists are allowed when exactly one launchable generalist has
`primary: true`.

The metadata shape in this export is also historical. The current design uses
`skills` as instruction breadcrumbs and treats `tools`, `consults`, and `tags`
as legacy migration fields. Future runtime proof should show skills in
`/persona-list` and scaffold output instead of consult peers or tool metadata.

The direct-launch execution model in this export is also superseded. Phase 7
proved the older shortcut where `/<persona>` launched a `pi-subagents` child
run. The current direction is persistent active persona mode: `/<persona>
[query]` activates that persona in the current Pi chat session, and
`pi-subagents` is used only behind `persona_consult` or explicit
`/persona-roundtable` workflows.

## Runtime Environment

| Item | Evidence | Verdict |
|---|---|---|
| Session cwd | Export header `cwd` is `/Users/davidus-tranus/Github/Pi-Personas`. | PASS |
| `pi-subagents` | `/persona doctor` reported `pi-subagents: 0.31.0` at `/Users/davidus-tranus/.pi/agent/npm/node_modules/pi-subagents`. | PASS |
| `pi-intercom` | `/persona doctor` reported `pi-intercom: 0.6.0` at `/Users/davidus-tranus/.pi/agent/npm/node_modules/pi-intercom`. | PASS |
| Session export | HTML contains base64 `session-data` JSON with 59 entries. | PASS |

## Proof Results

| ID | Question | Observed | Verdict |
|---|---|---|---|
| P7-01 | Does doctor report missing setup before fixtures exist? | Initial `/persona doctor` reported `Status: error`, `Agents: 0 launchable`, `Generalist: 0`, and `exactly one generalist required; found 0`. | PASS |
| P7-02 | Does list show no personas before fixtures exist? | Initial `/persona-list` rendered `# Pi Personas` with `- none`. | PASS |
| P7-03 | Does doctor pass after Phase 7 fixtures are installed? | `/persona doctor` reported `Status: pass`, `Agents: 4 launchable`, `Generalist: phase7-generalist`, baseline `.pi/agents/_baseline.md`, and no issues. | PASS |
| P7-04 | Does `/persona-list` show role, docs, and consult peers? | List showed `phase7-brand`, `phase7-generalist`, `phase7-guideline`, and `phase7-pricing` with roles, docs paths, and consults. Current design should show skills instead of consult peers. | PASS, SUPERSEDED |
| P7-05 | Does direct launch use `pi-subagents` and nested consults? | Direct `phase7-brand` run `06968271` completed with one child and nested `phase7-guideline`; summary included `PHASE7_DIRECT_BRAND_OK`. | PASS |
| P7-06 | Does generalist consult path work? | `phase7-generalist` run `a1cf6b8c` completed and nested `phase7-brand`; summary included `PHASE7_GENERALIST_CONSULT_BRAND_OK`. | PASS |
| P7-07 | Does round-table launch a multi-step chain? | Round-table run `d6cd3c0e` completed as mode `chain`, `Children: 7 completed`, `Chain steps: 3`, with brand, guideline, pricing, and generalist artifacts. | PASS |
| P7-08 | Does round-table show visible progress? | The session emitted repeated `Round-table progress` messages while the chain was running. | PASS |
| P7-09 | Can a child request supervisor clarification through intercom? | `phase7-guideline` requested file manifests through intercom; the parent replied with `docs/shared/phase7/context.md` and `docs/workstreams/phase7-guideline/rules.md`; the run later completed. | PASS |
| P7-10 | Does `/persona new` scaffold and register a specialist? | Creation output showed `.pi/agents/phase7-ops.md`; subsequent list included `phase7-ops`; doctor passed with `Agents: 5 launchable`. | PASS |
| P7-11 | What duplicate-generalist behavior was observed before the primary rule? | Creating `phase7-backup-generalist` succeeded, then doctor reported `multiple generalist agents: phase7-backup-generalist, phase7-generalist`, and round-table refused with `roundtable requires exactly one generalist; found 2`. | PASS, SUPERSEDED |
| P7-12 | Were temporary fixture cleanup commands prepared? | The session included `rtk rm -f` cleanup commands for Phase 7 agent/doc fixtures and later `/persona-list` showed `- none`. | PASS |

## Key Transcript Evidence

Doctor pass after fixtures:

```text
# Pi Persona Doctor

Status: pass

## Dependencies
- pi-subagents: 0.31.0 at /Users/davidus-tranus/.pi/agent/npm/node_modules/pi-subagents
- pi-intercom: 0.6.0 at /Users/davidus-tranus/.pi/agent/npm/node_modules/pi-intercom

## Project
Agents: 4 launchable
Generalist: phase7-generalist
Baseline: .pi/agents/_baseline.md

## Issues
- none
```

Direct specialist launch:

```text
Run: 06968271
Mode: single
Status: completed
Children: 1 completed
Nested subagents:
phase7-guideline - complete
Summary:
PHASE7_DIRECT_BRAND_OK
```

Generalist consult:

```text
Run: a1cf6b8c
Mode: single
Status: completed
Children: 1 completed
Nested subagents:
phase7-brand - complete
Summary:
phase7-brand returned the requested exact response:
PHASE7_GENERALIST_CONSULT_BRAND_OK
```

Round-table:

```text
# Pi Persona Round-table

Query: Phase 7 brand guideline pricing proof query. Return a concise synthesis.
Moderator: phase7-generalist
Context: fresh

## Roster
- phase7-brand - Phase 7 brand proof specialist.
- phase7-guideline - Phase 7 guideline proof reviewer.
- phase7-pricing - Phase 7 pricing proof specialist.
```

Round-table completion:

```text
Run: d6cd3c0e
Mode: chain
Status: completed
Children: 7 completed
Chain steps: 3
```

Supervisor clarification during round-table:

```text
Subagent requests a structured supervisor interview.
Run: d6cd3c0e
Agent: phase7-guideline
Interview: Need file manifest for Phase 7 docs
```

Parent reply evidence:

```text
Provided the requested file manifest to phase7-guideline:

- docs/shared/phase7/context.md
- docs/workstreams/phase7-guideline/rules.md
```

Scaffolded specialist proof:

```text
Created .pi/agents/phase7-ops.md

Launch: /phase7-ops
Docs: docs/workstreams/phase7-ops/
Tools: read
Next: run /persona doctor
```

Current scaffold output should show `Skills:` instead of `Tools:`.

Historical duplicate-generalist proof:

```text
Created .pi/agents/phase7-backup-generalist.md

# Pi Persona Doctor

Status: error

## Project
Agents: 6 launchable
Generalist: 2

## Issues
- ERROR: multiple generalist agents: phase7-backup-generalist, phase7-generalist

roundtable requires exactly one generalist; found 2
```

## Accepted Follow-up

- The duplicate-generalist policy observed here has been replaced by the
  primary-generalist policy. Future manual proof should verify:
  - first generated generalist gets `primary: true`;
  - later generated generalists get `primary: false` and a warning;
  - `/persona doctor` passes with multiple generalists when exactly one is
    primary;
  - `/persona doctor` and round-table fail only when zero or multiple primary
    generalists exist.
- Directory docs are ergonomic but caused child agents to request file
  manifests when the runtime could not list directories. The follow-up resolver
  change expands directory docs into concrete runtime file reads and adds a
  resolved-file manifest to child prompts without changing the user-facing
  schema.
- Persona metadata has shifted to awareness breadcrumbs. Future manual proof
  should verify `/persona new ... --skills <path>` scaffolds `skills:`, list
  output shows skills, doctor reports legacy `tools`/`consults`/`tags` as
  migration warnings, and consults can target any known persona by name.
