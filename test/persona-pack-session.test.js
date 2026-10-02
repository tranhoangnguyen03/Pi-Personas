import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { getPackageDir } from "@earendil-works/pi-coding-agent";

import { resolveAgentScope } from "../src/persona/resolver.js";
import { resolveAgentLaunchRequest } from "../src/persona/launch.js";
import { resolveConsultLaunchRequest } from "../src/persona/consult.js";
import { resolveRoundtableLaunchRequest, resolveRoundtableSelectionRequest } from "../src/persona/roundtable.js";
import { runPersonaChild } from "../src/persona/child-runner.js";
import { __withFsHookForTesting, loadPackSession } from "../src/persona/pack-session.js";
import { readPortablePersonaPack } from "../src/persona/pack-source.js";
import {
  applyCustomPersonaPackDraft,
  deleteCustomPersonaPack,
  stageCustomPersonaPackDraft,
} from "../src/persona/global-pack-store.js";

async function tempDir(t, prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeText(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

function agentSource(name, role, { packDocs = [] } = {}) {
  const lines = ["---", `name: ${name}`, `role: ${role}`, `description: ${name} ${role}.`];
  if (packDocs.length > 0) lines.push("packDocs:", ...packDocs.map((entry) => `  - ${entry}`));
  lines.push("---", `${name} prompt body.`, "");
  return lines.join("\n");
}

// A minimal schema 2 pack: a `lead` generalist and a `scout` specialist, each
// with their own pack-relative references, plus a baseline that declares
// both a workspace-relative doc and a pack-relative one, so combined
// baseline+persona docs/packDocs are exercised together.
async function writeCouncilPackSource(root, options = {}) {
  const name = options.name ?? "council";
  await writeText(path.join(root, "pack.yaml"), [
    "schema: 2",
    `name: ${name}`,
    `version: ${options.version ?? "1.0.0"}`,
    "description: Council test pack.",
  ].join("\n") + "\n");
  await writeText(path.join(root, "agents/_baseline.md"), [
    "---",
    "docs:",
    "  - library/shared/",
    "packDocs:",
    "  - shared/",
    "---",
    "Shared council instructions.",
    "",
  ].join("\n"));
  await writeText(path.join(root, "agents/lead.md"), agentSource("lead", "generalist", { packDocs: ["lead/"] }));
  await writeText(path.join(root, "agents/scout.md"), agentSource("scout", "specialist", { packDocs: ["scout/"] }));
  await writeText(path.join(root, "references/shared/_index.md"), "# shared\n");
  await writeText(path.join(root, "references/shared/contract.md"), options.sharedContract ?? "Shared contract.\n");
  await writeText(path.join(root, "references/lead/_index.md"), "# lead\n");
  await writeText(path.join(root, "references/lead/notes.md"), "Lead notes.\n");
  await writeText(path.join(root, "references/scout/_index.md"), "# scout\n");
  await writeText(path.join(root, "references/scout/notes.md"), options.scoutNotes ?? "Scout notes v1.\n");
  return readPortablePersonaPack(root, { type: "path", ref: root });
}

async function installCouncilPack(t, storeRoot, options = {}) {
  const name = options.name ?? "council";
  const sourceDir = await tempDir(t, "pi-persona-council-src-");
  const source = await writeCouncilPackSource(sourceDir, options);
  await stageCustomPersonaPackDraft(storeRoot, name, source);
  await applyCustomPersonaPackDraft(storeRoot, name);
}

test("loadPackSession copies a bounded, owner-only private snapshot independent of the store", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-session-store-");
  await installCouncilPack(t, storeRoot);

  const session = await loadPackSession(storeRoot, "custom/council");
  t.after(() => session.dispose().catch(() => {}));

  assert.equal(session.qualifiedName, "custom/council");
  assert.equal(session.manifest.name, "council");
  assert.ok(path.isAbsolute(session.root));
  assert.equal(path.relative(storeRoot, session.root).startsWith(".runtime-sessions"), true);
  assert.ok(session.revision.startsWith("sha256:"));

  for (const relativePath of ["pack.yaml", "agents/lead.md", "agents/scout.md", "agents/_baseline.md", "references/shared/contract.md"]) {
    assert.equal(await readFile(path.join(session.root, relativePath), "utf8").then(() => true), true);
  }

  if (process.platform !== "win32") {
    assert.equal((await stat(session.root)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(session.root, "agents/lead.md"))).mode & 0o777, 0o600);
  }

  const installedIntegrity = (await readPortablePersonaPack(path.join(storeRoot, "custom/council"), { type: "installed", ref: "custom/council" })).integrity;
  assert.equal(session.revision, installedIntegrity);
});

test("a resolved pack team feeds resolveAgentLaunchRequest/resolveConsultLaunchRequest/resolveRoundtableLaunchRequest while workspace docs and cwd stay live", async (t) => {
  const workspaceRoot = await tempDir(t, "pi-persona-session-workspace-");
  await writeText(path.join(workspaceRoot, "library/shared/note.md"), "Live workspace note.\n");

  const storeRoot = await tempDir(t, "pi-persona-session-store-");
  await installCouncilPack(t, storeRoot);
  const session = await loadPackSession(storeRoot, "custom/council");
  t.after(() => session.dispose().catch(() => {}));
  const team = session.team();

  assert.deepEqual(team.packName, "council");
  assert.equal(team.packRoot, session.root);

  const launch = await resolveAgentLaunchRequest(workspaceRoot, "lead", { ...team, task: "Plan the campaign." });
  assert.equal(launch.agentName, "lead");
  assert.equal(launch.userMessage, "Plan the campaign.");
  assert.match(launch.systemPrompt, /library\/shared\/note\.md/);
  assert.match(launch.systemPrompt, new RegExp(escapeRegExp(path.join(session.root, "references/lead/notes.md"))));
  assert.match(launch.systemPrompt, new RegExp(escapeRegExp(path.join(session.root, "references/shared/contract.md"))));

  const consult = await resolveConsultLaunchRequest(workspaceRoot, {
    requester: "lead",
    consultant: "scout",
    question: "Check the flank.",
    summary: "Need scouting input.",
  }, team);
  assert.equal(consult.requester.name, "lead");
  assert.equal(consult.consultant.name, "scout");
  assert.match(consult.task, new RegExp(escapeRegExp(path.join(session.root, "references/scout/notes.md"))));
  assert.match(consult.task, new RegExp(escapeRegExp(path.join(session.root, "references/shared/contract.md"))));

  const roundtable = await resolveRoundtableLaunchRequest(workspaceRoot, {
    query: "Plan the attack",
    selections: [{ name: "scout", reason: "scouting" }],
  }, team);
  assert.equal(roundtable.pack, "council");
  assert.equal(roundtable.generalist.name, "lead");
  assert.deepEqual(roundtable.roster.map((agent) => agent.name), ["scout"]);

  const selectionRequest = await resolveRoundtableSelectionRequest(workspaceRoot, { query: "Plan the attack" }, team);
  assert.equal(selectionRequest.moderator.name, "lead");
  assert.deepEqual(selectionRequest.candidates.map((agent) => agent.name), ["scout"]);

  // None of this touched or required a workspace `.pi` project: the roster
  // came entirely from the bound pack team.
  await assert.rejects(stat(path.join(workspaceRoot, ".pi")), /ENOENT/);
});

test("mutating or deleting the installed pack after loading a session preserves that session's direct and child-shaped scope references", async (t) => {
  const workspaceRoot = await tempDir(t, "pi-persona-session-workspace-");
  const storeRoot = await tempDir(t, "pi-persona-session-store-");
  await installCouncilPack(t, storeRoot, { scoutNotes: "Scout notes v1.\n" });

  const session = await loadPackSession(storeRoot, "custom/council");
  t.after(() => session.dispose().catch(() => {}));
  const team = session.team();

  const scopeBefore = await resolveAgentScope(workspaceRoot, "scout", team);
  const scoutNotesPath = scopeBefore.derived.defaultReads.find((entry) => entry.endsWith(path.join("references", "scout", "notes.md")));
  assert.ok(scoutNotesPath);
  assert.equal(await readFile(scoutNotesPath, "utf8"), "Scout notes v1.\n");

  // Mutate the installed pack in place.
  await installCouncilPack(t, storeRoot, { scoutNotes: "Scout notes v2 (mutated).\n" });
  // Then delete it entirely.
  await deleteCustomPersonaPack(storeRoot, "council");

  const scopeAfter = await resolveAgentScope(workspaceRoot, "scout", team);
  assert.equal(await readFile(scoutNotesPath, "utf8"), "Scout notes v1.\n");
  assert.deepEqual(scopeAfter.derived.defaultReads, scopeBefore.derived.defaultReads);

  const consult = await resolveConsultLaunchRequest(workspaceRoot, {
    requester: "lead",
    consultant: "scout",
    question: "Still reachable?",
    summary: "Old scope check.",
  }, team);
  assert.match(consult.task, new RegExp(escapeRegExp(scoutNotesPath)));
  assert.equal(consult.consultant.name, "scout");

  // The installed pack is gone; loading a fresh session for it must fail
  // cleanly, and that failure must not touch the still-open session above.
  await assert.rejects(() => loadPackSession(storeRoot, "custom/council"));
  assert.equal(await readFile(scoutNotesPath, "utf8"), "Scout notes v1.\n");
  assert.equal((await stat(session.root)).isDirectory(), true);
});

test("reloading a changed pack produces a new revision and an independent snapshot, leaving the prior session's content untouched", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-session-store-");
  await installCouncilPack(t, storeRoot, { scoutNotes: "v1\n" });

  const sessionA = await loadPackSession(storeRoot, "custom/council");
  t.after(() => sessionA.dispose().catch(() => {}));

  await installCouncilPack(t, storeRoot, { scoutNotes: "v2\n" });

  const sessionB = await loadPackSession(storeRoot, "custom/council");
  t.after(() => sessionB.dispose().catch(() => {}));

  assert.notEqual(sessionA.revision, sessionB.revision);
  assert.notEqual(sessionA.root, sessionB.root);
  assert.equal(await readFile(path.join(sessionA.root, "references/scout/notes.md"), "utf8"), "v1\n");
  assert.equal(await readFile(path.join(sessionB.root, "references/scout/notes.md"), "utf8"), "v2\n");
});

test("snapshot bounds are enforced before any private content is written to disk", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-session-store-");
  const sourceDir = await tempDir(t, "pi-persona-session-oversized-src-");
  const source = await writeCouncilPackSource(sourceDir, { name: "oversized" });
  await stageCustomPersonaPackDraft(storeRoot, "oversized", source);
  await applyCustomPersonaPackDraft(storeRoot, "oversized");
  // Add reference content well past the 50 MiB private snapshot ceiling,
  // directly under the installed pack (not through the draft flow, since
  // only the total-size ceiling — not file authoring — is under test here).
  await writeFile(path.join(storeRoot, "custom/oversized/references/shared/big-one.bin"), Buffer.alloc(26 * 1024 * 1024, 1));
  await writeFile(path.join(storeRoot, "custom/oversized/references/shared/big-two.bin"), Buffer.alloc(26 * 1024 * 1024, 2));

  await assert.rejects(
    () => loadPackSession(storeRoot, "custom/oversized"),
    /exceeding the 50\.0 MiB private snapshot limit/,
  );

  const runtimeSessionsDir = path.join(storeRoot, ".runtime-sessions");
  const entries = await readdir(runtimeSessionsDir).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  assert.deepEqual(entries, []);
});

test("the file-count snapshot bound is also enforced before any private content is written to disk", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-session-store-");
  await installCouncilPack(t, storeRoot, { name: "crowded" });
  // Add well past the 2,000-file private snapshot ceiling directly under the
  // installed pack, mirroring the oversized-bytes test above.
  for (let index = 0; index < 2001; index += 1) {
    await writeFile(path.join(storeRoot, "custom/crowded/references/shared", `extra-${index}.md`), "x");
  }

  await assert.rejects(
    () => loadPackSession(storeRoot, "custom/crowded"),
    /has \d+ files, exceeding the 2000-file private snapshot limit/,
  );

  const runtimeSessionsDir = path.join(storeRoot, ".runtime-sessions");
  const entries = await readdir(runtimeSessionsDir).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  assert.deepEqual(entries, []);
});

test("loading a session refuses a symlink standing in for the installed pack's own store directory", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-session-store-");
  const outsideTarget = await tempDir(t, "pi-persona-session-outside-");
  await mkdir(path.join(storeRoot, "custom"), { recursive: true });
  await symlink(outsideTarget, path.join(storeRoot, "custom", "escapee"), "dir");

  await assert.rejects(
    () => loadPackSession(storeRoot, "custom/escapee"),
    /symbolic links are not supported in the persona pack store/,
  );

  const runtimeSessionsDir = path.join(storeRoot, ".runtime-sessions");
  const entries = await readdir(runtimeSessionsDir).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  assert.deepEqual(entries, []);
});

test("a write failure partway through the snapshot copy leaves no orphaned session directory behind", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-session-store-");
  await installCouncilPack(t, storeRoot);

  let writeCount = 0;
  const realWriteFile = writeFile;
  await assert.rejects(
    () => __withFsHookForTesting({
      async writeFile(...args) {
        writeCount += 1;
        if (writeCount === 3) throw new Error("simulated disk failure mid-snapshot");
        return realWriteFile(...args);
      },
    }, () => loadPackSession(storeRoot, "custom/council")),
    /simulated disk failure mid-snapshot/,
  );
  assert.ok(writeCount >= 3, "expected the injected failure to actually fire partway through the copy");

  const runtimeSessionsDir = path.join(storeRoot, ".runtime-sessions");
  const entries = await readdir(runtimeSessionsDir).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  assert.deepEqual(entries, []);

  // The store's installed pack itself is untouched by the failed load.
  const stillInstalled = await readPortablePersonaPack(path.join(storeRoot, "custom/council"), { type: "installed", ref: "custom/council" });
  assert.equal(stillInstalled.manifest.name, "council");
});

test("a failed removal leaves a session not-disposed so dispose() can be retried instead of silently losing the snapshot", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-session-store-");
  await installCouncilPack(t, storeRoot);

  const session = await loadPackSession(storeRoot, "custom/council");
  const realRm = rm;

  await assert.rejects(
    () => __withFsHookForTesting({
      rm: async () => {
        throw new Error("simulated removal failure");
      },
    }, () => session.dispose()),
    /simulated removal failure/,
  );
  assert.equal(session.isDisposed, false);
  assert.equal((await stat(session.root)).isDirectory(), true);

  // Retrying without the injected failure succeeds and now actually removes it.
  const result = await __withFsHookForTesting({ rm: realRm }, () => session.dispose());
  assert.deepEqual(result, { disposed: true, alreadyDisposed: false });
  assert.equal(session.isDisposed, true);
  await assert.rejects(stat(session.root), /ENOENT/);
});

test("dispose is idempotent, refuses while a native child still holds the snapshot, and never touches a live installed pack", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-session-store-");
  await installCouncilPack(t, storeRoot);

  const session = await loadPackSession(storeRoot, "custom/council");
  const release = session.retain();

  await assert.rejects(() => session.dispose(), /native child run/);
  assert.equal((await stat(session.root)).isDirectory(), true);

  release();
  const result = await session.dispose();
  assert.deepEqual(result, { disposed: true, alreadyDisposed: false });
  await assert.rejects(stat(session.root), /ENOENT/);

  const second = await session.dispose();
  assert.deepEqual(second, { disposed: true, alreadyDisposed: true });

  assert.throws(() => session.retain(), /already disposed/);

  // The installed pack itself was never touched by disposing its session.
  const stillInstalled = await readPortablePersonaPack(path.join(storeRoot, "custom/council"), { type: "installed", ref: "custom/council" });
  assert.equal(stillInstalled.manifest.name, "council");
});

// Shutdown retention: extensions/pi-persona.ts's session_shutdown handler
// polls session.activeChildCount and only calls dispose() once it reaches 0
// (bounded, then still calls dispose() and lets it throw/log rather than
// force-deleting an active reference -- see waitForPersonaSessionIdle there).
// That polling loop is a private closure inside the extension and cannot be
// driven directly without a real forked native child settling at exactly the
// right moment, so this exercises the same pattern against pack-session.js's
// real retain()/dispose() primitives directly: it is the contract the
// shutdown fix depends on, verified at the level that can be driven
// deterministically.
test("a poll-until-idle-then-dispose loop succeeds once the last active child releases, and still refuses (never force-deletes) if one never does", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-session-store-");
  await installCouncilPack(t, storeRoot);

  async function waitForIdleThenDispose(session, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (session.activeChildCount > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return session.dispose();
  }

  // Case 1: the in-flight child settles (releases) shortly after shutdown
  // begins polling -- dispose() succeeds without ever being forced.
  {
    const session = await loadPackSession(storeRoot, "custom/council");
    const release = session.retain();
    setTimeout(release, 40);
    const result = await waitForIdleThenDispose(session, 2000);
    assert.deepEqual(result, { disposed: true, alreadyDisposed: false });
    assert.equal(session.isDisposed, true);
  }

  // Case 2: the child never settles within the bound -- dispose() still
  // refuses (never force-deletes an active reference) rather than silently
  // succeeding or corrupting the retained snapshot out from under it.
  {
    const session = await loadPackSession(storeRoot, "custom/council");
    t.after(() => {
      // Release so the snapshot can actually be cleaned up after the test.
    });
    const release = session.retain();
    await assert.rejects(() => waitForIdleThenDispose(session, 60), /native child run/);
    assert.equal(session.isDisposed, false);
    assert.equal((await stat(session.root)).isDirectory(), true, "the snapshot is still on disk -- never force-deleted while retained");
    release();
    await session.dispose();
  }
});

// This is the repo's REAL native backend (child-runner.js / child-entry.js),
// forked as an actual Node child process, loading Pi's REAL SDK
// (`@earendil-works/pi-coding-agent`'s dist build, the same entry
// createNativeRequest points at in extensions/pi-persona.ts) with only the
// far end of the model HTTP call replaced by a local mock — matching
// docs/plans/persona-pack-probes/probe-5-native-child-retained-cwd.mjs.
// Unlike a fake SDK module, this exercises Pi's actual resource loader,
// session construction, and real `read` tool execution for every read below.
test("a real native child, driven through Pi's actual SDK tool loop against a local mock model, reads live workspace docs and a retained pack doc under one unchanged live-workspace cwd, using the real baseline+persona system prompt", async (t) => {
  const workspaceRoot = await tempDir(t, "pi-persona-session-child-workspace-");
  const storeRoot = await tempDir(t, "pi-persona-session-child-store-");
  const workspaceNoteRelativePath = "library/shared/note.md";
  await writeText(path.join(workspaceRoot, workspaceNoteRelativePath), "Workspace note v1.\n");
  await installCouncilPack(t, storeRoot, { scoutNotes: "Scout notes for the native child.\n" });

  const session = await loadPackSession(storeRoot, "custom/council");
  t.after(() => session.dispose().catch(() => {}));
  const team = session.team();

  // Mutate the workspace's own doc AFTER the pack session is loaded, so this
  // proves the workspace side of a bound scope stays live even once the
  // pack side is a fixed, retained snapshot.
  await writeText(path.join(workspaceRoot, workspaceNoteRelativePath), "Workspace note v2 (post-load).\n");

  const consult = await resolveConsultLaunchRequest(workspaceRoot, {
    requester: "lead",
    consultant: "scout",
    question: "What did you find?",
    summary: "Field report.",
  }, team);
  const scoutNotesPath = consult.scope.derived.defaultReads.find((entry) => entry.endsWith(path.join("references", "scout", "notes.md")));
  assert.ok(scoutNotesPath);
  assert.notEqual(path.dirname(scoutNotesPath), workspaceRoot);
  assert.ok(consult.scope.derived.defaultReads.includes(workspaceNoteRelativePath));

  // The real baseline+persona system prompt this consult would actually
  // send, unmodified — matching createNativeRequest's own composition in
  // extensions/pi-persona.ts, not a stand-in string built just for this test.
  const systemPrompt = `${consult.scope.prompt}\n\n## Native Child Boundary\n\nThis is a one-shot leaf session. Use only the tools declared for this persona and return the requested answer directly. Do not attempt delegation.`;
  assert.match(systemPrompt, /Shared council instructions\./);
  assert.match(systemPrompt, /scout prompt body\./);

  const received = [];
  // Minimal mock of the OpenAI Chat Completions streaming endpoint: turn 1
  // requests a real `read` of the live workspace doc (relative path, so it
  // only resolves correctly if the child's actual cwd is the workspace);
  // turn 2 requests a real `read` of the retained pack doc (absolute path
  // into the snapshot); turn 3 echoes back exactly what those two real tool
  // results contained, proving both flowed through Pi's actual `read` tool.
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      received.push({ body: parsed, raw: body });
      const toolMessages = (parsed.messages ?? []).filter((message) => message.role === "tool");
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const id = "chatcmpl-mock-pack-session";
      const created = Math.floor(Date.now() / 1000);
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const frame = (delta, finish_reason = null) =>
        send({ id, object: "chat.completion.chunk", created, model: "mock-model", choices: [{ index: 0, delta, finish_reason }] });

      const requestRead = (callId, readPath) => {
        frame({ role: "assistant", content: null, tool_calls: [{ index: 0, id: callId, type: "function", function: { name: "read", arguments: "" } }] });
        frame({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: readPath }) } }] });
        frame({}, "tool_calls");
      };

      if (toolMessages.length === 0) {
        requestRead("call_workspace_note", workspaceNoteRelativePath);
      } else if (toolMessages.length === 1) {
        requestRead("call_pack_notes", scoutNotesPath);
      } else {
        const toolText = (message) => (Array.isArray(message.content) ? message.content.map((part) => part.text ?? "").join("") : String(message.content ?? ""));
        const answer = JSON.stringify({
          workspaceNote: toolText(toolMessages[0]),
          packNotes: toolText(toolMessages[1]),
        });
        frame({ role: "assistant", content: answer });
        frame({}, "stop");
      }
      send({ id, object: "chat.completion.chunk", created, model: "mock-model", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const agentDir = await tempDir(t, "pi-persona-session-child-agent-dir-");
  await writeText(path.join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "mock-provider": {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        api: "openai-completions",
        apiKey: "mock-key",
        models: [
          { id: "mock-model", name: "Mock Model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 },
        ],
      },
    },
  }));

  const result = await runPersonaChild({
    cwd: workspaceRoot, // <-- unchanged live workspace for the whole run
    agentDir,
    sdkEntry: pathToFileURL(path.join(getPackageDir(), "dist/index.js")).href,
    authStorageEntry: pathToFileURL(path.join(getPackageDir(), "dist/core/auth-storage.js")).href,
    projectTrusted: true,
    personaName: "scout",
    systemPrompt,
    task: consult.task,
    model: { provider: "mock-provider", id: "mock-model" },
    thinkingLevel: "off",
    auth: { apiKey: "mock-key", baseUrl: `http://127.0.0.1:${port}/v1`, headers: {} },
    skillNames: [],
    skillPaths: [],
    tools: ["read"],
    context: "fresh",
    branch: [],
  }, { idleTimeoutMs: 15000, startTimeoutMs: 15000 });

  assert.equal(result.status, "completed", JSON.stringify(result));
  const answer = JSON.parse(result.text);
  // The workspace read used a *relative* path, which Pi's real `read` tool
  // resolves against the child's actual OS-level cwd; it only comes back
  // with the current, post-load content if that cwd was really the live
  // workspace (not swapped to the pack's retained snapshot, nor left at
  // this process's own cwd).
  assert.equal(answer.workspaceNote, "Workspace note v2 (post-load).\n");
  assert.equal(answer.packNotes, "Scout notes for the native child.\n");

  assert.equal(received.length, 3, "expected 3 model turns: request workspace read, request pack read, final answer");
  // The real system prompt (baseline + persona body), not a fabricated
  // stand-in, actually crossed the wire to the model on the first call.
  assert.match(received[0].raw, /Shared council instructions\./);
  assert.match(received[0].raw, /scout prompt body\./);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
