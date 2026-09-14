# Pi Persona Blueprint

Pi Persona is a generic persona-agent extension for Pi Coding Agent 0.85.1. It
uses Pi's active chat session for direct persona answers and a selectable child
backend only for peer consults and round-tables.

The extension adds a thin semantic layer over Pi. It does not replace Pi's
session model, tool registry, permissions, plugin conventions, skill loading,
filesystem behavior, or model/tool runtime.

## Product Boundary

Pi owns:

- Session and thread lifecycle.
- Filesystem access and write permissions.
- Tool registration and execution policy.
- Skill and plugin loading.
- Model, terminal, editor, and workspace integration.

The native backend owns only one-shot child supervision: it starts a dedicated
Node process, creates one controlled Pi SDK session, forwards progress and
usage, cancels and disposes it, and returns one answer. Pi still owns the agent
loop, model providers, authentication, built-in tools, skills, and session
format. The legacy backend delegates child lifecycle to `pi-subagents`.

Pi Persona owns:

- Persona schema and role semantics.
- Primary generalist semantics.
- Shared baseline plus persona awareness assembly.
- Docs and native skill guidance.
- Direct persona command routing into active persona mode.
- Consult and round-table semantics.
- Validation and setup feedback.
- Conversational authoring of project persona files.
- Fixed consult and round-table orchestration.
- Backend selection and normalized child progress/results.

Pi Persona must not grow a public subagent tool, general workflow language,
permission system, message bus, persistent child-session store, background job
platform, or model/tool runtime.

## Core Model

An agent is a file. A resolver assembles role-aware instructions from that file.
Direct persona commands inject those instructions into the active Pi session.
Consult and round-table workflows reuse the same resolver, then launch child
sessions through the selected backend only when peer execution is needed.

The four main parts are:

- `.pi/agents/**/*.md` project agent files with Pi Persona metadata.
- `.pi/agents/_baseline.md`, merged into every resolved persona.
- Resolver logic that combines baseline, selected persona, docs, skills, and
  known persona roster.
- Active persona adapter that stores the selected persona, injects its prompt,
  and exposes peer consults through `persona_consult`.

Adding a persona should be data, not code. Users should be able to create a new
agent file, run `/persona doctor`, and launch it without adding a new launcher.
`/persona use <name>` is the canonical path; direct `/<name>` commands are
convenience aliases when the name is not reserved or colliding.

## Awareness, Not Restriction

Pi Persona is an awareness layer, not a security boundary.

- Shared docs and native skill names come from `_baseline.md`.
- Specialists add their own docs and native skill names.
- The generalist receives shared foundations and the persona roster, but not
  specialist docs unless the user promotes those docs to shared context.
- Persona prompts describe intended context and routing behavior.
- Pi and the host filesystem still own actual access. Native children receive
  a read-only built-in tool default, unless the persona declares other Pi built-ins; this is not a filesystem sandbox.
- Pi Persona rejects declared paths and writes that escape the physical
  workspace, including escapes through symlinks.

Friction should be added only for concrete failure modes. By default, inform,
nudge, validate, and keep the user moving.

## Child Backends

The `legacy` backend requires this Pi package:

```sh
pi install npm:pi-subagents
```

It must be installed and configured through Pi, not only present as a nested
npm dependency. The `native` backend requires no extra Pi package. Either
backend can be selected explicitly by `.pi/persona.json` with
`{ "backend": "native" | "legacy" }` or the `PI_PERSONA_BACKEND` environment
override; either wins over auto-detection, and an invalid value is a startup
error.

With no explicit preference, Pi Persona defaults to `legacy` when
`pi-subagents` is installed (the same existence check `detectDependencies`
performs for doctor) and to `native` otherwise. This default only looks at
whether the package is installed, not whether it is also configured as a
loaded Pi package or new enough for round-tables — an installed-but-broken
`pi-subagents` still resolves the default to `legacy`, and doctor/preflight
reports the configuration or version problem rather than silently retrying as
native. `/persona doctor` reports the effective backend and applies dependency
checks only to legacy.

Backend selection is frozen before work starts. There is no automatic retry or
fallback after launch because a repeated child might duplicate side effects.
Native launch resolves each selected persona's skills, built-in tools,
model, authentication, and fork snapshot before the first round-table child
starts. Authentication is then refreshed for each launch. Native is not an OS
sandbox: child processes inherit the parent environment and filesystem access.
Static doctor checks resolved child tools; loaded skills, models, providers,
and authentication are checked against live Pi state at launch. Wildcard Pi
peer metadata follows Pi packaging guidance. Pi 0.85.1 is the tested baseline;
other host versions are not rejected merely because their version differs.

## Project Layout

User projects are built around this shape:

```text
.pi/
  persona.json          # optional: { "backend": "native" }
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

Legacy runtime support roles remain ordinary local project files. The native
backend does not discover or require runtime support personas.

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

`/persona onboard` is the primary setup path. It creates or resumes
`init-data/my-operating-layer.yaml`, starts an assisted interview, and lets the
assistant edit the manifest, preview the plan, request approval, apply, index
docs, run doctor, list personas, and activate the primary generalist.
`--out <file>` overrides the default manifest path.

`/persona quick-start` creates only the minimal baseline, primary generalist,
and shared docs index. It preserves existing files. `/persona init` remains a
compatibility alias for `/persona onboard`.

`/persona init draft --out <file>`, `/persona init --plan --from <file>`,
`/persona init --from <file>`, and `/persona init status --from <file>` remain
advanced manifest controls. The manifest format is documented in
[`../../init-data/README.md`](../../init-data/README.md).

`/persona use <name> [query]` activates any valid project persona through the
stable namespace. This is the guaranteed route for reserved names and command
collisions.

`/<primary-generalist-name> [query]`, usually `/generalist [query]`, activates
the primary generalist in the current chat. If the command includes a query, Pi
answers that query as the generalist.

`/<specialist-name> [query]` activates a specialist in the current chat. If the
command includes a query, Pi answers that query as the specialist.

Direct persona command names are registered opportunistically as projects are
seen, but every invocation resolves against the active workspace. A stale
command name from another workspace must fail with `/persona-list` guidance
instead of activating stale persona state. Reserved aliases use `/persona use`.

`/persona-list` is read-only discovery. It lists the primary generalist,
non-primary generalists, specialists, descriptions, docs, and skills.

`/persona status` reports the active persona. `/persona clear` exits persona
mode.

`/persona index [docs-dir]` refreshes `_index.md` files for declared docs
directories.

`/persona-roundtable <query>` runs an explicit multi-persona workflow. The
command activates the primary generalist in the current chat. It returns a
schema-validated selection of one to five specialists with reasons through one
`persona_roundtable` tool call. That call launches one child workflow: only the
selected roster gathers independent positions and revises after peer reveal,
then the primary generalist synthesizes the answer. Selection failure is
explicit and never falls back to a lexical heuristic.

Legacy sends one request through the existing bridge: a chain payload for
`pi-subagents` 0.34.0-0.40.x and a foreground `workflowScript` for 0.41.0 or
newer. Native runs the same fixed workflow in Pi Persona: parallel Round 1, parallel Round 2 with
ordered Round 1 answers, then one moderator session. A phase failure cancels
unfinished siblings and prevents synthesis. Both paths show normalized progress
and return one moderator synthesis without raw runtime paths or receipts.

The round-table tool makes its process inspectable without streaming specialist
opinions: it shows the delegated query, context policy, selected roster and
reasons, independent/revision/synthesis phase purpose, stable per-persona state,
human-readable activity, next step, and final execution totals.

## Active Persona Direction

Direct persona commands do not launch child subagents. They activate persistent
persona mode in the current Pi session through prompt injection. Active persona
mode persists across follow-up turns until another persona command switches
personas or `/persona clear` exits.

`/generalist` is also a bootstrap command. Before a project has a launchable
primary generalist, the bootstrap command returns setup guidance to run
`/persona onboard` instead of falling through as ordinary prompt text.

The active persona can use `persona_consult` when peer expertise is needed.
That tool is the semantic consult boundary: it resolves the consultant, runs
one child through the selected backend, and returns compact provenance for
synthesis. The requester must match the active persona, and a persona cannot
consult itself.

Raw `subagent` guidance should not appear in direct persona prompts.
`subagent list` lists global Pi subagents when another package provides that
command. It is not the Pi Persona consultant roster and native never calls it.
`persona_consult` only accepts project Pi Persona agents discovered from the
active workspace.

## Settled Principles

- Pi Persona is a Pi extension, not a separate agent platform.
- Direct persona answers happen in the active chat.
- Subagents are for consult and round-table child work.
- Native children are one-shot, foreground leaf sessions with a read-only default; personas may declare other Pi built-in tools.
- Persistent conversations, background jobs, and child
  extensions require a new concrete product decision rather than another flag.
- The resolver is the only place that assembles persona awareness.
- The active persona state is explicit and clearable.
- Exactly one generalist should be `primary: true`.
- Consultation is one hop by default; child consult runs are leaf tasks.
- The requesting persona writes the consult summary.
- Consulted personas receive their own resolved awareness package.
- Round-table is explicit and bounded.
- The primary generalist owns round-table roster selection.
- Validation should be cheap and actionable.
- Access policy belongs to Pi and the host environment.
