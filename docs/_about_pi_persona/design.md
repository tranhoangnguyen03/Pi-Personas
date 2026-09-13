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

`src/persona/child-runner.js` starts and supervises one dedicated Node process
per native task. `src/persona/child-entry.js` imports the exact Pi SDK entry
supplied by the loaded host package, creates one restricted session, normalizes
progress and usage, and disposes it.

`src/persona/subagent-bridge.js` remains the legacy transport. It emits one
correlated request, forwards progress, and returns raw bridge data.

`src/persona/progress.js` turns observable child events into the live consult
summary shown in the streaming `[pi-persona]` tool box.

`src/persona/roundtable.js` builds the explicit multi-persona workflow.

`src/persona/runtime.js` resolves `legacy` or `native` (explicit
`PI_PERSONA_BACKEND`/`.pi/persona.json` first, otherwise the auto-detected
default from `dependencies.js`), creates safe fork snapshots, and retains
legacy parameter translation. `src/persona/dependencies.js` holds the shared
`pi-subagents` package detection used by both runtime's default-backend
auto-detection and doctor's dependency checks, kept in its own module so
`runtime.js` and `doctor.js` can both import it without a cyclic dependency
(`doctor.js` already imports `runtime.js` for backend resolution).
`src/persona/doctor.js`, `doc-index.js`, `scaffold.js`, and `init-manifest.js`
provide setup, validation, backend-aware dependency checks, docs catalogue
generation, and initialization.

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

The legacy bridge response is interpreted with one fallback ladder:

1. Use structured or final child output when present.
2. Else read the output artifact path when present.
3. Else use bridge text.
4. Else return a clear error with run and artifact metadata.

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
answer text are failures. There is no cross-backend retry after work begins.

For `fork`, the parent clones `ctx.sessionManager.getBranch()`, removes the
assistant entry containing the current tool call, and freezes the snapshot once
per workflow. The child adds a new version-3 header and restores the entries
through `SessionManager.inMemory`. Every round-table child gets the same parent
snapshot, not another child's history.

When `PI_SUBAGENT_CHILD=1`, Pi Persona remains inert for legacy children. All
child prompts also state that the child is a leaf task.

## Round-table Flow

`/persona-roundtable <query>` is an explicit multi-persona workflow. The
primary generalist owns specialist selection. The command activates that
generalist in the current chat with the query and current specialist roster.
The generalist must call `persona_roundtable` exactly once with one to five
names plus a reason for each. TypeBox validates the tool shape and Pi Persona
validates names, uniqueness, roster size, and reasons against the active
project; there is no heuristic fallback.

After validation, Pi Persona resolves only the chosen persona scopes. Legacy
sends one `pi-subagents` bridge request containing:

- independent specialist positions
- reveal and revise step
- moderator synthesis

The bridge keeps the 0.34.0-0.40.x chain payload and translates the same fixed
workflow to a foreground `workflowScript` for `pi-subagents` 0.41.0 or newer.
Legacy consults are also explicitly foreground so bridge receipts cannot be
mistaken for consultant answers.

Native runs the same fixed workflow directly: parallel Round 1, parallel Round
2 with ordered Round 1 answers, then one moderator session with ordered Round 2
answers. A phase failure aborts unfinished siblings and prevents synthesis.
Legacy extracts only the current moderator synthesis and requires
`pi-subagents` 0.34.0 or newer.

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
runtime deadline and inactivity cancellation; silence is displayed, not
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

- the effective backend from `PI_PERSONA_BACKEND`, `.pi/persona.json`, or the
  auto-detected default (`legacy` when `pi-subagents` is installed, `native`
  otherwise)
- `pi-subagents` is present, configured, and new enough when legacy is selected
- project agents are discoverable
- names, descriptions, roles, models, booleans, and list fields have valid types
- exactly one primary generalist exists
- docs paths remain inside the physical workspace, including through symlinks,
  and exist when required
- nested docs directories have `_index.md` guidance
- Pi skill names are used instead of path-style skill entries
- legacy metadata is reported as migration guidance
- runtime support roles carry useful provenance where possible
- resolved baseline-plus-agent tools name Pi built-ins available to the native child

Doctor's project and native-tool checks are static. Exact loaded skills, model
selection, extension-registered providers, and current credentials are live
session state and remain launch-time preflight checks. Pi 0.85.1 is the tested
baseline, not a runtime version gate. Wildcard Pi peer declarations follow Pi
package guidance; actual SDK failures are reported without automatic reruns.

On legacy only, doctor and orchestration preflight automatically normalize
duplicate `pi-subagents` declarations across global and project settings. The
global declaration wins, changed files receive `.pi-personas.bak` backups, and
the current orchestration pauses for one reload so already-loaded duplicate
listeners cannot launch the same child twice.

Consult and round-table commands freeze backend selection and run its preflight
before execution. Native round-tables preflight every selected persona resource
before the first child starts.

## Global Subagent List

`subagent list` may be provided by an installed subagent package. It can include
builtins, package agents, and project `.pi/agents` files, but it is not the Pi
Persona consultant list and native does not use it.

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
- runtime preflight reports the backend and requires `pi-subagents` only for legacy
- native execution uses the supplied host SDK entry, exact skills, declared Pi
  built-in tools, normalized progress, usage, cancellation, and terminal-answer checks
- fork snapshots exclude the in-flight tool call and abandoned branches
- canonical `/persona use` works when aliases are unavailable
- round-table selection is a primary-generalist `persona_roundtable` tool call;
  legacy emits one bridge request, while native runs only the selected
  specialists in two phases before synthesis
- native phase failure prevents synthesis and never triggers legacy fallback
- manifest apply is confirmation-gated through `persona_init`
- model-driven manifest apply includes doctor verification before success is
  reported
- child sessions are inert under `PI_SUBAGENT_CHILD`
- consult child prompts describe leaf task behavior
- docs explain global `subagent list` implications

The docs test should read `README.md`,
`docs/_about_pi_persona/blueprint.md`, and
`docs/_about_pi_persona/design.md` as the canonical documentation set.
