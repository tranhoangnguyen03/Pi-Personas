# Pi Persona Blueprint

Pi Persona is a generic persona-agent extension for Pi Coding Agent. It uses
Pi's active chat session for direct persona answers and uses `pi-subagents` and
`pi-intercom` only for peer consults, round-tables, and child-session support.

The extension adds a thin semantic layer over Pi. It does not replace Pi's
session model, tool registry, permissions, plugin conventions, skill loading,
filesystem behavior, or subagent runtime.

## Product Boundary

Pi owns:

- Session and thread lifecycle.
- Filesystem access and write permissions.
- Tool registration and execution policy.
- Skill and plugin loading.
- Model, terminal, editor, and workspace integration.

`pi-subagents` owns child Pi sessions, project-level subagent discovery, child
execution, fresh or forked launch context, `reads`, native skills, foreground
and background execution, status, resume, interrupt, and child safety.

`pi-intercom` owns targeted session-to-session communication and native child
progress or result channels used by `pi-subagents`.

Pi Persona owns:

- Persona schema and role semantics.
- Primary generalist semantics.
- Shared baseline plus persona awareness assembly.
- Docs and native skill guidance.
- Direct persona command routing into active persona mode.
- Consult and round-table semantics.
- Validation and setup feedback.
- Conversational authoring of project persona files.

Pi Persona must not create a parallel subagent system, permission system,
message bus, session store, or tool runtime.

## Core Model

An agent is a file. A resolver assembles role-aware instructions from that file.
Direct persona commands inject those instructions into the active Pi session.
Consult and round-table workflows reuse the same resolver, then launch child
sessions through `pi-subagents` only when peer execution is needed.

The four main parts are:

- `.pi/agents/**/*.md` project agent files, compatible with `pi-subagents`
  discovery and extended with Pi Persona metadata.
- `.pi/agents/_baseline.md`, merged into every resolved persona.
- Resolver logic that combines baseline, selected persona, docs, skills, and
  known persona roster.
- Active persona adapter that stores the selected persona, injects its prompt,
  and exposes peer consults through `persona_consult`.

Adding a persona should be data, not code. Users should be able to create a new
agent file, run `/persona doctor`, and launch it without adding a new launcher.

## Awareness, Not Restriction

Pi Persona is an awareness layer, not a security boundary.

- Shared docs and native skill names come from `_baseline.md`.
- Specialists add their own docs and native skill names.
- The generalist receives shared foundations and the persona roster, but not
  specialist docs unless the user promotes those docs to shared context.
- Persona prompts describe intended context and routing behavior.
- Pi, `pi-subagents`, and the host filesystem still own actual access.

Friction should be added only for concrete failure modes. By default, inform,
nudge, validate, and keep the user moving.

## Runtime Dependencies

Consult and round-table workflows require these Pi packages:

```sh
pi install npm:pi-subagents
pi install npm:pi-intercom
```

These packages must be installed and configured through Pi, not only present as
nested npm dependencies. Direct persona mode can still work when child-runtime
packages are missing. `/persona doctor`, `persona_consult`, and
`/persona-roundtable` perform a runtime preflight and report install or
configuration guidance before attempting bridge execution.

## Project Layout

User projects are built around this shape:

```text
.pi/
  agents/
    _baseline.md
    generalist.md
    example-specialist.md
    runtime/
      worker.md
docs/
  shared/
    _index.md
  workstreams/
    example-specialist/
      _index.md
      brief.md
```

Files prefixed with `_`, such as `_baseline.md`, are Pi Persona control files,
not launchable personas.

Runtime support roles copied from `pi-subagents` should be local project files
with provenance metadata. Prefer copied files over symlinks for repo
portability.

## Agent File Format

Persona files are markdown files with YAML frontmatter.

Specialist example:

```md
---
name: example-specialist
role: specialist
description: Reviews requests from the example specialist perspective.
docs: docs/workstreams/example-specialist/
skills:
  - review
---

You are the example specialist. Answer from your declared specialty.
```

Primary generalist example:

```md
---
name: generalist
role: generalist
primary: true
description: Routes broad requests and consults specialists when useful.
docs: docs/shared/
---

You are the primary generalist. Answer directly when shared context is enough.
Use persona_consult when another project persona has the needed expertise.
```

Baseline example:

```md
---
docs: docs/shared/
skills:
  - read
---

Shared project context and operating principles go here.
```

## Command Surface

`/persona init` creates the minimal baseline, primary generalist, and shared
docs index. It preserves existing files.

`/persona init draft --out <file>`, `/persona init --plan --from <file>`,
`/persona init --from <file>`, and `/persona init status --from <file>` support
manifest-backed setup. The manifest format is documented in
[`../init-data/README.md`](../init-data/README.md).

`/<primary-generalist-name> [query]`, usually `/generalist [query]`, activates
the primary generalist in the current chat. If the command includes a query, Pi
answers that query as the generalist.

`/<specialist-name> [query]` activates a specialist in the current chat. If the
command includes a query, Pi answers that query as the specialist.

`/persona-list` is read-only discovery. It lists the primary generalist,
non-primary generalists, specialists, descriptions, docs, and skills.

`/persona status` reports the active persona. `/persona clear` exits persona
mode.

`/persona index [docs-dir]` refreshes `_index.md` files for declared docs
directories.

`/persona-roundtable <query>` runs an explicit multi-persona workflow. The
primary generalist selects up to five relevant specialists, gathers independent
positions, allows revision, and synthesizes the answer.

## Active Persona Direction

Direct persona commands do not launch child subagents. They activate persistent
persona mode in the current Pi session through prompt injection. Active persona
mode persists across follow-up turns until another persona command switches
personas or `/persona clear` exits.

`/generalist` is also a bootstrap command. Before a project has a launchable
primary generalist, the bootstrap command returns setup guidance to run
`/persona init` instead of falling through as ordinary prompt text.

The active persona can use `persona_consult` when peer expertise is needed.
That tool is the semantic consult boundary: it resolves the consultant, runs
the child through `pi-subagents`, extracts the consultant answer, and returns
compact provenance for synthesis.

Raw `subagent` guidance should not appear in direct persona prompts.
`subagent list` lists global Pi subagents: builtins, user package agents, and
project `.pi/agents` files. It is not the Pi Persona consultant roster.
`persona_consult` only accepts project Pi Persona agents discovered from the
active workspace.

## Settled Principles

- Pi Persona is a Pi extension, not a separate agent platform.
- Direct persona answers happen in the active chat.
- Subagents are for consult and round-table child work.
- The resolver is the only place that assembles persona awareness.
- The active persona state is explicit and clearable.
- Exactly one generalist should be `primary: true`.
- Consultation is one hop by default; child consult runs are leaf tasks.
- The requesting persona writes the consult summary.
- Consulted personas receive their own resolved awareness package.
- Round-table is explicit and bounded.
- Validation should be cheap and actionable.
- Access policy belongs to Pi and the host environment.
