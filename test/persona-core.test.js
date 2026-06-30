import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAgentLaunchRequest,
  buildConsultEnvelope,
  discoverPersonaProject,
  createAgentScaffold,
  formatAgentScaffoldCreatedMessage,
  formatConsultSubagentInstructions,
  formatConsultProvenance,
  formatPersonaList,
  formatDoctorReport,
  formatRoundtableRosterPreview,
  parsePersonaNewArgs,
  parseFrontmatterDocument,
  normalizeAgentName,
  resolveAgentScope,
  resolveAgentPreview,
  resolveAgentLaunchRequest,
  resolveConsultLaunchRequest,
  resolveRoundtableLaunchRequest,
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
primary: true
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
tools: read, subagent
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
  assert.match(source, /parsePersonaNewArgs/);
  assert.match(source, /formatAgentScaffoldCreatedMessage/);
});

test("extension registers the persona_consult tool", async () => {
  const source = await readFile(path.join(process.cwd(), "extensions/pi-persona.ts"), "utf8");
  const consultToolBlock = source.slice(
    source.indexOf('name: "persona_consult"'),
    source.indexOf("const registerPersonaCommand"),
  );

  assert.match(source, /registerTool\(/);
  assert.match(source, /name:\s*"persona_consult"/);
  assert.match(source, /resolveConsultLaunchRequest/);
  assert.match(source, /formatConsultSubagentInstructions/);
  assert.doesNotMatch(consultToolBlock, /runSubagentBridgeRequest/);
});

test("extension registers persona-roundtable as a namespaced command", async () => {
  const source = await readFile(path.join(process.cwd(), "extensions/pi-persona.ts"), "utf8");

  assert.match(source, /registerCommand\("persona-roundtable"/);
  assert.doesNotMatch(source, /registerCommand\("roundtable"/);
  assert.match(source, /createRoundtableProgress/);
  assert.match(source, /onUpdate/);
  assert.match(source, /statusKey:\s*"pi-persona-roundtable"/);
  assert.match(source, /setStatus(?:\?\.)?\(options\.statusKey/);
});

test("extension shows visible progress for direct persona launches", async () => {
  const source = await readFile(path.join(process.cwd(), "extensions/pi-persona.ts"), "utf8");

  assert.match(source, /createPersonaLaunchProgress/);
  assert.match(source, /Launching \$\{agentName\}/);
  assert.match(source, /Persona is running/);
  assert.match(source, /onUpdate\(update: unknown\)/);
  assert.match(source, /statusKey:\s*"pi-persona-launch"/);
  assert.match(source, /setStatus(?:\?\.)?\(options\.statusKey/);
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
primary: true
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
  assert.ok(messages.some((message) => message.includes("multiple primary generalist agents")));
  assert.ok(messages.some((message) => message.includes("Set exactly one generalist to primary: true")));
  assert.ok(messages.some((message) => message.includes("docs path does not exist: docs/missing/")));
  assert.ok(messages.some((message) => message.includes("consults unknown agent 'missing-peer'")));
  assert.ok(messages.some((message) => message.includes("unknown tool 'fake_tool'")));
  assert.ok(messages.some((message) => message.includes("control file is launchable")));
});

test("agent scaffold marks first generalist primary and later generalists non-primary with warning", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-scaffold-primary-"));

  const first = await createAgentScaffold(root, "Generalist", { role: "generalist" });
  const second = await createAgentScaffold(root, "Backup Generalist", { role: "generalist" });

  assert.match(first.content, /role: generalist\nprimary: true/);
  assert.equal(first.options.primary, true);
  assert.deepEqual(first.warnings, []);
  assert.match(second.content, /role: generalist\nprimary: false/);
  assert.equal(second.options.primary, false);
  assert.ok(second.warnings.some((warning) => warning.includes("created as primary: false")));
  assert.ok(second.warnings.some((warning) => warning.includes("Set exactly one generalist to primary: true")));
  assert.match(formatAgentScaffoldCreatedMessage(second), /Warning:/);
  assert.match(formatAgentScaffoldCreatedMessage(second), /backup-generalist/);
});

test("doctor recognizes persona_consult as a Pi Persona runtime tool", async () => {
  const root = await createWorkspace();

  await writeText(path.join(root, ".pi/agents/brand.md"), `---
name: brand
role: specialist
description: Brand strategy specialist.
tools: read, subagent, persona_consult
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

test("doctor requires subagent tool for agents with consult peers", async () => {
  const root = await createWorkspace();

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

  const result = await runDoctor(root, {
    dependencyStatus: {
      piSubagents: { ok: true, version: "0.31.0", path: "/tmp/pi-subagents" },
      piIntercom: { ok: true, version: "0.6.0", path: "/tmp/pi-intercom" },
    },
  });

  assert.equal(result.status, "error");
  assert.ok(result.issues.some((issue) => issue.message.includes(".pi/agents/brand.md: consult-capable agents must list tool 'subagent'")));
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
    "subagent",
  ]);
  assert.deepEqual(preview.consults, [
    "guideline",
  ]);
  assert.deepEqual(preview.derived.defaultReads, [
    "docs/shared/company.md",
    "docs/workstreams/brand/brief.md",
  ]);
  assert.equal(Object.hasOwn(preview.agent.frontmatter, "defaultReads"), false);
  assert.equal(Object.hasOwn(preview.agent.frontmatter, "systemPromptMode"), false);
});

test("resolver expands directory docs into concrete runtime reads while preserving declared docs", async () => {
  const root = await createWorkspace();
  await writeText(path.join(root, "docs/workstreams/brand/examples/example.md"), "Brand example doc\n");

  const scope = await resolveAgentScope(root, "brand");

  assert.deepEqual(scope.docs, [
    "docs/shared/",
    "docs/workstreams/brand/",
  ]);
  assert.deepEqual(scope.derived.defaultReads, [
    "docs/shared/company.md",
    "docs/workstreams/brand/brief.md",
    "docs/workstreams/brand/examples/example.md",
  ]);
  assert.deepEqual(scope.derived.docManifest, [
    {
      declared: "docs/shared/",
      files: ["docs/shared/company.md"],
    },
    {
      declared: "docs/workstreams/brand/",
      files: [
        "docs/workstreams/brand/brief.md",
        "docs/workstreams/brand/examples/example.md",
      ],
    },
  ]);
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
  assert.match(report, /Primary generalist: generalist/);
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

  await writeText(path.join(root, ".pi/agents/specialist-primary.md"), `---
name: specialist-primary
role: specialist
primary: true
description: Specialist with invalid primary flag.
tools: read
docs: docs/shared/
---
Specialist primary prompt.
`);

  await writeText(path.join(root, ".pi/agents/string-primary.md"), `---
name: string-primary
role: generalist
primary: "true"
description: Generalist with invalid primary value.
tools: read
docs: docs/shared/
---
String primary prompt.
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
  assert.ok(messages.some((message) => message.includes("primary: true is only valid on role: generalist")));
  assert.ok(messages.some((message) => message.includes("primary must be true or false")));
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
  assert.ok(result.issues.some((issue) => issue.message.includes("exactly one primary generalist required")));
});

test("doctor allows multiple generalists when exactly one is primary", async () => {
  const root = await createWorkspace();

  await writeText(path.join(root, ".pi/agents/backup-generalist.md"), `---
name: backup-generalist
role: generalist
primary: false
description: Backup generalist.
tools: read, subagent
docs: docs/shared/
consults: all
---
Backup generalist prompt.
`);

  const result = await runDoctor(root, {
    dependencyStatus: {
      piSubagents: { ok: true, version: "0.31.0", path: "/tmp/pi-subagents" },
      piIntercom: { ok: true, version: "0.6.0", path: "/tmp/pi-intercom" },
    },
  });

  assert.equal(result.status, "pass");
  assert.equal(result.project.agents.filter((agent) => agent.role === "generalist").length, 2);
  assert.equal(result.project.agents.find((agent) => agent.name === "generalist").primary, true);
  assert.equal(result.project.agents.find((agent) => agent.name === "backup-generalist").primary, false);
});

test("doctor rejects multiple primary generalists with remediation", async () => {
  const root = await createWorkspace();

  await writeText(path.join(root, ".pi/agents/backup-generalist.md"), `---
name: backup-generalist
role: generalist
primary: true
description: Backup generalist.
tools: read, subagent
docs: docs/shared/
consults: all
---
Backup generalist prompt.
`);

  const result = await runDoctor(root, {
    dependencyStatus: {
      piSubagents: { ok: true, version: "0.31.0", path: "/tmp/pi-subagents" },
      piIntercom: { ok: true, version: "0.6.0", path: "/tmp/pi-intercom" },
    },
  });

  const messages = result.issues.map((issue) => issue.message);
  assert.equal(result.status, "error");
  assert.ok(messages.some((message) => message.includes("multiple primary generalist agents")));
  assert.ok(messages.some((message) => message.includes(".pi/agents/generalist.md")));
  assert.ok(messages.some((message) => message.includes(".pi/agents/backup-generalist.md")));
  assert.ok(messages.some((message) => message.includes("Set exactly one generalist to primary: true")));
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
    "docs/shared/company.md",
    "docs/workstreams/operator/runbook.md",
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
  assert.deepEqual(launch.tools, ["read", "subagent"]);
  assert.deepEqual(launch.consults, ["guideline"]);
  assert.deepEqual(launch.subagentParams, {
    agent: "brand",
    task: launch.subagentParams.task,
    clarify: false,
    agentScope: "both",
    context: "fresh",
    reads: [
      "docs/shared/company.md",
      "docs/workstreams/brand/brief.md",
    ],
  });
  assert.match(launch.subagentParams.task, /^\[Read from: docs\/shared\/company\.md, docs\/workstreams\/brand\/brief\.md\]/);
  assert.match(launch.subagentParams.task, /Resolved doc files:\n- docs\/shared\/: docs\/shared\/company\.md\n- docs\/workstreams\/brand\/: docs\/workstreams\/brand\/brief\.md/);
  assert.match(launch.subagentParams.task, /## Baseline Context\n\nShared operating context\./);
  assert.match(launch.subagentParams.task, /## User Request\n\nDraft a short launch message\./);
  assert.match(launch.subagentParams.task, /Tool: subagent/);
  assert.match(launch.subagentParams.task, /Call the `subagent` tool with `agent` set to an allowed consultant/);
  assert.match(launch.subagentParams.task, /requester: brand/);
  assert.match(launch.subagentParams.task, /Default consult context: fresh/);
  assert.doesNotMatch(launch.subagentParams.task, /Tool: persona_consult/);
  assert.equal(Object.hasOwn(scope.agent.frontmatter, "defaultReads"), false);
});

test("buildAgentLaunchRequest omits consult tool guidance when no consult peers exist", async () => {
  const root = await createWorkspace();
  const scope = await resolveAgentScope(root, "guideline");

  const request = buildAgentLaunchRequest(scope, { task: "Answer directly." });

  assert.doesNotMatch(request.subagentParams.task, /Tool: subagent/);
});

test("resolveAgentLaunchRequest refuses duplicate agent names instead of choosing one", async () => {
  const root = await createWorkspace();

  await writeText(path.join(root, ".pi/agents/duplicate-brand.md"), `---
name: brand
role: specialist
description: Duplicate brand strategy specialist.
tools: read
docs: docs/workstreams/brand/
consults:
tags: brand
---
Duplicate brand prompt.
`);

  await assert.rejects(
    () => resolveAgentLaunchRequest(root, "brand", { task: "Launch the brand persona." }),
    /ambiguous agent name 'brand'/,
  );
});

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
  assert.deepEqual(consult.subagentParams.reads, [
    "docs/shared/company.md",
    "docs/workstreams/guideline/rules.md",
  ]);
  assert.match(consult.subagentParams.task, /^\[Read from: docs\/shared\/company\.md, docs\/workstreams\/guideline\/rules\.md\]/);
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

test("resolveConsultLaunchRequest refuses duplicate requester or consultant names", async () => {
  const root = await createWorkspace();

  await writeText(path.join(root, ".pi/agents/duplicate-guideline.md"), `---
name: guideline
role: specialist
description: Duplicate guideline reviewer.
tools: read
docs: docs/workstreams/guideline/
consults:
tags: guideline
---
Duplicate guideline prompt.
`);

  await assert.rejects(
    () => resolveConsultLaunchRequest(root, {
      requester: "brand",
      consultant: "guideline",
      question: "Which guideline answer should I trust?",
      summary: "The requester is checking duplicate consultant handling.",
    }),
    /ambiguous consultant name 'guideline'/,
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

test("formatConsultSubagentInstructions returns the exact child-safe subagent request", async () => {
  const root = await createWorkspace();

  const consult = await resolveConsultLaunchRequest(root, {
    requester: "brand",
    consultant: "guideline",
    question: "Review this with the guideline persona.",
    summary: "The requester needs guideline review.",
  });

  const instructions = formatConsultSubagentInstructions(consult);

  assert.match(instructions, /Call the `subagent` tool with this exact request/);
  assert.match(instructions, /"agent": "guideline"/);
  assert.match(instructions, /"context": "fresh"/);
  assert.match(instructions, /After the `subagent` result returns/);
  assert.match(instructions, /- guideline \(answered\): <one-line summary>/);
});

test("buildConsultEnvelope requires requester-written summary", () => {
  assert.throws(
    () => buildConsultEnvelope({
      requester: "brand",
      consultant: "guideline",
      question: "Can you review this?",
    }),
    /consult summary is required/,
  );
});

test("formatConsultProvenance reports successful and failed consults compactly", () => {
  const text = formatConsultProvenance([
    { consultant: "guideline", status: "answered", summary: "Guideline approved with one caveat." },
    { consultant: "pricing", status: "failed", summary: "doc path missing" },
  ]);

  assert.match(text, /Consulted:/);
  assert.match(text, /- guideline \(answered\): Guideline approved with one caveat\./);
  assert.match(text, /- pricing \(failed\): doc path missing/);
});

test("formatPersonaList shows read-only discovery details", async () => {
  const root = await createWorkspace();
  const project = await discoverPersonaProject(root);

  const output = formatPersonaList(project);

  assert.match(output, /# Pi Personas/);
  assert.match(output, /generalist - generalist \(primary\)/);
  assert.match(output, /Routes to specialists\./);
  assert.match(output, /docs: docs\/shared\//);
  assert.match(output, /consults: all/);
  assert.match(output, /brand - specialist/);
  assert.match(output, /docs: docs\/workstreams\/brand\//);
  assert.match(output, /consults: guideline/);
  assert.doesNotMatch(output, /launch/i);
});

test("resolveRoundtableLaunchRequest builds a pi-subagents chain with two specialist rounds and synthesis", async () => {
  const root = await createWorkspace();

  await writeText(path.join(root, ".pi/agents/pricing.md"), `---
name: pricing
role: specialist
description: Pricing strategy specialist.
model: openai/gpt-5
tools: read
docs: docs/workstreams/pricing/
consults:
tags: pricing, revenue
---
Pricing prompt.
`);
  await writeText(path.join(root, "docs/workstreams/pricing/model.md"), "Pricing doc\n");

  const roundtable = await resolveRoundtableLaunchRequest(root, {
    query: "Should brand positioning change pricing and guideline language?",
  });

  assert.equal(roundtable.generalist.name, "generalist");
  assert.deepEqual(roundtable.roster.map((agent) => agent.name), ["brand", "guideline", "pricing"]);
  assert.equal(roundtable.context, "fresh");
  assert.deepEqual(roundtable.subagentParams.chain.map((step) => step.phase), [
    "Round 1",
    "Round 2",
    "Synthesis",
  ]);
  assert.equal(roundtable.subagentParams.chain[0].parallel.length, 3);
  assert.equal(roundtable.subagentParams.chain[1].parallel.length, 3);
  assert.equal(roundtable.subagentParams.chain[2].agent, "generalist");
  const pricingRoundOne = roundtable.subagentParams.chain[0].parallel.find((step) => step.agent === "pricing");
  const brandRoundTwo = roundtable.subagentParams.chain[1].parallel.find((step) => step.agent === "brand");
  assert.deepEqual(pricingRoundOne.reads, ["docs/shared/company.md", "docs/workstreams/pricing/model.md"]);
  assert.equal(pricingRoundOne.model, "openai/gpt-5");
  assert.deepEqual(brandRoundTwo.reads, ["docs/shared/company.md", "docs/workstreams/brand/brief.md"]);
  assert.deepEqual(roundtable.subagentParams.chain[2].reads, ["docs/shared/company.md"]);
  assert.match(roundtable.subagentParams.chain[0].parallel[0].task, /Round 1 - Independent Position/);
  assert.match(roundtable.subagentParams.chain[0].parallel[0].task, /Do not call persona_consult or subagent/);
  assert.match(roundtable.subagentParams.chain[1].parallel[0].task, /Round 2 - Reveal And Revise/);
  assert.match(roundtable.subagentParams.chain[1].parallel[0].task, /\{previous\}/);
  assert.match(roundtable.subagentParams.chain[2].task, /Moderator Synthesis/);
  assert.match(roundtable.subagentParams.chain[2].task, /\{previous\}/);
});

test("resolveRoundtableLaunchRequest refuses duplicate agent names before building a chain", async () => {
  const root = await createWorkspace();

  await writeText(path.join(root, ".pi/agents/duplicate-brand.md"), `---
name: brand
role: specialist
description: Duplicate brand strategy specialist.
tools: read
docs: docs/workstreams/brand/
consults:
tags: brand
---
Duplicate brand prompt.
`);

  await assert.rejects(
    () => resolveRoundtableLaunchRequest(root, {
      query: "Brand guideline question.",
    }),
    /ambiguous agent name 'brand'/,
  );
});

test("resolveRoundtableLaunchRequest caps the roster at five specialists", async () => {
  const root = await createWorkspace();

  for (const name of ["alpha", "beta", "delta", "epsilon", "zeta"]) {
    await writeText(path.join(root, `.pi/agents/${name}.md`), `---
name: ${name}
role: specialist
description: ${name} specialist for market planning.
tools: read
docs: docs/shared/
consults:
tags: market, planning, ${name}
---
${name} prompt.
`);
  }

  const roundtable = await resolveRoundtableLaunchRequest(root, {
    query: "Market planning question across many specialists.",
  });

  assert.equal(roundtable.roster.length, 5);
  assert.ok(!roundtable.roster.some((agent) => agent.role === "generalist"));
});

test("resolveRoundtableLaunchRequest excludes unrelated zero-score specialists when matches exist", async () => {
  const root = await createWorkspace();

  await writeText(path.join(root, ".pi/agents/unrelated.md"), `---
name: unrelated
role: specialist
description: Unrelated proof specialist.
tools: read
docs:
consults:
tags: unrelated
---
Unrelated prompt.
`);

  const roundtable = await resolveRoundtableLaunchRequest(root, {
    query: "Brand guideline question.",
  });

  assert.deepEqual(roundtable.roster.map((agent) => agent.name), ["brand", "guideline"]);
});

test("formatRoundtableRosterPreview shows selected specialists and command context", async () => {
  const root = await createWorkspace();
  const roundtable = await resolveRoundtableLaunchRequest(root, {
    query: "Brand guideline question.",
  });

  const preview = formatRoundtableRosterPreview(roundtable);

  assert.match(preview, /# Pi Persona Round-table/);
  assert.match(preview, /Query: Brand guideline question\./);
  assert.match(preview, /Moderator: generalist/);
  assert.match(preview, /- brand - Brand strategy specialist\./);
  assert.match(preview, /- guideline - Guideline reviewer\./);
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

test("runSubagentBridgeRequest forwards matching progress updates", async () => {
  const updates = [];
  const bus = createEventBus((request, events) => {
    events.emit("subagent:slash:started", { requestId: request.requestId });
    events.emit("subagent:slash:update", {
      requestId: "other-request",
      toolCount: 99,
    });
    events.emit("subagent:slash:update", {
      requestId: request.requestId,
      toolCount: 2,
      currentTool: "read",
      progress: [{ agent: "brand", status: "running", toolCount: 2 }],
    });
    events.emit("subagent:slash:response", {
      requestId: request.requestId,
      result: { content: [{ type: "text", text: "right" }], details: { mode: "single", results: [] } },
      isError: false,
    });
  });

  await runSubagentBridgeRequest(
    { events: bus },
    { cwd: "/tmp/example" },
    { agent: "brand", task: "Task", context: "fresh" },
    {
      requestId: "matching-request",
      onUpdate(update) {
        updates.push(update);
      },
    },
  );

  assert.deepEqual(updates, [{
    requestId: "matching-request",
    toolCount: 2,
    currentTool: "read",
    progress: [{ agent: "brand", status: "running", toolCount: 2 }],
  }]);
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

test("parsePersonaNewArgs accepts setup metadata options", () => {
  const parsed = parsePersonaNewArgs(
    'Market Research --role specialist --description "Market research specialist." --docs docs/workstreams/market/ --tools read,subagent --consults guideline,pricing --tags market,research',
  );

  assert.equal(parsed.rawName, "Market Research");
  assert.equal(parsed.options.role, "specialist");
  assert.equal(parsed.options.description, "Market research specialist.");
  assert.deepEqual(parsed.options.docs, ["docs/workstreams/market/"]);
  assert.deepEqual(parsed.options.tools, ["read", "subagent"]);
  assert.deepEqual(parsed.options.consults, ["guideline", "pricing"]);
  assert.deepEqual(parsed.options.tags, ["market", "research"]);
});

test("parsePersonaNewArgs accepts equals options and rejects unsafe input", () => {
  const parsed = parsePersonaNewArgs(
    'Ops Lead --role=generalist --description="Routes operational requests." --docs=docs/shared/,docs/workstreams/ops/ --tools=read --consults=all --tags=ops',
  );

  assert.equal(parsed.rawName, "Ops Lead");
  assert.equal(parsed.options.role, "generalist");
  assert.equal(parsed.options.description, "Routes operational requests.");
  assert.deepEqual(parsed.options.docs, ["docs/shared/", "docs/workstreams/ops/"]);
  assert.deepEqual(parsed.options.tools, ["read"]);
  assert.deepEqual(parsed.options.consults, ["all"]);
  assert.deepEqual(parsed.options.tags, ["ops"]);

  assert.throws(
    () => parsePersonaNewArgs("Ops Lead --role runtime"),
    /role must be generalist or specialist/,
  );
  assert.throws(
    () => parsePersonaNewArgs("Ops Lead --unknown value"),
    /unknown \/persona new option: --unknown/,
  );
  assert.throws(
    () => parsePersonaNewArgs("--role specialist"),
    /Usage: \/persona new <name>/,
  );
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

test("createAgentScaffold writes provided setup metadata without runtime fields", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-scaffold-"));
  await writeText(path.join(root, "docs/workstreams/market/brief.md"), "Market doc\n");

  const result = await createAgentScaffold(root, "Market Research", {
    role: "specialist",
    description: "Market research specialist.",
    docs: ["docs/workstreams/market/"],
    tools: ["read", "subagent"],
    consults: ["guideline"],
    tags: ["market", "research"],
  });
  const content = await readFile(result.filePath, "utf8");

  assert.match(content, /role: specialist/);
  assert.match(content, /description: Market research specialist\./);
  assert.match(content, /tools: read, subagent/);
  assert.match(content, /docs: docs\/workstreams\/market\//);
  assert.match(content, /consults: guideline/);
  assert.match(content, /tags: market, research/);
  assert.doesNotMatch(content, /defaultReads/);
  assert.doesNotMatch(content, /systemPromptMode/);
  assert.doesNotMatch(content, /inheritSkills/);

  const project = await discoverPersonaProject(root);
  const agent = project.agents.find((candidate) => candidate.name === "market-research");
  assert.equal(agent.description, "Market research specialist.");
  assert.deepEqual(agent.docs, ["docs/workstreams/market/"]);
  assert.deepEqual(agent.tools, ["read", "subagent"]);
  assert.deepEqual(agent.consults, ["guideline"]);
});

test("formatAgentScaffoldCreatedMessage gives next setup steps", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-scaffold-"));

  const result = await createAgentScaffold(root, "Market Research", {
    docs: ["docs/workstreams/market/"],
    tools: ["read"],
  });

  assert.equal(formatAgentScaffoldCreatedMessage(result), [
    "Created .pi/agents/market-research.md",
    "",
    "Launch: /market-research",
    "Docs: docs/workstreams/market/",
    "Tools: read",
    "Next: run /persona doctor",
  ].join("\n"));
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

test("phase 7 full workflow composes setup docs doctor launch consult roundtable and add-agent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-phase7-"));

  await writeText(path.join(root, ".pi/agents/_baseline.md"), `---
docs: docs/shared/
tools: read
---
Shared pilot context.
`);
  await writeText(path.join(root, "docs/shared/company.md"), "Shared pilot doc\n");
  await writeText(path.join(root, "docs/workstreams/brand/brief.md"), "Brand pilot doc\n");
  await writeText(path.join(root, "docs/workstreams/guideline/rules.md"), "Guideline pilot doc\n");
  await writeText(path.join(root, "docs/workstreams/pricing/model.md"), "Pricing pilot doc\n");

  await createAgentScaffold(root, "generalist", {
    role: "generalist",
    description: "Routes pilot requests.",
    docs: ["docs/shared/"],
    tools: ["read", "subagent"],
    consults: ["all"],
    tags: ["general", "routing"],
  });
  await createAgentScaffold(root, "brand", {
    description: "Brand pilot specialist.",
    docs: ["docs/workstreams/brand/"],
    tools: ["read", "subagent"],
    consults: ["guideline"],
    tags: ["brand"],
  });
  await createAgentScaffold(root, "guideline", {
    description: "Guideline pilot reviewer.",
    docs: ["docs/workstreams/guideline/"],
    tools: ["read"],
    tags: ["guideline"],
  });

  const doctor = await runDoctor(root, {
    dependencyStatus: {
      piSubagents: { ok: true, version: "0.31.0", path: "/tmp/pi-subagents" },
      piIntercom: { ok: true, version: "0.6.0", path: "/tmp/pi-intercom" },
    },
  });
  assert.equal(doctor.status, "pass");

  const initialProject = await discoverPersonaProject(root);
  const list = formatPersonaList(initialProject);
  assert.match(list, /generalist - generalist \(primary\)/);
  assert.match(list, /brand - specialist/);
  assert.match(list, /docs: docs\/workstreams\/brand\//);
  assert.match(list, /consults: guideline/);
  assert.doesNotMatch(list, /launch/i);

  const directLaunch = await resolveAgentLaunchRequest(root, "brand", {
    task: "Draft a pilot brand answer.",
  });
  assert.equal(directLaunch.subagentParams.agent, "brand");
  assert.equal(directLaunch.subagentParams.context, "fresh");
  assert.match(directLaunch.subagentParams.task, /Tool: subagent/);

  const consult = await resolveConsultLaunchRequest(root, {
    requester: "brand",
    consultant: "guideline",
    question: "Does the pilot answer follow the guideline?",
    summary: "The brand specialist is checking pilot copy.",
  });
  assert.equal(consult.subagentParams.agent, "guideline");
  assert.equal(consult.subagentParams.context, "fresh");
  assert.match(consult.subagentParams.task, /summary: The brand specialist is checking pilot copy\./);

  const roundtable = await resolveRoundtableLaunchRequest(root, {
    query: "Brand guideline pilot question.",
  });
  assert.equal(roundtable.generalist.name, "generalist");
  assert.deepEqual(roundtable.roster.map((agent) => agent.name), ["brand", "guideline"]);
  assert.equal(roundtable.subagentParams.chain.length, 3);

  await createAgentScaffold(root, "pricing", {
    description: "Pricing pilot specialist.",
    docs: ["docs/workstreams/pricing/"],
    tools: ["read"],
    tags: ["pricing"],
  });

  const expandedProject = await discoverPersonaProject(root);
  assert.ok(expandedProject.agents.some((agent) => agent.name === "pricing"));
  assert.equal((await resolveAgentLaunchRequest(root, "brand", { task: "Still works." })).agentName, "brand");
  assert.equal((await resolveAgentLaunchRequest(root, "pricing", { task: "Pricing works." })).agentName, "pricing");

  await createAgentScaffold(root, "backup-generalist", {
    role: "generalist",
    description: "Second pilot generalist.",
    docs: ["docs/shared/"],
    tools: ["read"],
    tags: ["general"],
  });

  const duplicateDoctor = await runDoctor(root, {
    dependencyStatus: {
      piSubagents: { ok: true, version: "0.31.0", path: "/tmp/pi-subagents" },
      piIntercom: { ok: true, version: "0.6.0", path: "/tmp/pi-intercom" },
    },
  });
  assert.equal(duplicateDoctor.status, "pass");
  const finalProject = await discoverPersonaProject(root);
  const backup = finalProject.agents.find((agent) => agent.name === "backup-generalist");
  assert.equal(backup.primary, false);
  const stableRoundtable = await resolveRoundtableLaunchRequest(root, { query: "Stable moderator question." });
  assert.equal(stableRoundtable.generalist.name, "generalist");
});
