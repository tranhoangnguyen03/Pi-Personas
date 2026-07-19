# Pi Persona Design

This document describes the current implementation design. It should be enough
for a maintainer to rebuild the repo behavior from first principles alongside
the tests.

## Module Responsibilities

`extensions/pi-persona.ts` is glue. It registers commands and tools, manages
active persona state through Pi hooks, updates extension status, calls pure
persona modules, and formats command output for Pi.

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

`src/persona/subagent-bridge.js` is transport only. It emits a bridge request,
waits for the matching response, forwards progress, and returns raw bridge data.

`src/persona/progress.js` turns observable child events into the live consult
summary shown in the streaming `[pi-persona]` tool box.

`src/persona/roundtable.js` builds the explicit multi-persona workflow.

`src/persona/doctor.js`, `runtime.js`, `doc-index.js`, `scaffold.js`, and
`init-manifest.js` provide setup, validation, dependency checks, docs catalogue
generation, and manifest-backed initialization.

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

The resolver should not execute tools, write files, or launch children. It
returns structured data that command handlers and workflow builders can use.

## Direct Persona Flow

When a user runs `/generalist <query>` or `/<specialist-name> <query>`, Pi
Persona resolves that persona and records it as the active persona for the
current session. `/persona use <name> [query]` uses the same activation path and
is canonical when a direct alias is reserved or collides.

Direct command names can outlive a workspace switch in the Pi command registry,
so the handler must resolve the name in `ctx.cwd` before activation. If the
persona is unavailable, the command reports `/persona-list` guidance and leaves
active persona state unchanged.

Before each agent turn, the extension injects the active persona prompt into
the active Pi chat. The persona answers in the same chat. There is no child
subagent run for direct persona answers.

Active state is restored on session start from transcript data. If the restored
persona no longer resolves in the current workspace, the extension clears it
before answering normally. `/persona status` reads the stored state.
`/persona clear` removes it.

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

The consult module resolves the consultant from project Pi Persona agents only.
It rejects unknown or duplicate names instead of falling back to global
subagents.

Default consult context is summarized and fresh. A forked requester context is
allowed only when the requester deliberately chooses it. In all cases, the
consultant receives its own resolved prompt, docs, skills, and model guidance.
Requester docs and skills are not inherited unless they are also part of the
consultant's baseline or persona file.

The bridge response is interpreted with one fallback ladder:

1. Use structured or final child output when present.
2. Else read the output artifact path when present.
3. Else use bridge text.
4. Else return a clear error with run and artifact metadata.

Provenance is compact and requester-facing. The requesting persona synthesizes
the final answer.

A consult has no overall runtime deadline. The bridge cancels after three
minutes without a matching child progress event, while each progress event
resets that idle window. The same `[pi-persona]` box refreshes in place with
elapsed and idle time, current tool and arguments, cumulative tool categories,
sources, turns, tokens, and reported failures; it does not publish consult
progress to the status line or add transcript messages.

The collapsed tool call shows the consultant, a query preview, and either
`Context: fresh · conversation history not included` or
`Context: fork · current conversation branch inherited`. Pi's native tool
expand action (`Ctrl+O` by default) reveals the full query, requester summary,
constraints, and expected output while preserving the live progress result.

## Child-Run Boundary

When `PI_SUBAGENT_CHILD=1`, Pi Persona is inert. It does not register persona
commands, `persona_consult`, direct persona bootstrap commands, or active
persona prompt injection. A child run is already executing as a selected leaf
persona.

Consult and round-table child prompts must treat the child as a leaf task. They
must not call `persona_consult`, raw `subagent`, `subagent list`,
`contact_supervisor`, or `intercom`. If blocked, the child reports the blocker
in its returned answer.

This prevents nested orchestration loops and avoids relying on bridge listeners
that are intentionally absent inside `pi-subagents` children.

## Round-table Flow

`/persona-roundtable <query>` is an explicit multi-persona workflow. The
primary generalist owns specialist selection. The command activates that
generalist in the current chat with the query and current specialist roster.
The generalist must call `persona_roundtable` exactly once with one to five
names plus a reason for each. TypeBox validates the tool shape and Pi Persona
validates names, uniqueness, roster size, and reasons against the active
project; there is no heuristic fallback.

After validation, Pi Persona resolves only the chosen persona scopes and sends
one `pi-subagents` bridge request containing:

- independent specialist positions
- reveal and revise step
- moderator synthesis

The in-process slash bridge returns the chain result directly to Pi Persona.
Pi Persona extracts only the current moderator synthesis, preserving native
execution, progress, cancellation, artifacts, and child coordination without
exposing the bridge receipt as a second verdict. Round-tables require
`pi-subagents` 0.34.0 or newer; no private delivery parameter is sent.

Every chain task is explicitly advisory and read-only, so analysis is not
rejected for failing to edit files. The top-level task repeats the no-edit
contract for runtimes that infer completion intent from the original query.
Only the current request's primary-generalist result or its exact output
artifact may become the final answer; Pi Persona never searches historical run
directories for a replacement.

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
bridge runtime deadline and inactivity cancellation; silence is displayed, not
treated as permission to interrupt a diligent specialist.

Round-table uses child runs because the user explicitly asked for a
multi-persona workflow. It is separate from ordinary direct persona answers.

## Assisted Manifest Authoring

`/persona onboard` creates or resumes the durable draft at
`init-data/my-operating-layer.yaml` by default and sends an authoring request
into the active Pi chat. The assistant edits that file and uses the
`persona_init` tool to plan, confirmation-gated apply, index docs, inspect
status, run doctor, list personas, and activate the primary generalist.
`/persona quick-start` provides the minimal scaffold; `/persona init` remains an
onboarding alias and the older manifest slash forms remain advanced controls.

## Doctor And Runtime Checks

`/persona doctor` validates:

- `pi-subagents` is present and configured
- project agents are discoverable and compatible with `pi-subagents`
- names, descriptions, roles, models, booleans, and list fields have valid types
- exactly one primary generalist exists
- docs paths remain inside the physical workspace, including through symlinks,
  and exist when required
- nested docs directories have `_index.md` guidance
- native skill names are used instead of path-style skill entries
- legacy metadata is reported as migration guidance
- runtime support roles carry useful provenance where possible

Before validation, doctor and orchestration preflight automatically normalize
duplicate `pi-subagents` declarations across global and project settings. The
global declaration wins, changed files receive `.pi-personas.bak` backups, and
the current orchestration pauses for one reload so already-loaded duplicate
listeners cannot launch the same child twice.

Consult and round-table commands also run a runtime preflight before bridge
execution so missing dependencies produce guidance instead of a timeout.

## Global Subagent List

`subagent list` lists global Pi subagents. It can include builtins, package
agents, and project `.pi/agents` files. This is useful Pi runtime behavior, but
it is not the Pi Persona consultant list.

Pi Persona's consultant roster comes from project agents resolved in the active
workspace. Users can inspect that roster with `/persona-list`.

## Documentation And Test Strategy

Tests should protect the public runtime boundaries:

- package manifest exposes the extension
- direct persona commands activate the active chat instead of child runs
- `/generalist` has bootstrap command behavior before setup
- active persona state is stored, restored, displayed, and clearable
- footer status uses `pi-persona-active`
- consults use `persona_consult`, not raw subagent discovery
- runtime preflight reports missing or unconfigured `pi-subagents`
- canonical `/persona use` works when aliases are unavailable
- round-table selection is a primary-generalist `persona_roundtable` tool call,
  exactly one bridge request is emitted, and the deliberation chain contains
  only selected specialists
- manifest apply is confirmation-gated through `persona_init`
- model-driven manifest apply includes doctor verification before success is
  reported
- child sessions are inert under `PI_SUBAGENT_CHILD`
- consult child prompts describe leaf task behavior
- docs explain global `subagent list` implications

The docs test should read `README.md`,
`docs/_about_pi_persona/blueprint.md`, and
`docs/_about_pi_persona/design.md` as the canonical documentation set.
