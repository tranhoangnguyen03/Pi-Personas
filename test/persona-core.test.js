import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";

import {
  buildAgentLaunchRequest,
  buildConsultEnvelope,
  createDocsIndex,
  createPersonaInitDraft,
  createPersonaProjectScaffold,
  createConsultProgressTracker,
  createRoundtableProcessDetails,
  createRoundtableProgressTracker,
  discoverPersonaProject,
  createAgentScaffold,
  extractConsultAnswer,
  extractRoundtableAnswer,
  formatAgentScaffoldCreatedMessage,
  formatConsultBridgeResult,
  formatConsultProvenance,
  formatDocsIndexReport,
  formatPersonaProjectScaffoldCreatedMessage,
  formatPersonaList,
  formatDoctorReport,
  formatPersonaInitDraftAuthoringPrompt,
  formatRoundtableBridgeFailure,
  formatRoundtableProcessLine,
  formatRoundtableRosterPreview,
  parsePersonaIndexArgs,
  parsePersonaInitArgs,
  parsePersonaNewArgs,
  parseFrontmatterDocument,
  planPersonaInitFromManifest,
  applyPersonaInitFromManifest,
  statusPersonaInitFromManifest,
  formatPersonaInitManifestReport,
  normalizeAgentName,
  resolveAgentScope,
  resolveAgentPreview,
  resolveAgentLaunchRequest,
  resolveConsultLaunchRequest,
  resolveRoundtableLaunchRequest,
  resolveRoundtableSelectionRequest,
  assertPersonaRuntimeReady,
  runSubagentBridgeRequest,
  runDoctor,
  repairRuntimePackageDuplicates,
  sendPersonaOutput,
} from "../src/persona/index.js";

const execFileAsync = promisify(execFile);

async function writeText(filePath, text) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text, "utf8");
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function createWorkspace() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-test-"));

  await writeText(path.join(root, ".pi/agents/_baseline.md"), `---
docs: docs/shared/
skills: shared-skill
---
Shared operating context.
`);

  await writeText(path.join(root, ".pi/agents/generalist.md"), `---
name: generalist
role: generalist
primary: true
description: Routes to specialists.
---
Generalist prompt.
`);

  await writeText(path.join(root, ".pi/agents/brand.md"), `---
name: brand
role: specialist
description: Brand strategy specialist.
docs: docs/workstreams/brand/
skills: brand-skill
---
Brand prompt.
`);

  await writeText(path.join(root, ".pi/agents/guideline.md"), `---
name: guideline
role: specialist
description: Guideline reviewer.
docs: docs/workstreams/guideline/
skills: guideline-skill
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
    listenerCount(event) {
      return (handlers.get(event) ?? []).length;
    },
  };
}

async function createCommandWorkspace(extraAgent) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-command-"));
  await writeText(path.join(root, ".pi/agents/generalist.md"), `---
name: generalist
role: generalist
primary: true
description: Generalist.
---
Generalist prompt.
`);

  if (extraAgent) {
    await writeText(path.join(root, `.pi/agents/${extraAgent}.md`), `---
name: ${extraAgent}
role: specialist
description: ${extraAgent} specialist.
---
${extraAgent} prompt.
`);
  }

  return root;
}

async function createExtensionHarness(cwd, options = {}) {
  const { default: registerPiPersona } = await import("../extensions/pi-persona.ts");
  const commands = new Map();
  const tools = new Map();
  const handlers = new Map();
  const entries = [];
  const messages = [];
  const notifications = [];
  const statuses = [];
  const sentUserMessages = [];
  const events = createEventBus(options.onSubagentRequest);
  const pi = {
    registerTool(spec) {
      tools.set(spec.name, spec);
    },
    registerCommand(name, spec) {
      commands.set(name, spec);
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
    appendEntry(customType, data) {
      entries.push({ type: "custom", customType, data });
    },
    sendMessage(message) {
      messages.push(message);
    },
    sendUserMessage(message, options) {
      sentUserMessages.push({ message, options });
    },
    events,
  };
  const ctx = {
    cwd,
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
      setStatus(key, value) {
        statuses.push({ key, value });
      },
    },
    sessionManager: {
      getBranch() {
        return entries;
      },
    },
    isIdle() {
      return true;
    },
  };

  registerPiPersona(pi);

  return {
    commands,
    tools,
    handlers,
    entries,
    messages,
    notifications,
    statuses,
    sentUserMessages,
    events,
    ctx,
  };
}

function starterInitManifest() {
  return `version: 1
project:
  name: test-business

baseline:
  docs:
    - docs/shared/
  skills: []
  prompt: |
    Shared test baseline.

docs:
  files:
    docs/shared/_index.md: |
      # Shared Index

      - context.md: shared context.
    docs/shared/context.md: |
      TEST_BUSINESS_CONTEXT
    docs/workstreams/operator/_index.md: |
      # Operator Index

      - brief.md: operator brief.
    docs/workstreams/operator/brief.md: |
      Operator workstream notes.

agents:
  - name: generalist
    role: generalist
    primary: true
    description: Routes test business requests.
    docs: []
    skills: []
    prompt: |
      Generalist prompt.

  - name: operator
    role: specialist
    description: Runs operating checklists.
    docs:
      - docs/workstreams/operator/
    skills: []
    prompt: |
      Operator prompt.
`;
}

test("package manifest exposes Pi Persona as a Pi extension package", async () => {
  const manifest = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8"));

  assert.ok(manifest.keywords.includes("pi-package"));
  assert.deepEqual(manifest.pi.extensions, ["./extensions/pi-persona.ts"]);
});

test("syntax checker discovers nested JavaScript files", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-syntax-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeText(path.join(root, "valid.js"), "export const ok = true;\n");
  await writeText(path.join(root, "nested/broken.js"), "function {\n");

  await assert.rejects(
    () => execFileAsync(process.execPath, ["scripts/check-syntax.js", root], {
      cwd: process.cwd(),
    }),
    /broken\.js/,
  );
});

test("package tarball excludes local runtime state and tests", async () => {
  const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json"], {
    cwd: process.cwd(),
    maxBuffer: 1024 * 1024,
  });
  const [packed] = JSON.parse(stdout);
  const files = packed.files.map((entry) => entry.path);
  const forbidden = files.filter((filePath) => (
    filePath.startsWith(".pi/")
    || filePath.startsWith(".pi-subagents/")
    || filePath.startsWith(".sc/")
    || filePath.startsWith("test/")
  ));

  assert.ok(files.includes("README.md"));
  assert.ok(files.includes("LICENSE"));
  assert.ok(files.includes("CHANGELOG.md"));
  assert.ok(files.includes("RELEASING.md"));
  assert.ok(files.includes("docs/_about_pi_persona/design.md"));
  assert.ok(files.includes("extensions/pi-persona.ts"));
  assert.ok(files.includes("init-data/_template.yaml"));
  assert.ok(files.includes("init-data/[EXAMPLE]business-operating-layer.yaml"));
  assert.ok(files.includes("src/persona/index.js"));
  assert.equal(files.some((filePath) => filePath.startsWith("docs/superpowers/")), false);
  assert.deepEqual(forbidden, []);
});

test("runtime Pi packages are optional peers for plain npm installs", async () => {
  const manifest = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8"));

  assert.equal(manifest.peerDependencies["pi-intercom"], undefined);
  assert.equal(manifest.peerDependencies["pi-subagents"], ">=0.34.0");
  assert.equal(manifest.peerDependenciesMeta["pi-subagents"].optional, true);
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.publishConfig.access, "public");
  assert.equal(manifest.scripts.prepublishOnly, "npm test");
});

test("README maintainer doc links point to checked-in files", async () => {
  const readme = await readFile(path.join(process.cwd(), "README.md"), "utf8");

  assert.match(readme, /\(docs\/_about_pi_persona\/README\.md\)/);
  assert.match(readme, /\(docs\/_about_pi_persona\/blueprint\.md\)/);
  assert.match(readme, /\(docs\/_about_pi_persona\/design\.md\)/);
  assert.doesNotMatch(readme, /\(docs\/README\.md\)/);
  assert.doesNotMatch(readme, /\(docs\/blueprint\.md\)/);
  assert.doesNotMatch(readme, /\(docs\/design\.md\)/);
});

test("extension uses the persona command namespace instead of generic agent", async () => {
  const source = await readFile(path.join(process.cwd(), "extensions/pi-persona.ts"), "utf8");

  assert.match(source, /registerCommand\("persona"/);
  assert.doesNotMatch(source, /registerCommand\("agent"/);
  assert.match(source, /\/persona init/);
  assert.match(source, /parsePersonaInitArgs/);
  assert.match(source, /\/persona doctor/);
  assert.match(source, /\/persona index \[docs-dir\]/);
  assert.doesNotMatch(source, /\/agent doctor/);
  assert.match(source, /parsePersonaNewArgs/);
  assert.match(source, /formatAgentScaffoldCreatedMessage/);
  assert.match(source, /createPersonaProjectScaffold/);
  assert.match(source, /planPersonaInitFromManifest/);
  assert.match(source, /createPersonaInitDraft/);
  assert.match(source, /formatPersonaInitDraftAuthoringPrompt/);
  assert.match(source, /createDocsIndex/);
  assert.match(source, /name:\s*"persona_init"/);
  assert.match(source, /\/persona use <name>/);
});

test("extension has no explicit any escape hatches", async () => {
  const source = await readFile(path.join(process.cwd(), "extensions/pi-persona.ts"), "utf8");
  assert.doesNotMatch(source, /:\s*any\b|as\s+any\b/);
});

test("extension starts agentic authoring after persona init draft", async () => {
  const source = await readFile(path.join(process.cwd(), "extensions/pi-persona.ts"), "utf8");
  const draftBlock = source.slice(
    source.indexOf('if (parsed.mode === "draft")'),
    source.indexOf('if (parsed.mode === "plan")'),
  );

  assert.match(draftBlock, /createPersonaInitDraft/);
  assert.match(draftBlock, /sendPersonaOutput/);
  assert.match(draftBlock, /pi\.sendUserMessage\(/);
  assert.match(draftBlock, /formatPersonaInitDraftAuthoringPrompt\(result\)/);
  assert.doesNotMatch(draftBlock, /Review or edit the YAML/);
});

test("extension exposes model-callable manifest planning and confirmation-gated apply", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-init-tool-"));
  const draft = await createPersonaInitDraft(root, "init-data/setup.yaml");
  const authoredDraft = (await readFile(path.join(root, draft.source), "utf8"))
    .replace("Add the user's business facts, priorities, constraints, audience,\n      products, services, channels, and recurring decisions here.", "This workspace verifies Pi Persona onboarding and operation.")
    .replace("Replace this with the specialist's operating notes.", "Review onboarding and operational behavior against the test brief.")
    .replace("Replace with the specialist's routing description.", "Reviews onboarding and operation against the test brief.")
    .replace("You are the example specialist. Replace this with the specialist's role,\n      operating style, and expected output shape.", "You are the QA specialist. Return concrete pass and fail findings.");
  await writeText(path.join(root, draft.source), authoredDraft);
  const harness = await createExtensionHarness(root);
  const tool = harness.tools.get("persona_init");

  assert.ok(tool);
  const plan = await tool.execute("plan", {
    action: "plan",
    source: draft.source,
  }, undefined, undefined, harness.ctx);
  assert.equal(plan.details.mode, "plan");
  assert.match(plan.content[0].text, /Pi Persona Init Plan/);

  const unconfirmed = await tool.execute("apply", {
    action: "apply",
    source: draft.source,
  }, undefined, undefined, harness.ctx);
  assert.equal(unconfirmed.isError, true);
  assert.match(unconfirmed.content[0].text, /requires confirmed: true/);

  const applied = await tool.execute("apply", {
    action: "apply",
    source: draft.source,
    confirmed: true,
  }, undefined, undefined, harness.ctx);
  assert.notEqual(applied.isError, true);
  assert.match(applied.content[0].text, /Pi Persona Init Applied/);
  assert.match(applied.content[0].text, /Pi Persona Doctor/);
  assert.ok(["pass", "warning"].includes(applied.details.doctor.status));
  assert.deepEqual((await discoverPersonaProject(root)).agents.map((agent) => agent.name), [
    "example-specialist",
    "generalist",
  ]);
});

test("extension registers the persona_consult tool", async () => {
  const source = await readFile(path.join(process.cwd(), "extensions/pi-persona.ts"), "utf8");
  const consultToolBlock = source.slice(
    source.indexOf('name: "persona_consult"'),
    source.indexOf("const registerPersonaCommand"),
  );

  assert.match(source, /registerTool\(/);
  assert.match(source, /name:\s*"persona_consult"/);
  assert.match(consultToolBlock, /label:\s*"pi-persona"/);
  assert.match(source, /resolveConsultLaunchRequest/);
  assert.match(source, /extractConsultAnswer/);
  assert.match(source, /formatConsultBridgeResult/);
  assert.match(consultToolBlock, /runSubagentBridgeRequest/);
  assert.match(consultToolBlock, /extractConsultAnswer/);
  assert.match(consultToolBlock, /assertPersonaRuntimeReady/);
  assert.match(consultToolBlock, /createConsultProgressReporter/);
  assert.match(consultToolBlock, /renderCall/);
  assert.match(consultToolBlock, /renderResult/);
  assert.match(consultToolBlock, /keyHint\("app\.tools\.expand", "to expand"\)/);
  assert.doesNotMatch(consultToolBlock, /setStatus/);
  assert.doesNotMatch(consultToolBlock, /formatConsultSubagentInstructions/);
});

test("persona consult panel discloses query and context mode", async () => {
  const root = await createCommandWorkspace("researcher");
  const harness = await createExtensionHarness(root);
  const tool = harness.tools.get("persona_consult");
  const theme = {
    bold(value) { return value; },
    fg(_color, value) { return value; },
  };
  const args = {
    requester: "analyst",
    consultant: "researcher",
    question: "Find and verify Gemma 4 fine-tuning implementations.",
    summary: "The user needs practical recipes.",
    constraints: "Prefer primary sources.",
    expectedOutput: "A concise table.",
    context: "fork",
  };

  const expanded = tool.renderCall(args, theme, { expanded: true })
    .render(160)
    .map((line) => line.trimEnd())
    .join("\n");
  assert.match(expanded, /Consulting researcher/);
  assert.match(expanded, /Query: Find and verify Gemma 4 fine-tuning implementations\./);
  assert.match(expanded, /Context: fork · current conversation branch inherited/);
  assert.match(expanded, /Requester: analyst/);
  assert.match(expanded, /Summary:\nThe user needs practical recipes\./);
  assert.match(expanded, /Constraints:\nPrefer primary sources\./);
  assert.match(expanded, /Expected output:\nA concise table\./);

  const fresh = tool.renderCall({ ...args, context: "fresh" }, theme, { expanded: true })
    .render(160)
    .map((line) => line.trimEnd())
    .join("\n");
  assert.match(fresh, /Context: fresh · conversation history not included/);

  const partial = tool.renderResult({
    content: [{ type: "text", text: "[pi-persona] Consulting researcher\n\n4:12 elapsed · 10 tools" }],
  }, { expanded: false, isPartial: true }, theme)
    .render(160)
    .map((line) => line.trimEnd())
    .join("\n");
  assert.equal(partial, "4:12 elapsed · 10 tools");
});

test("round-table panel discloses query context panel reasons process and completion evidence", async () => {
  const root = await createCommandWorkspace("researcher");
  const harness = await createExtensionHarness(root);
  const tool = harness.tools.get("persona_roundtable");
  const theme = {
    bold(value) { return value; },
    fg(_color, value) { return value; },
  };
  const args = {
    query: "Should this extension ship?",
    selections: [
      { name: "critic", reason: "Checks explicit release gates." },
      { name: "researcher", reason: "Assesses evidence coverage." },
    ],
    context: "fresh",
  };

  const expanded = tool.renderCall(args, theme, { expanded: true })
    .render(160)
    .map((line) => line.trimEnd())
    .join("\n");
  assert.match(expanded, /Round-table · 2 specialists/);
  assert.match(expanded, /Query: Should this extension ship\?/);
  assert.match(expanded, /Context: fresh · specialists receive only resolved persona context/);
  assert.match(expanded, /critic — Checks explicit release gates\./);
  assert.match(expanded, /researcher — Assesses evidence coverage\./);
  assert.match(expanded, /1\. Independent positions/);
  assert.match(expanded, /3\. Primary-generalist synthesis/);

  const partial = tool.renderResult({
    content: [{ type: "text", text: "[pi-persona] Round-table\n\nPhase: moderator synthesis" }],
  }, { expanded: false, isPartial: true }, theme)
    .render(160)
    .map((line) => line.trimEnd())
    .join("\n");
  assert.equal(partial, "Phase: moderator synthesis");

  const completed = tool.renderResult({
    content: [{ type: "text", text: "Moderator synthesis" }],
    details: {
      process: {
        specialists: 2,
        rounds: 2,
        completedSteps: 5,
        expectedSteps: 5,
        elapsedMs: 65_000,
        toolCount: 29,
        turns: 12,
        categories: { files: 7 },
      },
    },
  }, { expanded: false, isPartial: false }, theme)
    .render(160)
    .map((line) => line.trimEnd())
    .join("\n");
  assert.match(completed, /✓ Round-table complete/);
  assert.match(completed, /2 specialists · 2 rounds · 5\/5 steps complete · 1:05 elapsed · 29 tools · 12 turns · 7 files/);
});

test("extension direct persona commands activate the current chat instead of the subagent bridge", async () => {
  const source = await readFile(path.join(process.cwd(), "extensions/pi-persona.ts"), "utf8");
  const commandBlock = source.slice(
    source.indexOf("const activatePersona"),
    source.indexOf("const registerProjectCommands"),
  );

  assert.match(commandBlock, /setActivePersona/);
  assert.match(commandBlock, /sendUserMessage/);
  assert.doesNotMatch(commandBlock, /runSubagentBridgeRequest/);
  assert.match(source, /before_agent_start/);
  assert.match(source, /\/persona status/);
  assert.match(source, /\/persona clear/);
});

test("canonical persona use launches names that cannot own direct aliases", async () => {
  const root = await createCommandWorkspace("persona");
  const harness = await createExtensionHarness(root);

  await harness.handlers.get("session_start")(null, harness.ctx);
  await harness.commands.get("persona").handler("use persona review this", harness.ctx);

  assert.equal(harness.entries.at(-1).data.agentName, "persona");
  assert.equal(harness.sentUserMessages.at(-1).message, "review this");
});

test("persona consult requires and matches the active requester", async () => {
  const root = await createCommandWorkspace("brand");
  const harness = await createExtensionHarness(root);
  const tool = harness.tools.get("persona_consult");
  const params = {
    requester: "brand",
    consultant: "generalist",
    question: "Review this.",
    summary: "Focused context.",
  };

  const inactive = await tool.execute("consult", params, undefined, undefined, harness.ctx);
  assert.equal(inactive.isError, true);
  assert.match(inactive.content[0].text, /requires an active persona/);

  await harness.commands.get("generalist").handler("", harness.ctx);
  const mismatch = await tool.execute("consult", params, undefined, undefined, harness.ctx);
  assert.equal(mismatch.isError, true);
  assert.match(mismatch.content[0].text, /requester must match active persona 'generalist'/);
});

test("successful consult runs through the extension adapter", async (t) => {
  const root = await createWorkspace();
  const agentDir = await mkdtemp(path.join(tmpdir(), "pi-persona-consult-runtime-"));
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  await writeText(
    path.join(agentDir, "npm/node_modules/pi-subagents/package.json"),
    `${JSON.stringify({ name: "pi-subagents", version: "0.34.0" })}\n`,
  );
  await writeText(path.join(agentDir, "settings.json"), `${JSON.stringify({ packages: ["npm:pi-subagents"] })}\n`);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    await rm(root, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  });

  const requests = [];
  const progressUpdates = [];
  const harness = await createExtensionHarness(root, {
    onSubagentRequest(request, events) {
      requests.push(request);
      events.emit("subagent:slash:started", { requestId: request.requestId });
      events.emit("subagent:slash:update", {
        requestId: request.requestId,
        progress: [{
          index: 0,
          agent: "guideline",
          status: "running",
          currentTool: "read",
          recentTools: [],
          toolCount: 1,
          turnCount: 1,
        }],
      });
      events.emit("subagent:slash:response", {
        requestId: request.requestId,
        isError: false,
        result: {
          content: [{
            type: "text",
            text: "Delivered single subagent result via intercom.\nFull grouped output was sent over intercom.",
          }],
          details: {
            results: [{ agent: "guideline", finalOutput: "Guideline approves with one revision." }],
          },
        },
      });
    },
  });

  await harness.handlers.get("session_start")(null, harness.ctx);
  await harness.commands.get("brand").handler("", harness.ctx);
  const result = await harness.tools.get("persona_consult").execute(
    "consult",
    {
      requester: "brand",
      consultant: "guideline",
      question: "Review the proposed brand direction.",
      summary: "The brand persona needs a guideline check.",
    },
    undefined,
    (update) => progressUpdates.push(update),
    harness.ctx,
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].params.agent, "guideline");
  assert.equal(requests[0].params.context, "fresh");
  assert.ok(requests[0].params.reads.includes("docs/shared/company.md"));
  assert.ok(requests[0].params.reads.includes("docs/workstreams/guideline/rules.md"));
  assert.deepEqual(requests[0].params.skill, ["shared-skill", "guideline-skill"]);
  assert.ok(progressUpdates.some((update) => update.content[0].text.includes("Consulting guideline")));
  assert.notEqual(result.isError, true);
  assert.match(result.content[0].text, /Guideline approves with one revision/);
  assert.match(result.content[0].text, /Consulted:/);
  assert.doesNotMatch(result.content[0].text, /Delivered single subagent result/);
});

test("extension bootstraps /generalist before project agents exist", async () => {
  const source = await readFile(path.join(process.cwd(), "extensions/pi-persona.ts"), "utf8");
  const bootstrapIndex = source.indexOf('registerPersonaCommand("generalist")');
  const sessionStartIndex = source.indexOf('pi.on("session_start"');

  assert.ok(bootstrapIndex >= 0);
  assert.ok(bootstrapIndex < sessionStartIndex);
  assert.match(source, /\/persona init/);
  assert.match(source, /No Pi Persona `\/generalist` agent found/);
});

test("extension rejects stale direct persona commands in the current workspace", async () => {
  const workspaceA = await createCommandWorkspace("brand");
  const workspaceB = await createCommandWorkspace();
  const harness = await createExtensionHarness(workspaceA);

  await harness.handlers.get("session_start")(null, harness.ctx);
  assert.ok(harness.commands.has("brand"));

  harness.ctx.cwd = workspaceB;
  await harness.handlers.get("session_start")(null, harness.ctx);
  await harness.commands.get("brand").handler("", harness.ctx);

  assert.match(
    harness.messages.at(-1).content,
    /\/brand is not available in this workspace\. Run \/persona-list\./,
  );
  assert.ok(!harness.entries.some((entry) => entry.data?.agentName === "brand"));
});

test("extension clears restored active persona state when it is unavailable", async () => {
  const workspaceA = await createCommandWorkspace("ops");
  const workspaceB = await createCommandWorkspace();
  const harness = await createExtensionHarness(workspaceA);

  await harness.handlers.get("session_start")(null, harness.ctx);
  await harness.commands.get("ops").handler("", harness.ctx);
  assert.ok(harness.entries.some((entry) => entry.data?.agentName === "ops"));

  harness.ctx.cwd = workspaceB;
  const result = await harness.handlers.get("before_agent_start")(
    { systemPrompt: "base prompt" },
    harness.ctx,
  );

  assert.equal(harness.entries.at(-1).data.agentName, null);
  assert.match(result.systemPrompt, /Previously active persona \/ops is not available in this workspace/);
  assert.equal(harness.statuses.at(-1).value, undefined);
});

test("extension registers persona-roundtable as a namespaced command and model-callable tool", async () => {
  const source = await readFile(path.join(process.cwd(), "extensions/pi-persona.ts"), "utf8");

  assert.match(source, /registerCommand\("persona-roundtable"/);
  assert.doesNotMatch(source, /registerCommand\("roundtable"/);
  assert.match(source, /name:\s*"persona_roundtable"/);
  assert.match(source, /createRoundtableProgressReporter/);
  assert.match(source, /onUpdate/);
  assert.match(source, /assertPersonaRuntimeReady/);
  assert.match(source, /resolveRoundtableSelectionRequest/);
  assert.match(source, /extractRoundtableAnswer/);
});

test("extension preflights runtime dependencies before bridge execution", async () => {
  const source = await readFile(path.join(process.cwd(), "extensions/pi-persona.ts"), "utf8");
  const consultToolBlock = source.slice(
    source.indexOf('name: "persona_consult"'),
    source.indexOf("const registerPersonaCommand"),
  );
  const roundtableToolBlock = source.slice(
    source.indexOf('name: "persona_roundtable"'),
    source.indexOf("const activatePersona"),
  );
  const roundtableCommandBlock = source.slice(
    source.indexOf('pi.registerCommand("persona-roundtable"'),
    source.indexOf("function normalizeCommandText"),
  );

  assert.ok(consultToolBlock.indexOf("assertPersonaRuntimeReady") >= 0);
  assert.ok(roundtableToolBlock.indexOf("assertPersonaRuntimeReady") >= 0);
  assert.ok(consultToolBlock.indexOf("assertPersonaRuntimeReady") < consultToolBlock.indexOf("runSubagentBridgeRequest"));
  assert.ok(roundtableToolBlock.indexOf("assertPersonaRuntimeReady") < roundtableToolBlock.indexOf("runSubagentBridgeRequest"));
  assert.equal(roundtableToolBlock.match(/runSubagentBridgeRequest/g)?.length, 1);
  assert.doesNotMatch(roundtableCommandBlock, /runSubagentBridgeRequest/);
});

test("roundtable command delegates selection to the primary generalist and the tool emits one bridge request", async (t) => {
  const root = await createWorkspace();
  const agentDir = await mkdtemp(path.join(tmpdir(), "pi-persona-roundtable-runtime-"));
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  await writeText(
    path.join(agentDir, "npm/node_modules/pi-subagents/package.json"),
    `${JSON.stringify({ name: "pi-subagents", version: "0.34.0" })}\n`,
  );
  await writeText(path.join(agentDir, "settings.json"), `${JSON.stringify({ packages: ["npm:pi-subagents"] })}\n`);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  });
  const requests = [];
  const progressUpdates = [];
  const harness = await createExtensionHarness(root, {
    onSubagentRequest(request, events) {
      requests.push(request);
      events.emit("subagent:slash:started", { requestId: request.requestId });
      events.emit("subagent:slash:update", {
        requestId: request.requestId,
        progress: [
          {
            index: 0,
            agent: "brand",
            status: "running",
            currentTool: "search_web",
            currentToolArgs: "Gemma OCR benchmarks",
            recentTools: [],
            toolCount: 3,
            turnCount: 2,
            tokens: 1200,
          },
          {
            index: 1,
            agent: "guideline",
            status: "completed",
            recentTools: [],
            toolCount: 2,
            turnCount: 1,
            tokens: 800,
          },
        ],
      });
      events.emit("subagent:slash:response", {
        requestId: request.requestId,
        isError: false,
        result: {
          content: [{ type: "text", text: "Delivered chain subagent results via intercom.\nFull grouped output was sent over intercom." }],
          details: {
            mode: "chain",
            results: [
              { agent: "brand", exitCode: 0, finalOutput: "Brand position" },
              { agent: "guideline", exitCode: 0, finalOutput: "Guideline position" },
              { agent: "brand", exitCode: 0, finalOutput: "Revised brand position" },
              { agent: "guideline", exitCode: 0, finalOutput: "Revised guideline position" },
              { agent: "generalist", exitCode: 0, finalOutput: "Choose the model that wins on your representative OCR set." },
            ],
          },
        },
      });
    },
  });

  await harness.commands.get("persona-roundtable").handler("Compare Gemma models", harness.ctx);

  assert.equal(harness.entries.at(-1).data.agentName, "generalist");
  assert.match(harness.sentUserMessages.at(-1).message, /Compare Gemma models/);
  assert.match(harness.sentUserMessages.at(-1).message, /Call `persona_roundtable` exactly once/);
  assert.equal(requests.length, 0);

  const tool = harness.tools.get("persona_roundtable");
  const mismatch = await tool.execute(
    "roundtable-mismatch",
    {
      query: "A different query",
      selections: [{ name: "brand", reason: "Compare positioning trade-offs." }],
    },
    undefined,
    undefined,
    harness.ctx,
  );
  assert.equal(mismatch.isError, true);
  assert.match(mismatch.content[0].text, /query must match.*unchanged/);
  assert.equal(requests.length, 0);

  const result = await tool.execute(
    "roundtable",
    {
      query: "Compare Gemma models",
      selections: [
        { name: "brand", reason: "Compare positioning trade-offs." },
        { name: "guideline", reason: "Check evidence quality." },
      ],
    },
    undefined,
    (update) => progressUpdates.push(update),
    harness.ctx,
  );

  assert.equal(requests.length, 1);
  assert.equal("resultDelivery" in requests[0].params, false);
  assert.deepEqual(requests[0].params.chain.map((step) => step.phase), ["Round 1", "Round 2", "Synthesis"]);
  assert.match(progressUpdates.at(-1).content[0].text, /Round 1/);
  assert.match(progressUpdates.at(-1).content[0].text, /5 tools/);
  assert.notEqual(result.isError, true);
  assert.match(result.content[0].text, /Choose the model that wins/);
  assert.doesNotMatch(result.content[0].text, /Delivered chain subagent results via intercom/);
  assert.equal(result.details.process.specialists, 2);
  assert.equal(result.details.process.completedSteps, 5);
  assert.equal(result.details.process.expectedSteps, 5);

  const repeated = await tool.execute(
    "roundtable-repeat",
    {
      query: "Compare Gemma models",
      selections: [{ name: "brand", reason: "Compare positioning trade-offs." }],
    },
    undefined,
    undefined,
    harness.ctx,
  );
  assert.equal(repeated.isError, true);
  assert.match(repeated.content[0].text, /requires a pending \/persona-roundtable request/);
  assert.equal(requests.length, 1);
});

test("extension stores active persona state for direct persona mode", async () => {
  const source = await readFile(path.join(process.cwd(), "extensions/pi-persona.ts"), "utf8");
  const beforeAgentStartBlock = source.slice(
    source.indexOf('pi.on("before_agent_start"'),
    source.indexOf('pi.registerCommand("persona"'),
  );
  const statusBlock = source.slice(
    source.indexOf('if (subcommand === "status")'),
    source.indexOf('if (subcommand === "clear")'),
  );

  assert.match(source, /ACTIVE_PERSONA_STATE_TYPE/);
  assert.match(source, /appendEntry\(ACTIVE_PERSONA_STATE_TYPE/);
  assert.match(source, /restoreActivePersona/);
  assert.match(source, /getBranch\?\.\(\)/);
  assert.match(source, /resetIfMissing/);
  assert.match(source, /before_agent_start/);
  assert.match(source, /pi-persona-active/);
  assert.match(statusBlock, /restoreActivePersona\(ctx\)/);
  assert.match(beforeAgentStartBlock, /restoreActivePersona\(ctx\)/);
  assert.match(beforeAgentStartBlock, /updateActivePersonaStatus\(ctx\)/);
  assert.doesNotMatch(source, /createPersonaLaunchProgress/);
});

test("extension does not register persona orchestration inside pi-subagents child sessions", async () => {
  const source = await readFile(path.join(process.cwd(), "extensions/pi-persona.ts"), "utf8");
  const guardIndex = source.indexOf("PI_SUBAGENT_CHILD");
  const firstRegistrationIndex = Math.min(
    source.indexOf("pi.registerTool"),
    source.indexOf("pi.registerCommand"),
    source.indexOf('pi.on("session_start"'),
    source.indexOf('pi.on("before_agent_start"'),
  );

  assert.ok(guardIndex >= 0);
  assert.ok(guardIndex < firstRegistrationIndex);
  assert.match(source, /if\s*\([^)]*PI_SUBAGENT_CHILD[^)]*\)\s*return/);
});

test("active persona prompt treats raw subagent discovery as outside persona consults", async () => {
  const root = await createWorkspace();

  const launch = await resolveAgentLaunchRequest(root, "generalist");

  assert.match(launch.systemPrompt, /persona_consult/);
  assert.match(launch.systemPrompt, /Known personas:/);
  assert.match(launch.systemPrompt, /Do not use raw `subagent list` to discover Pi Persona consultants/);
  assert.match(launch.systemPrompt, /Raw `subagent` launches are global Pi runtime behavior/);
});

test("docs document active persona footer and global subagent list behavior", async () => {
  const docs = [
    await readFile(path.join(process.cwd(), "README.md"), "utf8"),
    await readFile(path.join(process.cwd(), "docs/_about_pi_persona/blueprint.md"), "utf8"),
    await readFile(path.join(process.cwd(), "docs/_about_pi_persona/design.md"), "utf8"),
  ].join("\n");

  assert.match(docs, /pi-persona-active/);
  assert.match(docs, /powerline\.customItems/);
  assert.match(docs, /npm:pi-powerline-footer/);
  assert.match(docs, /`subagent list` lists global Pi subagents/);
  assert.match(docs, /`persona_consult` only accepts project Pi Persona agents/);
  assert.match(docs, /bootstrap command/);
  assert.match(docs, /falling through as ordinary prompt text/);
  assert.match(docs, /pi install npm:pi-subagents/);
  assert.doesNotMatch(docs, /pi install npm:pi-intercom/);
  assert.match(docs, /runtime preflight/);
  assert.match(docs, /PI_SUBAGENT_CHILD/);
  assert.match(docs, /leaf task/);
  assert.match(docs, /\/persona use <name>/);
  assert.match(docs, /schema-validated selection/);
  assert.match(docs, /no extension-owned telemetry/i);
  assert.doesNotMatch(docs, /child supervisor/);
  assert.doesNotMatch(docs, /blocked children/);
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

test("doctor validates dependencies, docs, skill misuse, duplicate names, and generalist count", async () => {
  const root = await createWorkspace();

  await writeText(path.join(root, ".pi/agents/duplicate.md"), `---
name: brand
role: specialist
description: Duplicate brand name.
docs: docs/missing/
skills: .pi/skills/missing/
---
Duplicate prompt.
`);

  await writeText(path.join(root, ".pi/agents/another-generalist.md"), `---
name: second-generalist
role: generalist
primary: true
description: Extra generalist.
docs: docs/shared/
---
Second generalist prompt.
`);

  await writeText(path.join(root, ".pi/agents/_bad-control.md"), `---
name: bad-control
description: This control file is accidentally launchable.
---
Bad control prompt.
`);

  const result = await runDoctor(root, {
    dependencyStatus: {
      piSubagents: { ok: true, version: "0.34.0", path: "/tmp/pi-subagents" },
      piIntercom: { ok: true, version: "0.6.0", path: "/tmp/pi-intercom" },
    },
  });

  const messages = result.issues.map((issue) => issue.message);
  assert.equal(result.status, "error");
  assert.ok(messages.some((message) => message.includes("duplicate agent name 'brand'")));
  assert.ok(messages.some((message) => message.includes("multiple primary generalist agents")));
  assert.ok(messages.some((message) => message.includes("Set exactly one generalist to primary: true")));
  assert.ok(messages.some((message) => message.includes("docs path does not exist: docs/missing/")));
  assert.ok(messages.some((message) => message.includes("skills entry looks like a path")));
  assert.ok(messages.some((message) => message.includes(".pi/skills/missing/")));
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

test("doctor reports legacy tools consults and tags as migration warnings", async () => {
  const root = await createWorkspace();

  await writeText(path.join(root, ".pi/agents/legacy.md"), `---
name: legacy
role: specialist
description: Legacy metadata specialist.
tools: read, subagent, persona_consult
consults: guideline
tags: brand, voice
---
Legacy prompt.
`);

  const result = await runDoctor(root, {
    dependencyStatus: {
      piSubagents: { ok: true, version: "0.34.0", path: "/tmp/pi-subagents" },
      piIntercom: { ok: true, version: "0.6.0", path: "/tmp/pi-intercom" },
    },
  });

  assert.equal(result.status, "warning");
  assert.ok(result.issues.some((issue) => issue.message.includes("legacy field tools found; migrate tool-use guidance to native pi-subagents skills")));
  assert.ok(result.issues.some((issue) => issue.message.includes("legacy field consults found; route by agent descriptions instead")));
  assert.ok(result.issues.some((issue) => issue.message.includes("legacy field tags found; prefer high-signal descriptions")));
});

test("doctor warns when skills are path-style instead of native names", async () => {
  const root = await createWorkspace();

  await writeText(path.join(root, ".pi/agents/brand.md"), `---
name: brand
role: specialist
description: Brand strategy specialist.
docs: docs/workstreams/brand/
skills: .pi/skills/workstreams/empty/
---
Brand prompt.
`);

  const result = await runDoctor(root, {
    dependencyStatus: {
      piSubagents: { ok: true, version: "0.34.0", path: "/tmp/pi-subagents" },
      piIntercom: { ok: true, version: "0.6.0", path: "/tmp/pi-intercom" },
    },
  });

  assert.equal(result.status, "warning");
  assert.ok(result.issues.some((issue) => issue.message.includes(".pi/agents/brand.md: skills entry looks like a path")));
  assert.ok(result.issues.some((issue) => issue.message.includes(".pi/skills/workstreams/empty/")));
});

test("doctor detects the default pi-subagents dependency from PI_CODING_AGENT_DIR", async () => {
  const root = await createWorkspace();
  const agentDir = await mkdtemp(path.join(tmpdir(), "pi-persona-agent-dir-"));
  await writeText(
    path.join(agentDir, "npm/node_modules/pi-subagents/package.json"),
    `${JSON.stringify({ version: "9.9.1" })}\n`,
  );

  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const result = await runDoctor(root);
    assert.equal(result.dependencies.piSubagents.version, "9.9.1");
  } finally {
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
  }
});

test("doctor detects runtime package configuration from user settings", async () => {
  const root = await createWorkspace();
  const agentDir = await mkdtemp(path.join(tmpdir(), "pi-persona-agent-dir-"));
  await writeText(
    path.join(agentDir, "npm/node_modules/pi-subagents/package.json"),
    `${JSON.stringify({ version: "9.9.1" })}\n`,
  );
  await writeText(path.join(agentDir, "settings.json"), `${JSON.stringify({ packages: ["npm:pi-subagents"] })}\n`);

  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const result = await runDoctor(root);
    assert.equal(result.dependencies.piSubagents.configured, true);
    assert.match(formatDoctorReport(result), /pi-subagents: 9\.9\.1 at .*configured/);
  } finally {
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
  }
});

test("runtime duplicate repair keeps one global pi-subagents package and preserves settings", async () => {
  const root = await createWorkspace();
  const agentDir = await mkdtemp(path.join(tmpdir(), "pi-persona-agent-dir-"));
  const globalSettings = path.join(agentDir, "settings.json");
  const projectSettings = path.join(root, ".pi/settings.json");
  await writeText(globalSettings, `${JSON.stringify({
    theme: "dark",
    packages: ["npm:pi-subagents", "npm:other", "npm:pi-subagents"],
  }, null, 2)}\n`);
  await writeText(projectSettings, `${JSON.stringify({
    packages: ["file:/workspace/pi-personas", "npm:pi-subagents"],
    projectSetting: true,
  }, null, 2)}\n`);

  const repairs = await repairRuntimePackageDuplicates(root, { agentDir });

  assert.equal(repairs.length, 2);
  assert.deepEqual((await readJson(globalSettings)).packages, ["npm:pi-subagents", "npm:other"]);
  assert.deepEqual((await readJson(projectSettings)).packages, ["file:/workspace/pi-personas"]);
  assert.equal((await readJson(projectSettings)).projectSetting, true);
  assert.deepEqual((await readJson(`${projectSettings}.pi-personas.bak`)).packages, [
    "file:/workspace/pi-personas",
    "npm:pi-subagents",
  ]);
  assert.deepEqual(await repairRuntimePackageDuplicates(root, { agentDir }), []);
});

test("runtime duplicate repair preserves private settings permissions", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-private-settings-"));
  const agentDir = await mkdtemp(path.join(tmpdir(), "pi-persona-private-agent-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  });
  const settingsPath = path.join(root, ".pi/settings.json");
  await writeText(settingsPath, `${JSON.stringify({
    packages: ["npm:pi-subagents", "github:example/pi-subagents"],
  })}\n`);
  await chmod(settingsPath, 0o600);

  await repairRuntimePackageDuplicates(root, { agentDir });

  assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
  assert.equal((await stat(`${settingsPath}.pi-personas.bak`)).mode & 0o777, 0o600);
  assert.equal(
    (await readdir(path.dirname(settingsPath))).some((name) => name.endsWith(".tmp")),
    false,
  );
});

test("runtime preflight repairs duplicates before a consult can launch", async () => {
  const root = await createWorkspace();
  const agentDir = await mkdtemp(path.join(tmpdir(), "pi-persona-agent-dir-"));
  await writeText(
    path.join(agentDir, "npm/node_modules/pi-subagents/package.json"),
    `${JSON.stringify({ version: "9.9.1" })}\n`,
  );
  await writeText(path.join(agentDir, "settings.json"), `${JSON.stringify({ packages: ["npm:pi-subagents"] })}\n`);
  await writeText(path.join(root, ".pi/settings.json"), `${JSON.stringify({ packages: ["npm:pi-subagents"] })}\n`);

  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await assert.rejects(() => assertPersonaRuntimeReady(root), /repaired duplicate pi-subagents configuration.*Reload Pi/);
    await assert.doesNotReject(() => assertPersonaRuntimeReady(root));
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
});

test("consult progress reports observable activity and idle countdown", () => {
  const tracker = createConsultProgressTracker("researcher", { startedAt: 0, idleTimeoutMs: 180_000 });
  tracker.update({
    progress: [{
      agent: "researcher",
      status: "running",
      currentTool: "read_webpage",
      currentToolArgs: "https://example.com/a very long page",
      recentTools: [
        { tool: "search_web", args: "gemma", endMs: 1 },
        { tool: "read_webpage", args: "https://example.com", endMs: 2 },
        { tool: "read_github_file", args: "owner/repo/config.yaml", endMs: 3 },
      ],
      toolCount: 3,
      turnCount: 2,
      tokens: 1_500,
      failedTool: "read_webpage",
      lastActivityAt: 10_000,
    }],
  }, 10_000);

  const text = tracker.format(130_000);
  assert.match(text, /\[pi-persona\] Consulting researcher/);
  assert.match(text, /2:10 elapsed · active 2:00 ago · 3 tools · 2 sources · 1 recoverable errors · 2 turns · 1\.5k tokens/);
  assert.match(text, /Now: read_webpage · https:\/\/example\.com/);
  assert.match(text, /1 searches · 1 webpages · 1 repository/);
  assert.match(text, /cancelling in 1:00 unless activity resumes/);
});

test("doctor warns but keeps direct mode available when pi-subagents is missing", async () => {
  const root = await createWorkspace();

  const result = await runDoctor(root, {
    dependencyStatus: {
      piSubagents: { ok: false, path: "/tmp/pi-subagents" },
      piIntercom: { ok: false, path: "/tmp/pi-intercom" },
    },
  });

  assert.equal(result.status, "warning");
  assert.ok(result.issues.some((issue) => issue.severity === "warning" && issue.message.includes("pi-subagents missing; consults and round-tables are unavailable")));
});

test("doctor warns when runtime packages are installed but not configured", async () => {
  const root = await createWorkspace();

  const result = await runDoctor(root, {
    dependencyStatus: {
      piSubagents: { ok: true, configured: false, version: "0.33.1", path: "/tmp/pi-subagents", packageSource: "npm:pi-subagents" },
      piIntercom: { ok: true, configured: false, version: "0.6.0", path: "/tmp/pi-intercom", packageSource: "npm:pi-intercom" },
    },
  });

  assert.equal(result.status, "warning");
  assert.match(formatDoctorReport(result), /pi-subagents: 0\.33\.1 at \/tmp\/pi-subagents \(not configured in Pi settings\)/);
  assert.ok(result.issues.some((issue) => issue.message.includes("pi-subagents installed but not configured in Pi settings; run `pi install npm:pi-subagents`")));
});

test("runtime dependency preflight returns install and configuration guidance", async () => {
  await assert.rejects(
    () => assertPersonaRuntimeReady("/tmp/example", {
      dependencyStatus: {
        piSubagents: { ok: true, configured: false, version: "0.33.1", path: "/tmp/pi-subagents", packageSource: "npm:pi-subagents" },
        piIntercom: { ok: false, configured: false, path: "/tmp/pi-intercom", packageSource: "npm:pi-intercom" },
      },
    }),
    (error) => {
      assert.match(error.message, /Pi Persona consults and round-tables require runtime packages/);
      assert.match(error.message, /pi-subagents is installed but not configured/);
      assert.match(error.message, /pi install npm:pi-subagents/);
      assert.doesNotMatch(error.message, /pi-intercom/);
      return true;
    },
  );
});

test("doctor warns about unsupported round-table runtimes and round-table preflight rejects them", async () => {
  const root = await createWorkspace();
  const dependencyStatus = {
    piSubagents: { ok: true, configured: true, version: "0.33.1", path: "/tmp/pi-subagents", packageSource: "npm:pi-subagents" },
  };

  const doctor = await runDoctor(root, { dependencyStatus });
  assert.equal(doctor.status, "warning");
  assert.ok(doctor.issues.some((issue) => issue.message.includes("older than the supported round-table runtime")));

  await assert.rejects(
    () => assertPersonaRuntimeReady(root, {
      dependencyStatus,
      minimumPiSubagentsVersion: "0.34.0",
    }),
    /pi-subagents 0\.33\.1 is incompatible; round-tables require >=0\.34\.0/,
  );

  await assert.doesNotReject(() => assertPersonaRuntimeReady(root, { dependencyStatus }));
});

test("doctor rejects unresolved onboarding placeholders in personas and declared docs", async () => {
  const root = await createWorkspace();
  await writeText(path.join(root, "docs/shared/company.md"), "# Spec\n\nadd the behavior or spec under test here\n");
  await writeText(path.join(root, ".pi/agents/brand.md"), `---
name: brand
role: specialist
description: Replace with the specialist's routing description.
docs: docs/workstreams/brand/
---
Replace this with the specialist's operating notes.
`);

  const result = await runDoctor(root, {
    dependencyStatus: {
      piSubagents: { ok: true, configured: true, version: "0.34.0", path: "/tmp/pi-subagents" },
    },
  });

  assert.equal(result.status, "error");
  assert.ok(result.issues.some((issue) => issue.message.includes(".pi/agents/brand.md: unresolved template placeholder")));
  assert.ok(result.issues.some((issue) => issue.message.includes("docs/shared/company.md: unresolved template placeholder")));
});

test("doctor does not require per-persona subagent runtime provisioning", async () => {
  const root = await createWorkspace();

  await writeText(path.join(root, ".pi/agents/manual.md"), `---
name: manual
role: specialist
description: Manually created specialist.
docs: docs/shared/
skills: shared-skill
---
Manual prompt.
`);

  const result = await runDoctor(root, {
    dependencyStatus: {
      piSubagents: { ok: true, version: "0.34.0", path: "/tmp/pi-subagents" },
      piIntercom: { ok: true, version: "0.6.0", path: "/tmp/pi-intercom" },
    },
  });

  assert.equal(result.status, "pass");
  assert.equal(result.issues.some((issue) => issue.message.includes("nested persona consults need project runtime override")), false);
});

test("doctor treats legacy tools subagent as metadata to migrate, not required provisioning", async () => {
  const root = await createWorkspace();

  await writeText(path.join(root, ".pi/agents/manual.md"), `---
name: manual
role: specialist
description: Manually created specialist.
tools: subagent
docs: docs/shared/
skills: shared-skill
---
Manual prompt.
`);

  const result = await runDoctor(root, {
    dependencyStatus: {
      piSubagents: { ok: true, version: "0.34.0", path: "/tmp/pi-subagents" },
      piIntercom: { ok: true, version: "0.6.0", path: "/tmp/pi-intercom" },
    },
  });
  const manualIssues = result.issues.filter((issue) => issue.file === ".pi/agents/manual.md");

  assert.equal(result.status, "warning");
  assert.ok(manualIssues.some((issue) => issue.message.includes("legacy field tools found")));
  assert.equal(manualIssues.some((issue) => issue.message.includes("nested persona consults need project runtime override")), false);
});

test("resolver preview merges baseline and agent awareness while deriving runtime fields", async () => {
  const root = await createWorkspace();

  const preview = await resolveAgentPreview(root, "brand");

  assert.deepEqual(preview.docs, [
    "docs/shared/",
    "docs/workstreams/brand/",
  ]);
  assert.deepEqual(preview.skills, [
    "shared-skill",
    "brand-skill",
  ]);
  assert.deepEqual(preview.agentRoster.map((agent) => agent.name), [
    "brand",
    "generalist",
    "guideline",
  ]);
  assert.deepEqual(preview.derived.defaultReads, [
    "docs/shared/company.md",
    "docs/workstreams/brand/brief.md",
  ]);
  assert.equal(Object.hasOwn(preview.agent.frontmatter, "defaultReads"), false);
  assert.equal(Object.hasOwn(preview.agent.frontmatter, "systemPromptMode"), false);
});

test("resolver expands directory docs through progressive discovery reads", async () => {
  const root = await createWorkspace();
  await writeText(path.join(root, "docs/workstreams/brand/_index.md"), "Brand index\n");
  await writeText(path.join(root, "docs/workstreams/brand/examples/example.md"), "Brand example doc\n");

  const scope = await resolveAgentScope(root, "brand");

  assert.deepEqual(scope.docs, [
    "docs/shared/",
    "docs/workstreams/brand/",
  ]);
  assert.deepEqual(scope.derived.defaultReads, [
    "docs/shared/company.md",
    "docs/workstreams/brand/_index.md",
    "docs/workstreams/brand/brief.md",
  ]);
  assert.deepEqual(scope.derived.docManifest, [
    {
      declared: "docs/shared/",
      files: ["docs/shared/company.md"],
      deferred: [],
      indexFile: null,
    },
    {
      declared: "docs/workstreams/brand/",
      files: [
        "docs/workstreams/brand/_index.md",
        "docs/workstreams/brand/brief.md",
      ],
      deferred: [
        "docs/workstreams/brand/examples/example.md",
      ],
      indexFile: "docs/workstreams/brand/_index.md",
    },
  ]);

  const launch = buildAgentLaunchRequest(scope, { task: "Use progressive docs." });
  assert.match(launch.systemPrompt, /Progressive doc discovery:/);
  assert.match(launch.systemPrompt, /docs\/workstreams\/brand\/: 1 nested file not included in reads; read docs\/workstreams\/brand\/_index\.md/);
  assert.doesNotMatch(launch.systemPrompt.split("\n\n")[0], /examples\/example\.md/);
});

test("doctor warns when nested directory docs have no index", async () => {
  const root = await createWorkspace();
  await writeText(path.join(root, "docs/workstreams/brand/examples/example.md"), "Brand example doc\n");

  const result = await runDoctor(root, {
    dependencyStatus: {
      piSubagents: { ok: true, version: "0.34.0", path: "/tmp/pi-subagents" },
      piIntercom: { ok: true, version: "0.6.0", path: "/tmp/pi-intercom" },
    },
  });

  assert.equal(result.status, "warning");
  assert.ok(result.issues.some((issue) => issue.message.includes("docs/workstreams/brand/ has 1 nested docs but no _index.md")));
  assert.ok(result.issues.some((issue) => issue.message.includes("run /persona index docs/workstreams/brand/")));
});

test("launch prompt reports deferred nested docs even when nothing is included in reads", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-nested-only-"));

  await writeText(path.join(root, ".pi/agents/nested.md"), `---
name: nested
role: specialist
description: Nested docs specialist.
docs: docs/nested/
---
Nested prompt.
`);
  await writeText(path.join(root, "docs/nested/deep/example.md"), "Deep doc\n");

  const scope = await resolveAgentScope(root, "nested");
  const launch = buildAgentLaunchRequest(scope, { task: "Find deep docs." });

  assert.equal(launch.subagentParams, undefined);
  assert.match(launch.systemPrompt, /\[Read from: none\]/);
  assert.match(launch.systemPrompt, /Progressive doc discovery:/);
  assert.match(launch.systemPrompt, /docs\/nested\/: 1 nested file not included in reads; no _index file was found/);
});

test("persona docs index preserves hand notes while refreshing generated catalogue", async () => {
  const root = await createWorkspace();
  await writeText(path.join(root, "docs/workstreams/brand/_index.md"), "# Brand Notes\n\nHuman note.\n");
  await writeText(path.join(root, "docs/workstreams/brand/examples/example.md"), "Brand example doc\n");

  assert.deepEqual(parsePersonaIndexArgs("docs/workstreams/brand/"), {
    all: false,
    target: "docs/workstreams/brand/",
  });
  assert.deepEqual(parsePersonaIndexArgs("--all"), {
    all: true,
    target: null,
  });

  const result = await createDocsIndex(root, { target: "docs/workstreams/brand/" });
  const report = formatDocsIndexReport(result);
  const content = await readFile(path.join(root, "docs/workstreams/brand/_index.md"), "utf8");

  assert.match(report, /updated docs\/workstreams\/brand\/_index\.md/);
  assert.match(report, /top-level files: 2/);
  assert.match(report, /nested files: 1/);
  assert.match(content, /Human note\./);
  assert.match(content, /<!-- pi-persona-index:start -->/);
  assert.match(content, /`_index\.md`/);
  assert.match(content, /`brief\.md`/);
  assert.match(content, /`examples\/example\.md`/);
  assert.match(content, /<!-- pi-persona-index:end -->/);

  await writeText(path.join(root, "docs/workstreams/guideline/examples/example.md"), "Guideline example doc\n");
  const created = await createDocsIndex(root, { target: "docs/workstreams/guideline/" });
  const createdContent = await readFile(path.join(root, "docs/workstreams/guideline/_index.md"), "utf8");
  assert.match(formatDocsIndexReport(created), /top-level files: 2/);
  assert.match(createdContent, /`_index\.md`/);
  assert.match(createdContent, /`rules\.md`/);
  assert.match(createdContent, /`examples\/example\.md`/);
});

test("persona argument parsers share shell-like quote handling", async () => {
  assert.deepEqual(parsePersonaIndexArgs('"docs/workstreams/brand assets/"'), {
    all: false,
    target: "docs/workstreams/brand assets/",
  });
  assert.equal(
    parsePersonaNewArgs('Brand --description "Brand reviewer"').options.description,
    "Brand reviewer",
  );
  assert.deepEqual(parsePersonaInitArgs("--from 'init-data/my layer.yaml'"), {
    mode: "apply",
    from: "init-data/my layer.yaml",
  });

  assert.throws(() => parsePersonaIndexArgs('"unfinished'), /persona index arguments/);
  assert.throws(() => parsePersonaNewArgs('Brand --description "unfinished'), /persona new arguments/);
  assert.throws(() => parsePersonaInitArgs('--from "unfinished'), /persona init arguments/);

  const { tokenizeArgs } = await import("../src/persona/command-args.js");
  assert.deepEqual(tokenizeArgs('one "" two', "unterminated"), ["one", "", "two"]);
});

test("formats doctor report with actionable sections", async () => {
  const root = await createWorkspace();
  const result = await runDoctor(root, {
    dependencyStatus: {
      piSubagents: { ok: true, version: "0.34.0", path: "/tmp/pi-subagents" },
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
docs: docs/shared/
---
Missing description prompt.
`);

  await writeText(path.join(root, ".pi/agents/unknown-role.md"), `---
name: unknown-role
role: executive
description: Invalid role.
docs: docs/shared/
---
Unknown role prompt.
`);

  await writeText(path.join(root, ".pi/agents/runtime-leak.md"), `---
name: runtime-leak
role: specialist
description: Agent with runtime-only fields.
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
docs: docs/shared/
---
Specialist primary prompt.
`);

  await writeText(path.join(root, ".pi/agents/string-primary.md"), `---
name: string-primary
role: generalist
primary: "true"
description: Generalist with invalid primary value.
docs: docs/shared/
---
String primary prompt.
`);

  const result = await runDoctor(root, {
    dependencyStatus: {
      piSubagents: { ok: true, version: "0.34.0", path: "/tmp/pi-subagents" },
      piIntercom: { ok: true, version: "0.6.0", path: "/tmp/pi-intercom" },
    },
  });

  const messages = result.issues.map((issue) => issue.message);
  assert.equal(result.status, "error");
  assert.ok(messages.some((message) => message.includes("missing required field 'description'")));
  assert.ok(messages.some((message) => message.includes("unknown role 'executive'")));
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
docs: docs/brand/
---
Brand prompt.
`);

  await writeText(path.join(root, "docs/brand/brief.md"), "Brand doc\n");

  const result = await runDoctor(root, {
    dependencyStatus: {
      piSubagents: { ok: true, version: "0.34.0", path: "/tmp/pi-subagents" },
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
---
Backup generalist prompt.
`);

  const result = await runDoctor(root, {
    dependencyStatus: {
      piSubagents: { ok: true, version: "0.34.0", path: "/tmp/pi-subagents" },
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
---
Backup generalist prompt.
`);

  const result = await runDoctor(root, {
    dependencyStatus: {
      piSubagents: { ok: true, version: "0.34.0", path: "/tmp/pi-subagents" },
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
docs: docs/shared/
---
Worker prompt.
`);

  const project = await discoverPersonaProject(root);
  const result = await runDoctor(root, {
    dependencyStatus: {
      piSubagents: { ok: true, version: "0.34.0", path: "/tmp/pi-subagents" },
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
docs: ../../
---
Escape prompt.
`);

  const result = await runDoctor(root, {
    dependencyStatus: {
      piSubagents: { ok: true, version: "0.34.0", path: "/tmp/pi-subagents" },
      piIntercom: { ok: true, version: "0.6.0", path: "/tmp/pi-intercom" },
    },
  });

  assert.equal(result.status, "error");
  assert.ok(result.issues.some((issue) => issue.message.includes("docs path must stay inside workspace")));
});

test("filesystem operations reject workspace symlink escapes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-symlink-root-"));
  const outside = await mkdtemp(path.join(tmpdir(), "pi-persona-symlink-outside-"));
  await symlink(outside, path.join(root, "init-data"));

  await assert.rejects(
    () => createPersonaInitDraft(root, "init-data/escaped.yaml"),
    /draft path must stay inside workspace/,
  );
  await assert.rejects(
    () => readFile(path.join(outside, "escaped.yaml"), "utf8"),
    /ENOENT/,
  );

  const agentRoot = await mkdtemp(path.join(tmpdir(), "pi-persona-agent-outside-"));
  const linkedProject = await mkdtemp(path.join(tmpdir(), "pi-persona-agent-root-"));
  await mkdir(path.join(agentRoot, "agents"), { recursive: true });
  await symlink(agentRoot, path.join(linkedProject, ".pi"));
  await assert.rejects(
    () => discoverPersonaProject(linkedProject),
    /persona agent path must stay inside workspace.*symlink-escape/,
  );
});

test("doctor reports raw frontmatter types and excludes invalid agents from launch", async () => {
  const root = await createWorkspace();
  await writeText(path.join(root, ".pi/agents/invalid.md"), `---
name: 123
role: specialist
description:
  team: brand
model:
  provider: example
docs:
  - docs/shared/
  - 42
skills:
  name: review
---
Invalid prompt.
`);

  const result = await runDoctor(root, {
    dependencyStatus: {
      piSubagents: { ok: true, configured: true, version: "0.34.0", path: "/tmp/pi-subagents" },
    },
  });
  const messages = result.issues.map((issue) => issue.message);

  assert.equal(result.status, "error");
  assert.ok(!result.project.agents.some((agent) => agent.fileName === "invalid.md"));
  assert.ok(messages.some((message) => message.includes("name must be a non-empty string")));
  assert.ok(messages.some((message) => message.includes("description must be a non-empty string")));
  assert.ok(messages.some((message) => message.includes("model must be a non-empty string")));
  assert.ok(messages.some((message) => message.includes("docs[1] must be a non-empty string")));
  assert.ok(messages.some((message) => message.includes("skills must be a string or an array")));
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
skills:
  - shared-skill
  - brand-skill
consults: [guideline, launch]
tags:
  - brand
---
Prompt body.
`, ".pi/agents/yaml-agent.md");

  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.rawFrontmatter.docs, ["docs/shared/", "docs/workstreams/brand/"]);
  assert.equal(parsed.frontmatter.description, "Handles values with: colons");
  assert.deepEqual(parsed.frontmatter.tools, ["read", "write"]);
  assert.deepEqual(parsed.frontmatter.docs, ["docs/shared/", "docs/workstreams/brand/"]);
  assert.deepEqual(parsed.frontmatter.skills, ["shared-skill", "brand-skill"]);
  assert.deepEqual(parsed.frontmatter.consults, ["guideline", "launch"]);
  assert.deepEqual(parsed.frontmatter.tags, ["brand"]);
});

test("schema owns persona role and skill-name policy", async () => {
  const schema = await readFile(path.join(process.cwd(), "src/persona/schema.js"), "utf8");
  const doctor = await readFile(path.join(process.cwd(), "src/persona/doctor.js"), "utf8");
  const manifest = await readFile(path.join(process.cwd(), "src/persona/init-manifest.js"), "utf8");
  const scaffold = await readFile(path.join(process.cwd(), "src/persona/scaffold.js"), "utf8");

  assert.match(schema, /isAuthorablePersonaRole/);
  assert.match(schema, /isPathLikeSkillName/);
  assert.doesNotMatch(doctor, /function looksLikePath/);
  assert.doesNotMatch(manifest, /function looksLikePath|const VALID_ROLES/);
  assert.doesNotMatch(scaffold, /const VALID_ROLES/);
});

test("resolveAgentScope merges baseline and selected agent only", async () => {
  const root = await createWorkspace();

  await writeText(path.join(root, ".pi/agents/operator.md"), `---
name: operator
role: specialist
description: Operations specialist.
docs: docs/workstreams/operator/
skills: operator-skill
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
  assert.deepEqual(scope.skills, [
    "shared-skill",
    "operator-skill",
  ]);
  assert.deepEqual(scope.derived.defaultReads, [
    "docs/shared/company.md",
    "docs/workstreams/operator/runbook.md",
  ]);
  assert.match(scope.prompt, /Shared operating context/);
  assert.match(scope.prompt, /## Agent Roster/);
  assert.match(scope.prompt, /brand - specialist: Brand strategy specialist\./);
  assert.match(scope.prompt, /Operator prompt/);
  assert.doesNotMatch(scope.prompt, /Brand prompt/);
  assert.ok(!scope.docs.includes("docs/workstreams/brand/"));
  assert.ok(!scope.docs.includes("docs/workstreams/guideline/"));
  assert.ok(!scope.skills.includes("brand-skill"));
  assert.ok(!scope.skills.includes("guideline-skill"));
});

test("buildAgentLaunchRequest creates an active-session persona request", async () => {
  const root = await createWorkspace();
  const scope = await resolveAgentScope(root, "brand");

  const launch = buildAgentLaunchRequest(scope, {
    task: "Draft a short launch message.",
  });

  assert.equal(launch.agentName, "brand");
  assert.equal(launch.context, "active");
  assert.equal(launch.userMessage, "Draft a short launch message.");
  assert.deepEqual(launch.docs, [
    "docs/shared/",
    "docs/workstreams/brand/",
  ]);
  assert.deepEqual(launch.skills, ["shared-skill", "brand-skill"]);
  assert.equal(launch.subagentParams, undefined);
  assert.match(launch.systemPrompt, /^\[Read from: docs\/shared\/company\.md, docs\/workstreams\/brand\/brief\.md\]/);
  assert.match(launch.systemPrompt, /Resolved doc files:\n- docs\/shared\/: docs\/shared\/company\.md\n- docs\/workstreams\/brand\/: docs\/workstreams\/brand\/brief\.md/);
  assert.doesNotMatch(launch.systemPrompt, /Resolved skill files:/);
  assert.match(launch.systemPrompt, /## Active Pi Persona\n\nYou are the active Pi Persona `brand`/);
  assert.match(launch.systemPrompt, /Answer the user's current request directly as this persona/);
  assert.match(launch.systemPrompt, /Do not start a pi-subagents child run to answer a direct persona command/);
  assert.match(launch.systemPrompt, /Tool: persona_consult/);
  assert.match(launch.systemPrompt, /Known personas:/);
  assert.match(launch.systemPrompt, /guideline - specialist: Guideline reviewer\./);
  assert.match(launch.systemPrompt, /## Baseline Context\n\nShared operating context\./);
  assert.match(launch.systemPrompt, /## Agent Instructions\n\nBrand prompt\./);
  assert.equal(Object.hasOwn(scope.agent.frontmatter, "defaultReads"), false);
});

test("buildAgentLaunchRequest includes roster consult guidance without allowlists", async () => {
  const root = await createWorkspace();
  const scope = await resolveAgentScope(root, "guideline");

  const request = buildAgentLaunchRequest(scope, { task: "Answer directly." });

  assert.match(request.systemPrompt, /Known personas:/);
  assert.match(request.systemPrompt, /brand - specialist: Brand strategy specialist\./);
  assert.doesNotMatch(request.systemPrompt, /Allowed consultants:/);
});

test("resolveAgentLaunchRequest refuses duplicate agent names instead of choosing one", async () => {
  const root = await createWorkspace();

  await writeText(path.join(root, ".pi/agents/duplicate-brand.md"), `---
name: brand
role: specialist
description: Duplicate brand strategy specialist.
docs: docs/workstreams/brand/
skills: brand-skill
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
  assert.deepEqual(consult.skills, ["shared-skill", "guideline-skill"]);
  assert.equal(consult.subagentParams.agent, "guideline");
  assert.equal(consult.subagentParams.context, "fresh");
  assert.deepEqual(consult.subagentParams.skill, ["shared-skill", "guideline-skill"]);
  assert.deepEqual(consult.subagentParams.reads, [
    "docs/shared/company.md",
    "docs/workstreams/guideline/rules.md",
  ]);
  assert.match(consult.subagentParams.task, /^\[Read from: docs\/shared\/company\.md, docs\/workstreams\/guideline\/rules\.md\]/);
  assert.match(consult.subagentParams.task, /consultant: guideline/);
  assert.match(consult.subagentParams.task, /summary: The requester is revising launch copy/);
  assert.match(consult.subagentParams.task, /This consult is a leaf task/);
  assert.match(consult.subagentParams.task, /Do not call `persona_consult`, raw `subagent`, `subagent list`, `contact_supervisor`, or `intercom`/);
  assert.match(consult.subagentParams.task, /If blocked, report the blocker in your returned answer/);
  assert.doesNotMatch(consult.subagentParams.task, /Brand prompt/);
  assert.doesNotMatch(consult.subagentParams.task, /supervisor help/);
});

test("resolveConsultLaunchRequest allows consulting any known persona by roster", async () => {
  const root = await createWorkspace();

  const consult = await resolveConsultLaunchRequest(root, {
    requester: "guideline",
    consultant: "brand",
    question: "Can I ask brand?",
    summary: "Guideline wants a brand perspective.",
  });

  assert.equal(consult.requester.name, "guideline");
  assert.equal(consult.consultant.name, "brand");
  assert.equal(consult.subagentParams.agent, "brand");
});

test("resolveConsultLaunchRequest rejects self-consults", async () => {
  const root = await createWorkspace();

  await assert.rejects(
    () => resolveConsultLaunchRequest(root, {
      requester: "brand",
      consultant: "brand",
      question: "Can I ask myself?",
      summary: "Brand is attempting a redundant self-consult.",
    }),
    /consultant must be a different persona from requester/,
  );
});

test("resolveConsultLaunchRequest refuses duplicate requester or consultant names", async () => {
  const root = await createWorkspace();

  await writeText(path.join(root, ".pi/agents/duplicate-guideline.md"), `---
name: guideline
role: specialist
description: Duplicate guideline reviewer.
docs: docs/workstreams/guideline/
skills: guideline-skill
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

test("formatConsultBridgeResult returns consultant answer with compact provenance", async () => {
  const root = await createWorkspace();

  const consult = await resolveConsultLaunchRequest(root, {
    requester: "brand",
    consultant: "guideline",
    question: "Review this with the guideline persona.",
    summary: "The requester needs guideline review.",
  });

  const text = formatConsultBridgeResult(consult, "Guideline approved.\nSecond line.", false);

  assert.match(text, /## guideline/);
  assert.match(text, /Guideline approved\./);
  assert.match(text, /Consulted:/);
  assert.match(text, /- guideline \(answered\): Guideline approved\./);
});

test("extractConsultAnswer prefers structured and final child output", async () => {
  const structured = await extractConsultAnswer({
    result: {
      content: [{ type: "text", text: "Bridge wrapper" }],
      details: {
        results: [{
          structuredOutput: "Structured answer",
          finalOutput: "Final answer",
        }],
      },
    },
  });

  assert.deepEqual(structured, {
    text: "Structured answer",
    source: "structured",
  });

  const final = await extractConsultAnswer({
    result: {
      content: [{ type: "text", text: "Bridge wrapper" }],
      details: {
        results: [{
          finalOutput: "Final answer",
        }],
      },
    },
  });

  assert.deepEqual(final, {
    text: "Final answer",
    source: "final",
  });
});

test("extractConsultAnswer reads artifact output before bridge wrapper text", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-artifact-"));
  const outputPath = path.join(root, "consult-output.md");
  await writeText(outputPath, "Artifact answer\n");

  const answer = await extractConsultAnswer({
    result: {
      content: [{ type: "text", text: "Delivered single subagent result via intercom." }],
      details: {
        results: [{
          artifactPaths: { outputPath },
        }],
      },
    },
  });

  assert.deepEqual(answer, {
    text: "Artifact answer",
    source: "artifact",
    artifactPath: outputPath,
  });
});

test("extractConsultAnswer treats intercom receipts as metadata when artifact output is unavailable", async () => {
  const missingOutputPath = "/tmp/missing-consult-output.md";

  const answer = await extractConsultAnswer({
    result: {
      content: [{ type: "text", text: "Delivered single subagent result via intercom.\nRun: run-456\nFull grouped output was sent over intercom." }],
      details: {
        runId: "run-456",
        results: [{
          artifactPaths: { outputPath: missingOutputPath },
        }],
      },
    },
  });

  assert.equal(answer.source, "missing");
  assert.match(answer.text, /Consult completed but no answer text was found/);
  assert.match(answer.text, /run-456/);
  assert.match(answer.text, /\/tmp\/missing-consult-output\.md/);
});

test("extractConsultAnswer falls back to bridge text or clear metadata error", async () => {
  const bridge = await extractConsultAnswer({
    result: {
      content: [{ type: "text", text: "Bridge fallback answer" }],
    },
  });

  assert.deepEqual(bridge, {
    text: "Bridge fallback answer",
    source: "bridge",
  });

  const missing = await extractConsultAnswer({
    result: {
      details: {
        runId: "run-123",
        results: [{
          artifactPaths: { outputPath: "/tmp/missing-output.md" },
        }],
      },
    },
  });

  assert.equal(missing.source, "missing");
  assert.match(missing.text, /Consult completed but no answer text was found/);
  assert.match(missing.text, /run-123/);
  assert.match(missing.text, /\/tmp\/missing-output\.md/);
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
  assert.match(output, /docs: none/);
  assert.match(output, /skills: none/);
  assert.match(output, /brand - specialist/);
  assert.match(output, /docs: docs\/workstreams\/brand\//);
  assert.match(output, /skills: brand-skill/);
  assert.match(output, /launch: \/brand/);
});

test("primary generalist receives a roundtable selection prompt", async () => {
  const root = await createWorkspace();

  await writeText(path.join(root, ".pi/agents/pricing.md"), `---
name: pricing
role: specialist
description: Pricing strategy specialist.
model: openai/gpt-5
docs: docs/workstreams/pricing/
skills: pricing-skill
---
Pricing prompt.
`);
  await writeText(path.join(root, "docs/workstreams/pricing/model.md"), "Pricing doc\n");

  const selection = await resolveRoundtableSelectionRequest(root, {
    query: "Should brand positioning change pricing and guideline language?",
  });

  assert.equal(selection.generalist.name, "generalist");
  assert.deepEqual(selection.candidates.map((agent) => agent.name), ["brand", "guideline", "pricing"]);
  assert.equal(selection.context, "fresh");
  assert.match(selection.userMessage, /Pi Persona Round-table Selection/);
  assert.match(selection.userMessage, /brand: Brand strategy specialist/);
  assert.match(selection.userMessage, /pricing: Pricing strategy specialist/);
  assert.match(selection.userMessage, /Call `persona_roundtable` exactly once/);
  assert.match(selection.userMessage, /Do not call raw `subagent`/);
  assert.match(selection.userMessage, /present its returned moderator synthesis once/);
});

test("selected specialists build two roundtable rounds and primary synthesis", async () => {
  const root = await createWorkspace();
  const selections = [
    { name: "guideline", reason: "The policy language needs review." },
    { name: "brand", reason: "The positioning needs a brand perspective." },
  ];
  const roundtable = await resolveRoundtableLaunchRequest(root, {
    query: "Brand guideline question.",
    selections,
  });

  assert.deepEqual(selections, [
    { name: "guideline", reason: "The policy language needs review." },
    { name: "brand", reason: "The positioning needs a brand perspective." },
  ]);
  assert.deepEqual(roundtable.roster.map((agent) => agent.name), ["guideline", "brand"]);
  assert.deepEqual(roundtable.subagentParams.chain.map((step) => step.phase), [
    "Round 1",
    "Round 2",
    "Synthesis",
  ]);
  assert.equal(roundtable.subagentParams.chain[0].parallel.length, 2);
  assert.equal(roundtable.subagentParams.chain[1].parallel.length, 2);
  assert.equal(roundtable.subagentParams.chain[2].agent, "generalist");
  const brandRoundTwo = roundtable.subagentParams.chain[1].parallel.find((step) => step.agent === "brand");
  assert.deepEqual(brandRoundTwo.reads, ["docs/shared/company.md", "docs/workstreams/brand/brief.md"]);
  assert.deepEqual(brandRoundTwo.skill, ["shared-skill", "brand-skill"]);
  assert.deepEqual(roundtable.subagentParams.chain[2].reads, ["docs/shared/company.md"]);
  assert.deepEqual(roundtable.subagentParams.chain[2].skill, ["shared-skill"]);
  assert.match(roundtable.subagentParams.chain[0].parallel[0].task, /Round 1 - Independent Position/);
  assert.match(roundtable.subagentParams.chain[1].parallel[0].task, /Round 2 - Reveal And Revise/);
  assert.match(roundtable.subagentParams.chain[1].parallel[0].task, /\{previous\}/);
  for (const task of [
    roundtable.subagentParams.chain[0].parallel[0].task,
    roundtable.subagentParams.chain[1].parallel[0].task,
  ]) {
    assert.match(task, /This round-table step is a leaf task/);
    assert.match(task, /Do not call `persona_consult`, raw `subagent`, `subagent list`, `contact_supervisor`, or `intercom`/);
    assert.match(task, /If blocked, report the blocker in your returned answer/);
    assert.doesNotMatch(task, /supervisor help/);
  }
  assert.match(roundtable.subagentParams.chain[2].task, /Moderator Synthesis/);
  assert.match(roundtable.subagentParams.chain[2].task, /\{previous\}/);
  assert.match(roundtable.subagentParams.chain[2].task, /Shared operating context/);
  assert.match(roundtable.subagentParams.task, /Advisory analysis only/);
  assert.match(roundtable.subagentParams.task, /Do not edit or modify files/);
  for (const step of [
    ...roundtable.subagentParams.chain[0].parallel,
    ...roundtable.subagentParams.chain[1].parallel,
    roundtable.subagentParams.chain[2],
  ]) {
    assert.deepEqual(step.acceptance, {
      level: "none",
      reason: "Round-table analysis is advisory and does not require repository changes.",
    });
  }
});

test("roundtable selection refuses duplicate project agent names", async () => {
  const root = await createWorkspace();

  await writeText(path.join(root, ".pi/agents/duplicate-brand.md"), `---
name: brand
role: specialist
description: Duplicate brand strategy specialist.
docs: docs/workstreams/brand/
skills: brand-skill
---
Duplicate brand prompt.
`);

  await assert.rejects(
    () => resolveRoundtableSelectionRequest(root, {
      query: "Brand guideline question.",
    }),
    /ambiguous agent name 'brand'/,
  );
});

test("roundtable selection rejects unknown duplicate and oversized rosters", async () => {
  const root = await createWorkspace();

  for (const name of ["alpha", "beta", "delta", "epsilon", "zeta"]) {
    await writeText(path.join(root, `.pi/agents/${name}.md`), `---
name: ${name}
role: specialist
description: ${name} specialist for market planning.
docs: docs/shared/
skills: shared-skill
---
${name} prompt.
`);
  }
  await assert.rejects(
    () => resolveRoundtableLaunchRequest(root, {
      query: "Market planning question across many specialists.",
      selections: [{ name: "unknown", reason: "Unknown." }],
    }),
    /unknown specialist: unknown/,
  );
  await assert.rejects(
    () => resolveRoundtableLaunchRequest(root, {
      query: "Market planning question across many specialists.",
      selections: [
        { name: "brand", reason: "First." },
        { name: "brand", reason: "Second." },
      ],
    }),
    /duplicate specialist: brand/,
  );
  await assert.rejects(
    () => resolveRoundtableLaunchRequest(root, {
      query: "Market planning question across many specialists.",
      selections: ["brand", "guideline", "alpha", "beta", "delta", "epsilon"]
        .map((name) => ({ name, reason: `${name} reason.` })),
    }),
    /between 1 and 5 specialists/,
  );
});

test("formatRoundtableRosterPreview shows selected specialists and command context", async () => {
  const root = await createWorkspace();
  const roundtable = await resolveRoundtableLaunchRequest(root, {
    query: "Brand guideline question.",
    selections: [
      { name: "brand", reason: "Brand positioning is central." },
      { name: "guideline", reason: "Guideline language needs review." },
    ],
  });

  const preview = formatRoundtableRosterPreview(roundtable);

  assert.match(preview, /# Pi Persona Round-table/);
  assert.match(preview, /Query: Brand guideline question\./);
  assert.match(preview, /Moderator: generalist/);
  assert.match(preview, /- brand - Brand strategy specialist\./);
  assert.match(preview, /selected because: Brand positioning is central\./);
  assert.match(preview, /- guideline - Guideline reviewer\./);
});

test("roundtable progress reports phase, activity, tools, sources, and recoverable errors", () => {
  const tracker = createRoundtableProgressTracker(["brand", "guideline"], { startedAt: 1_000, moderator: "generalist" });
  tracker.update({
    progress: [{
      index: 0,
      agent: "brand",
      status: "completed",
      recentTools: [{ tool: "search_web", args: "query", endMs: 2_000 }],
      toolCount: 1,
      turnCount: 1,
      tokens: 500,
    }],
  }, 2_000);
  tracker.update({
    progress: [{
      index: 1,
      agent: "guideline",
      status: "running",
      currentTool: "read_webpage",
      currentToolArgs: "https://example.com/benchmark",
      recentTools: [{ tool: "read_webpage", args: "https://example.com/benchmark", endMs: 2_500 }],
      failedTool: "read_webpage",
      lastActivityAt: 2_500,
      toolCount: 2,
      turnCount: 2,
      tokens: 1000,
    }],
  }, 3_000);

  const text = tracker.format(4_000);
  assert.match(text, /Round-table/);
  assert.match(text, /Round 1 — independent positions · 1\/2 complete/);
  assert.match(text, /Specialists work separately before seeing peer answers/);
  assert.match(text, /active 1s ago/);
  assert.match(text, /3 tools/);
  assert.match(text, /1 sources/);
  assert.match(text, /1 recoverable errors/);
  assert.match(text, /brand · ✓ complete/);
  assert.match(text, /guideline · … searching evidence · 2 tools · 2 turns/);
  assert.match(text, /Next: specialists see peer positions and revise/);
  assert.doesNotMatch(text, /example\.com|https?:\/\//);

  tracker.update({ progress: [{ index: 1, agent: "guideline", status: "completed", toolCount: 2, turnCount: 2, tokens: 1000 }] }, 4_500);
  tracker.update({ progress: [{ index: 2, agent: "brand", status: "running", toolCount: 0, turnCount: 1, tokens: 250 }] }, 5_000);
  const roundTwo = tracker.format(6_000);
  assert.match(roundTwo, /Round 2 — reveal and revise · 0\/2 complete/);
  assert.match(roundTwo, /brand · ✓ independent · … revising after peer reveal/);
  assert.match(roundTwo, /guideline · ✓ independent · ○ waiting/);
  assert.equal(tracker.snapshot(6_000).turns, 4);
});

test("roundtable progress reports long quiet periods without a cancellation countdown", () => {
  const tracker = createRoundtableProgressTracker(["brand"], {
    startedAt: 1_000,
    idleTimeoutMs: false,
  });
  tracker.update({
    progress: [{
      index: 0,
      agent: "brand",
      status: "running",
      recentTools: [],
      toolCount: 0,
      tokens: 0,
    }],
  }, 2_000);

  const text = tracker.format(602_000);
  assert.match(text, /active 10:00 ago/);
  assert.doesNotMatch(text, /cancelling|countdown/i);
});

test("roundtable process details summarize completed and failed steps", () => {
  const details = createRoundtableProcessDetails(
    { roster: [{ name: "brand" }], generalist: { name: "generalist" } },
    { result: { details: { results: [{ status: "completed" }, { status: "failed" }] } } },
    {
      elapsedMs: 2_000,
      toolCount: 1,
      turns: 2,
      categories: {},
      sources: 0,
      recoverableErrors: 0,
    },
  );

  assert.equal(details.expectedSteps, 3);
  assert.equal(details.completedSteps, 1);
  assert.equal(details.failedSteps, 1);
  assert.match(formatRoundtableProcessLine(details), /1\/3 steps complete/);
});

test("extractRoundtableAnswer selects only the current moderator synthesis and ignores intercom receipts", async () => {
  const answer = await extractRoundtableAnswer({
    result: {
      content: [{ type: "text", text: "Delivered chain subagent results via intercom.\nFull grouped output was sent over intercom." }],
      details: {
        results: [
          { agent: "brand", finalOutput: "Brand position" },
          { agent: "guideline", finalOutput: "Guideline position" },
          { agent: "generalist", finalOutput: "Moderator verdict" },
        ],
      },
    },
  }, "generalist");

  assert.deepEqual(answer, { text: "Moderator verdict", source: "final" });

  const missing = await extractRoundtableAnswer({
    requestId: "private-request-id",
    result: {
      content: [{ type: "text", text: "Delivered chain subagent results via intercom.\nFull grouped output was sent over intercom." }],
      details: {
        runId: "private-run-id",
        results: [{ agent: "brand", finalOutput: "Partial position" }],
      },
    },
  }, "generalist");

  assert.equal(missing.source, "missing");
  assert.match(missing.text, /no moderator synthesis/i);
  assert.doesNotMatch(missing.text, /private-request-id|private-run-id|artifact/i);
});

test("consult may use bridge error text while roundtable keeps it private", async () => {
  assert.deepEqual(await extractConsultAnswer({ errorText: "consult failed" }), {
    text: "consult failed",
    source: "bridge",
  });

  const roundtable = await extractRoundtableAnswer({
    errorText: "private /tmp/roundtable error",
    result: { details: { results: [] } },
  }, "generalist");
  assert.equal(roundtable.source, "missing");
  assert.doesNotMatch(roundtable.text, /private|\/tmp/);
});

test("consult and roundtable share answer-value helpers", async () => {
  const consult = await readFile(path.join(process.cwd(), "src/persona/consult.js"), "utf8");
  const roundtable = await readFile(path.join(process.cwd(), "src/persona/roundtable.js"), "utf8");

  assert.match(consult, /from "\.\/answer-values\.js"/);
  assert.match(roundtable, /from "\.\/answer-values\.js"/);
  for (const source of [consult, roundtable]) {
    assert.doesNotMatch(source, /function (childResults|stringifyAnswerValue|normalizeAnswerText|isIntercomReceiptText|requireText)\(/);
  }
});

test("roundtable failure output reports only current phase and agent status", async () => {
  const root = await createWorkspace();
  const roundtable = await resolveRoundtableLaunchRequest(root, {
    query: "Brand guideline question.",
    selections: [
      { name: "brand", reason: "Brand position." },
      { name: "guideline", reason: "Guideline evidence." },
    ],
  });
  const text = formatRoundtableBridgeFailure(roundtable, {
    isError: true,
    errorText: "internal /tmp/private/run path",
    result: {
      details: {
        runId: "private-run-id",
        results: [
          { agent: "brand", exitCode: 0 },
          { agent: "guideline", exitCode: 1, error: "failed at /tmp/private/artifact" },
        ],
      },
    },
  });

  assert.match(text, /did not complete during Round 1/);
  assert.match(text, /Completed agents: brand/);
  assert.match(text, /Failed agents: guideline/);
  assert.doesNotMatch(text, /private|\/tmp|run-id|artifact/);
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

test("runSubagentBridgeRequest rejects when a started bridge stops responding", async () => {
  const bus = createEventBus((request, events) => {
    events.emit("subagent:slash:started", { requestId: request.requestId });
  });
  const request = runSubagentBridgeRequest(
    { events: bus },
    { cwd: "/tmp/example" },
    { agent: "brand", task: "Task", context: "fresh" },
    {
      requestId: "started-stuck",
      startTimeoutMs: 50,
      idleTimeoutMs: 5,
      maxRuntimeMs: 50,
    },
  );

  await assert.rejects(
    () => Promise.race([
      request,
      new Promise((_, reject) => setTimeout(() => reject(new Error("test guard: request stayed pending")), 30)),
    ]),
    /pi-subagents slash bridge timed out waiting for response/,
  );
  assert.equal(bus.listenerCount("subagent:slash:started"), 0);
  assert.equal(bus.listenerCount("subagent:slash:response"), 0);
  assert.equal(bus.listenerCount("subagent:slash:update"), 0);
  assert.ok(bus.emitted.some((entry) => (
    entry.event === "subagent:slash:cancel"
    && entry.data.requestId === "started-stuck"
  )));
});

test("runSubagentBridgeRequest resets the idle timeout on matching progress", async () => {
  const bus = createEventBus((request, events) => {
    events.emit("subagent:slash:started", { requestId: request.requestId });
    setTimeout(() => {
      events.emit("subagent:slash:update", {
        requestId: request.requestId,
        progress: [{ agent: "brand", status: "running" }],
      });
    }, 5);
    setTimeout(() => {
      events.emit("subagent:slash:response", {
        requestId: request.requestId,
        result: { content: [{ type: "text", text: "after progress" }], details: { mode: "single", results: [] } },
        isError: false,
      });
    }, 12);
  });

  const response = await runSubagentBridgeRequest(
    { events: bus },
    { cwd: "/tmp/example" },
    { agent: "brand", task: "Task", context: "fresh" },
    {
      requestId: "progress-reset",
      startTimeoutMs: 20,
      idleTimeoutMs: 10,
      maxRuntimeMs: 100,
    },
  );

  assert.equal(response.result.content[0].text, "after progress");
});

test("runSubagentBridgeRequest supports disabling idle cancellation", async () => {
  const bus = createEventBus((request, events) => {
    events.emit("subagent:slash:started", { requestId: request.requestId });
    setTimeout(() => {
      events.emit("subagent:slash:response", {
        requestId: request.requestId,
        result: { content: [{ type: "text", text: "patient result" }], details: { mode: "single", results: [] } },
        isError: false,
      });
    }, 12);
  });

  const response = await runSubagentBridgeRequest(
    { events: bus },
    { cwd: "/tmp/example" },
    { agent: "brand", task: "Task", context: "fresh" },
    {
      requestId: "idle-disabled",
      startTimeoutMs: 20,
      idleTimeoutMs: false,
      maxRuntimeMs: 100,
    },
  );

  assert.equal(response.result.content[0].text, "patient result");
  assert.ok(!bus.emitted.some((entry) => entry.event === "subagent:slash:cancel"));
});

test("runSubagentBridgeRequest has no default max runtime", async () => {
  const source = await readFile(path.join(process.cwd(), "src/persona/subagent-bridge.js"), "utf8");
  assert.match(source, /maxRuntimeMs\) \? options\.maxRuntimeMs : undefined/);
  assert.doesNotMatch(source, /: 900_000/);
});

test("runSubagentBridgeRequest supports an explicitly requested max runtime", async () => {
  const bus = createEventBus((request, events) => {
    events.emit("subagent:slash:started", { requestId: request.requestId });
    const timer = setInterval(() => {
      events.emit("subagent:slash:update", {
        requestId: request.requestId,
        progress: [{ agent: "brand", status: "running" }],
      });
    }, 2);
    setTimeout(() => clearInterval(timer), 30);
  });

  await assert.rejects(
    () => Promise.race([
      runSubagentBridgeRequest(
        { events: bus },
        { cwd: "/tmp/example" },
        { agent: "brand", task: "Task", context: "fresh" },
        {
          requestId: "max-runtime",
          startTimeoutMs: 20,
          idleTimeoutMs: 50,
          maxRuntimeMs: 8,
        },
      ),
      new Promise((_, reject) => setTimeout(() => reject(new Error("test guard: request stayed pending")), 40)),
    ]),
    /pi-subagents slash bridge exceeded max runtime/,
  );
  assert.ok(bus.emitted.some((entry) => (
    entry.event === "subagent:slash:cancel"
    && entry.data.requestId === "max-runtime"
  )));
});

test("runSubagentBridgeRequest aborts and emits cancel", async () => {
  const controller = new AbortController();
  const bus = createEventBus((request, events) => {
    events.emit("subagent:slash:started", { requestId: request.requestId });
  });
  const request = runSubagentBridgeRequest(
    { events: bus },
    { cwd: "/tmp/example" },
    { agent: "brand", task: "Task", context: "fresh" },
    {
      requestId: "aborted-request",
      startTimeoutMs: 20,
      idleTimeoutMs: 50,
      maxRuntimeMs: 100,
      signal: controller.signal,
    },
  );

  controller.abort();

  await assert.rejects(
    () => Promise.race([
      request,
      new Promise((_, reject) => setTimeout(() => reject(new Error("test guard: request stayed pending")), 30)),
    ]),
    /pi-subagents slash bridge request was cancelled/,
  );
  assert.ok(bus.emitted.some((entry) => (
    entry.event === "subagent:slash:cancel"
    && entry.data.requestId === "aborted-request"
  )));
});

test("parsePersonaNewArgs accepts setup metadata options", () => {
  const parsed = parsePersonaNewArgs(
    'Market Research --role specialist --description "Market research specialist." --docs docs/workstreams/market/ --skills market-skill',
  );

  assert.equal(parsed.rawName, "Market Research");
  assert.equal(parsed.options.role, "specialist");
  assert.equal(parsed.options.description, "Market research specialist.");
  assert.deepEqual(parsed.options.docs, ["docs/workstreams/market/"]);
  assert.deepEqual(parsed.options.skills, ["market-skill"]);
});

test("parsePersonaNewArgs accepts equals options and rejects unsafe input", () => {
  const parsed = parsePersonaNewArgs(
    'Ops Lead --role=generalist --description="Routes operational requests." --docs=docs/shared/,docs/workstreams/ops/ --skills=shared-skill,ops-skill',
  );

  assert.equal(parsed.rawName, "Ops Lead");
  assert.equal(parsed.options.role, "generalist");
  assert.equal(parsed.options.description, "Routes operational requests.");
  assert.deepEqual(parsed.options.docs, ["docs/shared/", "docs/workstreams/ops/"]);
  assert.deepEqual(parsed.options.skills, ["shared-skill", "ops-skill"]);

  assert.throws(
    () => parsePersonaNewArgs("Ops Lead --role runtime"),
    /role must be generalist or specialist/,
  );
  assert.throws(
    () => parsePersonaNewArgs("Ops Lead --unknown value"),
    /unknown \/persona new option: --unknown/,
  );
  assert.throws(
    () => parsePersonaNewArgs("Ops Lead --consults all"),
    /unknown \/persona new option: --consults/,
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
  assert.match(content, /docs: \[\]/);
  assert.match(content, /skills: \[\]/);
  assert.doesNotMatch(content, /tools:/);
  assert.doesNotMatch(content, /consults:/);
  assert.doesNotMatch(content, /tags:/);
  assert.match(content, /You are market-researcher\./);
  assert.doesNotMatch(content, /defaultReads/);
  assert.doesNotMatch(content, /systemPromptMode/);
  assert.doesNotMatch(content, /inheritSkills/);

  const project = await discoverPersonaProject(root);
  assert.deepEqual(project.agents.map((agent) => agent.name), ["market-researcher"]);

  await assert.rejects(
    () => readFile(path.join(root, ".pi/settings.json"), "utf8"),
    /ENOENT/,
  );
});

test("createAgentScaffold writes provided setup metadata without runtime fields", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-scaffold-"));
  await writeText(path.join(root, "docs/workstreams/market/brief.md"), "Market doc\n");

  const result = await createAgentScaffold(root, "Market Research", {
    role: "specialist",
    description: "Market research specialist.",
    docs: ["docs/workstreams/market/"],
    skills: ["market-skill"],
  });
  const content = await readFile(result.filePath, "utf8");

  assert.match(content, /role: specialist/);
  assert.match(content, /description: Market research specialist\./);
  assert.match(content, /docs: docs\/workstreams\/market\//);
  assert.match(content, /skills: market-skill/);
  assert.doesNotMatch(content, /tools:/);
  assert.doesNotMatch(content, /consults:/);
  assert.doesNotMatch(content, /tags:/);
  assert.doesNotMatch(content, /defaultReads/);
  assert.doesNotMatch(content, /systemPromptMode/);
  assert.doesNotMatch(content, /inheritSkills/);

  const project = await discoverPersonaProject(root);
  const agent = project.agents.find((candidate) => candidate.name === "market-research");
  assert.equal(agent.description, "Market research specialist.");
  assert.deepEqual(agent.docs, ["docs/workstreams/market/"]);
  assert.deepEqual(agent.skills, ["market-skill"]);
});

test("createAgentScaffold writes YAML-safe frontmatter descriptions", async () => {
  const cases = [
    ["Brand Colon", "Brand: voice and messaging"],
    ["Priority Hash", "Needs #1 priority"],
    ["Bracketed Brand", "[brand] review"],
  ];

  for (const [rawName, description] of cases) {
    const root = await mkdtemp(path.join(tmpdir(), "pi-persona-scaffold-yaml-"));
    const result = await createAgentScaffold(root, rawName, {
      description,
    });
    const content = await readFile(result.filePath, "utf8");
    const parsed = parseFrontmatterDocument(content, result.relativePath);
    const project = await discoverPersonaProject(root);

    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.frontmatter.description, description);
    assert.equal(project.agents[0].description, description);
    assert.equal(project.agents[0].name, result.agentName);
  }
});

test("createAgentScaffold preserves existing project settings without adding runtime overrides", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-scaffold-settings-"));
  const originalSettings = {
    packages: [".."],
    subagents: {
      disableThinking: true,
      agentOverrides: {
        existing: { model: "openai/gpt-5-mini" },
      },
    },
  };
  await writeText(path.join(root, ".pi/settings.json"), `${JSON.stringify(originalSettings, null, 2)}\n`);

  await createAgentScaffold(root, "Market Research");

  const settings = await readJson(path.join(root, ".pi/settings.json"));
  assert.deepEqual(settings, originalSettings);
});

test("createAgentScaffold preserves same-agent runtime settings without adding subagent tool", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-scaffold-settings-"));
  const originalSettings = {
    subagents: {
      agentOverrides: {
        "market-research": {
          model: "openai/gpt-5-mini",
          tools: ["read"],
        },
      },
    },
  };
  await writeText(path.join(root, ".pi/settings.json"), `${JSON.stringify(originalSettings, null, 2)}\n`);

  await createAgentScaffold(root, "Market Research");

  const settings = await readJson(path.join(root, ".pi/settings.json"));
  assert.deepEqual(settings, originalSettings);
});

test("createPersonaProjectScaffold creates minimal baseline and primary generalist", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-init-"));

  const result = await createPersonaProjectScaffold(root);

  assert.deepEqual(result.created, [
    ".pi/agents/_baseline.md",
    ".pi/agents/generalist.md",
    "docs/shared/_index.md",
  ]);
  assert.deepEqual(result.skipped, []);

  const baseline = await readFile(path.join(root, ".pi/agents/_baseline.md"), "utf8");
  const generalist = await readFile(path.join(root, ".pi/agents/generalist.md"), "utf8");
  const sharedIndex = await readFile(path.join(root, "docs/shared/_index.md"), "utf8");
  assert.match(baseline, /docs: docs\/shared\//);
  assert.match(baseline, /skills: \[\]/);
  assert.match(generalist, /role: generalist/);
  assert.match(generalist, /primary: true/);
  assert.match(sharedIndex, /# Shared Docs Index/);

  await assert.rejects(
    () => readFile(path.join(root, ".pi/settings.json"), "utf8"),
    /ENOENT/,
  );

  const doctor = await runDoctor(root, {
    dependencyStatus: {
      piSubagents: { ok: true, version: "0.34.0", path: "/tmp/pi-subagents" },
      piIntercom: { ok: true, version: "0.6.0", path: "/tmp/pi-intercom" },
    },
  });
  assert.equal(doctor.status, "pass");
});

test("createPersonaProjectScaffold preserves existing setup files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-init-existing-"));
  await writeText(path.join(root, ".pi/agents/_baseline.md"), "existing baseline\n");
  await writeText(path.join(root, "docs/shared/_index.md"), "existing index\n");

  const result = await createPersonaProjectScaffold(root);

  assert.deepEqual(result.created, [".pi/agents/generalist.md"]);
  assert.deepEqual(result.skipped, [
    ".pi/agents/_baseline.md",
    "docs/shared/_index.md",
  ]);
  assert.equal(await readFile(path.join(root, ".pi/agents/_baseline.md"), "utf8"), "existing baseline\n");
  assert.equal(await readFile(path.join(root, "docs/shared/_index.md"), "utf8"), "existing index\n");
});

test("formatPersonaProjectScaffoldCreatedMessage gives init next steps", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-init-message-"));
  const result = await createPersonaProjectScaffold(root);

  assert.equal(formatPersonaProjectScaffoldCreatedMessage(result), [
    "Initialized Pi Persona project",
    "",
    "Created:",
    "- .pi/agents/_baseline.md",
    "- .pi/agents/generalist.md",
    "- docs/shared/_index.md",
    "",
    "Primary generalist: /generalist",
    "Next: add specialists with /persona new <name>, then run /persona doctor",
  ].join("\n"));
});

test("parsePersonaInitArgs handles basic plan apply and status modes", () => {
  assert.deepEqual(parsePersonaInitArgs(""), { mode: "basic" });
  assert.deepEqual(parsePersonaInitArgs("draft --out init-data/business.yaml"), {
    mode: "draft",
    out: "init-data/business.yaml",
  });
  assert.deepEqual(parsePersonaInitArgs("draft --out=init-data/business.yaml"), {
    mode: "draft",
    out: "init-data/business.yaml",
  });
  assert.deepEqual(parsePersonaInitArgs("--plan --from init-data/business.yaml"), {
    mode: "plan",
    from: "init-data/business.yaml",
  });
  assert.deepEqual(parsePersonaInitArgs("--from init-data/business.yaml"), {
    mode: "apply",
    from: "init-data/business.yaml",
  });
  assert.deepEqual(parsePersonaInitArgs("status --from init-data/business.yaml"), {
    mode: "status",
    from: "init-data/business.yaml",
  });

  assert.throws(
    () => parsePersonaInitArgs("--plan"),
    /missing --from/,
  );
  assert.throws(
    () => parsePersonaInitArgs("draft"),
    /missing --out/,
  );
});

test("persona init draft writes a valid starter manifest without overwriting", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-draft-init-"));

  const result = await createPersonaInitDraft(root, "init-data/my-business.yaml");

  assert.equal(result.mode, "draft");
  assert.equal(result.source, "init-data/my-business.yaml");
  assert.equal(result.projectName, "my-business");

  const draft = await readFile(path.join(root, "init-data/my-business.yaml"), "utf8");
  assert.match(draft, /version: 1/);
  assert.match(draft, /name: generalist/);
  assert.match(draft, /primary: true/);
  assert.match(draft, /name: example-specialist/);
  assert.match(draft, /docs\/shared\/_index\.md/);

  await assert.rejects(
    () => planPersonaInitFromManifest(root, "init-data/my-business.yaml"),
    /unresolved template placeholders.*Finish assisted onboarding/,
  );
  assert.match(formatPersonaInitManifestReport(result), /Pi Persona Init Draft/);
  assert.match(formatPersonaInitManifestReport(result), /Starting assisted setup interview/);
  assert.doesNotMatch(formatPersonaInitManifestReport(result), /Review or edit the YAML/);
  assert.match(formatPersonaInitManifestReport(result), /assistant will preview the plan/);

  const prompt = formatPersonaInitDraftAuthoringPrompt(result);
  assert.match(prompt, /Help me shape the Pi Persona setup manifest at `init-data\/my-business\.yaml`/);
  assert.match(prompt, /Treat me as a new user/);
  assert.match(prompt, /Do not ask me to manually edit YAML/);
  assert.match(prompt, /Ask one question at a time/);
  assert.match(prompt, /call persona_init with action: plan/);
  assert.match(prompt, /confirmed: true/);
  assert.match(prompt, /apply result includes persona doctor verification/);
  assert.match(prompt, /Never use @name syntax/);

  await assert.rejects(
    () => createPersonaInitDraft(root, "init-data/my-business.yaml"),
    /draft manifest already exists: init-data\/my-business\.yaml/,
  );
});

test("shipped init-data fixtures retain their intended validation state", async () => {
  const example = await planPersonaInitFromManifest(
    process.cwd(),
    "init-data/[EXAMPLE]business-operating-layer.yaml",
  );
  assert.equal(example.projectName, "business-operating-layer");
  assert.ok(example.actions.length > 10);

  await assert.rejects(
    () => planPersonaInitFromManifest(process.cwd(), "init-data/_template.yaml"),
    /unresolved template placeholders/,
  );
});

test("manifest validation rejects malformed booleans lists models and doc contents", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-invalid-manifest-"));
  const valid = starterInitManifest();
  const cases = [
    {
      name: "primary",
      manifest: valid.replace("    primary: true", "    primary: \"true\""),
      error: /primary must be true or false/,
    },
    {
      name: "skills",
      manifest: valid.replace("  skills: []", "  skills:\n    invalid: true"),
      error: /baseline\.skills: must be a string or an array of non-empty strings/,
    },
    {
      name: "model",
      manifest: valid.replace(
        "    description: Routes test business requests.\n",
        "    description: Routes test business requests.\n    model: [invalid]\n",
      ),
      error: /model must be a non-empty string when provided/,
    },
    {
      name: "doc-content",
      manifest: valid.replace(
        "    docs/shared/context.md: |\n      TEST_BUSINESS_CONTEXT",
        "    docs/shared/context.md:\n      invalid: true",
      ),
      error: /docs\.files\.docs\/shared\/context\.md must be a string/,
    },
    {
      name: "placeholder",
      manifest: valid.replace("TEST_BUSINESS_CONTEXT", "add the behavior or spec under test here"),
      error: /unresolved template placeholders: docs\.files\.docs\/shared\/context\.md/,
    },
  ];

  for (const invalidCase of cases) {
    const source = `init-data/${invalidCase.name}.yaml`;
    await writeText(path.join(root, source), invalidCase.manifest);
    await assert.rejects(
      () => planPersonaInitFromManifest(root, source),
      invalidCase.error,
    );
  }
});

test("manifest init plans applies and reports status for a starter layer", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-manifest-init-"));
  await writeText(path.join(root, "init-data/business.yaml"), starterInitManifest());

  const plan = await planPersonaInitFromManifest(root, "init-data/business.yaml");
  assert.equal(plan.mode, "plan");
  assert.equal(plan.projectName, "test-business");
  assert.ok(plan.actions.some((action) => action.status === "create" && action.path === ".pi/agents/_baseline.md"));
  assert.ok(plan.actions.some((action) => action.status === "create" && action.path === ".pi/agents/generalist.md"));
  assert.ok(plan.actions.some((action) => action.status === "create" && action.path === ".pi/agents/operator.md"));
  assert.ok(plan.actions.some((action) => action.status === "create" && action.path === "docs/shared/context.md"));
  assert.equal(plan.actions.some((action) => action.kind === "runtime"), false);

  const planReport = formatPersonaInitManifestReport(plan);
  assert.match(planReport, /Pi Persona Init Plan/);
  assert.match(planReport, /create \.pi\/agents\/operator\.md/);
  assert.doesNotMatch(planReport, /runtime override/);

  const applied = await applyPersonaInitFromManifest(root, "init-data/business.yaml");
  assert.equal(applied.mode, "apply");
  assert.ok(applied.actions.some((action) => action.status === "created" && action.path === ".pi/agents/operator.md"));
  assert.equal(applied.actions.some((action) => action.kind === "runtime"), false);

  const baseline = await readFile(path.join(root, ".pi/agents/_baseline.md"), "utf8");
  const generalist = await readFile(path.join(root, ".pi/agents/generalist.md"), "utf8");
  const operator = await readFile(path.join(root, ".pi/agents/operator.md"), "utf8");
  const doc = await readFile(path.join(root, "docs/shared/context.md"), "utf8");
  assert.match(baseline, /docs:\n  - docs\/shared\//);
  assert.match(generalist, /primary: true/);
  assert.match(operator, /description: Runs operating checklists\./);
  assert.match(doc, /TEST_BUSINESS_CONTEXT/);

  await assert.rejects(
    () => readFile(path.join(root, ".pi/settings.json"), "utf8"),
    /ENOENT/,
  );

  const doctor = await runDoctor(root, {
    dependencyStatus: {
      piSubagents: { ok: true, version: "0.34.0", path: "/tmp/pi-subagents" },
      piIntercom: { ok: true, version: "0.6.0", path: "/tmp/pi-intercom" },
    },
  });
  assert.equal(doctor.status, "pass");

  const status = await statusPersonaInitFromManifest(root, "init-data/business.yaml");
  assert.equal(status.mode, "status");
  assert.match(formatPersonaInitManifestReport(status), /\[done\] \.pi\/agents\/operator\.md/);
  assert.match(formatPersonaInitManifestReport(status), /\[todo\] docs index: docs\/shared\//);
  assert.match(formatPersonaInitManifestReport(status), /\[todo\] docs index: docs\/workstreams\/operator\//);
  assert.match(formatPersonaInitManifestReport(status), /\[next\] run \/persona index --all/);

  await createDocsIndex(root, { all: true });
  const indexedStatus = await statusPersonaInitFromManifest(root, "init-data/business.yaml");
  assert.ok(indexedStatus.items.every((item) => item.state === "done"));
  assert.match(formatPersonaInitManifestReport(indexedStatus), /\[done\] docs index: docs\/shared\//);
  assert.match(formatPersonaInitManifestReport(indexedStatus), /\[next\] run \/persona doctor/);
});

test("manifest init writes YAML-safe frontmatter descriptions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-manifest-yaml-"));
  await writeText(path.join(root, "init-data/business.yaml"), `version: 1
project:
  name: test-business
baseline:
  docs: []
  skills: []
  prompt: |
    Shared prompt.
agents:
  - name: generalist
    role: generalist
    primary: true
    description: |-
      Routes research requests, answers from shared context,
      and synthesizes specialist input.
    docs: []
    skills: []
    prompt: |
      Generalist prompt.
  - name: specialist
    role: specialist
    description: "[brand] needs #1 review"
    docs: []
    skills: []
    prompt: |
      Specialist prompt.
`);

  await applyPersonaInitFromManifest(root, "init-data/business.yaml");

  const project = await discoverPersonaProject(root);
  assert.deepEqual(project.files.flatMap((file) => file.parseErrors), []);
  assert.deepEqual(project.agents.map((agent) => agent.description), [
    "Routes research requests, answers from shared context,\nand synthesizes specialist input.",
    "[brand] needs #1 review",
  ]);
  assert.match(
    await readFile(path.join(root, ".pi/agents/generalist.md"), "utf8"),
    /description: \|-\n  Routes research requests, answers from shared context,\n  and synthesizes specialist input\./,
  );
});

test("formatAgentScaffoldCreatedMessage gives next setup steps", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-scaffold-"));

  const result = await createAgentScaffold(root, "Market Research", {
    docs: ["docs/workstreams/market/"],
    skills: ["market-skill"],
  });

  assert.equal(formatAgentScaffoldCreatedMessage(result), [
    "Created .pi/agents/market-research.md",
    "",
    "Launch: /market-research",
    "Docs: docs/workstreams/market/",
    "Skills: market-skill",
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
  assert.equal(normalizeAgentName("123"), "agent-123");
  assert.throws(() => normalizeAgentName("!!!"), /agent name must contain at least one letter or number/);
});

test("phase 7 full workflow composes setup docs doctor launch consult roundtable and add-agent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-phase7-"));

  await writeText(path.join(root, ".pi/agents/_baseline.md"), `---
docs: docs/shared/
skills: shared-skill
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
  });
  await createAgentScaffold(root, "brand", {
    description: "Brand pilot specialist.",
    docs: ["docs/workstreams/brand/"],
    skills: ["brand-skill"],
  });
  await createAgentScaffold(root, "guideline", {
    description: "Guideline pilot reviewer.",
    docs: ["docs/workstreams/guideline/"],
    skills: ["guideline-skill"],
  });

  const doctor = await runDoctor(root, {
    dependencyStatus: {
      piSubagents: { ok: true, version: "0.34.0", path: "/tmp/pi-subagents" },
      piIntercom: { ok: true, version: "0.6.0", path: "/tmp/pi-intercom" },
    },
  });
  assert.equal(doctor.status, "pass");

  const initialProject = await discoverPersonaProject(root);
  const list = formatPersonaList(initialProject);
  assert.match(list, /generalist - generalist \(primary\)/);
  assert.match(list, /brand - specialist/);
  assert.match(list, /docs: docs\/workstreams\/brand\//);
  assert.match(list, /skills: brand-skill/);
  assert.match(list, /launch: \/brand/);

  const directLaunch = await resolveAgentLaunchRequest(root, "brand", {
    task: "Draft a pilot brand answer.",
  });
  assert.equal(directLaunch.agentName, "brand");
  assert.equal(directLaunch.context, "active");
  assert.equal(directLaunch.userMessage, "Draft a pilot brand answer.");
  assert.equal(directLaunch.subagentParams, undefined);
  assert.match(directLaunch.systemPrompt, /Tool: persona_consult/);
  assert.match(directLaunch.systemPrompt, /Known personas:/);

  const consult = await resolveConsultLaunchRequest(root, {
    requester: "brand",
    consultant: "guideline",
    question: "Does the pilot answer follow the guideline?",
    summary: "The brand specialist is checking pilot copy.",
  });
  assert.equal(consult.subagentParams.agent, "guideline");
  assert.equal(consult.subagentParams.context, "fresh");
  assert.deepEqual(consult.subagentParams.reads, ["docs/shared/company.md", "docs/workstreams/guideline/rules.md"]);
  assert.deepEqual(consult.subagentParams.skill, ["shared-skill", "guideline-skill"]);
  assert.match(consult.subagentParams.task, /summary: The brand specialist is checking pilot copy\./);

  const roundtable = await resolveRoundtableLaunchRequest(root, {
    query: "Brand guideline pilot question.",
    selections: [
      { name: "brand", reason: "Brand perspective." },
      { name: "guideline", reason: "Guideline perspective." },
    ],
  });
  assert.equal(roundtable.generalist.name, "generalist");
  assert.deepEqual(roundtable.roster.map((agent) => agent.name), ["brand", "guideline"]);
  assert.equal(roundtable.subagentParams.chain.length, 3);

  await createAgentScaffold(root, "pricing", {
    description: "Pricing pilot specialist.",
    docs: ["docs/workstreams/pricing/"],
    skills: ["pricing-skill"],
  });

  const expandedProject = await discoverPersonaProject(root);
  assert.ok(expandedProject.agents.some((agent) => agent.name === "pricing"));
  assert.equal((await resolveAgentLaunchRequest(root, "brand", { task: "Still works." })).agentName, "brand");
  assert.equal((await resolveAgentLaunchRequest(root, "pricing", { task: "Pricing works." })).agentName, "pricing");

  await createAgentScaffold(root, "backup-generalist", {
    role: "generalist",
    description: "Second pilot generalist.",
  });

  const duplicateDoctor = await runDoctor(root, {
    dependencyStatus: {
      piSubagents: { ok: true, version: "0.34.0", path: "/tmp/pi-subagents" },
      piIntercom: { ok: true, version: "0.6.0", path: "/tmp/pi-intercom" },
    },
  });
  assert.equal(duplicateDoctor.status, "pass");
  const finalProject = await discoverPersonaProject(root);
  const backup = finalProject.agents.find((agent) => agent.name === "backup-generalist");
  assert.equal(backup.primary, false);
  const stableRoundtable = await resolveRoundtableLaunchRequest(root, {
    query: "Stable moderator question.",
    selections: [{ name: "pricing", reason: "Pricing perspective." }],
  });
  assert.equal(stableRoundtable.generalist.name, "generalist");
});
