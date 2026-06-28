# Phase 0 Runtime Proof

Date: 2026-06-27
Workspace: `/Users/davidus-tranus/Github/Pi-Personas`

## Verdict

Status: pass with accepted limitations.

Phase 0 proves that Pi Persona can build on `pi-subagents` and `pi-intercom`
for the planned persona adapter layer. The proof covered project agent
discovery, metadata tolerance, fresh versus forked context, derived docs/default
reads, tool scoping, writes, interactive parallel fan-out, child-to-supervisor
intercom, and Pi's available summary/session surfaces.

No Phase 0 blockers remain.

## Runtime Environment

| Item | Evidence | Verdict |
|---|---|---|
| `pi-subagents` | `rtk pi list` showed `npm:pi-subagents` at `/Users/davidus-tranus/.pi/agent/npm/node_modules/pi-subagents`; installed version `0.31.0`. | PASS |
| `pi-intercom` | `rtk pi list` showed `npm:pi-intercom` at `/Users/davidus-tranus/.pi/agent/npm/node_modules/pi-intercom`; installed version `0.6.0`. | PASS |
| `pi-subagents` doctor | Explicitly loading `pi-subagents` and `pi-intercom` made `/subagents-doctor` callable; doctor reported async support, project agents, and active intercom bridge. | PASS |
| `pi-intercom` status | `intercom({ action: "status" })` returned connected with a session id and active sessions. | PASS |
| Default extension discovery | `rtk pi --no-session --approve -p "/subagents-doctor"` failed first on unrelated extension `/Users/davidus-tranus/.pi/agent/extensions/palpatine.ts`, which could not load `../lib/commands.js`. Explicit extension loading avoided that pollution. | ACCEPTED LIMITATION |

## Probe Fixtures

Temporary fixtures were created during the proof and removed after
consolidation:

- `.pi/agents/phase0-echo.md`
- `.pi/agents/phase0-persona-metadata.md`
- `.pi/agents/phase0-writer.md`
- `.pi/agents/phase0-long-runner.md`
- `.pi/agents/phase0-supervisor-asker.md`
- `.pi/agents/_baseline.md`
- `docs/shared/phase0-shared.md`
- `docs/workstreams/phase0-brand/brief.md`
- `docs/workstreams/phase0-hidden/secret.md`
- `tmp/phase0/writer-output.txt`

The fixture markers were:

- `PHASE0_SHARED_DOC_MARKER_27JUN2026`
- `PHASE0_BRAND_DOC_MARKER_27JUN2026`
- `PHASE0_HIDDEN_DOC_MARKER_27JUN2026`
- `PHASE0_WRITER_OUTPUT_27JUN2026`
- `PHASE0_PARENT_CONTEXT_CANARY_27JUN2026`
- `PHASE0_SUMMARY_CANARY_27JUN2026`

## Proof Results

| ID | Question | Observed | Verdict |
|---|---|---|---|
| P0-01 | Can Pi see both required runtime packages? | `pi-subagents@0.31.0` and `pi-intercom@0.6.0` were installed and explicitly loadable. | PASS |
| P0-02 | Are project agents discovered from `.pi/agents/**/*.md`? | Doctor reported `agents: total 16 (builtin 8, package 0, user 3, project 5)`. Project agents listed: `phase0-echo`, `phase0-long-runner`, `phase0-persona-metadata`, `phase0-supervisor-asker`, `phase0-writer`. | PASS |
| P0-03 | Is `_baseline.md` ignored, rejected, or launchable? | No baseline agent was listed. Installed parser skips files without both `name` and `description`. | PASS |
| P0-04 | Are pi-persona metadata fields tolerated? | `phase0-persona-metadata` launched despite `role`, `docs`, `consults`, and `tags`; installed parser stores unknown frontmatter in `extraFields`. | PASS |
| P0-05 | Does fresh context omit parent-only conversation? | Fresh child answered `NONE` when asked for parent-only Phase 0 markers. | PASS |
| P0-06 | Does fork context carry parent conversation as reference? | Fork child quoted `PHASE0_PARENT_CONTEXT_CANARY_27JUN2026`. | PASS |
| P0-07 | Do declared reads/default reads reach children? | `phase0-echo` read `PHASE0_SHARED_DOC_MARKER_27JUN2026`; `phase0-persona-metadata` read `PHASE0_BRAND_DOC_MARKER_27JUN2026`. | PASS |
| P0-08 | Does tool allowlisting constrain child tools? | Read-only metadata agent reported no write/bash capability; shell confirmed `tmp/phase0/metadata-should-not-write.txt` was not created. | PASS |
| P0-09 | Does mutation-capable child write when Pi/filesystem allow it? | Writer agent created exact content `PHASE0_WRITER_OUTPUT_27JUN2026`; shell and hex checks verified exact bytes. | PASS |
| P0-10 | Can parallel subagents run and return grouped results? | Interactive Pi `/parallel` completed `2/2 done` in run `798d7848`, returning both `PHASE0_PARALLEL_ECHO_27JUN2026` and `PHASE0_PARALLEL_METADATA_27JUN2026`. Natural-language parallel also returned `PHASE0_MANUAL_PARALLEL_ECHO_OK` and `PHASE0_MANUAL_PARALLEL_METADATA_OK`. | PASS |
| P0-11 | Do status, interrupt, and resume controls work? | Status inspected stalled foreground run `47f129a5`; `resume` returned `Async run not found` for that foreground/single-mode run. Async resume was not separately proven. | ACCEPTED LIMITATION |
| P0-12 | Does `contact_supervisor` work from child sessions? | Interactive run `2dd44d08` showed child ask, parent `intercom({ action: "reply", ... })`, and child final result containing the reply text. | PASS |
| P0-13 | Is `contact_supervisor` absent from normal top-level sessions? | Installed docs/source say `contact_supervisor` registers only when `pi-subagents` supplies child bridge env metadata. Direct top-level runtime proof was not needed for Phase 1. | ACCEPTED LIMITATION |
| P0-14 | What is Pi's native summary behavior? | Pi exposes `/compact`, `/resume`, `/fork`, and `/tree`. `/compact` was unavailable for tiny Phase 0 seed content; `/tree` summarize preserved the canary, file path, and doc marker as exact text. | PASS with accepted limitation |
| P0-15 | Where are subagent artifacts/session files stored? | Headless no-session runs wrote under `/var/folders/.../T/pi-subagents-uid-501/artifacts`; saved-session interactive/fork/fresh runs wrote under `~/.pi/agent/sessions/.../subagent-artifacts`. | PASS |

## Key Transcript Evidence

Dependency proof:

```bash
rtk pi list
rtk pi --no-extensions --extension /Users/davidus-tranus/.pi/agent/npm/node_modules/pi-subagents/src/extension/index.ts --extension /Users/davidus-tranus/.pi/agent/npm/node_modules/pi-intercom/index.ts --no-session --approve --mode json -p "/subagents-doctor"
```

Default extension discovery failed on unrelated local extension pollution:

```text
Error: Failed to load extension "/Users/davidus-tranus/.pi/agent/extensions/palpatine.ts": Failed to load extension: Cannot find module '../lib/commands.js'
Hint: Start without extensions using "pi -ne".
```

Fresh/fork context proof:

```text
Fresh context child result:
NONE.

Fork context child result:
PHASE0_PARENT_CONTEXT_CANARY_27JUN2026
```

Tool/write proof:

```text
Read-only child:
Neither a write/file-creation tool nor a bash/shell tool is available.

Writer child:
Created tmp/phase0/writer-output.txt containing exactly PHASE0_WRITER_OUTPUT_27JUN2026 using printf via bash.
```

Interactive parallel proof:

```text
parallel - 2/2 done - 12k token - 8.6s
Run: 798d7848
Mode: parallel
Status: completed
Children: 2 completed
Summary: PHASE0_PARALLEL_ECHO_27JUN2026
Summary: PHASE0_PARALLEL_METADATA_27JUN2026
```

Headless JSON-mode parallel harness failed and is not authoritative for
interactive runtime health:

```text
0/2 succeeded
FAILED (exit code 1): Stream ended without finish_reason
```

Supervisor bridge proof:

```text
Subagent needs a supervisor decision.
Run: 2dd44d08
Agent: phase0-supervisor-asker
Child intercom target: subagent-phase0-supervisor-asker-2dd44d08-1
To reply: intercom({ action: "reply", message: "..." })
```

Parent reply:

```text
Proceed with the task as instructed. Report this exact supervisor reply text and stop.
```

Child result:

```text
Run: 2dd44d08
Mode: single
Status: completed
Children: 1 completed
Summary:
Proceed with the task as instructed. Report this exact supervisor reply text and stop.
```

Summary surface proof:

```text
Pi built-ins observed: /compact, /resume, /fork, /tree.
/tree is for time-traveling the conversation, not code rewind.
/compact exists but was not available for the tiny Phase 0 seed content.
```

Observed `/tree` summarize result:

```text
1. PHASE0_SUMMARY_CANARY_27JUN2026 - exact text
2. docs/workstreams/phase0-brand/brief.md - exact text
3. PHASE0_BRAND_DOC_MARKER_27JUN2026 - exact text
```

## Accepted Limitations

- Default Pi extension discovery was polluted by an unrelated local extension
  failure in `palpatine.ts`; explicit extension loading worked.
- Headless JSON-mode CLI is not a valid proof harness for interactive parallel
  fan-out in this setup.
- Foreground/single-mode run control differs from async run control; async
  resume should be proven separately only if the product depends on it.
- A forked child may call `intercom list` for self-orientation even when asked
  not to use tools. The call did not affect the context proof.
- `/compact` exists but was not available for tiny seed content; `/tree`
  summarize provided the practical summary evidence.

## Adapter Decisions

| Decision | Resolution |
|---|---|
| Project agent directory | Use `.pi/agents/**/*.md`; project scope is discovered by `pi-subagents`. |
| Baseline exclusion | Keep `_baseline.md` non-launchable by omitting `name` and `description`, or derive baseline material at the adapter layer instead of registering it as an agent. |
| User-facing metadata | `role`, `docs`, `consults`, and `tags` can live in frontmatter; `pi-subagents` tolerates them as extra fields. |
| Runtime fields | Keep runtime-specific fields out of the pi-persona user schema where possible; derive them in the resolver/adapter. |
| Default consult context | Use requester-written summary/fresh context by default. |
| Forked consult context | Map deliberate full-context consults to `context: "fork"`. |
| Docs/default reads | Let users declare `docs`; derive `defaultReads` or runtime read hints from that. |
| Tool scope | Declared tool allowlists constrain child tools; write-capable agents can write when Pi/filesystem permissions allow it. |
| Intercom bridge | Use `contact_supervisor` for child-to-parent decisions where a running child needs clarification. |
| Parallel round table | Interactive Pi parallel fan-out is viable. Do not use the failed headless JSON-mode CLI harness as the product proof path. |
| Summary baseline | Treat Pi `/compact`, `/resume`, `/fork`, and `/tree` as runtime/session facilities. Keep consult summaries inside the requester-authored consult envelope. |

## Next Step

Proceed to Phase 1 implementation design using this proof as the runtime
contract. The first implementation target should be the thin adapter/resolver
that maps pi-persona agent files onto `pi-subagents` calls without leaking
runtime-only fields into the user-facing schema.
