# Pi Persona

Pi Persona is a Pi Coding Agent extension that adds named, project-local
personas on top of Pi and `pi-subagents`.

The extension keeps direct persona answers in the active Pi chat session.
Subagents are used only when an active persona explicitly consults another
persona or when `/persona-roundtable` runs a multi-persona workflow.

## What It Provides

- Project-local persona files under `.pi/agents/`.
- A shared `_baseline.md` that is merged into every persona.
- Direct persona commands such as `/generalist` and `/<specialist-name>`.
- A guaranteed `/persona use <name> [query]` activation route when an alias is reserved or collides.
- `persona_consult` for active personas to ask project peers for help.
- Assisted manifest authoring through the model-callable `persona_init` tool.
- `/persona-roundtable` for explicit multi-persona discussion.
- `/persona doctor` for setup and dependency validation.
- Active persona status through the `pi-persona-active` status key.

## Runtime Dependencies

Pi Persona requires Pi Coding Agent 0.80.6 through 0.80.x.

Pi Persona is built on Pi package extensions. Consult and round-table workflows
require `pi-subagents` to be installed and visible to Pi:

```sh
pi install npm:pi-subagents
```

Managed round-table delivery requires `pi-subagents` 0.35.0 or newer. Doctor
warns about older runtimes, and `/persona-roundtable` refuses to start rather
than expose raw child results, run IDs, or artifact paths.

Installing this repository's npm dependencies is not enough. `pi-subagents`
must be configured as a Pi package so Pi can expose its child-session behavior.
Its native supervisor and result channels are sufficient; external
`pi-intercom` is not required.

Direct persona activation can still work without that child-runtime package,
but `/persona doctor`, `persona_consult`, and `/persona-roundtable` will report
actionable readiness guidance until the dependencies are available.

## Install

```sh
pi install npm:pi-personas
pi install npm:pi-subagents
```

Then restart or reload Pi so the extension set is fresh.

### Local Development

Install this checkout as a project-local Pi package while developing:

```sh
npm install
pi install . -l --approve
pi install npm:pi-subagents
```

Pi Persona detects duplicate `pi-subagents` declarations across global and
project settings, keeps one global copy, backs up changed settings, and asks
you to reload before orchestration continues.

## Quickstart

Initialize a project:

```text
/persona init
```

Validate setup:

```text
/persona doctor
```

Ask the primary generalist:

```text
/generalist what should we do next?
```

Ask a specialist directly:

```text
/example-specialist review this from your role
```

The canonical activation form always works for valid project personas:

```text
/persona use example-specialist review this from your role
```

Direct persona command names are resolved against the active workspace each
time they run. If Pi still shows a command name from a different workspace, the
command fails with workspace guidance instead of activating a stale persona.
Reserved names and extension-command collisions should use `/persona use`.

List available personas:

```text
/persona-list
```

Check or clear session state:

```text
/persona status
/persona clear
```

Run an explicit multi-persona workflow:

```text
/persona-roundtable should we launch this now?
```

The command activates the primary generalist, which selects one to five relevant
specialists with a schema-validated rationale and calls `persona_roundtable`
exactly once. That single child workflow runs both discussion rounds and the
primary-generalist synthesis over only the selected roster. Its bridge request
uses response-only delivery so the clean tool result is the sole completion
message in the parent conversation. The tool panel discloses the query, context,
selected specialists, reasons, three-stage process, per-persona status, current
activity, next step, and a compact execution summary.

For richer project setup, use assisted manifest drafting:

```text
/persona init draft --out init-data/my-operating-layer.yaml
```

Pi Persona creates a draft and starts a setup interview in the active Pi
session. Answer the questions in chat; the assistant edits the YAML for you and
uses `persona_init` to preview the plan. It asks for explicit approval before
applying, returns doctor verification, then reports manifest status. See
[`init-data/README.md`](init-data/README.md) for the manifest details.

## Privacy And Data Flow

Pi Persona has no extension-owned telemetry or network client. Data is handled
through the Pi runtime and the model providers configured there.

- Direct mode may ask the active Pi session to read the persona's declared docs.
- A fresh consult sends the question, requester summary, constraints, and the
  consultant's declared docs and skills to a child session.
- A forked consult also gives that child the deliberately selected conversation
  context. Use `fresh` unless full history is required.
- A round-table performs roster selection in the active primary-generalist chat,
  then sends the query and resolved persona context to the selected specialists
  and final synthesizer; later rounds also receive prior round outputs.

Do not declare sensitive docs unless the configured Pi model provider is
allowed to process them.

## Troubleshooting

**`/generalist` says to run `/persona init`.** The project does not yet have a
launchable primary generalist under `.pi/agents/`. Run `/persona init`, then
`/persona doctor`.

**`persona_consult` reports an unknown consultant.** `persona_consult` only
accepts project Pi Persona agents discovered in the active workspace. Use
`/persona-list` to see the valid names.

**`/<persona>` says it is not available in this workspace.** Pi may keep a
direct command name visible after you switch workspaces in the same process.
The persona files are still project-local; run `/persona-list` in the current
workspace and choose one of the listed names. Use `/persona use <name>` when a
direct alias is reserved or collides with another command.

**`subagent list` shows many agents.** That is expected. `subagent list` lists
global Pi subagents, including builtins, user package agents, and project
`.pi/agents` files. It is not the Pi Persona consultant roster.

**The footer does not show the active persona.** Pi Persona publishes the
`pi-persona-active` status key. Footer rendering depends on the active Pi
footer extension. With `npm:pi-powerline-footer`, configure a custom item that
reads this status key.

**Consults or round-tables time out.** Run `/persona doctor`. The most common
cause is that `pi-subagents` is installed as an npm dependency but not loaded as
a Pi package. Duplicate declarations are repaired automatically and require one
reload. A running consult has no overall time limit, reports live elapsed time,
tool activity, sources, errors, turns, and tokens in its `[pi-persona]` box,
and cancels only after three minutes without a child progress event. Round-table
progress uses the same in-place box and additionally shows the active round,
specialist completion count, per-persona work state, phase purpose, upcoming
step, and moderator-synthesis phase. Once started, a
round-table has neither an overall deadline nor inactivity cancellation; use
the normal tool cancellation control when you want to stop it.

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
- [`RELEASING.md`](RELEASING.md) defines automated and manual release gates.
- [`CHANGELOG.md`](CHANGELOG.md) records published changes.
