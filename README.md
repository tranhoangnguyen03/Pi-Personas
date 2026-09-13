# Pi Persona

Pi Persona is a Pi Coding Agent extension that adds named, project-local
personas. Pi 0.85.1 is the current tested baseline, not a runtime requirement.

The extension keeps direct persona answers in the active Pi chat session.
Child sessions are used only when an active persona explicitly consults another
persona or when `/persona-roundtable` runs a multi-persona workflow. With no
explicit backend preference, Pi Persona uses the existing `pi-subagents`
backend when it is installed and falls back to the private native runner when
it is not; either backend can still be selected explicitly.

## Get Started

Install Pi Persona:

```sh
pi install npm:pi-personas
```

If you already use `pi-subagents`, Pi Persona detects it and keeps using that
legacy backend. Otherwise it uses its private native runner. Installing
`pi-subagents` is optional.

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

Pi Persona targets Pi Coding Agent 0.85.1 and Node 22.19 or newer. Direct
persona activation does not require a child backend.

Backend selection follows this precedence, checked in order:

1. The `PI_PERSONA_BACKEND` environment variable, if set. Accepted values are
   `legacy` and `native`; any other value is a startup error.
2. A `backend` key in `.pi/persona.json`, if present:

   ```json
   {
     "backend": "native"
   }
   ```

3. Otherwise, the effective default: `legacy` when `pi-subagents` is
   installed, `native` when it is not. "Installed" means Pi Persona
   can find the `pi-subagents` package files (the same existence check
   `/persona doctor` reports); it does not require the package to also be
   configured as a loaded Pi package. An installed-but-unconfigured or
   incompatible `pi-subagents` still counts as installed for this default, so
   `legacy` is still chosen, and doctor/preflight then reports the
   configuration or version problem instead of silently switching to native.

Run `/persona doctor` to see the effective backend. Backend selection happens
once, before work starts: a selected backend is never silently retried or
substituted for the other one, whether it was chosen explicitly or by
auto-detection, and whether the failure happens at selection or during
execution.

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

External `pi-intercom` is not required. Installing repository npm dependencies
alone does not configure the legacy `pi-subagents` backend as a Pi package.

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

The last command is required only for the legacy backend. Pi Persona
detects duplicate legacy declarations across global and project settings,
keeps one global copy, backs up changed settings, and asks you to reload before
legacy orchestration continues.

## Privacy And Data Flow

Pi Persona has no extension-owned telemetry or network client. Data is handled
through the Pi runtime and the model providers configured there.

- Direct mode may ask the active Pi session to read the persona's declared docs.
- A fresh consult sends the question, requester summary, constraints, resolved
  persona prompt, and declared docs and skills to a child session.
- A forked consult also gives that child a frozen copy of the active
  conversation branch. The in-flight consult tool call is removed so the child
  never receives a dangling call. Use `fresh` unless full history is required.
- A round-table performs roster selection in the active primary-generalist chat,
  then sends the query and resolved persona context to the selected specialists
  and final synthesizer; later rounds also receive prior round outputs.

Do not declare sensitive docs unless the configured Pi model provider is
allowed to process them. Native mode does not isolate the child from the
parent's environment or filesystem permissions.

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
`.pi/agents` files. It is not the Pi Persona consultant roster and is not used
by the native backend.

**The footer does not show the active persona.** Pi Persona publishes the
`pi-persona-active` status key. Footer rendering depends on the active Pi
footer extension. With `npm:pi-powerline-footer`, configure a custom item that
reads this status key.

**Consults or round-tables fail to start.** Run `/persona doctor` and check its
backend line. For `legacy`, ensure `pi-subagents` is loaded as a Pi package;
duplicate declarations are repaired automatically and require one reload. For
`native`, check the reported skill, model, authentication, or tool preflight
error. A running consult has no overall time limit, reports live elapsed time,
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
- [`RELEASING.md`](RELEASING.md) defines automated and manual release gates.
- [`CHANGELOG.md`](CHANGELOG.md) records published changes.
