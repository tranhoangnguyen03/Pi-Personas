# Pi Persona

Pi Persona is a Pi Coding Agent extension that adds named, project-local
personas on top of Pi and `pi-subagents`.

The extension keeps direct persona answers in the active Pi chat session.
Subagents are used only when an active persona explicitly consults another
persona or when `/persona-roundtable` runs a multi-persona workflow.

## Get Started

Install Pi Persona and its collaboration runtime:

```sh
pi install npm:pi-personas
pi install npm:pi-subagents
```

Restart Pi or run `/reload`. Then open Pi from the project you want to configure:

```sh
cd /path/to/your/project
pi
```

Persona setup is project-local: each workspace gets its own team and context.
In Pi, start guided onboarding:

```text
/persona onboard
```

Answer one question at a time. Pi Persona helps define a generalist and the
smallest useful set of specialists for this workspace, shows what it will
create, and asks before writing the setup. When onboarding finishes, the
primary generalist is active and ready for your first task.

See the personas created for this project:

```text
/persona-list
```

Ask the primary generalist for help:

```text
/generalist what should we do next?
```

To use a specialist, choose a name shown by `/persona-list`:

```text
/persona use <name> review this from your role
```

When the listed direct command is available, `/<name> ...` works too.

## Common Commands

```text
/persona onboard                         Start or resume guided setup
/persona-list                            List this project's personas
/generalist <request>                    Ask the primary generalist
/persona use <name> <request>            Ask a specific persona
/persona-roundtable <question>           Ask several relevant specialists
/persona status                          Show the active persona
/persona clear                           Leave persona mode
/persona doctor                          Check setup and runtime readiness
```

## Alternative Setup Options

Most users only need `/persona onboard`. For a minimal baseline and generalist
without the guided interview, run:

```text
/persona quick-start
```

`/persona init` remains an alias for `/persona onboard` for compatibility.
Advanced users can choose another setup-manifest path with:

```text
/persona onboard --out <file>
```

See [`init-data/README.md`](init-data/README.md) for manual manifest controls.

## What It Provides

- Project-local personas and shared context under `.pi/agents/`.
- Direct persona commands such as `/generalist` and `/<specialist-name>`.
- A guaranteed `/persona use <name> [query]` route when a direct command collides.
- Focused peer consultation between project personas.
- Explicit multi-persona discussion through `/persona-roundtable`.
- Guided, resumable setup and `/persona doctor` readiness checks.
- Persistent active-persona state in the current Pi session.

## Runtime Requirements

Pi Persona requires Pi Coding Agent 0.80.6 through 0.80.x. Consults and
round-tables require `pi-subagents` 0.35.0 or newer to be installed as a Pi
package. Direct persona activation can still work without it, while doctor,
consults, and round-tables provide installation guidance.

External `pi-intercom` is not required. Installing repository npm dependencies
alone does not configure `pi-subagents` as a Pi package.

## How Round-Tables Work

`/persona-roundtable` asks the primary generalist to select one to five relevant
specialists. They form independent positions, revise after seeing their peers'
views, and return one primary-generalist synthesis. The tool panel shows the
selected panel, reasons, progress, current activity, and completion summary.

## Local Development

Install this checkout as a project-local Pi package while developing:

```sh
npm install
pi install . -l --approve
pi install npm:pi-subagents
```

Pi Persona detects duplicate `pi-subagents` declarations across global and
project settings, keeps one global copy, backs up changed settings, and asks
you to reload before orchestration continues.

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

**`/generalist` says no persona setup was found.** Run `/persona onboard` and
answer the guided setup questions.

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
