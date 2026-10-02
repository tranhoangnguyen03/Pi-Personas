# Pi Persona

Pi Persona is a Pi Coding Agent extension that adds named personas, grouped
into packs. Packs are global: install or create one once and use it in any
project. The pack a session uses is its team; each session uses one team, and
one default team can be set for new sessions. You manage all of it by asking
in plain chat. Pi 0.85.1 is the current tested baseline, not a runtime
requirement.

Upgrading from 0.3.x with personas in `.pi/agents/`? See
[Upgrading From 0.3.x](#upgrading-from-03x): a one-time, copy-only migration
that leaves your original files untouched.

The words used below:

- A **pack** is a named set of personas, such as the bundled `philosopher-7`.
- A **team** is the pack your current session uses.
- Each pack has one **lead** (shown as `[G]`), which coordinates, plus
  **specialists**.
- **Official** packs come from the bundled catalog; **custom** packs are ones
  you create or copy (fork) and can edit.

The extension keeps direct persona answers in the active Pi chat session.
Child sessions are used only when an active persona explicitly consults another
persona or when `/persona-roundtable` runs a multi-persona workflow. Pi Persona
runs these children on its own private native runner; it does not use or
require `pi-subagents`.

## Get Started

Install Pi Persona:

```sh
pi install npm:pi-personas
```

Pi Persona runs natively; installing `pi-subagents` is unrelated and optional.
If you already use it for its own raw `subagent` tool, that keeps working
side by side and is never affected by Pi Persona's own consults or
round-tables.

Restart Pi or run `/reload`. You can open Pi in any directory: packs live in
Pi's agent directory, not in a project, so installing or creating one touches
no project files and needs no per-project setup.

Then just ask in chat:

```text
What persona teams can I use?
Install the philosopher-7 pack and switch this session to it.
```

Pi shows what it is about to change and waits for your yes before changing
anything. Installing or creating a pack never activates it by itself; using a
team in this session, or making it the default for new sessions, is always
its own approved step. Once the switch is done, `/persona-list` shows the
team's personas, led by `[G] symposium`. See
[Managing Personas In Chat](#managing-personas-in-chat) for editing a pack and
setting a default.

The same actions are available as exact [slash commands](#advanced-persona-pack-commands) for
precise control:

```text
/persona pack list
/persona pack install philosopher-7
/persona team philosopher-7
```

Skip `/persona onboard` on a first run: it adds no personas. See
[Optional Project Foundation](#optional-project-foundation).

## Managing Personas In Chat

Chat is the default way to manage personas. Ask for what you want in your own
words; Pi handles it behind the scenes:

```text
Show me the installed teams and which one this session uses.
Make a copy of philosopher-7 called my-philosophy that I can edit, and add a pricing specialist.
Switch this session to my-philosophy.
From now on, start new sessions with my-philosophy.
This project has an old persona setup. What would converting it involve?
```

Editing a copy, in chat, looks like this:

1. You ask for the copy and the change (the second example above).
2. Pi creates `my-philosophy`, edits a draft of it, shows you a preview of
   what changed, and waits.
3. You answer "yes, apply it". Pi applies the draft and confirms.
4. Pi offers to switch this session to `my-philosophy` (or to refresh it, if
   this session already uses it) and, separately, to make it the default.
   Say yes to the ones you want; `/persona-list` then shows the new
   specialist.

How it works:

- **Look first, change after approval.** Browsing is immediate. Anything that
  changes your setup (switching this session's team, setting or clearing the
  default, updating, removing or applying a pack, applying or rolling back a
  migration) is shown to you as a plan first, and Pi waits for your reply.
  Answer plainly ("yes, do it" / "no"): Pi checks that you replied, and the
  assistant reads whether your reply means yes. If something changes in the
  meantime (the pack is edited, the default moves, the draft is touched), Pi
  shows the updated plan instead of applying the old one.
- **Editing is a guided draft.** Customize an official pack by forking it into
  your own custom pack. Pi edits a draft of it, shows you a preview of the
  changes, and applies it once you approve. Applying never switches any
  session's team.
- **Your session keeps its copy.** A session that already uses a pack keeps
  the version it loaded until you refresh it ("refresh this session's team")
  or switch; new sessions get the latest version. Pi offers the refresh after
  you apply changes to the pack you are using.
- **Session and default are separate.** "This session" changes only the
  conversation you are in. "New sessions" / "from now on" changes only the
  default; open sessions keep their teams. If your request could mean either,
  Pi asks which one you mean.
- **Switching completes at the end of the reply.** Changing this session's
  team reloads Pi's extensions so the team's own `/` commands replace the old
  ones. That happens right after the reply in which you approved it, and Pi
  posts the result. If you jump to another session or conversation branch
  before then, nothing changes and Pi tells you. Approve one switch or
  rollback per reply; a second one in the same reply is not applied.
- **Migration copies, never moves.** Converting an older project setup copies
  it into a new global custom pack after you approve the preview; the
  project's original files are never changed, and the new pack is not selected
  or made the default for you. A rollback, also approved first, marks the
  project as needing migration again and keeps the copied pack.

## Optional Project Foundation

Each project can also keep an optional foundation: shared context and a
library every persona can read. Open Pi from that project and run:

```text
/persona onboard
```

Onboarding creates only `.pi/agents/_baseline.md` and `library/shared/`; it
adds no personas and is never required before installing, forking, creating,
or editing a pack.

## Advanced: Persona Pack Commands

Everything in this section can also be asked for in chat. These slash
commands are the advanced, exact route to the same operations.

Persona packs are global and user-owned: install/fork/create a pack once and
use it from any project. Every pack has exactly one on-theme generalist lead
plus specialists; discovery views mark that lead with a derived `[G]` prefix.
`[G]` is a display signal, not part of the stored name or slash command. Pi
Persona V1 includes the offline `philosopher-7` pack: `[G] symposium`
coordinates seven specialist methods—Socrates, Descartes, Kant, Hume,
Aristotle, Hegel, and Plato. They are reasoning methods, not historical
simulations.

Packs are either **official** (installed from the bundled catalog) or
**custom** (created from scratch or forked from an official/custom pack), and
each can be named as `official/<name>` or `custom/<name>` (the short name
works when only one pack has it). Installing/forking/creating/editing a pack
never selects it for any session — team selection is always the separate,
deliberate `/persona team` command (see below).

```text
/persona pack list                      Installed official/custom packs plus the bundled catalog
/persona pack status [name]             Detailed status for one pack, or a store-wide summary
/persona pack install <name>            Install an official pack from the bundled catalog
/persona pack update <name> [--discard-edits]   Update an installed official pack to a newer version
/persona pack uninstall <name>          Permanently remove an installed official pack
/persona pack fork <source> <name>      Create an independent custom pack from an official/custom source
/persona pack create <name>             Start (or resume) an inactive draft for a new custom pack
/persona pack edit <name>               Start (or resume) an inactive draft to revise a custom pack
/persona pack preview <name>            Show the pending draft's diff against the active pack
/persona pack apply <name>              Validate and apply the pending draft, replacing the active pack
/persona pack cancel <name>             Discard the pending draft
/persona pack delete <name>             Permanently remove a custom pack
```

`create` and `edit` start a private draft copy (not used by any session yet)
and report its path; edit
the draft's `pack.yaml`, `agents/*.md`, and `references/**` files directly
with your editor (or ask Pi to do it), then `preview` and `apply`. Nothing
changes until `apply` runs — `cancel` discards the draft instead. `update`,
`uninstall`, `delete`, and `apply` first show exactly what will happen without
changing anything; run the same command again to confirm. Uninstalling or
deleting the pack currently set as the global default clears that default
(never silently replaces it); updating a pack with local edits requires
`--discard-edits` to replace them (fork it first to keep them instead).

There is no way to create a new project-local pack. For older project
setups, see [Upgrading From 0.3.x](#upgrading-from-03x).

## Common Commands (Advanced)

Everything here can also be asked for in chat:

```text
/persona team [<name>]                   Bind this session to an installed pack, or pick one
/persona team default [<name>]           Show or set the default pack for new sessions
/persona pack list                       Browse installed packs and the bundled catalog
/persona onboard                         Start or resume the optional project foundation
/persona-list                            List the current session's personas
/persona use <name> <request>            Ask a specific persona
/persona-roundtable <question>           Ask one pack's specialists
/persona status                          Show the bound team and active persona
/persona clear                           Leave persona mode
/persona doctor                          Check setup and runtime readiness
/persona migrate inspect                 Review an older project setup for conversion
```

## Upgrading From 0.3.x

Packs used to live inside each project. They are now global, and each session
picks its team.

- **Older project setups need a one-time migration.** A workspace whose
  `.pi/agents/` has its own generalist (any setup from earlier releases) is
  recognized as an older setup. Sessions there start with no team and its
  personas are paused; Pi says so at startup. Ask in chat ("This project has
  an old persona setup. What would converting it involve?") or run
  `/persona migrate inspect`. Migration copies the setup into a new global
  custom pack after you approve the preview. The original files are never
  changed, and the new pack is not selected or made the default for you. The
  exact commands are in the
  [migration runbook](docs/_about_pi_persona/migration-runbook.md).
- **Rolling back a migration** marks the project as needing migration again
  and keeps the copied pack and the original files. It does not downgrade
  Pi Persona.
- **Packs that 0.3.x installed into a project** (`.pi/persona-packs/`,
  `.pi/agents/packs/`) are not converted. Install the global version (for
  example `philosopher-7`) and choose it as a team. Those files and your
  `library/` folders are left where they are.
- **`pi-subagents` is no longer used.** A `PI_PERSONA_BACKEND=legacy` or
  `.pi/persona.json` `{ "backend": "legacy" }` setting now stops with an error
  naming the setting; remove it or set it to `native`.

**Downgrading to pi-personas 0.3.x:**

- 0.3.x does not know about global persona packs. Your packs, default and
  migration receipts are left untouched on disk, but 0.3.x will not show or
  use them. Sessions bound to a global team show no personas.
- In a workspace you already migrated, 0.3.x uses the original `.pi/agents`
  team again.
- `/persona pack`, `/persona team` and `/persona migrate` only print 0.3.x
  usage text.
- If you edit `.pi/agents` while on 0.3.x, upgrading again marks that
  workspace's migration `changed-source`. New sessions there get no default
  team until you run `/persona migrate inspect/preview/apply` again.
- 0.3.x may clear a session's active persona. After upgrading again, the
  session keeps its team; pick the lead again (for example `/symposium`).
- Migration rollback is a different operation; it does not downgrade.

## What It Provides

- Chat-first management: ask in plain language; every change is shown as a
  plan and waits for your reply.
- Global, user-owned persona packs: install/update/uninstall official packs,
  create/fork/edit/delete custom packs, all independent of any one project.
- One team per session and a separate global default for new sessions;
  installing or editing a pack never activates it.
- One on-theme `[G]` lead and one or more specialists per pack.
- Direct persona commands such as `/<pack-lead>` and `/<specialist-name>`.
- A guaranteed `/persona use <name> [query]` route when a direct command collides.
- Focused peer consultation between team personas.
- Explicit team-local multi-persona discussion through `/persona-roundtable`.
- An optional, project-local foundation (shared context library) and
  `/persona doctor` readiness checks.
- Persistent active-persona state and bound team in the current Pi session.
- Guided migration of older project setups into a global custom pack.

## Runtime Requirements

Pi Persona targets Pi Coding Agent 0.85.1 and Node 22.19 or newer. Direct
persona activation does not require a child backend.

Pi Persona runs natively only; there is no other backend to select. An
explicit `PI_PERSONA_BACKEND=native` environment variable or `{"backend":
"native"}` in `.pi/persona.json` is a harmless no-op, kept for compatibility
with settings written before this release. Any other explicit value —
including the retired `legacy` backend — fails fast with an actionable error
naming the setting and how to remove it, instead of being silently ignored.

Run `/persona doctor` to see readiness for native execution.

The native backend starts one dedicated Node process and one in-memory Pi SDK
session per child task. It loads the complete resolved persona prompt, declared
Pi skills, read guidance, and selected model. Without `tools` metadata it uses
`read`, `grep`, `find`, and `ls`; a persona may instead select any Pi built-in
tools. It disables child extensions, prompt templates, themes, and automatic
context-file discovery so the child stays leaf-only. Missing skills, unknown
tool names, and unavailable models or authentication fail when that resource
is actually needed.

Native children are one-shot and foreground-only. Persistent child
conversations, background jobs, child extension tools, and automatic fallback
are not supported. Process isolation is not an OS sandbox: each child inherits
the parent environment and filesystem permissions.
Authentication is resolved again immediately before every child launch so
long round-tables do not reuse an expired credential snapshot.

Pi package peer ranges use `*` as recommended for Pi packages. Pi 0.85.1 is
our tested baseline, not a required host version. Other versions are allowed;
actual SDK or resource failures are reported when encountered, without
silently rerunning work through another backend.

`/persona doctor` performs static project checks, including the effective
baseline-plus-agent native tool set. Loaded skill identity, model resolution,
extension-provided models, and current authentication depend on the live Pi
session and are checked when a native consult or round-table launches.


External `pi-intercom` is not required, and neither is `pi-subagents`.

## How Consults And Round-Tables Work

An active persona can ask several independent specialists for advice at
once. Pi may run those consults in parallel; each
consultant is still a leaf and returns only to the requesting persona, which
synthesizes the answers.

`/persona-roundtable` asks the selected pack's `[G]` lead to choose relevant
specialists from that pack. They form independent positions, revise after
seeing their peers' views, and return self-contained final positions. The pack
lead then gives one argued synthesis covering the answer, each perspective's
contribution, real disagreements, conditions and tradeoffs, a recommended
decision, and what could change it. That synthesis is relayed in full. The
round-table always uses this session's team; there is no cross-pack option in
V1. The tool
panel shows the selected panel, reasons, progress, current activity, and
completion summary. Use this explicit command when specialists should see and
respond to one another; ordinary parallel consults do not create an interactive
discussion.

## Local Development

Install this checkout as a project-local Pi package while developing:

```sh
npm install
pi install . -l --approve
```

`pi install npm:pi-subagents` is unrelated to Pi Persona; only install it if
you separately want its raw `subagent` tool.

## Privacy And Data Flow

Pi Persona has no extension-owned telemetry or network client. Data is handled
through the Pi runtime and the model providers configured there.

- Direct mode injects the contents of the shared and active persona `_index.md`
  files so the persona knows what documents are available. Other documents are
  read progressively when relevant.
- A fresh consult sends the question, requester summary, constraints, and the
  consultant's declared library paths, index contents, and skills to a child
  session.
- A forked consult also gives that child a frozen copy of the deliberately
  selected conversation context; the in-flight consult tool call is removed so
  the child never receives a dangling call. Use `fresh` unless full history is
  required.
- A round-table performs roster selection in the selected pack-lead chat, then
  sends the query and each persona's own resolved context to the selected
  specialists and moderator; later rounds also receive prior round outputs.

Do not place sensitive library material where the configured Pi model provider
is not allowed to process it. Native mode does not isolate the child from the
parent's environment or filesystem permissions.

## Troubleshooting

**No personas appear after onboarding.** That is expected: onboarding creates
only the optional project foundation and shared library, and has nothing to do
with persona packs. Run `/persona pack list` to install or create a pack, then
`/persona team <name>` to bind this session to it.

**Personas refuse to run: "No persona team is bound" or "predates global
persona packs".** This session has no team, or the workspace has an older
setup that needs migration. Ask in chat to pick a team (or run
`/persona team`), or see [Upgrading From 0.3.x](#upgrading-from-03x).

**A consult reports an unknown name.** Consults only accept personas from
this session's team, using the copy of the pack the
session loaded. Use `/persona-list` to see the valid names.

**`/<persona>` says it is not available in this session.** Pi may keep a
direct command name visible after the team or workspace changes in the same
process. Run `/persona-list` and choose one of the listed names. Use
`/persona use <name>` when a direct alias is reserved or collides with another
command.

**Disk space after a crash.** Each running session keeps a private copy of its
team under `~/.pi/agent/persona/.runtime-sessions/` (or
`$PI_CODING_AGENT_DIR/persona/.runtime-sessions/`) and removes it when Pi exits
normally. If
Pi is killed (`kill -9`, power loss), that copy stays behind and is not cleaned
up automatically. With no Pi running, delete everything inside
`.runtime-sessions/`.

**`subagent list` shows many agents.** That is expected. `subagent list` lists
global Pi subagents, including builtins, user package agents, and project
`.pi/agents` files. It is not the Pi Persona consultant roster and is not used
by the native backend.

**The footer does not show the active persona.** Pi Persona publishes the
`pi-persona-active` status key. Footer rendering depends on the active Pi
footer extension. With `npm:pi-powerline-footer`, configure a custom item that
reads this status key.

**Consults or round-tables fail to start.** Run `/persona doctor` and check the
reported skill, model, authentication, or tool preflight error. If it reports
a stale `legacy` or unrecognized `PI_PERSONA_BACKEND`/`.pi/persona.json`
setting, remove it (or set it to `native`); Pi Persona has no other backend.
A running consult has no overall time limit, reports live elapsed time,
tool activity, sources, errors, turns, and tokens in its `[pi-persona]` box,
and cancels after three minutes without child activity. Round-table
progress uses the same in-place box and additionally shows the active round,
specialist completion count, per-persona work state, phase purpose, upcoming
step, and moderator-synthesis phase. Once started, a
round-table has neither an overall deadline nor inactivity cancellation; use
the normal tool cancellation control when you want to stop it.

If any native specialist fails during a round, unfinished peers are cancelled
and synthesis does not run. Retry explicitly after addressing the error; Pi
Persona does not reuse output from another run.

The consult box also shows the delegated query and whether context is `fresh`
or `fork`. Use Pi's tool expand key (`Ctrl+O` by default) to reveal the full
request, requester summary, constraints, and expected output.

## License

[MIT](LICENSE)

## Maintainer Docs

- [`docs/_about_pi_persona/README.md`](docs/_about_pi_persona/README.md) gives the maintainer reading order.
- [`docs/_about_pi_persona/blueprint.md`](docs/_about_pi_persona/blueprint.md) explains the product model and
  settled principles.
- [`docs/_about_pi_persona/design.md`](docs/_about_pi_persona/design.md) explains the implementation design.
- [`docs/_about_pi_persona/migration-runbook.md`](docs/_about_pi_persona/migration-runbook.md) gives exact
  `/persona migrate` commands for converting an older project setup.
- [`RELEASING.md`](RELEASING.md) defines automated and manual release gates.
- [`CHANGELOG.md`](CHANGELOG.md) records published changes.
