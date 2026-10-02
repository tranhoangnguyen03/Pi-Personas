// Chat-first persona management, end to end: a real `pi --mode rpc` process
// loads the real extension and a local zero-cost mock model
// (.fixtures/persona-team-rpc/mock-model.mjs) issues the actual persona_pack
// tool calls. Success is observed on the host itself -- the reloaded command
// registry (get_commands) and the session's own entries -- never on the
// model's or the tool's own claims. No paid provider, no real ~/.pi state.
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import { startPi, send, stop } from "./.fixtures/persona-team-rpc/rpc-harness.mjs";
import { startMockModel, retryFromToolResult } from "./.fixtures/persona-team-rpc/mock-model.mjs";
import { readPortablePersonaPack } from "../src/persona/pack-source.js";
import { applyCustomPersonaPackDraft, stageCustomPersonaPackDraft } from "../src/persona/global-pack-store.js";
import { readGlobalDefaultPack, writeGlobalDefaultPack } from "../src/persona/pack-session.js";
import { listGlobalPersonaPacks } from "../src/persona/global-pack-store.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_EXTENSION = path.join(HERE, "..", "extensions", "pi-persona.ts");

async function writeText(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

async function installTeamPack(storeRoot, { name, leadName, specialistName }) {
  const sourceDir = await mkdtemp(path.join(tmpdir(), `pi-persona-chat-pack-${name}-`));
  try {
    await writeText(path.join(sourceDir, "pack.yaml"), `schema: 2\nname: ${name}\nversion: 1.0.0\ndescription: ${name} test pack.\n`);
    for (const [agent, role] of [[leadName, "generalist"], [specialistName, "specialist"]]) {
      await writeText(path.join(sourceDir, "agents", `${agent}.md`), `---\nname: ${agent}\nrole: ${role}\ndescription: ${agent} ${role}.\n---\n${agent} prompt body.\n`);
    }
    await writeText(path.join(sourceDir, "references", "_index.md"), `# ${name}\n`);
    await stageCustomPersonaPackDraft(storeRoot, name, await readPortablePersonaPack(sourceDir, { type: "path", ref: sourceDir }));
    await applyCustomPersonaPackDraft(storeRoot, name);
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
  }
}

async function seedStore(agentDir) {
  const storeRoot = path.join(agentDir, "persona");
  await installTeamPack(storeRoot, { name: "marketing", leadName: "market-lead", specialistName: "market-analyst" });
  await installTeamPack(storeRoot, { name: "philosophy", leadName: "philo-lead", specialistName: "philo-scout" });
  await writeGlobalDefaultPack(storeRoot, "custom/marketing");
  return storeRoot;
}

// Starts the real extension over a seeded store and a scripted mock model.
// stop(child) is registered before any directory removal: node:test runs
// t.after hooks in registration order, and removing a live child's agent dir
// races its in-flight writes.
async function setup(t, respond, { cwd, seedWorkspace } = {}) {
  const agentDir = await mkdtemp(path.join(tmpdir(), "pi-persona-chat-agentdir-"));
  const storeRoot = await seedStore(agentDir);
  const workspace = cwd ?? await mkdtemp(path.join(tmpdir(), "pi-persona-chat-ws-"));
  await seedWorkspace?.(workspace);
  const model = await startMockModel(respond);
  model.writeModelsJson(agentDir);
  const { child, rpc } = startPi(
    ["--mode", "rpc", "--offline", "--extension", REAL_EXTENSION, "--approve", ...model.cliArgs],
    { PI_CODING_AGENT_DIR: agentDir },
    { cwd: workspace },
  );
  t.after(() => stop(child));
  t.after(() => model.close());
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  // Startup (default-team binding, command registration) settles before the
  // first get_commands response.
  await commandNames(child, rpc);
  return { agentDir, storeRoot, workspace, model, child, rpc };
}

// A scripted conversation standing in for a model that follows the tool's
// guidance: a matching request issues its persona_pack calls; the next
// request reports the results; "yes" sends back every exact retry the
// previous results offered (as sibling calls when there are several).
function chatScript(routes) {
  let offeredRetries = [];
  return (turn) => {
    if (turn.toolResults.length > 0) {
      offeredRetries = turn.toolResults.map(retryFromToolResult).filter(Boolean);
      return { text: turn.toolResults.map((text) => text.split("\n")[0]).join(" | ") };
    }
    if (/^yes/i.test(turn.lastUserText)) {
      return { toolCalls: offeredRetries.map((args) => ({ name: "persona_pack", arguments: args })) };
    }
    const route = routes.find((candidate) => candidate.match.test(turn.lastUserText));
    return route ? { toolCalls: route.calls.map((args) => ({ name: "persona_pack", arguments: args })) } : { text: "no scripted route" };
  };
}

async function commandNames(child, rpc) {
  const cursor = rpc.cursor();
  const id = `cmds-${Math.random()}`;
  send(child, { id, type: "get_commands" });
  const response = await rpc.waitFor((m) => m.type === "response" && m.id === id, "get_commands", 15000, cursor);
  return response.data.commands.map((c) => c.name);
}

// Sends a user prompt and waits until the agent has fully settled.
async function chat(child, rpc, message) {
  const cursor = rpc.cursor();
  const id = `prompt-${Math.random()}`;
  send(child, { id, type: "prompt", message });
  const response = await rpc.waitFor((m) => m.id === id && m.type === "response", `prompt ${message}`, 15000, cursor);
  assert.equal(response.success, true, `prompt rejected: ${JSON.stringify(response)}`);
  await rpc.waitFor((m) => m.type === "agent_settled", `agent_settled after ${message}`, 20000, cursor);
  return cursor;
}

function personaMessages(rpc, sinceIndex = 0) {
  return rpc.getMessages().slice(sinceIndex)
    .filter((m) => m.type === "message_end" && m.message?.customType === "pi-persona")
    .map((m) => String(m.message.content));
}

function toolEnds(rpc, sinceIndex = 0) {
  return rpc.getMessages().slice(sinceIndex).filter((m) => m.type === "tool_execution_end" && m.toolName === "persona_pack");
}

test("chat-first: a model-issued persona_pack team switch reloads the real command registry only after explicit approval", { timeout: 60_000 }, async (t) => {
  const { child, rpc, model } = await setup(t, chatScript([{ match: /philosophy/, calls: [{ action: "team", target: "philosophy" }] }]));

  let names = await commandNames(child, rpc);
  assert.ok(names.includes("market-lead"), `default team commands present at start: ${names}`);

  // Turn 1: the request produces a plan and changes nothing.
  const planCursor = await chat(child, rpc, "switch this session to the philosophy team");
  const [planEnd] = toolEnds(rpc, planCursor);
  assert.ok(planEnd, "the model actually called persona_pack");
  assert.equal(planEnd.result.details.mode, "confirm-required");
  assert.match(planEnd.result.content[0].text, /Switch this session's persona team from 'custom\/marketing' to 'custom\/philosophy'/);
  names = await commandNames(child, rpc);
  assert.ok(names.includes("market-lead") && !names.includes("philo-lead"), "a plan alone must not switch anything");

  // Turn 2: explicit approval -> tool schedules, turn terminates, host reloads.
  const requestsBefore = model.requests.length;
  const approveCursor = await chat(child, rpc, "yes, switch it");
  const [confirmEnd] = toolEnds(rpc, approveCursor);
  assert.equal(confirmEnd.result.details.mode, "scheduled", JSON.stringify(confirmEnd.result));
  assert.equal(model.requests.length, requestsBefore + 1, "terminate: no extra model call after the approved switch");
  await rpc.waitFor(
    (m) => m.type === "message_end" && m.message?.customType === "pi-persona" && String(m.message.content).includes("Persona team switched to 'custom/philosophy'"),
    "fresh-instance switch confirmation",
    20000,
    approveCursor,
  );
  names = await commandNames(child, rpc);
  assert.ok(names.includes("philo-lead"), `philosophy commands registered after reload: ${names}`);
  assert.ok(!names.includes("market-lead"), `marketing commands removed after reload: ${names}`);
  assert.ok(!personaMessages(rpc, approveCursor).some((text) => /no longer current|nothing was changed/.test(text)));
});

test("chat-first: the model cannot confirm a team plan in the same turn it was shown", { timeout: 60_000 }, async (t) => {
  const { child, rpc } = await setup(t, (turn) => {
    if (turn.toolResults.length === 0) return { toolCalls: [{ name: "persona_pack", arguments: { action: "team", target: "philosophy" } }] };
    if (turn.toolResults.length === 1) return { toolCalls: [{ name: "persona_pack", arguments: retryFromToolResult(turn.toolResults[0]) }] };
    return { text: "stopped" };
  });
  const cursor = await chat(child, rpc, "switch this session to philosophy");
  const ends = toolEnds(rpc, cursor);
  assert.equal(ends.length, 2);
  // persona_pack reports refusals as a returned isError result (its
  // established contract), which Pi's tool_execution_end does not mirror.
  assert.equal(ends[1].result.isError, true, `self-confirmation must be rejected: ${JSON.stringify(ends[1])}`);
  assert.match(ends[1].result.content[0].text, /has not replied since this plan was shown/);
  const names = await commandNames(child, rpc);
  assert.ok(names.includes("market-lead") && !names.includes("philo-lead"));
});

async function waitForPersona(rpc, substring, label, sinceIndex) {
  return rpc.waitFor(
    (m) => m.type === "message_end" && m.message?.customType === "pi-persona" && String(m.message.content).includes(substring),
    label,
    20000,
    sinceIndex,
  );
}

test("chat-first: setting the default via chat affects only new sessions, never the current one", { timeout: 60_000 }, async (t) => {
  const { child, rpc, storeRoot } = await setup(t, chatScript([{ match: /new sessions/, calls: [{ action: "default", target: "philosophy" }] }]));
  const planCursor = await chat(child, rpc, "from now on start new sessions with philosophy");
  assert.match(toolEnds(rpc, planCursor)[0].result.content[0].text, /Make 'custom\/philosophy' the default team for new sessions \(replacing 'custom\/marketing'\)/);
  assert.equal((await readGlobalDefaultPack(storeRoot))?.defaultPack, "custom/marketing", "a plan alone changes nothing");

  const approveCursor = await chat(child, rpc, "yes");
  assert.match(toolEnds(rpc, approveCursor)[0].result.content[0].text, /Default team set to 'custom\/philosophy'/);
  assert.equal((await readGlobalDefaultPack(storeRoot))?.defaultPack, "custom/philosophy");
  let names = await commandNames(child, rpc);
  assert.ok(names.includes("market-lead") && !names.includes("philo-lead"), "this session keeps its team");
  assert.ok(!personaMessages(rpc, approveCursor).some((text) => /switched/.test(text)), "no session switch happened");

  const cursor = rpc.cursor();
  send(child, { id: "new", type: "new_session" });
  await rpc.waitFor((m) => m.id === "new" && m.type === "response", "new_session", 15000, cursor);
  names = await commandNames(child, rpc);
  assert.ok(names.includes("philo-lead") && !names.includes("market-lead"), `a new session starts with the new default: ${names}`);
});

test("chat-first: a team plan goes stale when the target pack changes before approval", { timeout: 60_000 }, async (t) => {
  const { child, rpc, storeRoot } = await setup(t, chatScript([{ match: /philosophy/, calls: [{ action: "team", target: "philosophy" }] }]));
  await chat(child, rpc, "switch this session to philosophy");
  // Someone edits the philosophy pack between the plan and the approval.
  await installTeamPack(storeRoot, { name: "philosophy", leadName: "philo-lead", specialistName: "philo-critic" });

  const approveCursor = await chat(child, rpc, "yes");
  const [end] = toolEnds(rpc, approveCursor);
  assert.equal(end.result.isError, true);
  assert.match(end.result.content[0].text, /Something changed since this plan was shown/);
  const names = await commandNames(child, rpc);
  assert.ok(names.includes("market-lead") && !names.includes("philo-lead"), "nothing switched");
});

test("chat-first: two approvals in one tool batch -- exactly one runs, the other is refused and changes nothing", { timeout: 60_000 }, async (t) => {
  const { child, rpc } = await setup(t, chatScript([{
    match: /either/,
    calls: [{ action: "team", target: "philosophy" }, { action: "team", target: "none" }],
  }]));
  await chat(child, rpc, "either philosophy or no team for this session");
  const approveCursor = await chat(child, rpc, "yes");
  const ends = toolEnds(rpc, approveCursor);
  assert.equal(ends.length, 2);
  // Sibling tools run in parallel, so which call finishes first is up to the
  // host; the contract is that exactly one is scheduled and applied.
  const scheduled = ends.filter((end) => end.result.details.mode === "scheduled");
  const refused = ends.filter((end) => end.result.isError === true);
  assert.equal(scheduled.length, 1, JSON.stringify(ends));
  assert.equal(refused.length, 1, JSON.stringify(ends));
  assert.match(refused[0].result.content[0].text, /Another approved change is already waiting/);
  const target = scheduled[0].result.details.target;
  await waitForPersona(rpc, target ? `Persona team switched to '${target}'` : "Persona team switched: none", "the scheduled approval applied", approveCursor);
  const names = await commandNames(child, rpc);
  assert.ok(!names.includes("market-lead"), `old team commands removed: ${names}`);
  assert.equal(names.includes("philo-lead"), target === "custom/philosophy", `only the scheduled change applied: ${names}`);
});

function writeLegacyWorkspace(workspace) {
  return Promise.all([
    writeText(path.join(workspace, ".pi/agents/coordinator.md"), "---\nname: coordinator\nrole: generalist\ndescription: Legacy project coordinator.\n---\nLegacy coordinator prompt.\n"),
    writeText(path.join(workspace, ".pi/agents/writer.md"), "---\nname: writer\nrole: specialist\ndescription: Legacy project specialist.\n---\nLegacy specialist prompt.\n"),
  ]);
}

const MIGRATE_ROUTES = [
  { match: /what is this old setup/, calls: [{ action: "migrate", operation: "inspect" }] },
  { match: /preview/, calls: [{ action: "migrate", operation: "preview", target: "legacy-team", approvedPersonas: ["writer"] }] },
  { match: /convert it/, calls: [{ action: "migrate", operation: "apply", target: "legacy-team" }] },
  { match: /roll it back/, calls: [{ action: "migrate", operation: "rollback", target: "legacy-team" }] },
];

test("chat-first: migration inspect -> preview -> approved apply -> approved rollback, originals untouched and nothing auto-selected", { timeout: 90_000 }, async (t) => {
  const { child, rpc, storeRoot, workspace } = await setup(t, chatScript(MIGRATE_ROUTES), { seedWorkspace: writeLegacyWorkspace });
  const originalWriter = await readFile(path.join(workspace, ".pi/agents/writer.md"), "utf8");

  let cursor = await chat(child, rpc, "what is this old setup?");
  assert.match(toolEnds(rpc, cursor)[0].result.content[0].text, /Supported: yes/);
  cursor = await chat(child, rpc, "preview it as legacy-team with the writer");
  assert.match(toolEnds(rpc, cursor)[0].result.content[0].text, /Destination: custom\/legacy-team \(new\)/);

  cursor = await chat(child, rpc, "convert it");
  const [plan] = toolEnds(rpc, cursor);
  assert.equal(plan.result.details.mode, "confirm-required");
  assert.match(plan.result.content[0].text, /original persona files are not changed, and nothing is selected or made the default/);
  assert.equal((await listGlobalPersonaPacks(storeRoot)).custom.some((pack) => pack.name === "legacy-team"), false, "plan alone installs nothing");

  cursor = await chat(child, rpc, "yes");
  assert.match(toolEnds(rpc, cursor)[0].result.content[0].text, /Migration applied: custom\/legacy-team/);
  assert.equal((await listGlobalPersonaPacks(storeRoot)).custom.some((pack) => pack.name === "legacy-team"), true);
  assert.equal(await readFile(path.join(workspace, ".pi/agents/writer.md"), "utf8"), originalWriter);
  assert.equal((await readGlobalDefaultPack(storeRoot))?.defaultPack, "custom/marketing", "default untouched");
  // An unbound legacy session lists (but gates) the workspace's own commands,
  // as before; what matters is that no team was bound or activated.
  const teamCursor = rpc.cursor();
  send(child, { id: "team-status", type: "prompt", message: "/persona status" });
  const status = await waitForPersona(rpc, "Persona team:", "persona status after migration", teamCursor);
  assert.match(status.message.content, /Persona team: none \(no team is selected/);
  assert.match(status.message.content, /Active persona: none/);

  cursor = await chat(child, rpc, "actually, roll it back");
  assert.match(toolEnds(rpc, cursor)[0].result.content[0].text, /Roll back the migration to 'custom\/legacy-team'\? .*returns to needing migration, as before/);
  cursor = await chat(child, rpc, "yes");
  assert.equal(toolEnds(rpc, cursor)[0].result.details.mode, "scheduled");
  await waitForPersona(rpc, "requires migration again", "rollback applied after reload", cursor);
  assert.equal((await listGlobalPersonaPacks(storeRoot)).custom.some((pack) => pack.name === "legacy-team"), true, "rollback keeps the pack");
  assert.equal(await readFile(path.join(workspace, ".pi/agents/writer.md"), "utf8"), originalWriter);
  const statusCursor = rpc.cursor();
  send(child, { id: "status", type: "prompt", message: "/persona migrate status" });
  await waitForPersona(rpc, "rolled back", "slash status still works and reports the rollback", statusCursor);
});

test("chat-first: a migration draft edited after its apply plan was shown is refused", { timeout: 60_000 }, async (t) => {
  const { child, rpc, storeRoot } = await setup(t, chatScript(MIGRATE_ROUTES), { seedWorkspace: writeLegacyWorkspace });
  await chat(child, rpc, "preview it as legacy-team with the writer");
  await chat(child, rpc, "convert it");
  const draftWriter = path.join(storeRoot, "drafts", "legacy-team", "agents", "writer.md");
  await writeFile(draftWriter, (await readFile(draftWriter, "utf8")).replace("Legacy specialist prompt.", "Tampered prompt."));
  const cursor = await chat(child, rpc, "yes");
  const [end] = toolEnds(rpc, cursor);
  assert.equal(end.result.isError, true);
  assert.match(end.result.content[0].text, /Something changed since this plan was shown/);
  assert.equal((await listGlobalPersonaPacks(storeRoot)).custom.some((pack) => pack.name === "legacy-team"), false);
});
