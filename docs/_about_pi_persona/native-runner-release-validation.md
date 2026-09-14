# Pi 0.85.1 Native Runner Release Validation

Date: 2026-09-13  
Status: implementation round validated; not published

## Scope And Environment

Validation used Pi 0.85.1 with Node 24.14.1 in a disposable project. The
working tree's `pi-personas` 0.2.1 package was created with `npm pack`, installed
from that tarball, and loaded from the installed package directory. Global Pi
settings and global packages were not changed.

Authentication and model catalog files were copied into a disposable Pi config
directory. Only provider names, credential types, model metadata, and readiness
were inspected; no credential values were printed. Cerebras authentication
reported `ready`. Provider-backed runs used the configured, affordable
`cerebras/qwen-3.8-27b` model, with `cerebras/gpt-oss-120b` used for the fork and
cancellation checks when stronger tool-call compliance was needed. Thinking was
disabled.

The legacy checks used an isolated install of `pi-subagents` 0.67.0. Native was
selected only through the disposable project's `.pi/persona.json`; removing
that file restored the `legacy` backend. These live runs preceded the automatic
backend-selection change: the release now chooses legacy when `pi-subagents`
is installed and native otherwise, unless explicitly overridden. The installed
legacy fixture therefore retains the same selection under the new policy.
The automatic-selection change was subsequently verified with 140 unit tests
and one RPC smoke test; the live provider matrix was not repeated for that change.

## Executed Scenarios

| Scenario | Actual outcome |
| --- | --- |
| Packed native fresh consult | Passed. One `persona_consult` call launched a native child from the packed install. The child used `read` and returned the exact fixture line `PACKED_NATIVE_FIXTURE_EVIDENCE`. Details reported backend `native`, context `fresh`, and model `cerebras/qwen-3.8-27b`; nested usage was present. |
| Packed native fork consult | Passed with `gpt-oss-120b`. One `persona_consult` call used context `fork`. Its tool arguments did not contain `FORK_BRANCH_7Q9M`, while the child returned that marker from the active branch. The successful child session and the focused snapshot test cover removal of the in-flight tool call. |
| Packed native round-table | Passed. The primary generalist made exactly one `persona_roundtable` call, selected `operator` and `reviewer`, and completed Round 1, Round 2, and moderator synthesis. Process details reported 5/5 steps, zero failed steps, and nested usage. Two recoverable child read errors were reported during model-led probing; synthesis still completed normally. |
| Native cancellation during execution | Passed. RPC abort was sent 750 ms after `persona_consult` tool execution began. The active call ended with `Native Pi Persona child was cancelled.`, an error stop reason, no extension error, and no stderr. |
| Native model preflight failure | Passed. A disposable persona model `unavailable/no-such-model` was rejected before launch with `found 0`; no fallback backend ran. |
| Default legacy consult, `pi-subagents` 0.67.0 | Initially failed, then passed after the release-blocker fix. Final run returned `LEGACY_OK` as a foreground final child result, not an async receipt. Backend details remained `legacy`. |
| Default legacy round-table, `pi-subagents` 0.67.0 | Passed after the fix. One `persona_roundtable` call completed the two specialist rounds and synthesis through a foreground `workflowScript`; process details reported 5/5 steps and no failures. No receipt-triggered extra assistant turn appeared. |

## Release-Blocker Fixed

Current `pi-subagents` rejects the old public `clarify` field, defaults direct
children to asynchronous execution, and no longer accepts public top-level
`chain` orchestration. This caused a legacy consult to fail first with
`Public workflowScript execution does not support clarify UI`; after removing
that field, it returned a detached-run receipt instead of the consultant answer.

The correction is limited to the shared legacy request boundary:

- consult requests omit `clarify` and set `async: false`;
- round-tables retain the existing chain payload for `pi-subagents`
  0.34.0-0.40.x and use an equivalent foreground `workflowScript` for 0.41.0+;
- one focused regression test checks both payload generations.

## Commands Run

Paths below use placeholders for the disposable directory and packed artifact;
no credential-bearing path contents or values are included.

```sh
pi --version
PI_CODING_AGENT_DIR=<temp-config> pi --list-models
PI_CODING_AGENT_DIR=<temp-config> pi auth check --provider cerebras --no-refresh
npm pack --json --pack-destination <temp-dir>
npm install --ignore-scripts --no-audit --no-fund <temp-dir>/pi-personas-0.2.1.tgz
PI_CODING_AGENT_DIR=<temp-config> node live-rpc.mjs fresh
PI_CODING_AGENT_DIR=<temp-config> LIVE_MODEL=gpt-oss-120b node live-rpc.mjs fork
PI_CODING_AGENT_DIR=<temp-config> node live-rpc.mjs roundtable
PI_CODING_AGENT_DIR=<temp-config> LIVE_MODEL=gpt-oss-120b node live-rpc.mjs cancel
PI_CODING_AGENT_DIR=<temp-config> LIVE_MODEL=gpt-oss-120b node live-rpc.mjs preflight
PI_CODING_AGENT_DIR=<temp-config> node live-rpc.mjs legacy
PI_CODING_AGENT_DIR=<temp-config> node live-rpc.mjs legacy-roundtable
npm test
npm audit --omit=dev
npm pack --dry-run
git diff --check
```

## Automated Gate Results

- `npm test`: passed; 135 unit tests and one real offline Pi RPC smoke test.
- `npm audit --omit=dev`: passed; zero vulnerabilities.
- `npm pack --dry-run --json`: passed; 30 files, 64,173-byte tarball,
  SHA-1 `73546b39b89a56de96ebcd93193ef441de2e5738`.
- `git diff --check`: passed with no whitespace errors.

## Limitations And Remaining Gates

- The live legacy run covered `pi-subagents` 0.67.0. The 0.34.0 package and
  compatibility contract were inspected locally, and the 0.34 chain payload is
  regression-tested, but 0.34.0 was not exercised against a live provider.
- One exploratory fork attempt with `qwen-3.8-27b` answered the remembered
  marker directly instead of calling the requested tool. It did not exercise
  Pi Persona and was repeated successfully with `gpt-oss-120b`.
- Native children remain capability-limited rather than OS-sandboxed, as the
  product documentation states.
- The release checklist's clean-checkout setup was not run because this round
  explicitly preserved the approved dirty worktree. Final validation ran
  against the packed contents of that worktree.
- Publishing, versioning, committing, tagging, and pushing remain explicit
  maintainer gates and were not performed.
