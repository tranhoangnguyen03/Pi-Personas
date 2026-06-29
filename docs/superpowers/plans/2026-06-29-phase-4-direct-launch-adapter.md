# Phase 4 Direct Launch Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Build the first verifiable direct-launch adapter slice for Pi Persona agents.

**Architecture:** Keep persona scope resolution separate from subagent execution. The resolver assembles baseline plus selected agent scope; the launch adapter converts that scope into the same `pi-subagents` single-run parameter shape used by `/run`, with explicit fresh context and derived docs injected at runtime. The Pi extension exposes read-only discovery and attempts direct persona command registration, while actual execution remains behind the `pi-subagents` slash bridge.

**Tech Stack:** Node ESM, `node:test`, Pi extension command API, `pi-subagents` slash bridge event contract.

---

## Scope

Phase 4A implements the local adapter and command wiring that can be unit-tested in this repo:

- Build a launch request for one selected agent.
- Default direct launches to `context: "fresh"`.
- Prefix the task with derived docs using the installed `pi-subagents` convention: `[Read from: ...]`.
- Include baseline prompt context without writing runtime-only fields into user agent files.
- Add `/persona-list` as a read-only discovery command.
- Register direct persona slash commands on `session_start` for the current project agents.

Phase 4A does not claim the full runtime proof until a Pi session manually verifies:

- Dynamic commands registered during `session_start` appear as expected.
- `pi-subagents` responds to the bridge request from this extension.
- The child session sees the derived docs and baseline context.

## Files

- Create: `src/persona/launch.js`
- Create: `src/persona/subagent-bridge.js`
- Modify: `src/persona/index.js`
- Modify: `extensions/pi-persona.ts`
- Modify: `test/persona-core.test.js`
- Create: `docs/superpowers/plans/2026-06-29-phase-4-direct-launch-adapter.md`

## Tasks

### Task 1: Launch Request Builder

- [x] **Step 1: Write failing tests**

Add tests that call `buildAgentLaunchRequest` from a resolved `brand` scope and assert:

- `subagentParams.agent` is `brand`.
- `subagentParams.context` is `fresh`.
- `subagentParams.clarify` is `false`.
- `subagentParams.agentScope` is `both`.
- `subagentParams.task` starts with `[Read from: docs/shared/, docs/workstreams/brand/]`.
- `subagentParams.task` includes baseline context and the user request.
- The launch request does not require `defaultReads` in the user-facing agent frontmatter.

- [x] **Step 2: Run tests and confirm red**

Run: `npm test`

Expected: failure because `buildAgentLaunchRequest` is not exported.

- [x] **Step 3: Implement `src/persona/launch.js`**

Implement a pure builder that accepts a resolved scope and optional `{ task, context }`, then returns:

```js
{
  agentName,
  context,
  docs,
  tools,
  consults,
  tags,
  subagentParams: {
    agent: agentName,
    task,
    clarify: false,
    agentScope: "both",
    context,
    model
  }
}
```

Omit `model` when the agent does not declare one.

- [x] **Step 4: Export the builder**

Add `buildAgentLaunchRequest` and `resolveAgentLaunchRequest` to `src/persona/index.js`.

- [x] **Step 5: Run tests and confirm green**

Run: `npm test`

Expected: all tests pass.

### Task 2: Discovery Formatter

- [x] **Step 1: Write failing tests**

Add a test for `formatPersonaList(project)` that asserts the output lists each launchable agent with role, description, docs, and consult peers, and does not imply launch behavior.

- [x] **Step 2: Run tests and confirm red**

Run: `npm test`

Expected: failure because `formatPersonaList` is not exported.

- [x] **Step 3: Implement formatter**

Implement `formatPersonaList(project)` in `src/persona/launch.js` or a small adjacent module.

- [x] **Step 4: Wire `/persona-list`**

Modify `extensions/pi-persona.ts` to register a static `persona-list` command that discovers the current project and displays the formatted list.

- [x] **Step 5: Run tests and confirm green**

Run: `npm test`

Expected: all tests pass.

### Task 3: Subagent Bridge Caller

- [x] **Step 1: Write failing tests**

Add unit tests for a pure bridge helper using a fake event bus:

- Success path emits `subagent:slash:request` with `params`.
- Missing bridge rejects with a clear error when no `subagent:slash:started` event fires.
- Response listener resolves only matching request IDs.

- [x] **Step 2: Run tests and confirm red**

Run: `npm test`

Expected: failure because the bridge helper does not exist.

- [x] **Step 3: Implement `src/persona/subagent-bridge.js`**

Use the installed `pi-subagents` slash bridge event names:

- `subagent:slash:request`
- `subagent:slash:started`
- `subagent:slash:response`
- `subagent:slash:update`
- `subagent:slash:cancel`

Keep this helper thin. It does not implement subagent execution; it only sends a request to the bridge and waits for the existing bridge to respond.

- [x] **Step 4: Run tests and confirm green**

Run: `npm test`

Expected: all tests pass.

### Task 4: Direct Command Registration

- [x] **Step 1: Add extension wiring**

Modify `extensions/pi-persona.ts` so `session_start` discovers launchable project agents and registers a slash command for each new agent name. The handler resolves that agent's launch request and calls the bridge helper.

- [x] **Step 2: Keep fallback explicit**

If the bridge does not respond, notify:

```text
pi-subagents slash bridge did not respond. Ensure pi-subagents is installed and loaded in this Pi session.
```

- [x] **Step 3: Avoid stale overclaims**

Do not mark Phase 4 runtime complete in docs. Add a short manual verification note in the final response instead.

- [x] **Step 4: Run tests**

Run: `npm test`

Expected: all tests pass.

### Task 5: Commit

- [x] **Step 1: Inspect diff**

Run: `git diff -- src/persona/launch.js src/persona/subagent-bridge.js src/persona/index.js extensions/pi-persona.ts test/persona-core.test.js docs/superpowers/plans/2026-06-29-phase-4-direct-launch-adapter.md`

- [x] **Step 2: Stage exact files**

Run: `git add src/persona/launch.js src/persona/subagent-bridge.js src/persona/index.js extensions/pi-persona.ts test/persona-core.test.js docs/superpowers/plans/2026-06-29-phase-4-direct-launch-adapter.md`

- [x] **Step 3: Commit**

Run: `git commit -m "feat: add persona direct launch adapter"`

## Self-Review

- Spec coverage: This plan covers Phase 4A adapter behavior and leaves full Pi runtime proof as manual verification.
- Placeholder scan: No placeholder markers remain.
- Type consistency: `buildAgentLaunchRequest`, `resolveAgentLaunchRequest`, `formatPersonaList`, and `runSubagentBridgeRequest` are the stable names used across tests and implementation.

## Runtime Verification

Status: pass, with one follow-up polish fix applied.

Manual Pi session verification on 2026-06-29 showed:

- `/persona doctor` executed from the Pi Persona extension and reported installed dependencies:
  - `pi-subagents: 0.31.0`
  - `pi-intercom: 0.6.0`
- `/persona-list` executed and initially returned `- none`.
- `/persona new phase4-proof` created `.pi/agents/phase4-proof.md`.
- `/persona-list` then discovered `phase4-proof - specialist`.
- Direct slash launch of `/phase4-proof` reached `pi-subagents` and completed run `9d5f8645`.
- The child returned exact marker `PHASE4_DIRECT_LAUNCH_AFTER_INSTALL_OK`.

The remaining doctor error after that proof is expected until the project has
exactly one `role: generalist` agent:

```text
ERROR: exactly one generalist required; found 0
```

The session also exposed a command-output polish bug: Persona command messages
rendered as `[undefined]` because they were sent without a Pi `customType`.
That was fixed by tagging Persona visible messages with `customType:
"pi-persona"`.
