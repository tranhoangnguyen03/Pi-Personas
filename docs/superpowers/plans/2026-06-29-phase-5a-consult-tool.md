# Phase 5A Consult Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first usable one-hop Pi Persona consult mechanism.

**Architecture:** Keep pi-persona as the semantic layer. A new pure consult module resolves requester and consultant scopes, enforces `consults`, builds the structured consult envelope, and formats provenance. Runtime execution uses pi-subagents' child-safe `subagent` fanout tool; `persona_consult` prepares and validates a consult payload instead of calling the parent slash bridge.

**Tech Stack:** Node ESM, `node:test`, TypeScript Pi extension, `typebox`, pi-subagents slash bridge for direct launch, pi-subagents child fanout for consults, Pi `registerTool`.

---

## Scope

This plan implements:

- A summarized/fresh consult envelope by default.
- A deliberate `context: "fork"` option in the tool payload.
- Requester-side consult permission enforcement.
- Consultant scope resolution from the consultant agent plus `_baseline.md`.
- A compact `Consulted:` provenance formatter.
- A registered `persona_consult` Pi tool.
- Direct-launch prompt guidance that tells persona agents how to consult allowed peers.

This plan does not implement:

- Round-table orchestration.
- Full generalist routing heuristics.
- Hard runtime detection for nested consult depth. Phase 5A blocks nested consults through normal `consults` permission and prompt instructions; a future runtime marker can hard-block nested calls after live Pi behavior is verified.

## Runtime Findings To Preserve

- Pi packages expose tools with `pi.registerTool`; `pi-intercom` and other installed packages use this API.
- pi-subagents exposes a slash bridge over `subagent:slash:request` for parent-session direct launches and accepts `{ agent, task, context, agentScope, clarify }`.
- pi-subagents disables that parent slash bridge inside child sessions. Nested consult execution must use the child-safe `subagent` fanout tool.
- pi-subagents enables child-safe fanout only when the requester agent's `tools` frontmatter includes `subagent`; `/persona doctor` now treats a consult-capable agent without `subagent` as an error.

## Files

- Create: `src/persona/consult.js`
- Modify: `src/persona/index.js`
- Modify: `src/persona/launch.js`
- Modify: `src/persona/doctor.js`
- Modify: `extensions/pi-persona.ts`
- Modify: `test/persona-core.test.js`
- Modify: `package.json`
- Modify: `package-lock.json`

## Task 1: Pure Consult Envelope And Permission Checks

**Files:**
- Create: `src/persona/consult.js`
- Modify: `src/persona/index.js`
- Test: `test/persona-core.test.js`

- [ ] **Step 1: Write failing tests**

Add imports in `test/persona-core.test.js`:

```js
import {
  buildConsultEnvelope,
  formatConsultProvenance,
  resolveConsultLaunchRequest,
} from "../src/persona/index.js";
```

Add these tests near the launch-request tests:

```js
test("resolveConsultLaunchRequest builds summarized fresh consultant scope by default", async () => {
  const root = await createWorkspace();

  const consult = await resolveConsultLaunchRequest(root, {
    requester: "brand",
    consultant: "guideline",
    question: "Does this launch copy follow the guideline?",
    summary: "The requester is revising launch copy for a brand workstream.",
    constraints: "Use only guideline docs.",
    expectedOutput: "Return concise approval notes.",
  });

  assert.equal(consult.requester.name, "brand");
  assert.equal(consult.consultant.name, "guideline");
  assert.equal(consult.context, "fresh");
  assert.deepEqual(consult.docs, ["docs/shared/", "docs/workstreams/guideline/"]);
  assert.deepEqual(consult.tools, ["read"]);
  assert.deepEqual(consult.consults, []);
  assert.equal(consult.subagentParams.agent, "guideline");
  assert.equal(consult.subagentParams.context, "fresh");
  assert.match(consult.subagentParams.task, /consultant: guideline/);
  assert.match(consult.subagentParams.task, /summary: The requester is revising launch copy/);
  assert.doesNotMatch(consult.subagentParams.task, /Brand prompt/);
});

test("resolveConsultLaunchRequest rejects peers not allowed by requester consults", async () => {
  const root = await createWorkspace();

  await assert.rejects(
    () => resolveConsultLaunchRequest(root, {
      requester: "guideline",
      consultant: "brand",
      question: "Can I ask brand?",
      summary: "Guideline wants an unlisted peer.",
    }),
    /guideline cannot consult brand/,
  );
});

test("resolveConsultLaunchRequest honors deliberate fork context", async () => {
  const root = await createWorkspace();

  const consult = await resolveConsultLaunchRequest(root, {
    requester: "brand",
    consultant: "guideline",
    question: "Review with full thread context.",
    summary: "The requester says the full thread contains necessary nuance.",
    context: "fork",
  });

  assert.equal(consult.context, "fork");
  assert.equal(consult.subagentParams.context, "fork");
  assert.match(consult.subagentParams.task, /context: fork/);
});

test("formatConsultProvenance reports successful and failed consults compactly", () => {
  const text = formatConsultProvenance([
    { consultant: "guideline", status: "answered", summary: "Guideline approved with one caveat." },
    { consultant: "pricing", status: "failed", summary: "doc path missing" },
  ]);

  assert.match(text, /Consulted:/);
  assert.match(text, /- guideline \\(answered\\): Guideline approved with one caveat\\./);
  assert.match(text, /- pricing \\(failed\\): doc path missing/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
rtk npm test
```

Expected: FAIL because `buildConsultEnvelope`, `formatConsultProvenance`, and `resolveConsultLaunchRequest` are not exported.

- [ ] **Step 3: Implement consult module**

Create `src/persona/consult.js`:

```js
import { discoverPersonaProject } from "./agents.js";
import { resolveAgentScope } from "./resolver.js";

export function buildConsultEnvelope(input) {
  const requester = requireText(input.requester, "requester");
  const consultant = requireText(input.consultant, "consultant");
  const question = requireText(input.question, "question");
  const summary = requireText(input.summary, "summary");
  const context = input.context === "fork" ? "fork" : "fresh";

  return {
    consult: {
      requester,
      consultant,
      question,
      summary,
      context,
      constraints: optionalText(input.constraints),
      expectedOutput: optionalText(input.expectedOutput),
    },
  };
}

export async function resolveConsultLaunchRequest(root, input) {
  const project = await discoverPersonaProject(root);
  const requester = findAgent(project, input.requester, "requester");
  const consultant = findAgent(project, input.consultant, "consultant");
  assertCanConsult(requester, consultant);

  const consultantScope = await resolveAgentScope(root, consultant.name);
  const envelope = buildConsultEnvelope({
    ...input,
    requester: requester.name,
    consultant: consultant.name,
  });
  const task = buildConsultTask(consultantScope, envelope);

  return {
    requester,
    consultant,
    context: envelope.consult.context,
    envelope,
    docs: consultantScope.docs,
    tools: consultantScope.tools,
    consults: consultantScope.consults,
    tags: consultantScope.tags,
    subagentParams: {
      agent: consultant.name,
      task,
      clarify: false,
      agentScope: "both",
      context: envelope.consult.context,
      ...(consultantScope.agent.model ? { model: consultantScope.agent.model } : {}),
    },
  };
}

export function formatConsultProvenance(results) {
  const lines = ["Consulted:"];
  for (const result of results) {
    lines.push(`- ${result.consultant} (${result.status}): ${result.summary || "(no summary)"}`);
  }
  return lines.join("\n");
}

function buildConsultTask(scope, envelope) {
  const { consult } = envelope;
  const sections = [];
  if (scope.docs.length > 0) {
    sections.push(`[Read from: ${scope.docs.join(", ")}]`);
  }
  sections.push([
    "## Pi Persona Consult",
    "",
    `requester: ${consult.requester}`,
    `consultant: ${consult.consultant}`,
    `context: ${consult.context}`,
    `summary: ${consult.summary}`,
    `question: ${consult.question}`,
    `constraints: ${consult.constraints || "none"}`,
    `expectedOutput: ${consult.expectedOutput || "focused answer for the requester"}`,
    "",
    "Do not call persona_consult from this consult response. Answer the requester directly from your own scope.",
  ].join("\n"));
  return sections.join("\n\n");
}

function assertCanConsult(requester, consultant) {
  if (requester.consults.includes("all")) return;
  if (requester.consults.includes(consultant.name)) return;
  throw new Error(`${requester.name} cannot consult ${consultant.name}`);
}

function findAgent(project, name, label) {
  const agentName = requireText(name, label);
  const agent = project.agents.find((candidate) => candidate.name === agentName);
  if (!agent) throw new Error(`Unknown ${label}: ${agentName}`);
  return agent;
}

function requireText(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`consult ${field} is required`);
  }
  return value.trim();
}

function optionalText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
```

Modify `src/persona/index.js`:

```js
export {
  buildConsultEnvelope,
  formatConsultProvenance,
  resolveConsultLaunchRequest,
} from "./consult.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
rtk npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/persona/consult.js src/persona/index.js test/persona-core.test.js
rtk git commit -m "feat: add persona consult envelope"
```

## Task 2: Register `persona_consult` Tool

**Files:**
- Modify: `extensions/pi-persona.ts`
- Modify: `src/persona/doctor.js`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write failing static coverage**

Add this test to `test/persona-core.test.js`:

```js
test("doctor recognizes persona_consult as a Pi Persona runtime tool", async () => {
  const root = await createWorkspace();

  await writeText(path.join(root, ".pi/agents/brand.md"), `---
name: brand
role: specialist
description: Brand strategy specialist.
tools: read, persona_consult
docs: docs/workstreams/brand/
consults: guideline
tags: brand, voice
---
Brand prompt.
`);

  const result = await runDoctor(root, {
    dependencyStatus: {
      piSubagents: { ok: true, version: "0.31.0", path: "/tmp/pi-subagents" },
      piIntercom: { ok: true, version: "0.6.0", path: "/tmp/pi-intercom" },
    },
  });

  assert.equal(result.issues.some((issue) => issue.message.includes("persona_consult")), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
rtk npm test
```

Expected: FAIL because `persona_consult` is not in the doctor tool allowlist.

- [ ] **Step 3: Add dependency metadata**

Run:

```bash
rtk npm install --package-lock-only --legacy-peer-deps --ignore-scripts typebox
```

Expected: `package.json` and `package-lock.json` include `typebox`.

- [ ] **Step 4: Register the tool**

Modify `extensions/pi-persona.ts`:

```ts
import { Type } from "typebox";
import {
  formatConsultProvenance,
  resolveConsultLaunchRequest,
} from "../src/persona/index.js";
```

Inside `registerPiPersona`, before command registration:

```ts
  pi.registerTool({
    name: "persona_consult",
    label: "Persona Consult",
    description: "Consult an allowed Pi Persona peer. The requester must be the active persona agent, the consultant must be listed in its consults field or allowed by consults: all, and summarized fresh context is the default.",
    promptSnippet: "Use persona_consult only when your Pi Persona scope lists an allowed consult peer and the question genuinely needs that peer. Provide your own concise summary of relevant context.",
    parameters: Type.Object({
      requester: Type.String({ description: "Active Pi Persona requester agent name" }),
      consultant: Type.String({ description: "Allowed Pi Persona consultant agent name" }),
      question: Type.String({ description: "Specific question for the consultant" }),
      summary: Type.String({ description: "Requester-authored concise context summary" }),
      constraints: Type.Optional(Type.String({ description: "Constraints the consultant must follow" })),
      expectedOutput: Type.Optional(Type.String({ description: "Requested answer shape" })),
      context: Type.Optional(Type.String({
        enum: ["fresh", "fork"],
        description: "fresh by default; fork only when full conversation context is deliberately required",
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const consult = await resolveConsultLaunchRequest(ctx.cwd, params);
      const response = await runSubagentBridgeRequest(pi, ctx, consult.subagentParams);
      const text = bridgeResponseText(response);
      return {
        content: [{ type: "text", text }],
        details: {
          requester: consult.requester.name,
          consultant: consult.consultant.name,
          context: consult.context,
          provenance: formatConsultProvenance([{
            consultant: consult.consultant.name,
            status: response.isError ? "failed" : "answered",
            summary: response.isError ? response.errorText || text : firstLine(text),
          }]),
        },
      };
    },
  });
```

Add a helper near `bridgeResponseText`:

```ts
function firstLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find(Boolean) || "(no output)";
}
```

Modify `src/persona/doctor.js`:

```js
  "persona_consult",
```

- [ ] **Step 5: Run tests to verify they pass**

Run:

```bash
rtk npm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add extensions/pi-persona.ts src/persona/doctor.js package.json package-lock.json test/persona-core.test.js
rtk git commit -m "feat: register persona consult tool"
```

## Task 3: Teach Direct-Launch Agents When To Consult

**Files:**
- Modify: `src/persona/launch.js`
- Test: `test/persona-core.test.js`

- [ ] **Step 1: Write failing launch prompt tests**

Add this assertion to the existing `buildAgentLaunchRequest creates a fresh pi-subagents single-run request` test:

```js
  assert.match(launch.subagentParams.task, /Tool: persona_consult/);
  assert.match(launch.subagentParams.task, /requester: brand/);
  assert.match(launch.subagentParams.task, /Default consult context: fresh/);
```

Add this separate test:

```js
test("buildAgentLaunchRequest omits consult tool guidance when no consult peers exist", async () => {
  const root = await createWorkspace();
  const scope = await resolveAgentScope(root, "guideline");

  const request = buildAgentLaunchRequest(scope, { task: "Answer directly." });

  assert.doesNotMatch(request.subagentParams.task, /Tool: persona_consult/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
rtk npm test
```

Expected: FAIL because the launch prompt has no consult tool guidance.

- [ ] **Step 3: Add consult guidance to launch task**

Modify `buildLaunchTask` in `src/persona/launch.js` after the Pi Persona Scope section:

```js
  if (scope.consults.length > 0) {
    sections.push([
      "## Consult Tool",
      "",
      "Tool: persona_consult",
      `requester: ${scope.agent.name}`,
      `Allowed consultants: ${scope.consults.join(", ")}`,
      "Default consult context: fresh",
      "Use context: fork only when the request genuinely requires full conversation context.",
      "You, the requesting agent, must write the consult summary.",
      "After the consult, synthesize the answer and include the compact provenance returned by the tool when useful.",
    ].join("\n"));
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
rtk npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/persona/launch.js test/persona-core.test.js
rtk git commit -m "feat: guide persona consult usage"
```

## Task 4: Runtime Verification Instructions

**Files:**
- Modify: `docs/superpowers/plans/2026-06-29-phase-5a-consult-tool.md`

- [ ] **Step 1: Run local verification**

Run:

```bash
rtk npm test
rtk npm audit --omit=dev --legacy-peer-deps
rtk git diff --check HEAD
```

Expected: tests pass, audit reports 0 vulnerabilities, diff check is clean.

- [ ] **Step 2: Manual Pi session verification**

In a fresh Pi session after reinstalling or reloading the local package:

```text
/persona doctor
/persona-list
/persona new phase5-generalist
/persona new phase5-requester
/persona new phase5-consultant
```

Edit `.pi/agents/phase5-generalist.md`:

```md
role: generalist
tools: subagent
consults: all
```

Edit `.pi/agents/phase5-requester.md`:

```md
tools: subagent
consults: phase5-consultant
```

Leave `tools:` blank on `phase5-consultant` unless deliberately narrowing its
tools. Then start a new Pi session and run:

```text
/phase5-requester Ask phase5-consultant whether the phrase "PHASE5_CONSULT_CANARY_29JUN2026" should be preserved exactly. The requester must consult the peer and summarize the result.
```

Pass criteria:

- `/persona doctor` is handled by Pi Persona, not by the generic `subagent` doctor.
- `/persona doctor` passes once `phase5-generalist`, `phase5-requester`, and `phase5-consultant` are configured.
- `/persona-list` is handled by Pi Persona and lists all three phase5 agents.
- `/phase5-requester` launches through pi-subagents.
- The requester calls the child-safe `subagent` tool for `phase5-consultant`.
- The consultant receives a summarized/fresh envelope by default.
- The response preserves `PHASE5_CONSULT_CANARY_29JUN2026`.
- The final answer includes a compact `Consulted:` provenance line.

- [ ] **Step 3: Commit the plan completion note if updated during execution**

```bash
rtk git add docs/superpowers/plans/2026-06-29-phase-5a-consult-tool.md
rtk git commit -m "docs: record phase 5a consult verification"
```

## Self-Review

- Spec coverage: Covers Phase 5 consult envelope, default summarized/fresh behavior, fork opt-in, permission checks, consultant scoping, provenance, and Pi tool registration.
- Known gap: Hard nested-consult runtime blocking is explicitly outside this 5A slice because it needs live Pi session metadata or a reliable consult-depth marker.
- Type consistency: Public function names are `buildConsultEnvelope`, `resolveConsultLaunchRequest`, and `formatConsultProvenance`; tool name is `persona_consult`.

## Implementation Status

Status: local option-2 implementation complete; live Pi consult proof needs a fresh manual Pi session with a requester agent that lists `subagent` in `tools`.

Completed on 2026-06-29:

- Added pure consult envelope and permission checks.
- Registered `persona_consult` as a Pi tool that prepares and validates the consult payload for the child-safe `subagent` tool.
- Added direct-launch prompt guidance for agents with configured consult peers to call `subagent` with a Pi Persona consult envelope.
- Added doctor validation requiring `subagent` in `tools` for agents with configured consult peers.
- Added `typebox` dependency to match the installed Pi extension runtime pattern.
- Corrected the manual verification setup to include one `phase5-generalist`.

Local verification:

```bash
rtk npm test
rtk npm audit --omit=dev --legacy-peer-deps
rtk git diff --check HEAD
```

Results:

- `rtk npm test`: 32/32 passing.
- `rtk npm audit --omit=dev --legacy-peer-deps`: 0 vulnerabilities.
- `rtk git diff --check HEAD`: clean.

Pi command smoke checks:

- `/persona-list` executes through Pi Persona and emits `customType: "pi-persona"`.
- `/persona doctor` executes through Pi Persona and currently reports the expected local fixture issue: one specialist exists and no generalist exists.
