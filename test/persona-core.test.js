import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";

import {
  assertNativeBackend,
  buildAgentLaunchRequest,
  buildConsultEnvelope,
  createDocsIndex,
  createPersonaInitDraft,
  createPersonaProjectScaffold,
  createConsultProgressTracker,
  createRoundtableProgressTracker,
  discoverPersonaProject,
  createAgentScaffold,
  formatAgentScaffoldCreatedMessage,
  formatConsultBridgeResult,
  formatConsultProvenance,
  formatDocsIndexReport,
  formatPersonaProjectScaffoldCreatedMessage,
  formatPersonaList,
  formatDoctorReport,
  formatPersonaInitDraftAuthoringPrompt,
  formatRoundtableRosterPreview,
  parsePersonaIndexArgs,
  parsePersonaInitArgs,
  parsePersonaOnboardArgs,
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
  runDoctor,
  resolveNativeChildTools,
  runNativeRoundtable,
  runPersonaChild,
  sendPersonaOutput,
  snapshotForkBranch,
  inspectTeamEntries,
  TEAM_BINDING_ENTRY_TYPE,
  TEAM_PENDING_ENTRY_TYPE,
} from "../src/persona/index.js";
import { readPortablePersonaPack } from "../src/persona/pack-source.js";
import {
  applyCustomPersonaPackDraft,
  listGlobalPersonaPacks,
  stageCustomPersonaPackDraft,
} from "../src/persona/global-pack-store.js";
import { readGlobalDefaultPack } from "../src/persona/pack-session.js";

async function withAgentDir(agentDir, run) {
  const original = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    return await run();
  } finally {
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = original;
  }
}

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
      if (
        (event === "subagent:slash:request" || event === "prompt-template:subagent:request")
        && onRequest
      ) {
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
  await writeText(path.join(root, ".pi/agents/_baseline.md"), `---
docs: []
skills: []
---
Shared project foundation.
`);
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
  const selections = [];
  const confirmations = [];
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
    model: options.model ?? { provider: "anthropic", id: "pi-persona-test-model" },
    thinkingLevel: options.thinkingLevel ?? "low",
    modelRegistry: options.modelRegistry ?? {
      getAll() {
        return [ctx.model];
      },
      getRegisteredProviderIds() {
        return [];
      },
      async getApiKeyAndHeaders() {
        return { ok: true, apiKey: "test-key" };
      },
    },
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
      setStatus(key, value) {
        statuses.push({ key, value });
      },
      async select(prompt, choices) {
        selections.push({ prompt, choices });
        return options.select?.(prompt, choices);
      },
      async confirm(title, message) {
        confirmations.push({ title, message });
        return options.confirm ? options.confirm(title, message) : true;
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
    isProjectTrusted: options.isProjectTrusted ?? (() => true),
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
    selections,
    confirmations,
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
    - library/shared/
  skills: []
  prompt: |
    Shared test baseline.

docs:
  files:
    library/shared/_index.md: |
      # Shared Index

      - context.md: shared context.
    library/shared/context.md: |
      TEST_BUSINESS_CONTEXT

agents: []
`;
}

function legacyAgentInitManifest() {
  return `version: 1
project:
  name: test-business

baseline:
  docs:
    - library/shared/
  skills: []
  prompt: |
    Shared test baseline.

docs:
  files:
    library/shared/_index.md: |
      # Shared Index

      - context.md: shared context.
    library/shared/context.md: |
      TEST_BUSINESS_CONTEXT
    library/personal/generalist/_index.md: |
      # Generalist Index
    library/personal/operator/_index.md: |
      # Operator Index

      - brief.md: operator brief.
    library/personal/operator/brief.md: |
      Operator personal notes.

agents:
  - name: generalist
    role: generalist
    primary: true
    description: Routes test business requests.
    docs:
      - library/personal/generalist/
    skills: []
    prompt: |
      Generalist prompt.

  - name: operator
    role: specialist
    description: Runs operating checklists.
    docs:
      - library/personal/operator/
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

test("package tarball excludes local runtime state and tests", async () => {
  const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json"], {
    cwd: process.cwd(),
    env: { ...process.env, NPM_CONFIG_CACHE: path.join(tmpdir(), "pi-persona-npm-cache") },
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
  assert.ok(files.includes("packs/philosopher-7/pack.yaml"));
  assert.ok(files.includes("packs/philosopher-7/agents/socrates.md"));
  assert.ok(files.includes("src/persona/index.js"));
  assert.equal(files.some((filePath) => filePath.endsWith(".pdf")), false);
  assert.equal(files.some((filePath) => filePath.startsWith("docs/superpowers/")), false);
  assert.deepEqual(forbidden, []);
});

test("Pi Persona has no runtime dependency on pi-subagents in the package manifest", async () => {
  const manifest = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8"));

  assert.equal(manifest.peerDependencies["pi-intercom"], undefined);
  assert.equal(manifest.peerDependencies["pi-subagents"], undefined);
  assert.equal(manifest.peerDependenciesMeta["pi-subagents"], undefined);
  assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], "*");
  assert.equal(manifest.peerDependencies["@earendil-works/pi-tui"], "*");
  assert.equal(manifest.peerDependencies.typebox, "*");
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.publishConfig.access, "public");
});

test("assertNativeBackend accepts an explicit native setting and rejects anything else", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-backend-"));
  await writeText(path.join(root, ".pi/persona.json"), `${JSON.stringify({ backend: "native" })}\n`);
  await assert.doesNotReject(() => assertNativeBackend(root, { env: {} }));
  await assert.doesNotReject(() => assertNativeBackend(root, { env: { PI_PERSONA_BACKEND: "native" } }));

  await assert.rejects(
    () => assertNativeBackend(root, { env: { PI_PERSONA_BACKEND: "legacy" } }),
    /PI_PERSONA_BACKEND environment variable is set to 'legacy'.*retired the pi-subagents backend.*unset PI_PERSONA_BACKEND or set it to 'native'/,
  );
  await assert.rejects(
    () => assertNativeBackend(root, { env: { PI_PERSONA_BACKEND: "automatic" } }),
    /PI_PERSONA_BACKEND environment variable must be 'native'/,
  );

  await writeText(path.join(root, ".pi/persona.json"), `${JSON.stringify({ backend: "legacy" })}\n`);
  await assert.rejects(
    () => assertNativeBackend(root, { env: {} }),
    /backend field in \.pi\/persona\.json is set to 'legacy'.*remove the backend field, or set it to 'native'/,
  );

  await writeText(path.join(root, ".pi/persona.json"), `${JSON.stringify({ backend: "automatic" })}\n`);
  await assert.rejects(
    () => assertNativeBackend(root, { env: {} }),
    /backend field in \.pi\/persona\.json must be 'native'/,
  );
});

test("assertNativeBackend rejects malformed project backend configuration", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-backend-malformed-"));
  await writeText(path.join(root, ".pi/persona.json"), '"native"\n');
  await assert.rejects(() => assertNativeBackend(root, { env: {} }), /.pi\/persona.json must contain a JSON object/);
});

test("assertNativeBackend respects an explicitly supplied env instead of falling back to process.env", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-backend-env-"));
  const originalBackend = process.env.PI_PERSONA_BACKEND;
  process.env.PI_PERSONA_BACKEND = "legacy";
  try {
    await assert.doesNotReject(() => assertNativeBackend(root, { env: {} }));
    await assert.rejects(
      () => assertNativeBackend(root),
      /PI_PERSONA_BACKEND environment variable is set to 'legacy'/,
    );
  } finally {
    if (originalBackend === undefined) delete process.env.PI_PERSONA_BACKEND;
    else process.env.PI_PERSONA_BACKEND = originalBackend;
  }
});

test("an installed pi-subagents package never alters Pi Persona's native backend", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-backend-default-"));
  const agentDir = await mkdtemp(path.join(tmpdir(), "pi-persona-agent-dir-"));
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await assert.doesNotReject(() => assertNativeBackend(root, { env: {} }));

    await writeText(
      path.join(agentDir, "npm/node_modules/pi-subagents/package.json"),
      `${JSON.stringify({ version: "0.35.0" })}\n`,
    );
    await writeText(path.join(agentDir, "settings.json"), `${JSON.stringify({ packages: ["npm:pi-subagents"] })}\n`);
    await assert.doesNotReject(() => assertNativeBackend(root, { env: {} }));
    assert.deepEqual(await assertPersonaRuntimeReady(root), { backend: "native" });
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
});

test("fork snapshots keep the active branch but remove the in-flight tool call", () => {
  const branch = [
    { type: "message", id: "user", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "Question" }], timestamp: 1 } },
    { type: "thinking_level_change", id: "thinking", parentId: "user", timestamp: "2026-01-01T00:00:01.000Z", thinkingLevel: "low" },
    { type: "message", id: "assistant", parentId: "thinking", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "I will consult." }, { type: "toolCall", id: "call-1", name: "persona_consult", arguments: { consultant: "brand" } }], api: "anthropic-messages", provider: "anthropic", model: "test", usage: {}, stopReason: "toolUse", timestamp: 2 } },
  ];
  assert.deepEqual(snapshotForkBranch({ getBranch: () => branch }, "call-1"), branch.slice(0, 2));
  assert.notEqual(snapshotForkBranch({ getBranch: () => branch }, "call-1")[0], branch[0]);
  assert.throws(
    () => snapshotForkBranch({ getBranch: () => branch }, "missing-call"),
    /could not find the triggering tool call 'missing-call'/,
  );
});

test("native child loads the supplied SDK entry and returns normalized progress and usage", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-child-"));
  const sdkPath = path.join(root, "sdk.mjs");
  const disposedPath = path.join(root, "disposed");
  await writeText(sdkPath, `
import { writeFile } from "node:fs/promises";
setInterval(() => {}, 1000);
export const getAgentDir = () => ${JSON.stringify(root)};
export class AuthStorage { static inMemory(data) { return { data }; } }
export class SettingsManager { static create(cwd, agentDir, options) { return { cwd, agentDir, options }; } }
export class DefaultResourceLoader {
  constructor(options) { this.options = options; }
  async reload() {}
  getSkills() { return { skills: [], diagnostics: [] }; }
}
export class ModelRuntime { static async create() { return new ModelRuntime(); } async setRuntimeApiKey() {} }
export const resolveCliModel = ({ cliModel, cliThinking }) => {
  const [provider, id] = cliModel.split("/");
  return { model: { provider, id, baseUrl: "https://example.test" }, thinkingLevel: cliThinking };
};
export class SessionManager {
  static inMemory(cwd, options, entries = []) { return { cwd, options, entries }; }
}
export async function createAgentSession(options) {
  const listeners = new Set();
  let release;
  const usage = { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const answer = JSON.stringify({ tools: options.tools, noExtensions: options.resourceLoader.options.noExtensions, entries: options.sessionManager.entries.length, projectTrusted: options.settingsManager.options.projectTrusted, thinkingLevel: options.thinkingLevel });
  const assistant = { role: "assistant", content: [{ type: "text", text: answer }], stopReason: "stop", usage };
  return { session: {
    messages: [assistant],
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async prompt(task) {
      if (task === "hang") await new Promise((resolve) => { release = resolve; });
      for (const listener of listeners) listener({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "README.md" } });
      for (const listener of listeners) listener({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", result: {}, isError: false });
      for (const listener of listeners) listener({ type: "turn_end", message: assistant });
    },
    getLastAssistantText() { return answer; },
    async abort() { release?.(); },
    async dispose() { await writeFile(${JSON.stringify(disposedPath)}, "disposed"); },
  } };
}
`);
  const updates = [];
  process.execArgv.push("--input-type=module");
  let result;
  try {
    result = await runPersonaChild({
      cwd: root,
      agentDir: root,
      sdkEntry: pathToFileURL(sdkPath).href,
      projectTrusted: true,
      personaName: "reviewer",
      systemPrompt: "Review carefully.",
      task: "Review.",
      model: { provider: "test", id: "model" },
      thinkingLevel: "low",
      auth: { apiKey: "private" },
      skillNames: [],
      skillPaths: [],
      tools: ["read", "grep", "find", "ls"],
      context: "fork",
      branch: [{ type: "session" }, { type: "message" }],
    }, { index: 4, onUpdate: (update) => updates.push(update) });
  } finally {
    process.execArgv.pop();
  }

  assert.deepEqual(JSON.parse(result.text), { tools: ["read", "grep", "find", "ls"], noExtensions: true, entries: 3, projectTrusted: true, thinkingLevel: "low" });
  assert.equal(result.usage.totalTokens, 5);
  assert.ok(updates.some((update) => update.progress[0].currentTool === "read"));
  assert.ok(updates.some((update) => update.progress[0].recentTools?.[0]?.args === JSON.stringify({ path: "README.md" })));
  assert.ok(updates.every((update) => update.progress[0].index === 4));
  assert.equal(await readFile(disposedPath, "utf8"), "disposed");

  const controller = new AbortController();
  const cancelled = runPersonaChild({
    cwd: root,
    agentDir: root,
    sdkEntry: pathToFileURL(sdkPath).href,
    projectTrusted: true,
    personaName: "reviewer",
    systemPrompt: "Review carefully.",
    task: "hang",
    model: { provider: "test", id: "model" },
    thinkingLevel: "low",
    auth: {},
    skillNames: [],
    skillPaths: [],
    tools: ["read"],
    context: "fresh",
    branch: [],
  }, {
    signal: controller.signal,
    onUpdate(update) {
      if (update.progress[0].status === "running") controller.abort();
    },
  });
  await assert.rejects(cancelled, /was cancelled/);

  const aborted = AbortSignal.abort();
  await assert.rejects(
    () => runPersonaChild(new Proxy({}, { get() { throw new Error("request was inspected"); } }), { signal: aborted }),
    /was cancelled/,
  );
});

test("native child startup timeout covers SDK initialization", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-child-startup-"));
  const sdkPath = path.join(root, "sdk.mjs");
  await writeText(sdkPath, "await new Promise(() => {});\n");

  await assert.rejects(
    () => runPersonaChild({
      cwd: root,
      sdkEntry: pathToFileURL(sdkPath).href,
      personaName: "reviewer",
      systemPrompt: "Review.",
      task: "Review.",
      model: { provider: "test", id: "model" },
      skillNames: [],
      skillPaths: [],
      tools: ["read"],
      context: "fresh",
      branch: [],
    }, { startTimeoutMs: 25 }),
    /did not start/,
  );
});

test("README gives new users a global-pack-first path with an optional project foundation", async () => {
  const readme = await readFile(path.join(process.cwd(), "README.md"), "utf8");
  const getStarted = readme.slice(readme.indexOf("## Get Started"), readme.indexOf("## Common Commands"));

  // Packs are global: no project directory is required, and onboarding is
  // an optional section after the first-run path.
  assert.doesNotMatch(getStarted, /cd \/path\/to\/your\/project/);
  assert.match(getStarted, /open Pi in any directory/);
  assert.match(getStarted, /Skip `\/persona onboard` on a first run/);
  assert.match(getStarted, /## Optional Project Foundation[\s\S]*\/persona onboard/);
  assert.match(getStarted, /\/persona pack list/);
  assert.match(getStarted, /\/persona pack install philosopher-7/);
  assert.match(getStarted, /\/persona team philosopher-7/);
  // Chat-first: plain-language requests lead; slash commands follow as the
  // precise alternative.
  assert.match(getStarted, /just ask in chat/);
  assert.ok(getStarted.indexOf("just ask in chat") < getStarted.indexOf("/persona pack install philosopher-7"));
  assert.doesNotMatch(getStarted, /\/persona pack author/);
  assert.doesNotMatch(getStarted, /\/example-specialist/);
  assert.doesNotMatch(getStarted, /\/persona quick-start/);
  assert.doesNotMatch(getStarted, /setup-manifest/);
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
  assert.match(source, /Usage: \/persona onboard/);
  assert.match(source, /\/persona doctor/);
  assert.match(source, /\/persona pack create <new-name>/);
  assert.doesNotMatch(source, /Usage: \/persona quick-start/);
  assert.doesNotMatch(source, /Usage: \/persona new/);
  assert.doesNotMatch(source, /Usage: \/persona index/);
  assert.doesNotMatch(source, /\/agent doctor/);
  assert.match(source, /planPersonaInitFromManifest/);
  assert.match(source, /createPersonaInitDraft/);
  assert.match(source, /formatPersonaInitDraftAuthoringPrompt/);
  assert.match(source, /createDocsIndex/);
  assert.match(source, /name:\s*"persona_init"/);
  assert.match(source, /\/persona use <name>/);
});

test("persona onboard starts or resumes guided setup at the default manifest", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-onboard-"));
  const harness = await createExtensionHarness(root);
  const command = harness.commands.get("persona");

  await command.handler("onboard", harness.ctx);

  assert.match(await readFile(path.join(root, "init-data/my-persona-setup.yaml"), "utf8"), /version: 1/);
  assert.match(harness.messages.at(-1).content, /Starting a short guided project foundation/);
  assert.match(harness.messages.at(-1).content, /2–5 minutes/);
  assert.match(harness.messages.at(-1).content, /library\/shared/);
  assert.doesNotMatch(harness.messages.at(-1).content, /library\/personal|project-specific/);
  assert.match(harness.sentUserMessages.at(-1).message, /Ask me one question at a time/);
  assert.doesNotMatch(harness.sentUserMessages.at(-1).message, /persona_init|confirmed: true|The user invoked/);

  await command.handler("onboard", harness.ctx);

  assert.match(harness.messages.at(-1).content, /Resuming a short guided project foundation/);
  assert.equal(harness.sentUserMessages.length, 2);
});

test("persona onboard reports an existing persona setup instead of restarting", async () => {
  const root = await createCommandWorkspace("brand");
  const harness = await createExtensionHarness(root);

  await harness.commands.get("persona").handler("onboard", harness.ctx);

  assert.match(harness.messages.at(-1).content, /Pi Persona is already set up/);
  assert.match(harness.messages.at(-1).content, /# Pi Persona Doctor/);
  assert.match(harness.messages.at(-1).content, /# Pi Personas/);
  assert.equal(harness.sentUserMessages.length, 0);
});

test("persona onboard reports readiness after an applied manifest", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-onboard-applied-"));
  await writeText(path.join(root, "init-data/my-persona-setup.yaml"), starterInitManifest());
  await applyPersonaInitFromManifest(root, "init-data/my-persona-setup.yaml");
  await createDocsIndex(root, { all: true });
  const harness = await createExtensionHarness(root);

  await harness.commands.get("persona").handler("onboard", harness.ctx);

  assert.match(harness.messages.at(-1).content, /Pi Persona onboarding is complete/);
  assert.match(harness.messages.at(-1).content, /# Pi Persona Doctor/);
  assert.equal(harness.sentUserMessages.length, 0);
});

test("/persona pack manages global packs end to end without any project foundation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-pack-no-baseline-"));
  const agentDir = await mkdtemp(path.join(tmpdir(), "pi-persona-pack-agentdir-"));

  await withAgentDir(agentDir, async () => {
    const harness = await createExtensionHarness(root);
    const command = harness.commands.get("persona");

    // No .pi/agents/_baseline.md exists in `root`, and none of the following
    // global pack operations should need or create one -- design draft §1:
    // "There are no new project installations or project activation
    // overrides", so install/fork/create/edit never touch ctx.cwd at all.
    await command.handler("pack list", harness.ctx);
    assert.match(harness.messages.at(-1).content, /philosopher-7 \(1\.0\.0\)/);
    assert.equal(harness.sentUserMessages.length, 0);

    await command.handler("pack install philosopher-7", harness.ctx);
    assert.match(harness.messages.at(-1).content, /Installed persona pack 'official\/philosopher-7'/);
    assert.equal(harness.sentUserMessages.length, 0);
    assert.equal(await pathExists(path.join(root, ".pi")), false);

    await command.handler("pack status philosopher-7", harness.ctx);
    assert.match(harness.messages.at(-1).content, /official\/philosopher-7/);
    assert.match(harness.messages.at(-1).content, /\[G\] symposium/);

    await command.handler("pack create my-team", harness.ctx);
    const createMessage = harness.messages.at(-1).content;
    assert.match(createMessage, /Started a new draft for 'my-team'/);
    const draftPath = path.join(agentDir, "persona", "drafts", "my-team");
    assert.match(createMessage, new RegExp(draftPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(harness.sentUserMessages.length, 1);
    assert.match(harness.sentUserMessages.at(-1).message, /Help me create the persona pack 'my-team'/);
    assert.match(harness.sentUserMessages.at(-1).message, new RegExp(draftPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    // Calling create again on the same pending draft resumes it instead of
    // silently restarting it (a resumed draft must not clobber in-progress
    // edits already made on disk).
    await command.handler("pack create my-team", harness.ctx);
    assert.match(harness.messages.at(-1).content, /Resuming the pending draft for 'my-team'/);

    await command.handler("pack preview my-team", harness.ctx);
    assert.match(harness.messages.at(-1).content, /new pack/);

    // apply is one of the confirm-gated actions: it must show the ctx.ui.confirm
    // dialog before mutating anything (the default test harness answers yes).
    await command.handler("pack apply my-team", harness.ctx);
    assert.equal(harness.confirmations.length, 1);
    assert.match(harness.confirmations[0].message, /Apply the pending draft for 'my-team'/);
    // The dialog is read by a person: no tool-call syntax may leak into it.
    assert.doesNotMatch(harness.confirmations[0].message, /confirmed|planId|Run (apply )?again/);
    assert.match(harness.messages.at(-1).content, /Applied the draft for 'custom\/my-team'/);

    await command.handler("pack fork philosopher-7 my-fork", harness.ctx);
    assert.match(harness.messages.at(-1).content, /Forked 'official\/philosopher-7' into 'custom\/my-fork'/);

    await command.handler("pack edit my-fork", harness.ctx);
    assert.match(harness.messages.at(-1).content, /Started editing draft for 'my-fork'/);

    await command.handler("pack cancel my-fork", harness.ctx);
    assert.match(harness.messages.at(-1).content, /Discarded the pending draft for 'my-fork'/);

    await command.handler("pack delete my-fork", harness.ctx);
    assert.match(harness.confirmations.at(-1).message, /Permanently delete 'custom\/my-fork'/);
    assert.doesNotMatch(harness.confirmations.at(-1).message, /confirmed|planId|Run again/);
    assert.match(harness.messages.at(-1).content, /Deleted persona pack 'custom\/my-fork'/);

    await command.handler("pack uninstall philosopher-7", harness.ctx);
    assert.match(harness.messages.at(-1).content, /Uninstalled persona pack 'official\/philosopher-7'/);

    const { official, custom } = await listGlobalPersonaPacks(path.join(agentDir, "persona"));
    assert.deepEqual(official, []);
    assert.deepEqual(custom.map((pack) => pack.name), ["my-team"]);
  });
});

test("declining the confirmation dialog cancels a destructive persona pack action", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-pack-decline-"));
  const agentDir = await mkdtemp(path.join(tmpdir(), "pi-persona-pack-decline-agentdir-"));

  await withAgentDir(agentDir, async () => {
    const harness = await createExtensionHarness(root, { confirm: () => false });
    const command = harness.commands.get("persona");

    await command.handler("pack install philosopher-7", harness.ctx);
    await command.handler("pack uninstall philosopher-7", harness.ctx);

    assert.equal(harness.confirmations.length, 1);
    assert.match(harness.messages.at(-1).content, /^Cancelled\.$/);
    const { official } = await listGlobalPersonaPacks(path.join(agentDir, "persona"));
    assert.equal(official.length, 1, "declining the dialog must leave the pack installed");
  });
});

test("uninstalling the current global default explicitly names and clears it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-pack-default-clear-"));
  const agentDir = await mkdtemp(path.join(tmpdir(), "pi-persona-pack-default-clear-agentdir-"));

  await withAgentDir(agentDir, async () => {
    const harness = await createExtensionHarness(root);
    const command = harness.commands.get("persona");

    await command.handler("pack install philosopher-7", harness.ctx);
    await command.handler("team default philosopher-7", harness.ctx);
    assert.equal(
      (await readGlobalDefaultPack(path.join(agentDir, "persona")))?.defaultPack,
      "official/philosopher-7",
    );

    await command.handler("pack uninstall philosopher-7", harness.ctx);
    assert.match(harness.confirmations.at(-1).message, /currently the global default/);
    assert.doesNotMatch(harness.confirmations.at(-1).message, /confirmed|clearDefaultConfirmed|Run again/);
    assert.match(harness.messages.at(-1).content, /global default was cleared/);
    assert.equal((await readGlobalDefaultPack(path.join(agentDir, "persona")))?.defaultPack, null);
  });
});

test("persona_pack tool manages global packs with an explicit plan-then-confirm gate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-pack-tool-"));
  const agentDir = await mkdtemp(path.join(tmpdir(), "pi-persona-pack-tool-agentdir-"));

  await withAgentDir(agentDir, async () => {
    const harness = await createExtensionHarness(root);
    const tool = harness.tools.get("persona_pack");
    assert.match(tool.promptSnippet, /Never pass confirmed: true on the first call/);

    const install = await tool.execute("install", { action: "install", target: "philosopher-7" }, undefined, undefined, harness.ctx);
    assert.notEqual(install.isError, true);
    assert.match(install.content[0].text, /Installed persona pack 'official\/philosopher-7'/);

    const create = await tool.execute("create", { action: "create", target: "tool-team" }, undefined, undefined, harness.ctx);
    assert.equal(create.details.mode, "draft");
    const draftPath = create.details.draftPath;
    await writeText(path.join(draftPath, "agents", "tool-team-lead.md"), (
      await readFile(path.join(draftPath, "agents", "tool-team-lead.md"), "utf8")
    ).replace("Replace this starter prompt with real instructions.", "Coordinate the tool team."));

    const previewFirst = await tool.execute("apply", { action: "apply", target: "tool-team" }, undefined, undefined, harness.ctx);
    assert.equal(previewFirst.details.mode, "confirm-required", "the tool must see a plan before it may apply");
    assert.ok(previewFirst.details.planId, "a confirm-required plan must carry a plan token to bind the eventual apply to it");
    assert.doesNotMatch(previewFirst.content[0].text, /Applied/);
    // The plan's own summary stays plain text; the exact approved-retry
    // parameters are handed to the tool caller separately and structured.
    assert.doesNotMatch(previewFirst.details.summary, /confirmed|planId/);
    assert.deepEqual(previewFirst.details.confirmParams, { confirmed: true, planId: previewFirst.details.planId });
    assert.ok(
      previewFirst.content[0].text.includes(JSON.stringify({ action: "apply", target: "tool-team", confirmed: true, planId: previewFirst.details.planId })),
      "the tool result spells out the exact structured retry",
    );
    assert.match(previewFirst.content[0].text, /Only after the user explicitly approves/);

    const appliedWithoutToken = await tool.execute("apply", { action: "apply", target: "tool-team", confirmed: true }, undefined, undefined, harness.ctx);
    assert.equal(appliedWithoutToken.isError, true, "confirmed:true alone, without the plan's own token, must not be enough to apply");

    const appliedSameTurn = await tool.execute("apply", { action: "apply", target: "tool-team", confirmed: true, planId: previewFirst.details.planId }, undefined, undefined, harness.ctx);
    assert.equal(appliedSameTurn.isError, true, "the plan's token alone is not approval: the user must reply after seeing the plan");
    assert.match(appliedSameTurn.content[0].text, /has not replied since this plan was shown/);
    harness.entries.push({ type: "message", message: { role: "user", content: [{ type: "text", text: "yes, apply it" }] } });

    const applied = await tool.execute("apply", { action: "apply", target: "tool-team", confirmed: true, planId: previewFirst.details.planId }, undefined, undefined, harness.ctx);
    assert.match(applied.content[0].text, /Applied the draft for 'custom\/tool-team'/);

    const deletePreview = await tool.execute("delete", { action: "delete", target: "tool-team" }, undefined, undefined, harness.ctx);
    assert.equal(deletePreview.details.mode, "confirm-required");
    assert.ok(deletePreview.details.planId);
    const { custom: beforeDelete } = await listGlobalPersonaPacks(path.join(agentDir, "persona"));
    assert.equal(beforeDelete.length, 1, "an unconfirmed delete call must not mutate the store");
    harness.entries.push({ type: "message", message: { role: "user", content: [{ type: "text", text: "yes, delete it" }] } });

    const deleted = await tool.execute("delete", { action: "delete", target: "tool-team", confirmed: true, planId: deletePreview.details.planId }, undefined, undefined, harness.ctx);
    assert.match(deleted.content[0].text, /Deleted persona pack 'custom\/tool-team'/);
  });
});

async function pathExists(candidate) {
  try {
    await stat(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

test("persona init remains an onboarding alias while removed quick-start shows public usage", async () => {
  const onboardRoot = await mkdtemp(path.join(tmpdir(), "pi-persona-init-alias-"));
  const onboard = await createExtensionHarness(onboardRoot);

  await onboard.commands.get("persona").handler("init", onboard.ctx);

  assert.match(await readFile(path.join(onboardRoot, "init-data/my-persona-setup.yaml"), "utf8"), /version: 1/);
  assert.equal(onboard.sentUserMessages.length, 1);

  const quickRoot = await mkdtemp(path.join(tmpdir(), "pi-persona-quick-start-"));
  const quick = await createExtensionHarness(quickRoot);

  await quick.commands.get("persona").handler("quick-start", quick.ctx);

  assert.match(quick.messages.at(-1).content, /Usage: \/persona onboard/);
  assert.doesNotMatch(quick.messages.at(-1).content, /quick-start/);
  assert.equal((await discoverPersonaProject(quickRoot)).agents.length, 0);
  assert.equal(quick.sentUserMessages.length, 0);
});

test("extension exposes model-callable manifest planning and confirmation-gated apply", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-init-tool-"));
  const draft = await createPersonaInitDraft(root, "init-data/setup.yaml");
  const authoredDraft = (await readFile(path.join(root, draft.source), "utf8"))
    .replace(
      "Add the user's project purpose, shared constraints, vocabulary, and\n      recurring context here.",
      "This workspace verifies Pi Persona onboarding and operation.",
    );
  await writeText(path.join(root, draft.source), authoredDraft);
  const harness = await createExtensionHarness(root);
  const tool = harness.tools.get("persona_init");

  assert.ok(tool);
  const plan = await tool.execute("plan", {
    action: "plan",
    source: draft.source,
  }, undefined, undefined, harness.ctx);
  assert.equal(plan.details.mode, "plan");
  assert.match(plan.content[0].text, /Project Foundation Plan/);

  await assert.rejects(
    () => tool.execute("apply", {
      action: "apply",
      source: draft.source,
    }, undefined, undefined, harness.ctx),
    /approve the displayed foundation plan/,
  );

  const applied = await tool.execute("apply", {
    action: "apply",
    source: draft.source,
    confirmed: true,
  }, undefined, undefined, harness.ctx);
  assert.notEqual(applied.isError, true);
  assert.match(applied.content[0].text, /Project Foundation Applied/);
  assert.match(applied.content[0].text, /Pi Persona Doctor/);
  assert.match(applied.content[0].text, /# Pi Personas/);
  assert.match(applied.content[0].text, /Project foundation complete/);
  assert.match(applied.content[0].text, /\/persona pack list/);
  assert.ok(["pass", "warning"].includes(applied.details.doctor.status));
  assert.ok(applied.details.status.items.every((item) => item.state === "done"));
  assert.equal(harness.entries.length, 0);
  assert.deepEqual((await discoverPersonaProject(root)).agents, []);
});

test("manifest apply reports completed writes that still need doctor attention", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-needs-attention-"));
  await writeText(path.join(root, "init-data/setup.yaml"), starterInitManifest());
  await writeText(path.join(root, ".pi/agents/broken.md"), "---\nname: broken\n---\nBroken.\n");
  const harness = await createExtensionHarness(root);

  const result = await harness.tools.get("persona_init").execute("apply", {
    action: "apply",
    source: "init-data/setup.yaml",
    confirmed: true,
  }, undefined, undefined, harness.ctx);

  assert.equal(result.details.doctor.status, "error");
  assert.notEqual(result.isError, true);
  assert.match(result.content[0].text, /Project Foundation Applied — Needs Attention/);
  assert.match(result.content[0].text, /Onboarding needs attention/);
  assert.doesNotMatch(result.content[0].text, /rolled back/i);
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
  assert.match(source, /formatConsultBridgeResult/);
  assert.match(consultToolBlock, /runPersonaChild/);
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
  assert.match(expanded, /Moderator: active pack \[G\] persona/);
  assert.match(expanded, /3\. Moderator synthesis/);

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
  assert.match(source, /session_shutdown/);
  assert.match(source, /cancelPersonaChildren/);
  assert.match(source, /\/persona status/);
  assert.match(source, /\/persona clear/);
});

// Project-local pack authoring/configuration (install/author/configure/
// update/remove creating or mutating .pi/agents/packs/**) was retired from
// persona_pack in favor of the global store (see the "/persona pack manages
// global packs" tests above): persona_pack now never reads or writes
// ctx.cwd at all. That structurally removes the corruption risk the two
// tests previously here guarded against (an unrelated ctx.cwd pack mutation
// clearing a bound global team's active persona/commands) -- there is no
// longer any live code path that mutates ctx.cwd's roster from persona_pack.
// The replacement below still exercises the one invariant that remains
// meaningful under the new architecture: a global persona_pack mutation
// (install) must never touch a bound session's own active persona/commands.
test("a bound global team's active persona and commands survive an unrelated global persona_pack mutation", async (t) => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "pi-persona-bound-vs-global-"));
  const agentDir = await mkdtemp(path.join(tmpdir(), "pi-persona-bound-vs-global-agent-"));
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  });

  // A real global custom pack, installed into the store, that this session
  // binds to -- exactly like a completed /persona team switch.
  const storeRoot = path.join(agentDir, "persona");
  const sourceDir = await mkdtemp(path.join(tmpdir(), "pi-persona-bound-vs-global-src-"));
  await writeText(path.join(sourceDir, "pack.yaml"), "schema: 2\nname: council\nversion: 1.0.0\ndescription: Council test pack.\n");
  await writeText(path.join(sourceDir, "agents/lead.md"), "---\nname: lead\nrole: generalist\ndescription: Council lead.\n---\nLead prompt.\n");
  await writeText(path.join(sourceDir, "agents/scout.md"), "---\nname: scout\nrole: specialist\ndescription: Council scout.\n---\nScout prompt.\n");
  await writeText(path.join(sourceDir, "references/_index.md"), "# council\n");
  const source = await readPortablePersonaPack(sourceDir, { type: "path", ref: sourceDir });
  await stageCustomPersonaPackDraft(storeRoot, "council", source);
  await applyCustomPersonaPackDraft(storeRoot, "council");
  await rm(sourceDir, { recursive: true, force: true });

  const harness = await createExtensionHarness(workspaceRoot);
  // Simulate an already-committed binding with its lead already active, as
  // if a prior "/persona team custom/council" switch had run to completion.
  harness.entries.push({ type: "custom", customType: TEAM_BINDING_ENTRY_TYPE, data: { status: "pack", qualifiedName: "custom/council" } });
  harness.entries.push({ type: "custom", customType: "pi-persona-active", data: { agentName: "lead" } });
  await harness.handlers.get("session_start")(null, harness.ctx);

  await harness.commands.get("persona").handler("status", harness.ctx);
  assert.match(harness.messages.at(-1).content, /Persona team: custom\/council/);
  assert.match(harness.messages.at(-1).content, /Active persona: \[G\] lead \(\/lead\)/);

  // An entirely unrelated global pack install through persona_pack, which
  // never touches ctx.cwd or any bound session state.
  const tool = harness.tools.get("persona_pack");
  const install = await tool.execute("install", { action: "install", target: "philosopher-7" }, undefined, undefined, harness.ctx);
  assert.match(install.content[0].text, /Installed persona pack 'official\/philosopher-7'/);

  await harness.commands.get("persona").handler("status", harness.ctx);
  assert.match(harness.messages.at(-1).content, /Persona team: custom\/council/, "the bound global team survives an unrelated global pack install");
  assert.match(harness.messages.at(-1).content, /Active persona: \[G\] lead \(\/lead\)/, "the bound team's active persona is not cleared by an unrelated global pack install");
  assert.ok(harness.commands.has("lead"), "the bound team's command remains registered");
  assert.ok(
    !harness.commands.has("symposium"),
    "installing an unrelated global pack while bound never registers its own lead as a live dispatchable command",
  );
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
  // Direct persona commands are registered from the discovered project
  // roster (there is no static, always-there "generalist" command), so the
  // workspace's own roster must actually be registered first.
  await harness.handlers.get("session_start")(null, harness.ctx);
  const tool = harness.tools.get("persona_consult");
  const params = {
    requester: "brand",
    consultant: "generalist",
    question: "Review this.",
    summary: "Focused context.",
  };

  await assert.rejects(
    () => tool.execute("consult", params, undefined, undefined, harness.ctx),
    /requires an active persona/,
  );

  await harness.commands.get("generalist").handler("", harness.ctx);
  await assert.rejects(
    () => tool.execute("consult", params, undefined, undefined, harness.ctx),
    /requester must match active persona 'generalist'/,
  );
});

test("none, missing-bound, and migration-required block every persona execution path; legacy does not", async (t) => {
  const agentDir = await mkdtemp(path.join(tmpdir(), "pi-persona-execution-guard-"));
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  });

  const scenarios = [
    {
      name: "none",
      binding: { status: "none" },
      fragment: /No persona team is bound\. Run \/persona team to choose one\./,
    },
    {
      name: "missing-bound",
      binding: { status: "pack", qualifiedName: "custom/does-not-exist" },
      fragment: /This session's persona team could not be loaded\. Run \/persona team to choose a valid pack\./,
    },
    {
      name: "migration-required",
      binding: { status: "migration-required" },
      fragment: /Run \/persona migrate inspect[\s\S]*run \/persona team to choose an already-installed persona team/,
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const root = await createCommandWorkspace("brand");
      const harness = await createExtensionHarness(root);
      harness.entries.push({ type: "custom", customType: TEAM_BINDING_ENTRY_TYPE, data: scenario.binding });
      await harness.handlers.get("session_start")(null, harness.ctx);

      // Direct activation of a ctx.cwd-registered command is refused, not
      // silently resolved against the unrelated ctx.cwd roster.
      await harness.commands.get("brand").handler("", harness.ctx);
      assert.match(harness.messages.at(-1).content, scenario.fragment, "direct activation");
      assert.ok(!harness.entries.some((entry) => entry.customType === "pi-persona-active" && entry.data.agentName), "no active persona was recorded");

      // /persona use is the same activation path and is refused identically.
      await harness.commands.get("persona").handler("use brand", harness.ctx);
      assert.match(harness.messages.at(-1).content, scenario.fragment, "/persona use");

      // persona_consult refuses before even checking for an active persona.
      const consultTool = harness.tools.get("persona_consult");
      await assert.rejects(
        () => consultTool.execute("consult", {
          requester: "brand",
          consultant: "generalist",
          question: "Review this.",
          summary: "Context.",
        }, undefined, undefined, harness.ctx),
        scenario.fragment,
        "persona_consult",
      );

      // persona_roundtable refuses even with well-formed selections.
      const roundtableTool = harness.tools.get("persona_roundtable");
      await assert.rejects(
        () => roundtableTool.execute("roundtable", {
          query: "Should we ship?",
          selections: [{ name: "brand", reason: "Brand perspective." }],
        }, undefined, undefined, harness.ctx),
        scenario.fragment,
        "persona_roundtable",
      );
    });
  }

  // Legacy (no team-binding entry ever recorded) is the one unbound state
  // that keeps the pre-existing ctx.cwd fallback usable: this is the
  // no-team-redesign-touched-it-at-all case, not a guarded state.
  await t.test("legacy", async () => {
    const root = await createCommandWorkspace("brand");
    const harness = await createExtensionHarness(root);
    await harness.handlers.get("session_start")(null, harness.ctx);
    await harness.commands.get("brand").handler("", harness.ctx);
    assert.equal(harness.entries.at(-1).data.agentName, "brand", "legacy direct activation still works");
  });
});

test("native consult uses live extension context and reaches the real child SDK path", async (t) => {
  const root = await createCommandWorkspace("brand");
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(root, ".pi-agent");
  t.after(() => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  });
  await writeText(path.join(root, ".pi/persona.json"), `${JSON.stringify({ backend: "native" })}\n`);
  let authCalls = 0;
  let trustCalls = 0;
  const model = { provider: "pi-persona-missing-provider", id: "missing-model" };
  const harness = await createExtensionHarness(root, {
    model,
    thinkingLevel: "high",
    isProjectTrusted() {
      trustCalls += 1;
      return true;
    },
    modelRegistry: {
      getAll: () => [model],
      getRegisteredProviderIds: () => [],
      async getApiKeyAndHeaders(selected) {
        authCalls += 1;
        assert.equal(selected, model);
        return { ok: true, env: { PI_PERSONA_TEST_API_KEY: "test-key" } };
      },
    },
  });
  await harness.handlers.get("session_start")(null, harness.ctx);
  await harness.commands.get("generalist").handler("", harness.ctx);
  await harness.handlers.get("before_agent_start")({ systemPrompt: "base", systemPromptOptions: { skills: [] } }, harness.ctx);

  await assert.rejects(
    () => harness.tools.get("persona_consult").execute("native-consult", {
      requester: "generalist",
      consultant: "brand",
      question: "Review this.",
      summary: "Focused context.",
    }, undefined, undefined, harness.ctx),
    /model/i,
  );
  assert.equal(authCalls, 1);
  assert.equal(trustCalls, 1);
});

test("native child tools default read-only and accept declared Pi built-ins", () => {
  assert.deepEqual(resolveNativeChildTools([]), ["read", "grep", "find", "ls"]);
  assert.deepEqual(resolveNativeChildTools(["read", "bash", "edit", "write"]), ["read", "bash", "edit", "write"]);
  assert.throws(() => resolveNativeChildTools(["web_search"]), /unknown built-in tools: web_search/);
});

test("native consult preflight accepts declared Pi built-in tools and rejects only unavailable resources", async (t) => {
  await t.test("declared built-in tools", async () => {
    const root = await createCommandWorkspace("brand");
    await writeText(path.join(root, ".pi/persona.json"), `${JSON.stringify({ backend: "native" })}\n`);
    await writeText(path.join(root, ".pi/agents/_baseline.md"), "---\ntools: bash, edit, write\n---\nBaseline.\n");
    const source = await readFile(path.join(process.cwd(), "extensions/pi-persona.ts"), "utf8");
    assert.doesNotMatch(source, /supports read-only child tools; unsupported/);
  });

  await t.test("missing loaded skill", async () => {
    const root = await createCommandWorkspace("brand");
    await writeText(path.join(root, ".pi/persona.json"), `${JSON.stringify({ backend: "native" })}\n`);
    await writeText(path.join(root, ".pi/agents/_baseline.md"), "---\nskills: required-skill\n---\nBaseline.\n");
    const harness = await createExtensionHarness(root);
    await harness.handlers.get("session_start")(null, harness.ctx);
    await harness.commands.get("generalist").handler("", harness.ctx);
    await assert.rejects(
      () => harness.tools.get("persona_consult").execute("skill", { requester: "generalist", consultant: "brand", question: "Review.", summary: "Context." }, undefined, undefined, harness.ctx),
      /exactly one loaded Pi skill named 'required-skill'/,
    );
  });

  await t.test("extension provider", async () => {
    const root = await createCommandWorkspace("brand");
    await writeText(path.join(root, ".pi/persona.json"), `${JSON.stringify({ backend: "native" })}\n`);
    const model = { provider: "extension-provider", id: "model" };
    const harness = await createExtensionHarness(root, {
      model,
      modelRegistry: {
        getAll: () => [model],
        getRegisteredProviderIds: () => [model.provider],
        getApiKeyAndHeaders: async () => ({ ok: true }),
      },
    });
    await harness.handlers.get("session_start")(null, harness.ctx);
    await harness.commands.get("generalist").handler("", harness.ctx);
    await assert.rejects(
      () => harness.tools.get("persona_consult").execute("provider", { requester: "generalist", consultant: "brand", question: "Review.", summary: "Context." }, undefined, undefined, harness.ctx),
      /cannot use extension-registered provider/,
    );
  });

  await t.test("authentication", async () => {
    const root = await createCommandWorkspace("brand");
    await writeText(path.join(root, ".pi/persona.json"), `${JSON.stringify({ backend: "native" })}\n`);
    const model = { provider: "anthropic", id: "model" };
    const harness = await createExtensionHarness(root, {
      model,
      modelRegistry: {
        getAll: () => [model],
        getRegisteredProviderIds: () => [],
        getApiKeyAndHeaders: async () => ({ ok: false, error: "login required" }),
      },
    });
    await harness.handlers.get("session_start")(null, harness.ctx);
    await harness.commands.get("generalist").handler("", harness.ctx);
    await assert.rejects(
      () => harness.tools.get("persona_consult").execute("auth", { requester: "generalist", consultant: "brand", question: "Review.", summary: "Context." }, undefined, undefined, harness.ctx),
      /login required/,
    );
  });
});

test("concurrent sibling persona consults dispatch independently to native children even with pi-subagents installed", async (t) => {
  const root = await createWorkspace();
  const agentDir = await mkdtemp(path.join(tmpdir(), "pi-persona-consult-runtime-"));
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  await writeText(
    path.join(agentDir, "npm/node_modules/pi-subagents/package.json"),
    `${JSON.stringify({ name: "pi-subagents", version: "0.37.2" })}\n`,
  );
  await writeText(path.join(agentDir, "settings.json"), `${JSON.stringify({ packages: ["npm:pi-subagents"] })}\n`);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  });

  const requests = [];
  let authCalls = 0;
  const model = { provider: "pi-persona-missing-provider", id: "missing-model" };
  const harness = await createExtensionHarness(root, {
    model,
    modelRegistry: {
      getAll: () => [model],
      getRegisteredProviderIds: () => [],
      async getApiKeyAndHeaders() {
        authCalls += 1;
        return { ok: true };
      },
    },
    onSubagentRequest(request) {
      requests.push(request);
    },
  });
  await harness.commands.get("persona").handler("use generalist", harness.ctx);
  await harness.handlers.get("before_agent_start")({
    systemPrompt: "base",
    systemPromptOptions: {
      skills: ["shared-skill", "brand-skill", "guideline-skill"].map((name) => ({ name, filePath: path.join(root, "missing", name, "SKILL.md") })),
    },
  }, harness.ctx);
  const tool = harness.tools.get("persona_consult");

  const [brandOutcome, guidelineOutcome] = await Promise.allSettled([
    tool.execute("consult-brand", {
      requester: "generalist",
      consultant: "brand",
      question: "What positioning should we use?",
      summary: "The requester is preparing launch copy.",
    }, undefined, undefined, harness.ctx),
    tool.execute("consult-guideline", {
      requester: "generalist",
      consultant: "guideline",
      question: "What evidence standard should we use?",
      summary: "The requester is preparing launch copy.",
    }, undefined, undefined, harness.ctx),
  ]);

  assert.equal(brandOutcome.status, "rejected");
  assert.equal(guidelineOutcome.status, "rejected");
  assert.equal(authCalls, 2, "each sibling consult resolves its own native child auth independently");
  assert.equal(requests.length, 0, "installed pi-subagents must never receive a Pi Persona dispatch");
  assert.equal(harness.events.listenerCount("subagent:slash:request"), 0);
  assert.equal(harness.events.listenerCount("prompt-template:subagent:request"), 0);
});

test("extension does not bootstrap a project coordinator and routes unknown names to discovery", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-generalist-bootstrap-"));
  const harness = await createExtensionHarness(root);

  await harness.commands.get("persona").handler("use generalist", harness.ctx);

  assert.match(harness.messages.at(-1).content, /\/generalist is not available in this session\. Run \/persona-list\./);
  assert.doesNotMatch(harness.messages.at(-1).content, /persona onboard/);
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
    /\/brand is not available in this session\. Run \/persona-list\./,
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
  assert.match(result.systemPrompt, /Previously active persona \/ops is not available in this session/);
  assert.equal(harness.statuses.at(-1).value, undefined);
});

for (const status of ["none", "migration-required"]) {
  test(`a restored active persona does not pull the workspace roster into a ${status} session`, async (t) => {
    // e.g. an older pi-personas appended pi-persona-active after this
    // version recorded the session's team scope.
    const workspace = await createCommandWorkspace();
    const agentDir = await mkdtemp(path.join(tmpdir(), "pi-persona-restored-active-"));
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    t.after(async () => {
      if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
      await rm(agentDir, { recursive: true, force: true });
    });
    const harness = await createExtensionHarness(workspace);
    harness.entries.push(
      { type: "custom", customType: "pi-persona-team", data: { status } },
      { type: "custom", customType: "pi-persona-active", data: { agentName: "generalist" } },
    );

    await harness.handlers.get("session_start")({ type: "session_start", reason: "startup" }, harness.ctx);
    assert.equal(harness.entries.at(-1).data.agentName, null, "the stale active persona is cleared on start");
    assert.equal(harness.statuses.at(-1).value, undefined);

    harness.entries.push({ type: "custom", customType: "pi-persona-active", data: { agentName: "generalist" } });
    const result = await harness.handlers.get("before_agent_start")({ systemPrompt: "base prompt" }, harness.ctx);
    assert.doesNotMatch(result?.systemPrompt ?? "", /Generalist prompt\./, "the workspace persona prompt is not injected");
    assert.equal(harness.entries.at(-1).data.agentName, null);
  });
}

test("extension registers persona-roundtable as a namespaced command and model-callable tool", async () => {
  const source = await readFile(path.join(process.cwd(), "extensions/pi-persona.ts"), "utf8");

  assert.match(source, /registerCommand\("persona-roundtable"/);
  assert.doesNotMatch(source, /registerCommand\("roundtable"/);
  assert.match(source, /name:\s*"persona_roundtable"/);
  assert.match(source, /createRoundtableProgressReporter/);
  assert.match(source, /onUpdate/);
  assert.match(source, /assertPersonaRuntimeReady/);
  assert.match(source, /resolveRoundtableSelectionRequest/);
  assert.match(source, /runNativeRoundtable/);
  assert.match(source, /present its moderator synthesis faithfully and in full/);
  assert.match(source, /never summarize, shorten, paraphrase/);
});

test("extension preflights runtime readiness before native child execution", async () => {
  const source = await readFile(path.join(process.cwd(), "extensions/pi-persona.ts"), "utf8");
  const consultToolBlock = source.slice(
    source.indexOf('name: "persona_consult"'),
    source.indexOf("const registerPersonaCommand"),
  );
  const roundtableToolBlock = source.slice(
    source.indexOf('name: "persona_roundtable"'),
    source.indexOf("const activatePersona"),
  );

  assert.ok(consultToolBlock.indexOf("assertPersonaRuntimeReady") >= 0);
  assert.ok(roundtableToolBlock.indexOf("assertPersonaRuntimeReady") >= 0);
  assert.ok(consultToolBlock.indexOf("assertPersonaRuntimeReady") < consultToolBlock.indexOf("runPersonaChild"));
  assert.ok(roundtableToolBlock.indexOf("assertPersonaRuntimeReady") < roundtableToolBlock.indexOf("runNativeRoundtable"));
  assert.doesNotMatch(source, /runSubagentBridgeRequest/);
});

test("a fresh multi-pack roundtable uses one native team picker and preserves the query", async (t) => {
  const root = await createCommandWorkspace();
  const agentDir = await mkdtemp(path.join(tmpdir(), "pi-persona-picker-runtime-"));
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  t.after(async () => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    await rm(root, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  });
  await writeText(
    path.join(agentDir, "npm/node_modules/pi-subagents/package.json"),
    `${JSON.stringify({ name: "pi-subagents", version: "0.37.2" })}\n`,
  );
  await writeText(path.join(agentDir, "settings.json"), `${JSON.stringify({ packages: ["npm:pi-subagents"] })}\n`);
  process.env.PI_CODING_AGENT_DIR = agentDir;

  for (const [pack, name, role] of [
    ["philosopher-7", "symposium", "generalist"],
    ["philosopher-7", "socrates", "specialist"],
    ["writer-team", "writers-room", "generalist"],
    ["writer-team", "copy-editor", "specialist"],
  ]) {
    await writeText(path.join(root, `.pi/agents/packs/${pack}/${name}.md`), `---
name: ${name}
role: ${role}
description: ${name} ${role}.
docs: []
skills: []
---
${name} prompt.
`);
  }

  const harness = await createExtensionHarness(root, {
    select(_prompt, choices) {
      return choices.find((choice) => choice.startsWith("writer-team"));
    },
  });
  await harness.commands.get("persona-roundtable").handler("who let the dog out?", harness.ctx);

  assert.deepEqual(harness.selections, [{
    prompt: "Which team should host this roundtable?",
    choices: [
      "philosopher-7 — [G] symposium",
      "writer-team — [G] writers-room",
    ],
  }]);
  assert.equal(harness.entries.at(-1).data.agentName, "writers-room");
  assert.match(harness.sentUserMessages.at(-1).message, /Pack: writer-team/);
  assert.match(harness.sentUserMessages.at(-1).message, /Question:\nwho let the dog out\?/);
  assert.doesNotMatch(harness.selections[0].choices.join("\n"), /cross-pack/i);
});

test("unpacked roundtable delegates selection to its project coordinator and runs natively even with pi-subagents installed", async (t) => {
  const root = await createWorkspace();
  const agentDir = await mkdtemp(path.join(tmpdir(), "pi-persona-roundtable-runtime-"));
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  await writeText(
    path.join(agentDir, "npm/node_modules/pi-subagents/package.json"),
    `${JSON.stringify({ name: "pi-subagents", version: "0.36.0" })}\n`,
  );
  await writeText(path.join(agentDir, "settings.json"), `${JSON.stringify({ packages: ["npm:pi-subagents"] })}\n`);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  });
  const requests = [];
  const model = { provider: "pi-persona-missing-provider", id: "missing-model" };
  const harness = await createExtensionHarness(root, {
    model,
    modelRegistry: {
      getAll: () => [model],
      getRegisteredProviderIds: () => [],
      async getApiKeyAndHeaders() {
        return { ok: true };
      },
    },
    onSubagentRequest(request) {
      requests.push(request);
    },
  });

  await harness.commands.get("persona-roundtable").handler("Compare Gemma models", harness.ctx);
  await harness.handlers.get("before_agent_start")({
    systemPrompt: "base",
    systemPromptOptions: {
      skills: ["shared-skill", "brand-skill", "guideline-skill"].map((name) => ({ name, filePath: path.join(root, "missing", name, "SKILL.md") })),
    },
  }, harness.ctx);

  assert.equal(harness.entries.at(-1).data.agentName, "generalist");
  assert.match(harness.sentUserMessages.at(-1).message, /Compare Gemma models/);
  assert.match(harness.sentUserMessages.at(-1).message, /run one round-table for the question as written/);
  assert.equal(requests.length, 0);

  const tool = harness.tools.get("persona_roundtable");
  await assert.rejects(
    () => tool.execute(
      "roundtable-mismatch",
      {
        query: "A different query",
        selections: [{ name: "brand", reason: "Compare positioning trade-offs." }],
      },
      undefined,
      undefined,
      harness.ctx,
    ),
    /query must match.*unchanged/,
  );
  assert.equal(requests.length, 0);

  await assert.rejects(
    () => tool.execute(
      "roundtable",
      {
        query: "Compare Gemma models",
        selections: [
          { name: "brand", reason: "Compare positioning trade-offs." },
          { name: "guideline", reason: "Check evidence quality." },
        ],
      },
      undefined,
      undefined,
      harness.ctx,
    ),
    /stopped during Round 1/,
  );

  assert.equal(requests.length, 0, "installed pi-subagents must never receive a Pi Persona dispatch");
  assert.equal(harness.events.listenerCount("subagent:slash:request"), 0);
  assert.equal(harness.events.listenerCount("prompt-template:subagent:request"), 0);

  await assert.rejects(
    () => tool.execute(
      "roundtable-repeat",
      {
        query: "Compare Gemma models",
        selections: [{ name: "brand", reason: "Compare positioning trade-offs." }],
      },
      undefined,
      undefined,
      harness.ctx,
    ),
    /requires a pending \/persona-roundtable request/,
  );
  assert.equal(requests.length, 0);
});

test("native roundtable resolves authentication again for each child launch", async () => {
  const root = await createWorkspace();
  await writeText(path.join(root, ".pi/persona.json"), `${JSON.stringify({ backend: "native" })}\n`);
  let authCalls = 0;
  const model = { provider: "pi-persona-missing-provider", id: "missing-model" };
  const harness = await createExtensionHarness(root, {
    model,
    modelRegistry: {
      getAll: () => [model],
      getRegisteredProviderIds: () => [],
      async getApiKeyAndHeaders() {
        authCalls += 1;
        return { ok: true };
      },
    },
  });
  await harness.commands.get("persona-roundtable").handler("Compare options", harness.ctx);
  await harness.handlers.get("before_agent_start")({
    systemPrompt: "base",
    systemPromptOptions: {
      skills: ["shared-skill", "brand-skill", "guideline-skill"].map((name) => ({ name, filePath: path.join(root, "missing", name, "SKILL.md") })),
    },
  }, harness.ctx);

  await assert.rejects(
    () => harness.tools.get("persona_roundtable").execute("native-roundtable", {
      query: "Compare options",
      selections: [
        { name: "brand", reason: "Brand view." },
        { name: "guideline", reason: "Guideline view." },
      ],
    }, undefined, undefined, harness.ctx),
    /stopped during Round 1/,
  );

  assert.equal(authCalls, 5);
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
  assert.match(launch.systemPrompt, /Raw `subagent` launches bypass Pi Persona consult semantics/);
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
  assert.match(docs, /`persona_consult` only accepts personas from this session's team/);
  assert.match(docs, /pi install npm:pi-subagents/);
  assert.doesNotMatch(docs, /pi install npm:pi-intercom/);
  assert.match(docs, /runtime preflight/);
  assert.match(docs, /PI_SUBAGENT_CHILD/);
  assert.match(docs, /leaf task/);
  assert.match(docs, /\/persona use <name>/);
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

test("doctor validates dependencies, docs, skill misuse, duplicate names, and control files", async () => {
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

  await writeText(path.join(root, ".pi/agents/_bad-control.md"), `---
name: bad-control
description: This control file is accidentally launchable.
---
Bad control prompt.
`);

  const result = await runDoctor(root, {
    dependencyStatus: {
      piSubagents: { ok: true, version: "0.36.0", path: "/tmp/pi-subagents" },
      piIntercom: { ok: true, version: "0.6.0", path: "/tmp/pi-intercom" },
    },
  });

  const messages = result.issues.map((issue) => issue.message);
  assert.equal(result.status, "error");
  assert.ok(messages.some((message) => message.includes("duplicate agent name 'brand'")));
  assert.ok(messages.some((message) => message.includes("library path does not exist: docs/missing/")));
  assert.ok(messages.some((message) => message.includes("skills entry looks like a path")));
  assert.ok(messages.some((message) => message.includes(".pi/skills/missing/")));
  assert.ok(messages.some((message) => message.includes("control file is launchable")));
});

test("legacy agent scaffold helper preserves historical primary metadata", async () => {
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

test("doctor treats tools as runtime metadata and flags only legacy routing metadata", async () => {
  const root = await createWorkspace();

  await writeText(path.join(root, ".pi/agents/legacy.md"), `---
name: legacy
role: specialist
description: Legacy metadata specialist.
tools: read
consults: guideline
tags: brand, voice
---
Legacy prompt.
`);

  const result = await runDoctor(root);

  assert.equal(result.status, "warning");
  assert.ok(!result.issues.some((issue) => issue.message.includes("legacy field tools")));
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
      piSubagents: { ok: true, version: "0.36.0", path: "/tmp/pi-subagents" },
      piIntercom: { ok: true, version: "0.6.0", path: "/tmp/pi-intercom" },
    },
  });

  assert.equal(result.status, "warning");
  assert.ok(result.issues.some((issue) => issue.message.includes(".pi/agents/brand.md: skills entry looks like a path")));
  assert.ok(result.issues.some((issue) => issue.message.includes(".pi/skills/workstreams/empty/")));
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

  const delegated = createConsultProgressTracker("researcher", { startedAt: 0 });
  delegated.update({
    requestId: "consult-1",
    currentTool: "read",
    currentToolArgs: "library/shared/brief.md",
    recentTools: [{ tool: "read", args: "library/shared/brief.md" }],
    toolCount: 1,
    tokens: 420,
  }, 1_000);
  assert.match(
    delegated.format(2_000),
    /2s elapsed · active 1s ago · 1 tool · 420 tokens[\s\S]*Now: read · library\/shared\/brief\.md/,
  );
});

test("doctor guides empty workspaces to onboarding", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-empty-doctor-"));
  const result = await runDoctor(root);

  assert.equal(result.status, "error");
  assert.ok(result.issues.some((issue) => issue.message.includes("project foundation is missing")));
  assert.match(formatDoctorReport(result), /No project foundation found\. Run \/persona onboard\./);
});

test("doctor does not demand a project foundation once a global team is bound", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-bound-doctor-"));
  const withoutTeam = await runDoctor(root);
  assert.equal(withoutTeam.status, "error");
  assert.ok(withoutTeam.issues.some((issue) => issue.message.includes("project foundation is missing")));

  const bound = await runDoctor(root, { team: { state: "bound", qualifiedName: "official/philosopher-7" } });
  assert.ok(
    !bound.issues.some((issue) => issue.message.includes("project foundation is missing")),
    "a valid bound global team makes this empty ctx.cwd project foundation irrelevant, not an error",
  );
  assert.doesNotMatch(formatDoctorReport(bound), /No project foundation found/);
});

test("doctor reports the global persona pack store and actionable per-state team recovery guidance", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-store-doctor-"));
  const storeRoot = await mkdtemp(path.join(tmpdir(), "pi-persona-store-doctor-store-"));
  t.after(() => rm(storeRoot, { recursive: true, force: true }));
  const sourceDir = await mkdtemp(path.join(tmpdir(), "pi-persona-store-doctor-src-"));
  await writeText(path.join(sourceDir, "pack.yaml"), "schema: 2\nname: council\nversion: 1.0.0\ndescription: Council.\n");
  await writeText(path.join(sourceDir, "agents/lead.md"), "---\nname: lead\nrole: generalist\ndescription: Lead.\n---\nLead.\n");
  await writeText(path.join(sourceDir, "agents/scout.md"), "---\nname: scout\nrole: specialist\ndescription: Scout.\n---\nScout.\n");
  await writeText(path.join(sourceDir, "references/_index.md"), "# council\n");
  const draftSource = await readPortablePersonaPack(sourceDir, { type: "path", ref: sourceDir });
  await stageCustomPersonaPackDraft(storeRoot, "council", draftSource);

  const withDraft = await runDoctor(root, { storeRoot });
  assert.equal(withDraft.globalPackSummary.official, 0);
  assert.equal(withDraft.globalPackSummary.custom, 0);
  assert.equal(withDraft.globalPackSummary.drafts, 1);
  assert.ok(withDraft.issues.some((issue) => issue.message.includes("persona pack draft 'council' is unfinished")));

  const missingBound = await runDoctor(root, {
    storeRoot,
    team: { state: "missing-bound", qualifiedName: "official/gone" },
  });
  assert.ok(missingBound.issues.some((issue) => (
    issue.severity === "error" && issue.message.includes("this session's persona team 'official/gone' could not be loaded")
  )));

  const migrationRequired = await runDoctor(root, { storeRoot, team: { state: "migration-required" } });
  assert.ok(migrationRequired.issues.some((issue) => issue.message.includes("predates global persona packs")));

  assert.match(formatDoctorReport(withDraft), /## Global Persona Packs/);
  assert.match(formatDoctorReport(withDraft), /Pending drafts: 1/);
});

test("doctor turns stale backend settings into diagnostic issues instead of throwing", async () => {
  const root = await createWorkspace();

  const staleEnv = await runDoctor(root, { env: { PI_PERSONA_BACKEND: "legacy" } });
  assert.equal(staleEnv.status, "error");
  assert.ok(staleEnv.issues.some((issue) => issue.message.includes("PI_PERSONA_BACKEND environment variable is set to 'legacy'")));

  await writeText(path.join(root, ".pi/persona.json"), `${JSON.stringify({ backend: "legacy" })}\n`);
  const staleConfig = await runDoctor(root, { env: {} });
  assert.equal(staleConfig.status, "error");
  assert.ok(staleConfig.issues.some((issue) => issue.message.includes("backend field in .pi/persona.json is set to 'legacy'")));

  await writeText(path.join(root, ".pi/persona.json"), "{ invalid json ");
  const malformedJson = await runDoctor(root, { env: {} });
  assert.equal(malformedJson.status, "error");
  assert.ok(malformedJson.issues.some((issue) => issue.message.includes("Invalid .pi/persona.json:")));
});

test("doctor never requires pi-subagents; native readiness holds even when it is installed", async () => {
  const root = await createWorkspace();
  const agentDir = await mkdtemp(path.join(tmpdir(), "pi-persona-agent-dir-"));
  await writeText(
    path.join(agentDir, "npm/node_modules/pi-subagents/package.json"),
    `${JSON.stringify({ version: "0.35.0" })}\n`,
  );
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const result = await runDoctor(root);

    assert.equal(result.backend, "native");
    assert.ok(!result.issues.some((issue) => issue.message.includes("pi-subagents missing")));
    assert.match(formatDoctorReport(result), /Backend: native/);
    assert.match(formatDoctorReport(result), /static doctor: resolved baseline \+ agent built-in tool names/);
    assert.match(formatDoctorReport(result), /live launch preflight: loaded skills, model, provider, and current authentication/);
    assert.deepEqual(await assertPersonaRuntimeReady(root), { backend: "native" });
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
});

test("native doctor does not reject declared built-in tools or other Pi versions", async () => {
  const root = await createCommandWorkspace("brand");
  await writeText(path.join(root, ".pi/persona.json"), `${JSON.stringify({ backend: "native" })}\n`);
  await writeText(path.join(root, ".pi/agents/_baseline.md"), "---\ntools: bash\n---\nBaseline.\n");
  await writeText(path.join(root, ".pi/agents/brand.md"), "---\nname: brand\nrole: specialist\ndescription: Brand.\ntools: write\n---\nBrand.\n");

  const result = await runDoctor(root);
  assert.ok(!result.issues.some((issue) => issue.message.includes("unsupported tools") || issue.message.includes("requires tested Pi")));
  assert.deepEqual(await assertPersonaRuntimeReady(root), { backend: "native" });
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
      piSubagents: { ok: true, configured: true, version: "0.36.0", path: "/tmp/pi-subagents" },
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
      piSubagents: { ok: true, version: "0.36.0", path: "/tmp/pi-subagents" },
      piIntercom: { ok: true, version: "0.6.0", path: "/tmp/pi-intercom" },
    },
  });

  assert.equal(result.status, "pass");
  assert.equal(result.issues.some((issue) => issue.message.includes("nested persona consults need project runtime override")), false);
});

test("doctor leaves legacy tools metadata alone instead of demanding migration", async () => {
  const root = await createWorkspace();

  await writeText(path.join(root, ".pi/agents/manual.md"), `---
name: manual
role: specialist
description: Manually created specialist.
tools: read
docs: docs/shared/
skills: shared-skill
---
Manual prompt.
`);

  const result = await runDoctor(root);
  const manualIssues = result.issues.filter((issue) => issue.file === ".pi/agents/manual.md");

  assert.equal(result.status, "pass");
  assert.equal(manualIssues.some((issue) => issue.message.includes("legacy field tools found")), false);
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
      piSubagents: { ok: true, version: "0.36.0", path: "/tmp/pi-subagents" },
      piIntercom: { ok: true, version: "0.6.0", path: "/tmp/pi-intercom" },
    },
  });

  assert.equal(result.status, "warning");
  assert.ok(result.issues.some((issue) => issue.message.includes("docs/workstreams/brand/ has 1 nested library file but no _index.md")));
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
  assert.doesNotMatch(createdContent, /\/persona index/);
});

test("formats doctor report with actionable sections", async () => {
  const root = await createWorkspace();
  const result = await runDoctor(root);

  const report = formatDoctorReport(result);

  assert.match(report, /Pi Persona Doctor/);
  assert.match(report, /Backend: native/);
  assert.match(report, /Native Checks/);
  assert.match(report, /Agents: 3 launchable/);
  assert.match(report, /Generalists \[G\]: 1/);
  assert.doesNotMatch(report, /coordinator/i);
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
      piSubagents: { ok: true, version: "0.36.0", path: "/tmp/pi-subagents" },
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

test("doctor allows a project without a generalist", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-no-generalist-"));

  await writeText(path.join(root, ".pi/agents/_baseline.md"), `---
docs: []
skills: []
---
Shared project foundation.
`);
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
      piSubagents: { ok: true, version: "0.36.0", path: "/tmp/pi-subagents" },
      piIntercom: { ok: true, version: "0.6.0", path: "/tmp/pi-intercom" },
    },
  });

  assert.equal(result.status, "pass");
  assert.equal(result.project.agents.some((agent) => agent.role === "generalist"), false);
  assert.equal(result.issues.some((issue) => issue.message.includes("generalist required")), false);
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
      piSubagents: { ok: true, version: "0.36.0", path: "/tmp/pi-subagents" },
      piIntercom: { ok: true, version: "0.6.0", path: "/tmp/pi-intercom" },
    },
  });

  assert.equal(result.status, "pass");
  assert.equal(result.project.agents.filter((agent) => agent.role === "generalist").length, 2);
  assert.equal(result.project.agents.find((agent) => agent.name === "generalist").primary, true);
  assert.equal(result.project.agents.find((agent) => agent.name === "backup-generalist").primary, false);
});

test("doctor tolerates multiple primary generalists", async () => {
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
      piSubagents: { ok: true, version: "0.36.0", path: "/tmp/pi-subagents" },
      piIntercom: { ok: true, version: "0.6.0", path: "/tmp/pi-intercom" },
    },
  });

  const messages = result.issues.map((issue) => issue.message);
  assert.equal(result.status, "pass");
  assert.equal(result.project.agents.filter((agent) => agent.role === "generalist").length, 2);
  assert.equal(messages.some((message) => message.includes("primary generalist")), false);
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
      piSubagents: { ok: true, version: "0.36.0", path: "/tmp/pi-subagents" },
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
      piSubagents: { ok: true, version: "0.36.0", path: "/tmp/pi-subagents" },
      piIntercom: { ok: true, version: "0.6.0", path: "/tmp/pi-intercom" },
    },
  });

  assert.equal(result.status, "error");
  assert.ok(result.issues.some((issue) => issue.message.includes("library path must stay inside workspace")));
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
      piSubagents: { ok: true, configured: true, version: "0.36.0", path: "/tmp/pi-subagents" },
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
  assert.match(launch.systemPrompt, /Do not start a child run to answer a direct persona command/);
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
  assert.deepEqual(consult.scope.derived.defaultReads, [
    "docs/shared/company.md",
    "docs/workstreams/guideline/rules.md",
  ]);
  assert.match(consult.task, /^\[Read from: docs\/shared\/company\.md, docs\/workstreams\/guideline\/rules\.md\]/);
  assert.match(consult.task, /consultant: guideline/);
  assert.match(consult.task, /summary: The requester is revising launch copy/);
  assert.match(consult.task, /This consult is a leaf task/);
  assert.match(consult.task, /Do not call `persona_consult`, raw `subagent`, `subagent list`, `contact_supervisor`, or `intercom`/);
  assert.match(consult.task, /If blocked, report the blocker in your returned answer/);
  assert.doesNotMatch(consult.task, /Brand prompt/);
  assert.doesNotMatch(consult.task, /supervisor help/);
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
  assert.match(consult.task, /context: fork/);
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

test("persona list guides empty workspaces to onboarding", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-empty-list-"));
  const project = await discoverPersonaProject(root);

  assert.match(formatPersonaList(project), /No project foundation found\. Run \/persona onboard\./);
});

test("persona list and doctor keep roles but never label a bound global pack lead as a legacy coordinator", async () => {
  const packRoot = await mkdtemp(path.join(tmpdir(), "pi-persona-bound-list-"));
  await writeText(path.join(packRoot, "agents/lead.md"), "---\nname: lead\nrole: generalist\ndescription: Leads the council.\n---\nLead.\n");
  await writeText(path.join(packRoot, "agents/scout.md"), "---\nname: scout\nrole: specialist\ndescription: Scouts ahead.\n---\nScout.\n");
  const bound = await discoverPersonaProject(packRoot, "agents");

  const list = formatPersonaList(bound);
  assert.match(list, /\[G\] lead - generalist$/m);
  assert.match(list, /Leads the council\./);
  assert.match(list, /scout - specialist$/m);
  assert.doesNotMatch(list, /coordinator/i);

  const report = formatDoctorReport({
    status: "pass",
    issues: [],
    project: bound,
    team: { state: "bound", qualifiedName: "custom/council" },
  });
  assert.match(report, /Generalists \[G\]: 1/);
  assert.doesNotMatch(report, /coordinator/i);
  assert.doesNotMatch(report, /legacy/i);

  const oldFixture = await discoverPersonaProject(await createWorkspace());
  assert.match(formatPersonaList(oldFixture), /\[G\] generalist - generalist$/m);
  assert.doesNotMatch(formatPersonaList(oldFixture), /legacy project coordinator/);
});

test("formatPersonaList shows read-only discovery details", async () => {
  const root = await createWorkspace();
  const project = await discoverPersonaProject(root);

  const output = formatPersonaList(project);

  assert.match(output, /# Pi Personas/);
  assert.match(output, /\[G\] generalist - generalist$/m);
  assert.doesNotMatch(output, /legacy project coordinator/);
  assert.match(output, /Routes to specialists\./);
  assert.match(output, /library: none/);
  assert.match(output, /skills: none/);
  assert.match(output, /brand - specialist/);
  assert.match(output, /library: docs\/workstreams\/brand\//);
  assert.match(output, /skills: brand-skill/);
  assert.match(output, /launch: \/brand/);
});

test("legacy unpacked coordinator receives a roundtable selection prompt", async () => {
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
  assert.match(selection.userMessage, /Host this Pi Persona round-table/);
  assert.match(selection.userMessage, /brand — Brand strategy specialist/);
  assert.match(selection.userMessage, /pricing — Pricing strategy specialist/);
  assert.match(selection.userMessage, /Available perspectives/);
  assert.match(selection.userMessage, /run one round-table for the question as written/);
  assert.match(selection.userMessage, /present the final moderator synthesis faithfully and in full/);
  assert.doesNotMatch(selection.userMessage, /raw `subagent`/);
});

test("native roundtable rounds and synthesis carry per-specialist assigned contributions and doc reads", async () => {
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

  const calls = [];
  const result = await runNativeRoundtable(roundtable, async ({ scope, task, index }) => {
    calls.push({ agent: scope.agent.name, task, index });
    return { text: `${scope.agent.name} answer` };
  });

  const roundOne = calls.filter((call) => call.index < 2);
  const roundTwo = calls.filter((call) => call.index >= 2 && call.index < 4);
  const synthesis = calls.find((call) => call.index === 4);
  assert.equal(synthesis.agent, "generalist");

  const brandRoundTwo = roundTwo.find((call) => call.agent === "brand");
  assert.match(brandRoundTwo.task, /\[Read from: docs\/shared\/company\.md, docs\/workstreams\/brand\/brief\.md\]/);
  assert.match(brandRoundTwo.task, /Assigned contribution: The positioning needs a brand perspective\./);
  assert.match(roundOne[0].task, /Round 1 - Independent Position/);
  assert.match(roundTwo[0].task, /Round 2 - Reveal And Revise/);
  assert.match(roundTwo[0].task, /guideline answer/);
  assert.match(roundOne[0].task, /Assigned contribution:/);
  assert.match(roundTwo[0].task, /Restate every claim and reason needed for synthesis/);
  for (const task of [roundOne[0].task, roundTwo[0].task]) {
    assert.match(task, /This round-table step is a leaf task/);
    assert.match(task, /Do not call `persona_consult`, raw `subagent`, `subagent list`, `contact_supervisor`, or `intercom`/);
    assert.match(task, /If blocked, report the blocker in your returned answer/);
    assert.doesNotMatch(task, /supervisor help/);
  }
  assert.match(synthesis.task, /Moderator Synthesis/);
  assert.match(synthesis.task, /guideline answer/);
  assert.match(synthesis.task, /Assigned contributions:/);
  assert.match(synthesis.task, /- guideline: The policy language needs review\./);
  assert.match(synthesis.task, /- brand: The positioning needs a brand perspective\./);
  assert.match(synthesis.task, /## Perspective contributions/);
  assert.match(synthesis.task, /## Recommended decision/);
  assert.match(synthesis.task, /Shared operating context/);
  assert.equal(result.text, "generalist answer");
});

test("native roundtable runs two parallel phases then synthesis and stops on phase failure", async () => {
  const root = await createWorkspace();
  const roundtable = await resolveRoundtableLaunchRequest(root, {
    query: "Brand guideline question.",
    selections: [
      { name: "brand", reason: "Brand position." },
      { name: "guideline", reason: "Guideline evidence." },
    ],
  });
  const calls = [];
  const result = await runNativeRoundtable(roundtable, async ({ scope, task, index }) => {
    calls.push({ agent: scope.agent.name, task, index });
    return { text: `${scope.agent.name} answer`, usage: { totalTokens: 1 } };
  });

  assert.deepEqual(calls.map((call) => call.index), [0, 1, 2, 3, 4]);
  assert.match(calls[2].task, /### brand\n\nbrand answer/);
  assert.match(calls[2].task, /### guideline\n\nguideline answer/);
  assert.match(calls[4].task, /### brand\n\nbrand answer/);
  assert.equal(result.text, "generalist answer");

  const failedCalls = [];
  await assert.rejects(
    () => runNativeRoundtable(roundtable, async ({ scope, index }) => {
      failedCalls.push(index);
      if (scope.agent.name === "brand") throw new Error("brand failed");
      return { text: "ok" };
    }),
    /stopped during Round 1/,
  );
  assert.deepEqual(failedCalls.sort(), [0, 1]);

  const controller = new AbortController();
  controller.abort();
  const abortedCalls = [];
  await assert.rejects(
    () => runNativeRoundtable(roundtable, async (step) => {
      abortedCalls.push(step);
      return { text: "unexpected" };
    }, { signal: controller.signal }),
    /was cancelled/,
  );
  assert.deepEqual(abortedCalls, []);
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
  assert.match(preview, /Moderator: \[G\] generalist/);
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

test("legacy agent scaffold parser accepts setup metadata options", () => {
  const parsed = parsePersonaNewArgs(
    'Market Research --role specialist --description "Market research specialist." --docs docs/workstreams/market/ --skills market-skill',
  );

  assert.equal(parsed.rawName, "Market Research");
  assert.equal(parsed.options.role, "specialist");
  assert.equal(parsed.options.description, "Market research specialist.");
  assert.deepEqual(parsed.options.docs, ["docs/workstreams/market/"]);
  assert.deepEqual(parsed.options.skills, ["market-skill"]);
});

test("legacy agent scaffold parser accepts equals options and rejects unsafe input", () => {
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
    /unknown .* option: --unknown/,
  );
  assert.throws(
    () => parsePersonaNewArgs("Ops Lead --consults all"),
    /unknown .* option: --consults/,
  );
  assert.throws(
    () => parsePersonaNewArgs("--role specialist"),
    /Usage:/,
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
  assert.match(content, /docs: library\/personal\/market-researcher\//);
  assert.match(content, /skills: \[\]/);
  assert.doesNotMatch(content, /tools:/);
  assert.doesNotMatch(content, /consults:/);
  assert.doesNotMatch(content, /tags:/);
  assert.match(content, /You are market-researcher\./);
  assert.doesNotMatch(content, /defaultReads/);
  assert.doesNotMatch(content, /systemPromptMode/);
  assert.doesNotMatch(content, /inheritSkills/);
  assert.match(
    await readFile(path.join(root, "library/personal/market-researcher/_index.md"), "utf8"),
    /Market Researcher Personal Library/,
  );

  const project = await discoverPersonaProject(root);
  assert.deepEqual(project.agents.map((agent) => agent.name), ["market-researcher"]);
  assert.deepEqual(project.agents[0].docs, ["library/personal/market-researcher/"]);

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
  assert.deepEqual(agent.docs, [
    "docs/workstreams/market/",
    "library/personal/market-research/",
  ]);
  assert.deepEqual(agent.skills, ["market-skill"]);
  assert.match(
    await readFile(path.join(root, "library/personal/market-research/_index.md"), "utf8"),
    /context; it is not an access-control/,
  );
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

test("legacy quick scaffold helper creates its historical baseline and coordinator", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-init-"));

  const result = await createPersonaProjectScaffold(root);

  assert.deepEqual(result.created, [
    ".pi/agents/_baseline.md",
    ".pi/agents/generalist.md",
    "library/shared/_index.md",
    "library/personal/generalist/_index.md",
  ]);
  assert.deepEqual(result.skipped, []);

  const baseline = await readFile(path.join(root, ".pi/agents/_baseline.md"), "utf8");
  const generalist = await readFile(path.join(root, ".pi/agents/generalist.md"), "utf8");
  const sharedIndex = await readFile(path.join(root, "library/shared/_index.md"), "utf8");
  const personalIndex = await readFile(path.join(root, "library/personal/generalist/_index.md"), "utf8");
  assert.match(baseline, /docs: library\/shared\//);
  assert.match(baseline, /skills: \[\]/);
  assert.match(generalist, /role: generalist/);
  assert.match(generalist, /primary: true/);
  assert.match(generalist, /docs: library\/personal\/generalist\//);
  assert.match(sharedIndex, /# Shared Library Index/);
  assert.match(personalIndex, /# Generalist Personal Library/);

  await assert.rejects(
    () => readFile(path.join(root, ".pi/settings.json"), "utf8"),
    /ENOENT/,
  );

  const doctor = await runDoctor(root, {
    dependencyStatus: {
      piSubagents: { ok: true, version: "0.36.0", path: "/tmp/pi-subagents" },
      piIntercom: { ok: true, version: "0.6.0", path: "/tmp/pi-intercom" },
    },
  });
  assert.equal(doctor.status, "pass");
});

test("legacy quick scaffold helper preserves existing setup files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-init-existing-"));
  await writeText(path.join(root, ".pi/agents/_baseline.md"), "existing baseline\n");
  await writeText(path.join(root, "library/shared/_index.md"), "existing index\n");

  const result = await createPersonaProjectScaffold(root);

  assert.deepEqual(result.created, [
    ".pi/agents/generalist.md",
    "library/personal/generalist/_index.md",
  ]);
  assert.deepEqual(result.skipped, [
    ".pi/agents/_baseline.md",
    "library/shared/_index.md",
  ]);
  assert.equal(await readFile(path.join(root, ".pi/agents/_baseline.md"), "utf8"), "existing baseline\n");
  assert.equal(await readFile(path.join(root, "library/shared/_index.md"), "utf8"), "existing index\n");
});

test("legacy quick scaffold report lists created files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-init-message-"));
  const result = await createPersonaProjectScaffold(root);

  const report = formatPersonaProjectScaffoldCreatedMessage(result);
  assert.match(report, /Initialized Pi Persona project/);
  assert.match(report, /- \.pi\/agents\/_baseline\.md/);
  assert.match(report, /- \.pi\/agents\/generalist\.md/);
  assert.match(report, /- library\/shared\/_index\.md/);
  assert.match(report, /- library\/personal\/generalist\/_index\.md/);
});

test("parsePersonaOnboardArgs defaults the manifest path and accepts an override", () => {
  assert.deepEqual(parsePersonaOnboardArgs(""), {
    out: "init-data/my-persona-setup.yaml",
  });
  assert.deepEqual(parsePersonaOnboardArgs("--out init-data/team-layer.yaml"), {
    out: "init-data/team-layer.yaml",
  });
  assert.throws(() => parsePersonaOnboardArgs("unexpected"), /Usage: \/persona onboard/);
  assert.throws(() => parsePersonaOnboardArgs("--out --other"), /Usage: \/persona onboard/);
  assert.throws(() => parsePersonaOnboardArgs("--out=init-data/team.yaml extra"), /Usage: \/persona onboard/);
});

test("legacy init parser remains available for internal compatibility", () => {
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
  assert.match(draft, /library\/shared\/_index\.md/);
  assert.match(draft, /library\/shared\/project-context\.md/);
  assert.match(draft, /agents: \[\]/);
  assert.doesNotMatch(draft, /library\/personal\//);

  await assert.rejects(
    () => planPersonaInitFromManifest(root, "init-data/my-business.yaml"),
    /unresolved template placeholders.*Finish assisted onboarding/,
  );
  assert.match(formatPersonaInitManifestReport(result), /Pi Persona Onboarding/);
  assert.match(formatPersonaInitManifestReport(result), /Starting a short guided project foundation/);
  assert.match(formatPersonaInitManifestReport(result), /2–5 minutes/);
  assert.doesNotMatch(formatPersonaInitManifestReport(result), /Review or edit the YAML/);
  assert.match(formatPersonaInitManifestReport(result), /Nothing will be applied until you review and approve/);
  assert.doesNotMatch(formatPersonaInitManifestReport(result), /The assistant|manifest is a working draft/);

  const prompt = formatPersonaInitDraftAuthoringPrompt(result);
  assert.match(prompt, /Help me set up this project's Pi Persona foundation using the saved draft at `init-data\/my-business\.yaml`/);
  assert.match(prompt, /Ask me one question at a time/);
  assert.match(prompt, /it is not an access-control boundary/);
  assert.doesNotMatch(prompt, /library\/personal|author a pack|pending pack request/);
  assert.match(prompt, /Do not ask me to edit configuration files or design a team/);
  assert.match(prompt, /wait for my explicit approval/);
  assert.match(prompt, /offer to show me the available persona packs/);
  assert.doesNotMatch(prompt, /persona_init|action: plan|confirmed: true|planId|The user invoked/);

  await assert.rejects(
    () => createPersonaInitDraft(root, "init-data/my-business.yaml"),
    /draft manifest already exists: init-data\/my-business\.yaml/,
  );
});

test("manifest validation rejects malformed booleans lists models and doc contents", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-invalid-manifest-"));
  const valid = legacyAgentInitManifest();
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
        "    library/shared/context.md: |\n      TEST_BUSINESS_CONTEXT",
        "    library/shared/context.md:\n      invalid: true",
      ),
      error: /docs\.files\.library\/shared\/context\.md must be a string/,
    },
    {
      name: "placeholder",
      manifest: valid.replace("TEST_BUSINESS_CONTEXT", "add the behavior or spec under test here"),
      error: /unresolved template placeholders: docs\.files\.library\/shared\/context\.md/,
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

test("manifest init plans applies and reports status for a coordinator-free project foundation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-manifest-init-"));
  await writeText(path.join(root, "init-data/business.yaml"), starterInitManifest());

  const plan = await planPersonaInitFromManifest(root, "init-data/business.yaml");
  assert.equal(plan.mode, "plan");
  assert.equal(plan.projectName, "test-business");
  assert.ok(plan.actions.some((action) => action.status === "create" && action.path === ".pi/agents/_baseline.md"));
  assert.ok(plan.actions.some((action) => action.status === "create" && action.path === "library/shared/context.md"));
  assert.equal(plan.actions.some((action) => action.path.startsWith(".pi/agents/") && action.path !== ".pi/agents/_baseline.md"), false);
  assert.equal(plan.actions.some((action) => action.path.startsWith("library/personal/")), false);
  assert.equal(plan.actions.some((action) => action.kind === "runtime"), false);

  const planReport = formatPersonaInitManifestReport(plan);
  assert.match(planReport, /Project Foundation Plan/);
  assert.match(planReport, /create \.pi\/agents\/_baseline\.md/);
  assert.match(planReport, /Choose a persona pack/);
  assert.doesNotMatch(planReport, /runtime override/);

  const applied = await applyPersonaInitFromManifest(root, "init-data/business.yaml");
  assert.equal(applied.mode, "apply");
  assert.ok(applied.actions.some((action) => action.status === "created" && action.path === ".pi/agents/_baseline.md"));
  assert.equal(applied.actions.some((action) => action.kind === "runtime"), false);

  const baseline = await readFile(path.join(root, ".pi/agents/_baseline.md"), "utf8");
  const doc = await readFile(path.join(root, "library/shared/context.md"), "utf8");
  assert.match(baseline, /docs:\n  - library\/shared\//);
  assert.match(doc, /TEST_BUSINESS_CONTEXT/);
  assert.deepEqual((await discoverPersonaProject(root)).agents, []);

  await assert.rejects(
    () => readFile(path.join(root, ".pi/settings.json"), "utf8"),
    /ENOENT/,
  );

  const doctor = await runDoctor(root, {
    dependencyStatus: {
      piSubagents: { ok: true, version: "0.36.0", path: "/tmp/pi-subagents" },
      piIntercom: { ok: true, version: "0.6.0", path: "/tmp/pi-intercom" },
    },
  });
  assert.equal(doctor.status, "pass");

  const status = await statusPersonaInitFromManifest(root, "init-data/business.yaml");
  assert.equal(status.mode, "status");
  assert.match(formatPersonaInitManifestReport(status), /\[done\] \.pi\/agents\/_baseline\.md/);
  assert.match(formatPersonaInitManifestReport(status), /\[todo\] library index: library\/shared\//);

  await createDocsIndex(root, { all: true });
  const indexedStatus = await statusPersonaInitFromManifest(root, "init-data/business.yaml");
  assert.ok(indexedStatus.items.every((item) => item.state === "done"));
  assert.match(formatPersonaInitManifestReport(indexedStatus), /\[done\] library index: library\/shared\//);
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
    "Library: docs/workstreams/market/, library/personal/market-research/",
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

  const doctor = await runDoctor(root);
  assert.equal(doctor.status, "pass");

  const initialProject = await discoverPersonaProject(root);
  const list = formatPersonaList(initialProject);
  assert.match(list, /\[G\] generalist - generalist$/m);
  assert.doesNotMatch(list, /legacy project coordinator/);
  assert.match(list, /brand - specialist/);
  assert.match(list, /library: docs\/workstreams\/brand\/, library\/personal\/brand\//);
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
  assert.equal(consult.consultant.name, "guideline");
  assert.equal(consult.context, "fresh");
  assert.deepEqual(consult.scope.derived.defaultReads, [
    "docs/shared/company.md",
    "docs/workstreams/guideline/rules.md",
    "library/personal/guideline/_index.md",
  ]);
  assert.deepEqual(consult.skills, ["shared-skill", "guideline-skill"]);
  assert.match(consult.task, /summary: The brand specialist is checking pilot copy\./);

  const roundtable = await resolveRoundtableLaunchRequest(root, {
    query: "Brand guideline pilot question.",
    selections: [
      { name: "brand", reason: "Brand perspective." },
      { name: "guideline", reason: "Guideline perspective." },
    ],
  });
  assert.equal(roundtable.generalist.name, "generalist");
  assert.deepEqual(roundtable.roster.map((agent) => agent.name), ["brand", "guideline"]);

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

  const duplicateDoctor = await runDoctor(root);
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

test("inspectTeamEntries: no team entries at all reads as missing (not explicit none)", () => {
  const result = inspectTeamEntries([
    { type: "custom", customType: "unrelated", data: {} },
  ]);
  assert.equal(result.binding, undefined);
  assert.equal(result.unresolvedPending, undefined);
});

test("inspectTeamEntries: an explicit none binding is distinguishable from missing", () => {
  const result = inspectTeamEntries([
    { type: "custom", customType: TEAM_BINDING_ENTRY_TYPE, data: { status: "none" } },
  ]);
  assert.deepEqual(result.binding, { status: "none" });
  assert.equal(result.unresolvedPending, undefined);
});

test("inspectTeamEntries: latest committed binding wins over an older one", () => {
  const result = inspectTeamEntries([
    { type: "custom", customType: TEAM_BINDING_ENTRY_TYPE, data: { status: "pack", qualifiedName: "official/marketing" } },
    { type: "user", content: [] },
    { type: "custom", customType: TEAM_BINDING_ENTRY_TYPE, data: { status: "pack", qualifiedName: "official/philosophy" } },
  ]);
  assert.deepEqual(result.binding, { status: "pack", qualifiedName: "official/philosophy" });
});

test("inspectTeamEntries: a pending entry after the last committed binding is unresolved", () => {
  const result = inspectTeamEntries([
    { type: "custom", customType: TEAM_BINDING_ENTRY_TYPE, data: { status: "pack", qualifiedName: "official/marketing" } },
    { type: "custom", customType: TEAM_PENDING_ENTRY_TYPE, data: { target: "official/philosophy" } },
  ]);
  assert.deepEqual(result.binding, { status: "pack", qualifiedName: "official/marketing" });
  assert.deepEqual(result.unresolvedPending, { target: "official/philosophy" });
});

test("inspectTeamEntries: a pending entry resolved by a later committed binding is not unresolved", () => {
  const result = inspectTeamEntries([
    { type: "custom", customType: TEAM_PENDING_ENTRY_TYPE, data: { target: "official/philosophy" } },
    { type: "custom", customType: TEAM_BINDING_ENTRY_TYPE, data: { status: "pack", qualifiedName: "official/philosophy" } },
  ]);
  assert.deepEqual(result.binding, { status: "pack", qualifiedName: "official/philosophy" });
  assert.equal(result.unresolvedPending, undefined);
});

test("inspectTeamEntries: a pending switch to none is a real unresolved target, not the missing sentinel", () => {
  const result = inspectTeamEntries([
    { type: "custom", customType: TEAM_BINDING_ENTRY_TYPE, data: { status: "pack", qualifiedName: "official/marketing" } },
    { type: "custom", customType: TEAM_PENDING_ENTRY_TYPE, data: { target: null } },
  ]);
  assert.deepEqual(result.unresolvedPending, { target: null });
});
