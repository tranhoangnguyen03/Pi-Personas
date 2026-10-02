# Pi Persona Design

This document describes the current implementation design. It should be enough
for a maintainer to rebuild the repo behavior from first principles alongside
the tests.

## Module Responsibilities

`extensions/pi-persona.ts` is glue. It registers commands and tools, manages
active persona state through Pi hooks, updates extension status, calls pure
persona modules, and formats command output for Pi.

Slash commands that need an AI turn inject a concise, first-person user
intention. Tool protocol, approval tokens, and continuation mechanics stay in
model-facing tool content and prompt snippets. Custom rendering shows the
human-readable plan or outcome without exposing those internal controls.

`src/persona/index.js` is the public module surface for the extension wrapper.

`src/persona/agents.js`, `frontmatter.js`, and `schema.js` handle agent
discovery, raw-plus-normalized frontmatter parsing, strict field validation,
launchability, and physical workspace path containment.

`src/persona/resolver.js` builds resolved persona scopes from baseline,
selected agent, declared docs, native skills, and known persona roster.

`src/persona/launch.js` builds active-session persona prompts for direct
persona commands.

`src/persona/consult.js` owns semantic consult formatting, consultant launch
requests, answer extraction, and provenance.

`src/persona/child-runner.js` starts and supervises one dedicated Node process
per native task. `src/persona/child-entry.js` imports the exact Pi SDK entry
supplied by the loaded host package, creates one restricted session, normalizes
progress and usage, and disposes it.

`src/persona/progress.js` turns observable child events into the live consult
summary shown in the streaming `[pi-persona]` tool box.

`src/persona/roundtable.js` builds the explicit multi-persona workflow.

`src/persona/runtime.js` validates that no explicit `PI_PERSONA_BACKEND` or
`.pi/persona.json` setting still names the retired `legacy` backend (an
explicit `native` is a harmless no-op), and creates safe fork snapshots.
There is no dependency-detection module and no default-backend
auto-detection: Pi Persona never inspects whether `pi-subagents` is
installed. `src/persona/doctor.js`, `doc-index.js`, `scaffold.js`, and
`init-manifest.js` provide setup, validation, library catalogue generation,
and manifest-backed initialization.

`src/persona/pack-source.js` owns the bundled catalog, fixed portable-source
layout, manifest validation, and source hashing. It reads two manifest schemas
without reinterpreting one as the other. Schema 1 requires workspace `docs`
naming `library/personal/<persona>/` and `library/shared/<pack>/` plus a
`configure.md`. Schema 2 adds `packDocs`, resolved against the pack's own
`references/` root, and an optional `agents/_baseline.md` parsed as shared
instructions and excluded from the roster. Under schema 2, `docs` and
`packDocs` are both optional, and every declared `packDocs` entry must exist
inside the pack's reference root; containment is the boundary, not a
mandatory minimum. The bundled `philosopher-7` pack is schema 2 and also
declares workspace `docs`, which resolve only if the workspace has them.

`src/persona/global-pack-store.js` owns the store's filesystem operations
under one mutation lock. `src/persona/pack-lifecycle.js`'s
`runGlobalPersonaPackAction` plans and applies every `/persona pack` verb
(`list/status/install/update/uninstall/fork/create/edit/preview/apply/cancel/
delete`) and is shared by the slash command and the `persona_pack` tool. The
same module's older project-scoped `runPersonaPackAction` is used only by
doctor, to report 0.3.x project-local pack installs read-only; no command
copies pack content into a project.

`src/persona/pack-session.js` owns retained snapshots, the store-wide default,
and the session binding entries. `src/persona/pack-migration.js` owns
recognition of older project setups, migration preview/apply, the workspace
marker and receipt, and rollback.

## Resolver Contract

The resolver receives the workspace root and a persona name. It discovers
`.pi/agents/**/*.md`, excludes control files such as `_baseline.md` from
launchable personas, keeps schema-invalid files visible to doctor but out of
the launchable roster, finds the selected agent, and
combines:

- baseline prompt, docs, and skills
- selected persona prompt, docs, and skills
- known persona roster
- derived doc read guidance
- derived child-runtime fields for consult and round-table runs

For each declared library directory, doc resolution reads the actual
`_index.md` contents. Direct, consult, and round-table prompts include the
shared indexes plus the selected persona's personal index; they do not inject
other personas' personal indexes. Other document contents remain progressive
reads chosen when the request makes them relevant.

The resolver should not execute tools, write files, or launch children. It
returns structured data that command handlers and workflow builders can use.

`resolveScopedAgentDocs` is a separate, explicitly root-aware primitive built
from the same containment-checked doc reads: given `docs` and `packDocs`
plus an explicit `workspaceRoot` and/or `packRoot`, it resolves each against
its own root and tags the result `workspace` or `pack` so origins are never
conflated. `packRoot` is the pack's own root — the same root
`readPortablePersonaPack` returns, containing `pack.yaml`, `agents/`, and
`references/` — not a pre-resolved references directory; `packDocs` is
resolved deterministically against `<packRoot>/references`, matching how
pack-source validation resolves the same field. `docs` stays optional read
guidance when a `workspaceRoot` is supplied (a missing or escaping entry
resolves to no reads); declaring `docs` without a `workspaceRoot`, like
declaring `packDocs` without a `packRoot`, is a caller error rather than
silently-empty output. `packDocs` names content the pack itself ships, so a
missing or escaping entry is a clear pack-authoring error instead. Pack-owned
reads and their manifest/index paths come back as absolute filesystem paths,
so they stay directly readable regardless of the caller's current working
directory; workspace reads stay workspace-relative, matching
`resolveAgentScope`'s existing convention. For a bound session,
`resolveAgentScope` receives the snapshot's roster and `packRoot` and uses this
primitive, so direct launch, consult, and round-table read pack references
from the retained snapshot and workspace `docs` from `ctx.cwd`.

## Direct Persona Flow

When a user runs a pack lead or specialist command such as
`/symposium <query>` or `/socrates <query>`, Pi Persona resolves that persona
and records it as active for the current session. `/persona use <name> [query]`
uses the same activation path and is canonical when a direct alias is reserved
or collides.

Direct command names come from the bound team's snapshot and are replaced on
the reload that switches teams. A name can still be visible after a workspace
change, so the handler resolves it against the session's current roster before
activation. If the persona is unavailable, the command reports `/persona-list`
guidance and leaves active persona state unchanged.

Before each agent turn, the extension injects the active persona prompt into
the active Pi chat. The persona answers in the same chat. There is no child
subagent run for direct persona answers.

Active state is restored on session start from transcript data. If the session
has no usable team, or the restored persona no longer resolves in it, the
extension clears it before answering normally; it never injects a workspace
persona into a `none` or `migration-required` session. `/persona status` reads
the stored state. `/persona clear` removes it.

The extension publishes the current persona to Pi status surfaces through the
stable key `pi-persona-active`. When no persona is active, the key is cleared.
With `npm:pi-powerline-footer`, users can display it through
`powerline.customItems`, for example:

```json
{
  "powerline": {
    "customItems": [
      {
        "id": "persona",
        "statusKey": "pi-persona-active",
        "position": "secondary",
        "color": "accent"
      }
    ]
  }
}
```

Pi Persona owns the status key, not the footer layout. It must update the key
on session start, persona switch, persona clear, `/persona status`, and normal
agent turns.

## Consult Flow

`persona_consult` is available to top-level active personas. The requester
provides a consultant name, question, summary, constraints, expected output,
and optional context mode. Execution rejects calls without an active persona,
requester names that do not match the active persona, and self-consults.

The consult module resolves the consultant from the session's team snapshot
only. It rejects unknown or duplicate names instead of falling back to global
subagents.

Ordinary consults each launch their own native child.
An active persona may issue multiple independent sibling `persona_consult`
calls and Pi may execute them in parallel. Each call still resolves one
consultant as a leaf; sibling consultants do not see one another's answers, and
the active requester synthesizes their results.

Default consult context is summarized and fresh. A forked requester context is
allowed only when the requester deliberately chooses it. In all cases, the
consultant receives its own resolved prompt, docs, skills, and model guidance.
Requester docs and skills are not inherited unless they are also part of the
consultant's baseline or persona file.

The native child returns its answer text directly; Pi Persona fails the
consult with a clear error if the child completes without one.

Provenance is compact and requester-facing. The requesting persona synthesizes
the final answer.

Native receives the full `scope.prompt`, exact Pi skill paths resolved from the
parent turn, declared doc-read guidance, and the persona's Pi built-in tools.
The default is `read`, `grep`, `find`, and `ls`; persona metadata may select
other Pi built-ins. Missing skills, unknown tool names, unavailable models or
auth, and extension-registered providers fail only when that resource is used.

A consult has no overall runtime deadline. Both runners cancel after three
minutes without child activity, while child activity resets that idle window.
The same `[pi-persona]` box refreshes in place with
elapsed and idle time, current tool and arguments, cumulative tool categories,
sources, turns, tokens, and reported failures; it does not publish consult
progress to the status line or add transcript messages.

The collapsed tool call shows the consultant, a query preview, and either
`Context: fresh · conversation history not included` or
`Context: fork · current conversation branch inherited`. Pi's native tool
expand action (`Ctrl+O` by default) reveals the full query, requester summary,
constraints, and expected output while preserving the live progress result.

## Child-Run Boundary

Native uses one Node child, one in-memory Pi SDK session, and one task. The
child loads no extensions, prompt templates, themes, or automatic context
files. It loads only exact selected skill paths. Tools default to `read`,
`grep`, `find`, and `ls`; persona `tools` metadata may select any Pi built-in.
Child extensions stay disabled so delegation remains leaf-only.

The parent passes the host SDK entry derived from Pi's `getPackageDir()`, agent
directory, workspace, resolved model and auth, thinking level, resources, task,
prompt, and optional branch snapshot over Node IPC. Secrets do not appear in
argv or task text. Authentication is resolved at each launch rather than
cached across round-table rounds. The child returns status, answer, model, and
nested usage.

The native child is capability-limited, not sandboxed. It inherits the full
parent environment so environment-based provider credentials continue to work,
and it retains the parent process's filesystem permissions. The tool allowlist
prevents normal model-driven writes and shell execution; it is not an OS-level
security boundary.

Cancellation proceeds through IPC cancel, then SIGTERM and SIGKILL after
bounded grace periods. Session shutdown cancels every live native child. The
child aborts and disposes its session in `finally`.
Process exit without a result, terminal model errors, abortion, and missing
answer text are failures. There is no retry after work begins.

For `fork`, the parent clones `ctx.sessionManager.getBranch()`, removes the
assistant entry containing the current tool call, and freezes the snapshot once
per workflow. The child adds a new version-3 header and restores the entries
through `SessionManager.inMemory`. Every round-table child gets the same parent
snapshot, not another child's history.

When `PI_SUBAGENT_CHILD=1`, Pi Persona remains inert: a child spawned by an
installed `pi-subagents` package (for its own, unrelated raw `subagent` tool)
must never re-register Pi Persona's commands and tools. All child prompts
also state that the child is a leaf task.

## Round-table Flow

`/persona-roundtable <query>` is an explicit multi-persona workflow. A bound
session's team is exactly one pack, and that pack's `role: generalist` persona
is the moderator; there is no picker. Only the unbound workspace fallback with
several project packs opens a native “Which team should host this
roundtable?” picker. V1 offers no cross-pack option.

The extension activates the selected pack lead in the current chat with the
query and that pack's specialist roster. The lead must call
`persona_roundtable` exactly once with selected names plus a reason for each.
TypeBox validates the tool shape and Pi Persona validates names, uniqueness,
roster size, reasons, and pack membership; there is no heuristic fallback.

After validation, Pi Persona resolves only the chosen persona scopes and runs
a fixed native workflow:

- independent, self-contained specialist positions, each with the lead's
  assigned contribution
- a reveal-and-revise step whose final positions restate all reasoning needed
  by the moderator
- a moderator synthesis with Answer, Perspective contributions, Real
  disagreements, Conditions and tradeoffs, Recommended decision, and What
  could change the answer sections

Pi Persona runs the fixed workflow directly on its native runner: parallel
Round 1, parallel Round 2 with ordered Round 1 answers, then one moderator
session with ordered Round 2 answers. A phase failure aborts unfinished
siblings and prevents synthesis. Pi Persona returns only the current
moderator synthesis, preserving native execution, progress, cancellation, and
child coordination. The active pack lead relays that synthesis faithfully and
in full rather than compressing it again. No `pi-subagents` package is
required or contacted.

Every round-table task is explicitly advisory and read-only, so analysis is
not rejected for failing to edit files. The top-level task repeats the no-edit
contract for runtimes that infer completion intent from the original query.
Only the current request's moderator result may become the final answer; Pi
Persona never searches historical run directories for a replacement.

The model-callable tool reports progress through one in-place `[pi-persona]`
box. It shows elapsed and idle time, current phase, completed specialists,
active persona tools and targets, aggregate tool categories, sources, reported
failures, turns, and tokens. Partial parallel updates are accumulated by child
index so completed seats and totals never regress. The panel translates tools
into human activities, shows every persona's round status, explains the active
phase, names the next step, and finishes with a compact execution receipt.
Collapsed and expanded call views disclose query, context, roster, selection
reasons, and process without exposing raw child output or runtime paths. A
heartbeat refreshes quiet periods without adding progress messages to the
transcript. Started round-tables disable both the
runtime deadline and inactivity cancellation; silence is displayed, not
treated as permission to interrupt a diligent specialist.

Round-table uses child runs because the user explicitly asked for a
multi-persona workflow. It is separate from ordinary direct persona answers
and from parallel sibling consults: round-table specialists see peers'
positions and revise before their pack lead's synthesis.

## Assisted Manifest Authoring

`/persona onboard` creates or resumes the durable draft at
`init-data/my-persona-setup.yaml` by default and sends an authoring request
into the active Pi chat. The assistant edits that file and uses the
`persona_init` tool to plan, confirmation-gated apply, index libraries, inspect
status, and run doctor. Before asking a question it explains the short
project-purpose → shared-context → preview-and-verification journey. It tells
the user that `library/shared/` reaches all future personas.

The manifest contains baseline instructions, shared library files, and no
agents. Onboarding therefore creates the project foundation only—never a
persona, a project coordinator, or a team. Pack operations never require it.

## Global Persona Pack Lifecycle

Persona packs are global, not project-local: they live in one store under
Pi's agent directory (`<agentDir>/persona/{official,custom,drafts}`), owned
by `src/persona/global-pack-store.js` (pure filesystem operations, one
mutation lock per store) and orchestrated by `src/persona/pack-lifecycle.js`'s
`runGlobalPersonaPackAction`, which the extension's single internal tool
calls for every `/persona pack` verb: `list/status/install/update/uninstall/
fork/create/edit/preview/apply/cancel/delete`. There is no way to create a
new project-local pack.

A pack is **official** (installed from the bundled offline catalog via
`loadPersonaPackSource`/`installOfficialPersonaPack`) or **custom** (created
from a blank starter or forked from an official/custom source), addressed as
`official/<name>` or `custom/<name>`.

`create`/`edit` stage an inactive draft at `<store>/drafts/<name>` and never
touch the active pack. The user (or an assisting Pi) edits the draft's
`pack.yaml`, `agents/*.md`, and `references/**` files directly; `preview`
diffs the draft against the active pack; `apply` re-validates, then swaps the
draft in atomically inside the store's mutation lock, replacing the pack's
active content. `cancel` discards the draft. None of these verbs binds any
session to the pack.

`update` accepts a bundled catalog source only for an installed **official**
pack at a strictly higher stable semantic version. There is no per-file
merge: if the installed pack carries local edits, `update` refuses outright
unless `discardLocalEdits` (`--discard-edits`) is passed, which replaces the
whole pack wholesale — fork it first with `/persona pack fork` to keep the
edits under a new name instead.

`uninstall` (official) and `delete` (custom) are confirmation-gated,
plan-verified against the store's live state at apply time (a plan previewed
against now-stale state is refused rather than silently applied), and
permanent — no archive is kept. Removing the pack currently set as the
global default clears that default inside the same mutation instead of
leaving a dangling reference.

Validation requires exactly one on-theme generalist and at least one
specialist per pack. UI formatting derives `[G]` for each pack generalist
without changing its stored name or slash command.

### Session Binding And Retained Snapshots

Installing, forking, creating, or editing a pack never activates it for any
session. `/persona team <name>` (implemented in `src/persona/pack-session.js`)
is the only way a session binds to a pack, and `/persona team default
[<name>]` sets the store-wide default new sessions inherit. Binding
(`loadPackSession`) copies the selected pack's content **once** into a
private, owner-only, per-session directory that is never shared with the
store or with any other loaded session. Because it is an independent copy,
not a live reference, a bound session keeps serving its retained snapshot
unchanged even after another session edits and applies a change to the same
pack — the mutation becomes visible only to sessions that bind, or rebind,
after it lands.

The session records its binding as custom entries (`pi-persona-team`, plus
`pi-persona-team-pending` while a switch reloads). Resume and reload keep the
recorded team and reload its current validated content. Only a genuinely new
session (`reason: "new"`, or a first startup with no conversation) applies the
default. A switch writes the pending entry and calls `ctx.reload()`; the fresh
instance completes it, and a pending switch whose reload did not happen is
settled as cancelled so a later reload cannot replay it. Snapshots are removed
on `session_shutdown`, and a `session_start` that fires twice on one runtime
disposes the first snapshot. A killed process (`kill -9`) leaves its snapshot
under `<agentDir>/persona/.runtime-sessions/`; there is no sweeper yet, so it
must be deleted by hand while no Pi runs.

### Session Scope States And The Migration Gate

`teamScopeState` in `extensions/pi-persona.ts` gates every persona execution
path (direct activation, `/persona use`, `persona_consult`,
`persona_roundtable`, and prompt injection in `before_agent_start`) through
`assertPersonaExecutionAllowed`:

- `bound`: the session's retained snapshot supplies roster and content.
- `none`, `missing-bound`: personas refuse with team-selection guidance.
- `migration-required`: the workspace's `.pi/agents/` has its own top-level
  generalist (an older setup) that is not migrated, has drifted since
  migration (`changed-source`), or lost its destination. New sessions, and
  sessions from earlier versions reopened at startup, get this state instead
  of the default, and personas refuse with migration guidance.
- `legacy`: no recorded team, no default, and no recognized older setup. This
  is the only state that still resolves `ctx.cwd`'s own `.pi/agents/` roster.

Migration (`/persona migrate` or `persona_pack` `migrate`) copies the
approved personas into a new custom pack, writes a backup, receipt, and
marker under `.pi/persona-migration/`, and never changes `.pi/agents/`. An
unbound session moves to `none`; nothing is selected or defaulted. Rollback
marks the receipt `rolled-back`, removes the marker, restores the session's
prior binding (usually `migration-required`), and keeps the pack, backup, and
originals. See `migration-runbook.md`.

### Chat-First Management

The `persona_pack` tool exposes every pack verb plus `team`, `default`, and
`migrate` on the same functions as the `/persona` commands; command output
text is unchanged.

- Every mutating action first returns `confirm-required` with a `planId` and
  changes nothing. The `planId` is derived from the exact plan and current
  state: target revision and current binding for `team`, current and target
  default for `default`, legacy source digest plus draft and destination
  integrity for migrate `apply`, and the receipt's destination, attempt, and
  status for `rollback`. Lifecycle verbs use the lifecycle's own plan token.
- An in-memory registry records each issued plan with the session id and the
  session's user-message count. A confirming call is refused unless the plan
  was issued here, still recomputes to the same id, and at least one user
  message arrived since. Plans are single-use. The runtime does not judge
  whether the reply means yes.
- Tools receive no `reload()`. An approved `team` switch or `rollback` stores
  one pending handoff (a nonce never shown to the model, the session id, and
  the branch anchor), dispatches `/persona chat-handoff <nonce>` with
  `expandPromptTemplates: true`, and returns `terminate: true`. The command
  handler waits for idle, revalidates nonce, session, and branch, rechecks
  idle immediately before committing, then reloads. A second approval while
  one handoff waits is refused.
- Results carry a plain `details.display` for people; retry parameters and
  agent notes go only to the model.

The bundled `philosopher-7` pack has `[G] symposium` as its coordinating
generalist plus seven specialist methods. All eight agents share
an epistemic contract: they use philosophy-inspired reasoning methods without
claiming literal historical
identity, inventing quotations or facts, treating authority as evidence,
conflating scholarship with adaptation, or relying on theatrical imitation.
Their methods are Socratic questions and assumptions, Cartesian decomposition
and doubt, Kantian premises and limits, Humean empirical caution, Aristotelian
classification and causes, Hegelian contradiction and integration, and
Platonic abstraction followed by a return to the concrete problem.

## Doctor And Runtime Checks

`/persona doctor` validates:

- no explicit `PI_PERSONA_BACKEND` or `.pi/persona.json` setting still names
  the retired `legacy` backend or any other value besides `native`
- project agents are discoverable
- names, descriptions, roles, models, booleans, and list fields have valid types
- every pack has exactly one generalist and at least one specialist
- declared context paths remain inside the physical workspace, including
  through symlinks, and exist when required
- nested library and reference directories have `_index.md` guidance
- Pi skill names are used instead of path-style skill entries
- legacy metadata is reported as migration guidance
- runtime support roles carry useful provenance where possible
- the global store and this session's team scope are reported with recovery
  actions; leftover 0.3.x project-local pack installs and drafts are reported
  read-only
- resolved baseline-plus-agent tools name Pi built-ins available to the native child

Doctor's project and native-tool checks are static. Exact loaded skills, model
selection, extension-registered providers, and current credentials are live
session state and remain launch-time preflight checks. Pi 0.85.1 is the tested
baseline, not a runtime version gate. Wildcard Pi peer declarations follow Pi
package guidance; actual SDK failures are reported without automatic reruns.

Consult and round-table commands run the same backend-configuration preflight
before execution. Native round-tables preflight every selected persona resource
before the first child starts.

## Global Subagent List

`subagent list` may be provided by an installed subagent package such as
`pi-subagents`. It can include builtins, package agents, and project
`.pi/agents` files, but it is not the Pi Persona consultant list and Pi
Persona never uses it.

Pi Persona's consultant roster is the session's team snapshot. Users can
inspect it with `/persona-list`.

## Documentation And Test Strategy

Tests should protect the public runtime boundaries:

- package manifest exposes the extension
- direct persona commands activate the active chat instead of child runs
- onboarding creates only the baseline and shared library
- list and status derive `[G]` for pack generalists
- active persona state is stored, restored, displayed, and clearable
- footer status uses `pi-persona-active`
- consults use `persona_consult`, not raw subagent discovery
- independent sibling consults each launch their own native child and may run
  in parallel, while every child remains a leaf
- runtime preflight reports readiness and never requires `pi-subagents`
- an installed `pi-subagents` package never alters Pi Persona's own consults
  or round-tables, and no bridge request is ever emitted
- native execution uses the supplied host SDK entry, exact skills, declared Pi
  built-in tools, normalized progress, usage, cancellation, and terminal-answer checks
- fork snapshots exclude the in-flight tool call and abandoned branches
- canonical `/persona use` works when aliases are unavailable
- round-table selection is a pack-lead `persona_roundtable` tool call on the
  session's team, and native runs only the selected specialists in two phases
  before synthesis
- native phase failure prevents synthesis
- manifest apply is confirmation-gated through `persona_init`
- model-driven manifest apply includes doctor verification before success is
  reported
- child sessions are inert under `PI_SUBAGENT_CHILD`
- consult child prompts describe leaf task behavior
- docs explain global `subagent list` implications
- pack list and status are global and read-only
- installing, forking, creating, or editing a pack never activates it; only
  `/persona team` binds a session
- portable validation enforces the fixed layout and four-field manifest
- plans reject collisions and duplicate persona names before writing
- create/edit stage a draft the user edits directly; preview/apply write only
  within the target pack's own root
- update classifies unchanged, local-only, upstream-only, and conflicting files
  and records explicit detach decisions
- uninstall/delete apply the correct warning, leave no archive or pack files,
  and clear the global default if it named the removed pack
- a session bound to a pack keeps its retained snapshot across later store
  mutations to that pack from another session
- pack validation requires one generalist and one or more specialists
- bound sessions resolve `packDocs` from the retained snapshot
- resolved prompts contain shared and personal `_index.md` contents
- older project setups are gated as `migration-required`, migration leaves
  the originals byte-identical, and rollback keeps the pack
- persona execution is refused in `none`, `missing-bound`, and
  `migration-required` sessions, including restored-persona prompt injection
- chat confirmations require an issued, unchanged plan and an intervening user
  message; team switches reload through the command handoff
- packaging includes `philosopher-7` and excludes the research PDF

The docs test should read `README.md`,
`docs/_about_pi_persona/blueprint.md`, and
`docs/_about_pi_persona/design.md` as the canonical documentation set.

## Manual Verification Milestones

Manual verification is product acceptance, not a repetition of automated
tests. Record the environment, package or commit, result, and any confusing
wording for each gate. Use disposable projects and a disposable
`PI_CODING_AGENT_DIR` for every milestone; never this repository and never a
developer's real global Pi agent directory.

**Prerequisites:** Node 22.19 or newer and Pi Coding Agent 0.85.1 (the tested
baseline). No `pi-subagents` install is required or relevant; consults and
round-tables run natively only, and Pi Persona has no other backend. Milestone
6 begins earlier than the others by installing the actual packed `.tgz`
release artifact instead of the checkout.

1. **Discovery and status:** With no packs installed, confirm
   `/persona pack list` shows only the bundled catalog and `/persona status`
   reports no bound team. Install `philosopher-7`, confirm it lists as
   installed with its `[G] symposium` lead and seven specialists, and that
   `/persona pack status philosopher-7` reports its source and version. No
   project files change; the pack lives under Pi's
   agent directory, not the disposable project.
2. **Install → team → play:** Install `philosopher-7`, then bind a session to
   it with `/persona team philosopher-7`. Confirm `/persona-list` shows the
   full roster, `/symposium <query>` activates the lead, and `/persona status`
   reports the bound team and active persona. Restart Pi in the same project
   without setting a session team and confirm no team is bound (installing
   never activates), then set `/persona team default philosopher-7` and
   restart again to confirm the new session inherits that default.
3. **Fork → create/edit → preview → apply:** Fork `philosopher-7` into a
   custom pack, then `/persona pack edit` it: add a specialist, change a
   description containing punctuation such as a colon. Confirm
   `/persona pack preview` shows an accurate diff against the active pack,
   `apply` is confirmation-gated (decline once, confirm nothing changed, then
   confirm), and `/persona pack cancel` discards a draft the user does not
   want. Separately, `/persona pack create <name>` an independent custom pack
   from a blank draft through the same create → edit → preview → apply path.
4. **Default and session switching, both directions:** With two installed
   packs, set the global default to one, bind a session to the other with
   `/persona team`, and confirm `/persona status` shows the explicit
   session-level binding while a fresh session still gets the default. Switch
   the same session to the other pack and back; confirm both directions work
   and the previous session's state is not corrupted. Set `/persona team none`
   and confirm the session returns to no bound team without touching the
   global default.
5. **Missing/invalid recovery, and edit/remove of an active pack:** Attempt
   `/persona team <nonexistent>` and confirm it is refused with guidance
   rather than silently binding nothing. Uninstall or delete a pack that is
   currently the global default and confirm the default is cleared, not
   silently reassigned. With a session already bound to a custom pack, edit or
   delete that same pack from a separate session sharing the same store, then
   confirm the first, already-bound session keeps working against its
   retained snapshot rather than erroring or silently picking up the mutation
   mid-session.
6. **Release artifact and migration:** Install the actual packed release into
   a clean disposable project outside this checkout, using its own
   `node_modules` (no checkout-relative import). Confirm `philosopher-7` is
   the only bundled pack, the research PDF and this repo's tests/probes are
   absent from the installed package, and a native consult still runs through
   the installed `child-entry.js` importing the host Pi SDK from the
   installed `@earendil-works/pi-coding-agent`, not from any checkout path.
   Separately, in a fixture project with pre-existing `.pi/agents/*.md`
   persona files predating the pack model, run
   `/persona migrate inspect → preview → apply` and confirm the original
   `.pi/agents/*.md` files are byte-for-byte unchanged after `apply`, then run
   `/persona migrate rollback` and confirm it restores only this session's
   prior team binding and marker (never the store, never the original files).

The implementer runs every milestone. Product acceptance covers four complete
release-candidate journeys: install/team/play, fork-or-create/edit/apply,
default-and-session-switching, and release-artifact/migration. Chat is the
default route, so the journeys are also run once in plain chat with an
authorized model (RELEASING.md, manual smoke step 8).
