import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAgentLaunchRequest,
  discoverPersonaProject,
  createAgentScaffold,
  formatPersonaList,
  formatDoctorReport,
  parseFrontmatterDocument,
  normalizeAgentName,
  resolveAgentScope,
  resolveAgentPreview,
  runSubagentBridgeRequest,
  runDoctor,
  sendPersonaOutput,
} from "../src/persona/index.js";

async function writeText(filePath, text) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text, "utf8");
}

async function createWorkspace() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-test-"));

  await writeText(path.join(root, ".pi/agents/_baseline.md"), `---
docs: docs/shared/
tools: read
---
Shared operating context.
`);

  await writeText(path.join(root, ".pi/agents/generalist.md"), `---
name: generalist
role: generalist
description: Routes to specialists.
tools: read, subagent
docs: docs/shared/
consults: all
tags: general, routing
---
Generalist prompt.
`);

  await writeText(path.join(root, ".pi/agents/brand.md"), `---
name: brand
role: specialist
description: Brand strategy specialist.
tools: read
docs: docs/workstreams/brand/
consults: guideline
tags: brand, voice
---
Brand prompt.
`);

  await writeText(path.join(root, ".pi/agents/guideline.md"), `---
name: guideline
role: specialist
description: Guideline reviewer.
tools: read
docs: docs/workstreams/guideline/
consults:
tags: guideline
---
Guideline prompt.
`);

  await writeText(path.join(root, "docs/shared/company.md"), "Shared doc\n");
  await writeText(path.join(root, "docs/workstreams/brand/brief.md"), "Brand doc\n");
  await writeText(path.join(root, "docs/workstreams/guideline/rules.md"), "Guideline doc\n");

  return root;
}

function createEventBus(onRequest) {
  const handlers = new Map();
  const emitted = [];

  return {
    emitted,
    on(event, handler) {
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler);
      handlers.set(event, eventHandlers);
      return () => {
        const next = (handlers.get(event) ?? []).filter((candidate) => candidate !== handler);
        handlers.set(event, next);
      };
    },
    emit(event, data) {
      emitted.push({ event, data });
      if (event === "subagent:slash:request" && onRequest) {
        onRequest(data, this);
      }
      for (const handler of handlers.get(event) ?? []) {
        handler(data);
      }
    },
  };
}

test("package manifest exposes Pi Persona as a Pi extension package", async () => {
  const manifest = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8"));

  assert.ok(manifest.keywords.includes("pi-package"));
  assert.deepEqual(manifest.pi.extensions, ["./extensions/pi-persona.ts"]);
});

test("extension uses the persona command namespace instead of generic agent", async () => {
  const source = await readFile(path.join(process.cwd(), "extensions/pi-persona.ts"), "utf8");

  assert.match(source, /registerCommand\("persona"/);
  assert.doesNotMatch(source, /registerCommand\("agent"/);
  assert.match(source, /\/persona doctor/);
  assert.doesNotMatch(source, /\/agent doctor/);
});

test("sendPersonaOutput writes visible command output when Pi sendMessage is available", () => {
  const messages = [];
  const notifications = [];

  sendPersonaOutput(
    {
      sendMessage(message) {
        messages.push(message);
      },
    },
    {
      ui: {
        notify(message, level) {
          notifications.push({ message, level });
        },
      },
    },
    "Doctor report",
    "info",
  );

  assert.deepEqual(messages, [{ customType: "pi-persona", content: "Doctor report", display: true }]);
  assert.deepEqual(notifications, []);
});

test("discovers launchable project agents and keeps baseline as control file", async () => {
  const root = await createWorkspace();

  const project = await discoverPersonaProject(root);

  assert.deepEqual(project.agents.map((agent) => agent.name).sort(), [
    "brand",
    "generalist",
    "guideline",
  ]);
  assert.equal(project.baseline.fileName, "_baseline.md");
  assert.equal(project.controlFiles.length, 1);
  assert.equal(project.agents.find((agent) => agent.name === "brand").role, "specialist");
});

test("doctor validates dependencies, docs, duplicate names, generalist count, consults, and tools", async () => {
  const root = await createWorkspace();

  await writeText(path.join(root, ".pi/agents/duplicate.md"), `---
name: brand
role: specialist
description: Duplicate brand name.
tools: fake_tool
docs: docs/missing/
consults: missing-peer
---
Duplicate prompt.
`);

  await writeText(path.join(root, ".pi/agents/another-generalist.md"), `---
name: second-generalist
role: generalist
description: Extra generalist.
tools: read
docs: docs/shared/
consults: all
---
Second generalist prompt.
`);

  await writeText(path.join(root, ".pi/agents/_bad-control.md"), `---
name: bad-control
description: This control file is accidentally launchable.
tools: read
---
Bad control prompt.
`);

  const result = await runDoctor(root, {
    dependencyStatus: {
      piSubagents: { ok: true, version: "0.31.0", path: "/tmp/pi-subagents" },
      piIntercom: { ok: true, version: "0.6.0", path: "/tmp/pi-intercom" },
    },
  });

  const messages = result.issues.map((issue) => issue.message);
  assert.equal(result.status, "error");
  assert.ok(messages.some((message) => message.includes("duplicate agent name 'brand'")));
  assert.ok(messages.some((message) => message.includes("multiple generalist agents")));
  assert.ok(messages.some((message) => message.includes("docs path does not exist: docs/missing/")));
  assert.ok(messages.some((message) => message.includes("consults unknown agent 'missing-peer'")));
  assert.ok(messages.some((message) => message.includes("unknown tool 'fake_tool'")));
  assert.ok(messages.some((message) => message.includes("control file is launchable")));
});

test("resolver preview merges baseline and agent scope while deriving runtime fields", async () => {
  const root = await createWorkspace();

  const preview = await resolveAgentPreview(root, "brand");

  assert.deepEqual(preview.docs, [
    "docs/shared/",
    "docs/workstreams/brand/",
  ]);
  assert.deepEqual(preview.tools, [
    "read",
  ]);
  assert.deepEqual(preview.consults, [
    "guideline",
  ]);
  assert.deepEqual(preview.derived.defaultReads, [
    "docs/shared/",
    "docs/workstreams/brand/",
  ]);
  assert.equal(Object.hasOwn(preview.agent.frontmatter, "defaultReads"), false);
  assert.equal(Object.hasOwn(preview.agent.frontmatter, "systemPromptMode"), false);
});

test("formats doctor report with actionable sections", async () => {
  const root = await createWorkspace();
  const result = await runDoctor(root, {
    dependencyStatus: {
      piSubagents: { ok: true, version: "0.31.0", path: "/tmp/pi-subagents" },
      piIntercom: { ok: true, version: "0.6.0", path: "/tmp/pi-intercom" },
    },
  });

  const report = formatDoctorReport(result);

  assert.match(report, /Pi Persona Doctor/);
  assert.match(report, /Dependencies/);
  assert.match(report, /Agents: 3 launchable/);
  assert.match(report, /Generalist: generalist/);
  assert.match(report, /Status: pass/);
});

test("doctor reports schema errors without relying on pi-subagents failure", async () => {
  const root = await createWorkspace();

  await writeText(path.join(root, ".pi/agents/missing-description.md"), `---
name: missing-description
role: specialist
tools: read
docs: docs/shared/
---
Missing description prompt.
`);

  await writeText(path.join(root, ".pi/agents/unknown-role.md"), `---
name: unknown-role
role: executive
description: Invalid role.
tools: read
docs: docs/shared/
---
Unknown role prompt.
`);

  await writeText(path.join(root, ".pi/agents/specialist-all.md"), `---
name: specialist-all
role: specialist
description: Specialist with invalid all consult.
tools: read
docs: docs/shared/
consults: all
---
Specialist all prompt.
`);

  await writeText(path.join(root, ".pi/agents/runtime-leak.md"), `---
name: runtime-leak
role: specialist
description: Agent with runtime-only fields.
tools: read
docs: docs/shared/
defaultReads: docs/shared/
systemPromptMode: replace
inheritSkills: false
---
Runtime leak prompt.
`);

  const result = await runDoctor(root, {
    dependencyStatus: {
      piSubagents: { ok: true, version: "0.31.0", path: "/tmp/pi-subagents" },
      piIntercom: { ok: true, version: "0.6.0", path: "/tmp/pi-intercom" },
    },
  });

  const messages = result.issues.map((issue) => issue.message);
  assert.equal(result.status, "error");
  assert.ok(messages.some((message) => message.includes("missing required field 'description'")));
  assert.ok(messages.some((message) => message.includes("unknown role 'executive'")));
  assert.ok(messages.some((message) => message.includes("specialist cannot use consults: all")));
  assert.ok(messages.some((message) => message.includes("runtime-only field 'defaultReads'")));
  assert.ok(messages.some((message) => message.includes("runtime-only field 'systemPromptMode'")));
  assert.ok(messages.some((message) => message.includes("runtime-only field 'inheritSkills'")));
});

test("doctor requires exactly one generalist", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-no-generalist-"));

  await writeText(path.join(root, ".pi/agents/brand.md"), `---
name: brand
role: specialist
description: Brand strategy specialist.
tools: read
docs: docs/brand/
---
Brand prompt.
`);

  await writeText(path.join(root, "docs/brand/brief.md"), "Brand doc\n");

  const result = await runDoctor(root, {
    dependencyStatus: {
      piSubagents: { ok: true, version: "0.31.0", path: "/tmp/pi-subagents" },
      piIntercom: { ok: true, version: "0.6.0", path: "/tmp/pi-intercom" },
    },
  });

  assert.equal(result.status, "error");
  assert.ok(result.issues.some((issue) => issue.message.includes("exactly one generalist required")));
});

test("runtime role files are launchable but excluded from generalist requirements", async () => {
  const root = await createWorkspace();

  await writeText(path.join(root, ".pi/agents/runtime/worker.md"), `---
name: worker
package: runtime
origin: pi-subagents builtin worker
role: runtime
description: Runtime worker.
tools: read
docs: docs/shared/
---
Worker prompt.
`);

  const project = await discoverPersonaProject(root);
  const result = await runDoctor(root, {
    dependencyStatus: {
      piSubagents: { ok: true, version: "0.31.0", path: "/tmp/pi-subagents" },
      piIntercom: { ok: true, version: "0.6.0", path: "/tmp/pi-intercom" },
    },
  });

  assert.ok(project.agents.some((agent) => agent.name === "worker" && agent.role === "runtime"));
  assert.equal(result.status, "pass");
  assert.ok(!result.issues.some((issue) => issue.message.includes("unknown role 'runtime'")));
});

test("doctor rejects docs paths that escape the workspace", async () => {
  const root = await createWorkspace();

  await writeText(path.join(root, ".pi/agents/escape.md"), `---
name: escape
role: specialist
description: Escaping docs specialist.
tools: read
docs: ../../
---
Escape prompt.
`);

  const result = await runDoctor(root, {
    dependencyStatus: {
      piSubagents: { ok: true, version: "0.31.0", path: "/tmp/pi-subagents" },
      piIntercom: { ok: true, version: "0.6.0", path: "/tmp/pi-intercom" },
    },
  });

  assert.equal(result.status, "error");
  assert.ok(result.issues.some((issue) => issue.message.includes("docs path must stay inside workspace")));
});

test("frontmatter parser supports YAML arrays and quoted colon values", () => {
  const parsed = parseFrontmatterDocument(`---
name: yaml-agent
description: "Handles values with: colons"
tools:
  - read
  - write
docs:
  - docs/shared/
  - docs/workstreams/brand/
consults: [guideline, launch]
tags:
  - brand
---
Prompt body.
`, ".pi/agents/yaml-agent.md");

  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.frontmatter.description, "Handles values with: colons");
  assert.deepEqual(parsed.frontmatter.tools, ["read", "write"]);
  assert.deepEqual(parsed.frontmatter.docs, ["docs/shared/", "docs/workstreams/brand/"]);
  assert.deepEqual(parsed.frontmatter.consults, ["guideline", "launch"]);
  assert.deepEqual(parsed.frontmatter.tags, ["brand"]);
});

test("resolveAgentScope merges baseline and selected agent only", async () => {
  const root = await createWorkspace();

  await writeText(path.join(root, ".pi/agents/operator.md"), `---
name: operator
role: specialist
description: Operations specialist.
tools: write
docs: docs/workstreams/operator/
consults: brand
tags: operations
---
Operator prompt.
`);

  await writeText(path.join(root, "docs/workstreams/operator/runbook.md"), "Operator doc\n");

  const scope = await resolveAgentScope(root, "operator");

  assert.equal(scope.agent.name, "operator");
  assert.equal(scope.baseline.fileName, "_baseline.md");
  assert.deepEqual(scope.docs, [
    "docs/shared/",
    "docs/workstreams/operator/",
  ]);
  assert.deepEqual(scope.tools, [
    "read",
    "write",
  ]);
  assert.deepEqual(scope.consults, [
    "brand",
  ]);
  assert.deepEqual(scope.derived.defaultReads, [
    "docs/shared/",
    "docs/workstreams/operator/",
  ]);
  assert.match(scope.prompt, /Shared operating context/);
  assert.match(scope.prompt, /Operator prompt/);
  assert.doesNotMatch(scope.prompt, /Brand prompt/);
  assert.ok(!scope.docs.includes("docs/workstreams/brand/"));
  assert.ok(!scope.docs.includes("docs/workstreams/guideline/"));
});

test("buildAgentLaunchRequest creates a fresh pi-subagents single-run request", async () => {
  const root = await createWorkspace();
  const scope = await resolveAgentScope(root, "brand");

  const launch = buildAgentLaunchRequest(scope, {
    task: "Draft a short launch message.",
  });

  assert.equal(launch.agentName, "brand");
  assert.equal(launch.context, "fresh");
  assert.deepEqual(launch.docs, [
    "docs/shared/",
    "docs/workstreams/brand/",
  ]);
  assert.deepEqual(launch.tools, ["read"]);
  assert.deepEqual(launch.consults, ["guideline"]);
  assert.deepEqual(launch.subagentParams, {
    agent: "brand",
    task: launch.subagentParams.task,
    clarify: false,
    agentScope: "both",
    context: "fresh",
  });
  assert.match(launch.subagentParams.task, /^\[Read from: docs\/shared\/, docs\/workstreams\/brand\/\]/);
  assert.match(launch.subagentParams.task, /## Baseline Context\n\nShared operating context\./);
  assert.match(launch.subagentParams.task, /## User Request\n\nDraft a short launch message\./);
  assert.equal(Object.hasOwn(scope.agent.frontmatter, "defaultReads"), false);
});

test("formatPersonaList shows read-only discovery details", async () => {
  const root = await createWorkspace();
  const project = await discoverPersonaProject(root);

  const output = formatPersonaList(project);

  assert.match(output, /# Pi Personas/);
  assert.match(output, /generalist - generalist/);
  assert.match(output, /Routes to specialists\./);
  assert.match(output, /docs: docs\/shared\//);
  assert.match(output, /consults: all/);
  assert.match(output, /brand - specialist/);
  assert.match(output, /docs: docs\/workstreams\/brand\//);
  assert.match(output, /consults: guideline/);
  assert.doesNotMatch(output, /launch/i);
});

test("runSubagentBridgeRequest emits a pi-subagents slash request", async () => {
  const params = {
    agent: "brand",
    task: "Task",
    clarify: false,
    agentScope: "both",
    context: "fresh",
  };
  const bus = createEventBus((request, events) => {
    events.emit("subagent:slash:started", { requestId: request.requestId });
    events.emit("subagent:slash:response", {
      requestId: request.requestId,
      result: { content: [{ type: "text", text: "done" }], details: { mode: "single", results: [] } },
      isError: false,
    });
  });

  const response = await runSubagentBridgeRequest(
    { events: bus },
    { cwd: "/tmp/example" },
    params,
    { requestId: "phase4-request" },
  );

  assert.equal(response.isError, false);
  assert.equal(bus.emitted[0].event, "subagent:slash:request");
  assert.equal(bus.emitted[0].data.requestId, "phase4-request");
  assert.deepEqual(bus.emitted[0].data.params, params);
});

test("runSubagentBridgeRequest rejects when the pi-subagents bridge is absent", async () => {
  const bus = createEventBus();

  await assert.rejects(
    () => runSubagentBridgeRequest(
      { events: bus },
      { cwd: "/tmp/example" },
      { agent: "brand", task: "Task", context: "fresh" },
      { requestId: "missing-bridge", startTimeoutMs: 1 },
    ),
    /pi-subagents slash bridge did not respond/,
  );
});

test("runSubagentBridgeRequest ignores responses for other request ids", async () => {
  const bus = createEventBus((request, events) => {
    events.emit("subagent:slash:started", { requestId: request.requestId });
    events.emit("subagent:slash:response", {
      requestId: "other-request",
      result: { content: [{ type: "text", text: "wrong" }], details: { mode: "single", results: [] } },
      isError: false,
    });
    events.emit("subagent:slash:response", {
      requestId: request.requestId,
      result: { content: [{ type: "text", text: "right" }], details: { mode: "single", results: [] } },
      isError: false,
    });
  });

  const response = await runSubagentBridgeRequest(
    { events: bus },
    { cwd: "/tmp/example" },
    { agent: "brand", task: "Task", context: "fresh" },
    { requestId: "matching-request" },
  );

  assert.equal(response.result.content[0].text, "right");
});

test("runSubagentBridgeRequest accepts delayed bridge start and response", async () => {
  const bus = createEventBus((request, events) => {
    queueMicrotask(() => {
      events.emit("subagent:slash:started", { requestId: request.requestId });
      queueMicrotask(() => {
        events.emit("subagent:slash:response", {
          requestId: request.requestId,
          result: { content: [{ type: "text", text: "delayed" }], details: { mode: "single", results: [] } },
          isError: false,
        });
      });
    });
  });

  const response = await runSubagentBridgeRequest(
    { events: bus },
    { cwd: "/tmp/example" },
    { agent: "brand", task: "Task", context: "fresh" },
    { requestId: "delayed-request", startTimeoutMs: 50 },
  );

  assert.equal(response.result.content[0].text, "delayed");
});

test("createAgentScaffold writes a minimal user-facing agent file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-scaffold-"));

  const result = await createAgentScaffold(root, "Market Researcher");
  const content = await readFile(result.filePath, "utf8");

  assert.equal(result.agentName, "market-researcher");
  assert.equal(result.relativePath, ".pi/agents/market-researcher.md");
  assert.match(content, /^---\nname: market-researcher\n/m);
  assert.match(content, /role: specialist/);
  assert.match(content, /description: Market Researcher specialist\./);
  assert.match(content, /tools:\n/);
  assert.doesNotMatch(content, /tools: read/);
  assert.match(content, /docs:\n/);
  assert.match(content, /consults:\n/);
  assert.match(content, /tags:\n/);
  assert.match(content, /You are market-researcher\./);
  assert.doesNotMatch(content, /defaultReads/);
  assert.doesNotMatch(content, /systemPromptMode/);
  assert.doesNotMatch(content, /inheritSkills/);

  const project = await discoverPersonaProject(root);
  assert.deepEqual(project.agents.map((agent) => agent.name), ["market-researcher"]);
});

test("createAgentScaffold refuses to overwrite existing agents", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-scaffold-"));

  await createAgentScaffold(root, "writer");

  await assert.rejects(
    () => createAgentScaffold(root, "writer"),
    /agent file already exists: .pi\/agents\/writer.md/,
  );
});

test("normalizeAgentName creates stable pi-subagents compatible names", () => {
  assert.equal(normalizeAgentName("Market Researcher"), "market-researcher");
  assert.equal(normalizeAgentName("  Launch__Reviewer!! "), "launch-reviewer");
  assert.throws(() => normalizeAgentName("!!!"), /agent name must contain at least one letter or number/);
});
