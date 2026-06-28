import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  discoverPersonaProject,
  createAgentScaffold,
  formatDoctorReport,
  normalizeAgentName,
  resolveAgentScope,
  resolveAgentPreview,
  runDoctor,
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

test("createAgentScaffold writes a minimal user-facing agent file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-scaffold-"));

  const result = await createAgentScaffold(root, "Market Researcher");
  const content = await readFile(result.filePath, "utf8");

  assert.equal(result.agentName, "market-researcher");
  assert.equal(result.relativePath, ".pi/agents/market-researcher.md");
  assert.match(content, /^---\nname: market-researcher\n/m);
  assert.match(content, /role: specialist/);
  assert.match(content, /description: Market Researcher specialist\./);
  assert.match(content, /tools: read/);
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
