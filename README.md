# Pi Persona

Pi Persona is a Pi Coding Agent extension that adds named, project-local
personas on top of Pi, `pi-subagents`, and `pi-intercom`.

The extension keeps direct persona answers in the active Pi chat session.
Subagents are used only when an active persona explicitly consults another
persona or when `/persona-roundtable` runs a multi-persona workflow.

## What It Provides

- Project-local persona files under `.pi/agents/`.
- A shared `_baseline.md` that is merged into every persona.
- Direct persona commands such as `/generalist` and `/<specialist-name>`.
- `persona_consult` for active personas to ask project peers for help.
- `/persona-roundtable` for explicit multi-persona discussion.
- `/persona doctor` for setup and dependency validation.
- Active persona status through the `pi-persona-active` status key.

## Runtime Dependencies

Pi Persona is built on Pi package extensions. Consult and round-table workflows
require these packages to be installed and visible to Pi:

```sh
pi install npm:pi-subagents
pi install npm:pi-intercom
```

Installing this repository's npm dependencies is not enough. `pi-subagents` and
`pi-intercom` must be configured as Pi packages so Pi can expose their runtime
tools and child-session behavior.

Direct persona activation can still work without those child-runtime packages,
but `/persona doctor`, `persona_consult`, and `/persona-roundtable` will report
actionable readiness guidance until the dependencies are available.

## Local Install

This package is currently marked private in `package.json`, so treat it as a
local Pi package during development:

```sh
npm install
pi install . -l --approve
pi install npm:pi-subagents
pi install npm:pi-intercom
```

Then restart or reload Pi so the extension set is fresh.

If Pi reports duplicate `subagent` or `wait` tools, remove or disable the stale
duplicate extension path and keep only one loaded copy of `pi-subagents`.

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

For richer project setup, use assisted manifest drafting:

```text
/persona init draft --out init-data/my-operating-layer.yaml
```

Pi Persona creates a draft and starts a setup interview in the active Pi
session. Answer the questions in chat; the assistant edits the YAML for you and
previews the plan before apply. See [`init-data/README.md`](init-data/README.md)
for the manifest details.

## Troubleshooting

**`/generalist` says to run `/persona init`.** The project does not yet have a
launchable primary generalist under `.pi/agents/`. Run `/persona init`, then
`/persona doctor`.

**`persona_consult` reports an unknown consultant.** `persona_consult` only
accepts project Pi Persona agents discovered in the active workspace. Use
`/persona-list` to see the valid names.

**`subagent list` shows many agents.** That is expected. `subagent list` lists
global Pi subagents, including builtins, user package agents, and project
`.pi/agents` files. It is not the Pi Persona consultant roster.

**The footer does not show the active persona.** Pi Persona publishes the
`pi-persona-active` status key. Footer rendering depends on the active Pi
footer extension. With `npm:pi-powerline-footer`, configure a custom item that
reads this status key.

**Consults or round-tables time out.** Run `/persona doctor`. The most common
cause is that `pi-subagents` or `pi-intercom` is installed as an npm dependency
but not loaded as a Pi package.

## Maintainer Docs

- [`docs/README.md`](docs/README.md) gives the maintainer reading order.
- [`docs/blueprint.md`](docs/blueprint.md) explains the product model and
  settled principles.
- [`docs/design.md`](docs/design.md) explains the implementation design.
