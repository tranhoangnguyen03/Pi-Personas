# Pi Persona Blueprint

Pi Persona is a generic persona-agent extension for Pi Coding Agent 0.85.1. It
uses Pi's active chat session for direct persona answers and its own private
native child runner only for peer consults and round-tables.

The extension adds a thin semantic layer over Pi. It does not replace Pi's
session model, tool registry, permissions, plugin conventions, skill loading,
filesystem behavior, or model/tool runtime.

User-facing copy calls onboarding's result the **project foundation**. It holds
project purpose and shared context; packs supply persona teams. The default
working manifest is `init-data/my-persona-setup.yaml`.

## Product Boundary

Pi owns:

- Session and thread lifecycle.
- Filesystem access and write permissions.
- Tool registration and execution policy.
- Skill and plugin loading.
- Model, terminal, editor, and workspace integration.

Pi Persona's native runner owns only one-shot child supervision: it starts a
dedicated Node process, creates one controlled Pi SDK session, forwards
progress and usage, cancels and disposes it, and returns one answer. Pi still
owns the agent loop, model providers, authentication, built-in tools, skills,
and session format. Pi Persona does not delegate child lifecycle to
`pi-subagents` or any other extension.

Pi Persona owns:

- Persona schema and role semantics.
- Shared baseline plus persona awareness assembly.
- Library, reference, and native skill guidance.
- Direct persona command routing into active persona mode.
- Consult and round-table semantics.
- Project-foundation onboarding and validation feedback.
- Draft-based authoring (create/fork/edit/preview/apply) of global persona
  packs.
- Global persona-pack discovery, lifecycle, and provenance.
- Session team binding, the default for new sessions, and migration of older
  project setups.
- Chat-first management through the `persona_pack` tool.
- Native child launch and normalized child progress/results.

Pi Persona must not grow a public subagent tool, general workflow language,
permission system, message bus, persistent child-session store, background job
platform, or model/tool runtime.

## Core Model

An agent is a file inside a persona pack. A resolver assembles role-aware
instructions from that file. Direct persona commands inject those instructions
into the active Pi session. Consult and round-table workflows reuse the same
resolver, then launch native child sessions only when peer execution is
needed.

The main parts are:

- A global pack store under Pi's agent directory
  (`<agentDir>/persona/{official,custom,drafts}`). Each pack holds
  `pack.yaml`, `agents/*.md`, and `references/**`.
- A session binding: each session records one team (or none), and a store-wide
  default applies to genuinely new sessions only.
- A retained snapshot: binding copies the pack once into a private
  per-session directory, and the session's commands, prompts, consults, and
  round-tables read that copy. Later store changes reach a session only when
  it refreshes or switches.
- The resolver, which combines the optional workspace baseline
  (`.pi/agents/_baseline.md`), the selected persona, its workspace `docs`, its
  pack-relative `packDocs` (resolved against the snapshot's `references/`),
  skills, and the team roster.
- The active persona adapter, which stores the selected persona, injects its
  prompt, and exposes peer consults through `persona_consult`.

Adding a persona is data, not launcher code: edit a custom pack's draft and
apply it. `/persona use <name>` is the canonical path; direct `/<name>`
commands are convenience aliases when the name is not reserved or colliding.

## Chat-First Management

Plain chat is the default way to manage personas; slash commands are the
advanced, exact route to the same operations. The `persona_pack` tool covers
the pack lifecycle plus `team` (this session's team: select, refresh, none),
`default` (the team for new sessions), and `migrate`
(inspect/status/preview/cancel/apply/rollback).

- Read-only actions answer immediately. Every change returns a plan and a
  `planId` first and changes nothing.
- Pi accepts the confirming call only when the plan was issued by this
  runtime for this session, still matches current state (pack revision,
  binding, default, draft, legacy source, or receipt), and the user has sent
  at least one message since it was shown. The assistant judges whether that
  message is a yes; the runtime enforces only the intervening reply. Plans
  are single-use and held in memory.
- Tools cannot reload Pi. An approved team switch or rollback is handed to the
  `/persona` command path, which waits for idle, rechecks the session,
  branch, and plan, then reloads so the new team's commands replace the old
  ones. It is dropped if the conversation moved, Pi is busy, or another
  approved change is already waiting.
- Pack changes never change a session's team or the default; those are
  separate approvals.

## Awareness, Not Restriction

Pi Persona is an awareness layer, not a security boundary.

- Shared library paths and native skill names come from `_baseline.md`.
- Every persona adds its own personal library and its pack-shared library.
- A pack's `[G]` lead receives shared foundations and the pack roster, but not
  another persona's personal library unless the user promotes that material to
  shared context.
- Resolved prompts contain the actual shared and personal `_index.md` contents,
  so a persona knows which documents are available. Other document contents
  are read progressively when relevant.
- Persona prompts describe intended context and routing behavior.
- Pi and the host filesystem still own actual access. Native children receive
  a read-only built-in tool default, unless the persona declares other Pi built-ins; this is not a filesystem sandbox.
- Pi Persona rejects declared paths and writes that escape the physical
  workspace, including escapes through symlinks.

Friction should be added only for concrete failure modes. By default, inform,
nudge, validate, and keep the user moving.

**Empower capable personas; constrain only concrete trust/data boundaries.**
A persona's declared tools, skills, model, and read guidance exist so it can
do useful work, not so the extension can police model behavior. Validation
should stop a real trust or data-loss failure — path escape, a symlink out of
a pack or workspace root, a missing declared reference, ownership confusion
between distinct pack roots — never a merely unfamiliar but harmless choice,
such as a persona referencing any amount of its own pack's content, including
none at all. The pack-root versus workspace-root split (schema 2's
`packDocs` versus `docs`) is exactly this kind of boundary: it exists so a
pack cannot escape its own reference root or bleed into another pack's or the
workspace's data, not to restrict which of its own files a persona may read.

## Child Backend

Pi Persona runs a single native child backend and requires no extra Pi
package. It never delegates to `pi-subagents`; that extension can be
installed for its own unrelated raw `subagent` tool without altering Pi
Persona's consults or round-tables in any way.

An explicit `.pi/persona.json` with `{ "backend": "native" }` or a
`PI_PERSONA_BACKEND=native` environment variable is a harmless no-op, kept
for compatibility with settings written before native-only. Any other
explicit value — including the retired `legacy` backend — is a startup error
naming the setting and how to remove it; Pi Persona never silently falls back
to a different backend or ignores a conflicting override.

There is no automatic retry or fallback after launch because a repeated child
might duplicate side effects. Native launch resolves each selected persona's
skills, built-in tools, model, authentication, and fork snapshot before the
first round-table child starts. Authentication is then refreshed for each
launch. Native is not an OS sandbox: child processes inherit the parent
environment and filesystem access. Static doctor checks resolved child tools;
loaded skills, models, providers, and authentication are checked against live
Pi state at launch. Wildcard Pi peer metadata follows Pi packaging guidance.
Pi 0.85.1 is the tested baseline; other host versions are not rejected merely
because their version differs.

## Project Layout

Persona packs are global (see "Persona Pack Model" below): they live under
Pi's agent directory, not any one project, so a normal project carries no
pack files at all. `.pi/persona.json` is the only optional project file, and
only to set `{ "backend": "native" }` — a harmless no-op kept for
compatibility with settings written before native-only.

The optional project foundation from onboarding is the only other project
content:

```text
.pi/
  persona.json          # optional: { "backend": "native" }
  agents/
    _baseline.md        # shared instructions for every persona
library/
  shared/
    _index.md
    project-context.md
```

Files prefixed with `_`, such as `_baseline.md`, are Pi Persona control files,
not launchable personas. A persona's workspace `docs` (for example
`library/personal/<persona>/`) are optional; nothing creates them. The
foundation never discovers parent folders or another project's shared
library.

A workspace whose `.pi/agents/` has its own top-level generalist is an older
setup from before global packs; see "Older Project Setups" below.

## Persona Pack Model

A persona pack is either:

- **official** — installed from the bundled offline catalog; or
- **custom** — created from a blank draft or forked from an official/custom
  pack.

Both kinds live in one global store under Pi's agent directory
(`<agentDir>/persona/{official,custom,drafts}`), addressed as
`official/<name>` or `custom/<name>` (bare names work when unambiguous).
Installing, forking, creating, or editing a pack never activates it; a
session opts into one with a separate, approved team action. See
design.md's "Global Persona Pack Lifecycle" for the implementation, and
README.md's "Advanced: Persona Pack Commands" section for the exact command
table.

Every pack has one fixed, visible layout:

```text
pack.yaml
agents/**/*.md
references/**/*
```

Its manifest has no profiles, hooks, dependencies, or path maps:

```yaml
schema: 2
name: philosopher-7
version: 1.0.0
description: A philosophical symposium generalist with seven specialist reasoning methods.
```

`create`/`edit` stage an inactive draft on disk (`<store>/drafts/<name>`) and
report its path; edit the draft's `pack.yaml`, `agents/*.md`, and
`references/**` files directly, then `preview` the diff and `apply` it —
`apply` validates and, once confirmed, replaces the pack's active content
atomically. Installed/applied pack files are a fully user-owned working copy,
not a read-only package cache.

Every pack contains exactly one on-theme `role: generalist` persona and at
least one specialist. Discovery and status views derive a `[G]` prefix for
that lead; the stored name and slash command remain unchanged. There is no
project-wide coordinator above the packs. Under schema 2 a persona's
workspace `docs` and pack-relative `packDocs` are both optional; every
`packDocs` entry must exist inside the pack's `references/`.

## Older Project Setups

A workspace whose `.pi/agents/` has its own top-level generalist is
recognized as an older setup. Sessions there are gated as
`migration-required`: they get no default team and refuse to run personas
until the user migrates it or picks an installed team. Migration copies the
setup into a global custom pack after an approved preview, never changes the
originals, and never selects or defaults the new pack. Rollback marks the
workspace as needing migration again and keeps the copied pack. See
`migration-runbook.md`.

Only a workspace with no recognized older setup, no recorded team, and no
default still falls back to whatever `.pi/agents/` personas it has.

## Agent File Format

Persona files are markdown files with YAML frontmatter.

Specialist example:

```md
---
name: example-specialist
role: specialist
description: Reviews requests from the example specialist perspective.
docs:
  - library/personal/example-specialist/
packDocs:
  - example-specialist/
  - shared/
skills:
  - review
---

You are the example specialist. Answer from your declared specialty.
```

Pack generalist example:

```md
---
name: editorial-room
role: generalist
description: Coordinates the editorial team and synthesizes its work.
docs:
  - library/personal/editorial-room/
  - library/shared/editorial-team/
---

You are the editorial team's generalist. Answer directly when shared context
is enough and consult complementary editorial specialists when useful.
```

Baseline example:

```md
---
docs: library/shared/
skills:
  - read
---

Shared project context and operating principles go here.
```

## Command Surface

Persona packs are global, not project-local: they are
installed/forked/created/edited under one shared store, addressed as
`official/<name>` or `custom/<name>`, and a session deliberately binds to one
team with `/persona team`; installing or editing a pack never activates it.
See `README.md`'s "Advanced: Persona Pack Commands" section for the exact command table and
`/persona team`/`/persona migrate` for session binding and legacy-project
conversion.

`/persona onboard` is the primary setup path for the **optional** project
foundation (shared context and a library every persona can read); it has
nothing to do with persona packs and is never required before a global pack
operation. It creates or resumes `init-data/my-persona-setup.yaml`, starts an
assisted interview, and lets the assistant edit the manifest, preview the
plan, request approval, apply, index the shared library, and run doctor.
Before question one it explains the short project-purpose → shared-context →
preview-and-verification journey. It also explains that every future persona
sees `library/shared/`. Onboarding creates no persona and no project
coordinator.

`/persona use <name> [query]` activates any persona of this session's team
through the stable namespace. This is the guaranteed route for reserved names
and command collisions.

`/<persona-name> [query]` activates a pack lead or specialist in the current
chat. If the command includes a query, Pi answers that query as the persona.

Direct persona command names come from the session's bound team snapshot, and
every invocation resolves against it. A stale command name left visible after
a team or workspace change must fail with `/persona-list` guidance instead of
activating stale persona state. Reserved aliases use `/persona use`.

`/persona-list` is read-only discovery. It lists pack leads with the derived
`[G]` signal, specialists, pack membership, descriptions, library paths, and
skills.

`/persona status` reports the active persona. `/persona clear` exits persona
mode.

Persona packs have twelve public verbs:

```text
/persona pack list
/persona pack status [name]
/persona pack install <name>
/persona pack update <name> [--discard-edits]
/persona pack uninstall <name>
/persona pack fork <source> <name>
/persona pack create <name>
/persona pack edit <name>
/persona pack preview <name>
/persona pack apply <name>
/persona pack cancel <name>
/persona pack delete <name>
```

Validation and planning are internal tool actions. The user names an intention;
Pi Persona validates, previews collisions and file changes, requests
confirmation, applies, and verifies. There are no public `plan` or `validate`
commands.

`list` has installed and available sections and shows each pack's persona
roster. Bare install names resolve only the bundled offline catalog. Pack
operations never require or trigger onboarding; the optional project
foundation is entirely independent of the global pack store.

`create` and `edit` stage an inactive draft on disk and report its path; the
user (or an assisting Pi) edits the draft's `pack.yaml`, `agents/*.md`, and
`references/**` files directly, then `preview` shows a diff against the
active pack and `apply` validates and, once confirmed, replaces it. `cancel`
discards the draft instead. Nothing changes until `apply` runs, and `apply`
never activates the pack for any session — that is always a separate
`/persona team`.

Portable updates require a higher stable semantic version from the recorded
source. There is no per-file merge: if the installed pack has local edits,
`update` refuses until `--discard-edits` explicitly accepts discarding them
wholesale (fork the pack first to keep them instead).

`uninstall`/`delete` are confirmation-gated and permanent: successful removal
leaves no archive, and if the removed pack was the global default, the
default is cleared rather than silently reassigned.

`/persona-roundtable <query>` runs an explicit multi-persona workflow on the
session's team, and that team's `[G]` lead moderates. V1 has no cross-pack
choice.

The pack lead returns a schema-validated specialist selection with reasons
through one `persona_roundtable` tool call. Only specialists from that pack may
participate. Each reason becomes that specialist's assigned contribution. They
return independent positions, then self-contained final positions after peer
reveal so the moderator does not lose Round 1 reasoning. The pack lead returns
an argued answer with explicit perspective, disagreement, tradeoff, decision,
and uncertainty sections. Selection failure is explicit and never falls back
to a lexical heuristic.

The native runner runs a fixed workflow in Pi Persona itself: parallel Round 1,
parallel Round 2 with ordered Round 1 answers, then one moderator session. A
phase failure cancels unfinished siblings and prevents synthesis. Progress is
normalized and only one moderator synthesis is returned, without raw runtime
paths or a receipt-triggered second verdict. The active lead presents the
synthesis in full without paraphrasing it into a shorter second answer.

The round-table tool makes its process inspectable without streaming specialist
opinions: it shows the delegated query, context policy, selected roster and
reasons, independent/revision/synthesis phase purpose, stable per-persona state,
human-readable activity, next step, and final execution totals.

## Active Persona Direction

Direct persona commands do not launch child subagents. They activate persistent
persona mode in the current Pi session through prompt injection. Active persona
mode persists across follow-up turns until another persona command switches
personas or `/persona clear` exits.

The active persona can use `persona_consult` when peer expertise is needed.
That tool is the semantic consult boundary: it resolves the consultant, runs
one native child, and returns compact provenance for synthesis. The requester
must match the active persona, and a persona cannot consult itself.

An active persona may issue several independent sibling `persona_consult`
calls in parallel. Every consultant remains a leaf and returns to the same
requester. This is distinct from `/persona-roundtable`, where selected
specialists see one another's positions, revise, and contribute to a moderated
synthesis.

Raw `subagent` guidance should not appear in direct persona prompts.
`subagent list` lists global Pi subagents when another package provides that
command. It is not the Pi Persona consultant roster and native never calls it.
`persona_consult` only accepts personas from this session's team, resolved
from its retained snapshot.

## Settled Principles

- Pi Persona is a Pi extension, not a separate agent platform.
- Direct persona answers happen in the active chat.
- Subagents are for consult and round-table child work.
- Native children are one-shot, foreground leaf sessions with a read-only default; personas may declare other Pi built-in tools.
- Persistent conversations, background jobs, and child
  extensions require a new concrete product decision rather than another flag.
- The resolver is the only place that assembles persona awareness.
- The active persona state is explicit and clearable.
- Onboarding creates only the project foundation and shared library.
- There is no project-wide persona coordinator in V1.
- Consultation is one hop by default; child consult runs are leaf tasks.
- Independent sibling consultations may run in parallel.
- The requesting persona writes the consult summary.
- Consulted personas receive their own resolved awareness package.
- Round-table is explicit and bounded.
- Round-tables stay inside one pack and that pack's `[G]` lead owns selection.
- Cross-pack panels are deferred.
- Validation should be cheap and actionable.
- Access policy belongs to Pi and the host environment.
- Persona packs are global and user-owned, not scoped to a Pi working folder.
- Each session uses one team; one default applies to new sessions only.
- Chat is the default management route; every change is a plan that waits
  for the user's reply.
- Older project setups are gated until migrated; migration copies and never
  changes the originals.
- One pack is one roster; packs have no install profiles.
- Every pack has one on-theme `[G]` lead and at least one specialist.
- Installed pack files are fully user-owned.
- Pack references are read from the session's retained snapshot; nothing is
  copied into the project.
- Installing, forking, creating, or editing a pack never activates it; only a
  team action binds a session, and a bound session's retained pack content
  survives later store mutations to that pack.
- Updates preserve local work and never auto-merge conflicts.
- Removal (`uninstall`/`delete`) means permanent removal; no persistent
  archive is created, and it clears the global default if it named the
  removed pack.
- Network catalogs, registries, and downloads are deferred beyond V1.
