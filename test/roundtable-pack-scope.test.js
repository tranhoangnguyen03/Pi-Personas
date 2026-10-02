import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveRoundtableLaunchRequest,
  resolveRoundtableSelectionRequest,
  runNativeRoundtable,
} from "../src/persona/roundtable.js";

async function createWorkspace(t) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-roundtable-pack-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeText(path.join(root, ".pi/agents/_baseline.md"), `---
docs: library/shared/
---
Shared project context.
`);
  await writeText(path.join(root, "library/shared/_index.md"), "Shared library index.\n");
  return root;
}

async function writePackAgent(root, pack, name, role, docs = []) {
  await writeText(path.join(root, `.pi/agents/packs/${pack}/${name}.md`), `---
name: ${name}
role: ${role}
${role === "generalist" ? "primary: false\n" : ""}description: ${name} for ${pack}.
${docs.length ? `docs: ${docs.join(", ")}\n` : ""}---
${name} prompt.
`);
}

async function writeText(filePath, text) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text, "utf8");
}

test("a coordinator-free foundation directs roundtables to pack discovery", async (t) => {
  const root = await createWorkspace(t);

  await assert.rejects(
    () => resolveRoundtableSelectionRequest(root, { query: "Who let the dog out?" }),
    /round-tables need a persona team; ask in chat to install or choose one/,
  );
});

test("active pack persona scopes moderator and specialist candidates", async (t) => {
  const root = await createWorkspace(t);
  await writePackAgent(root, "philosopher-7", "symposium", "generalist");
  await writePackAgent(root, "philosopher-7", "socrates", "specialist");
  await writePackAgent(root, "writer-team", "writers-room", "generalist");
  await writePackAgent(root, "writer-team", "copy-editor", "specialist");

  const byName = await resolveRoundtableSelectionRequest(root, {
    query: "Challenge this assumption.",
    activePersona: "socrates",
  });
  assert.equal(byName.pack, "philosopher-7");
  assert.equal(byName.moderator.name, "symposium");
  assert.deepEqual(byName.candidates.map((agent) => agent.name), ["socrates"]);
  assert.match(byName.userMessage, /Pack: philosopher-7/);
  assert.match(byName.userMessage, /Moderator: \[G\] symposium/);
  assert.match(byName.userMessage, /normally use two to four complementary specialists/);
  assert.match(byName.userMessage, /present the final moderator synthesis faithfully and in full/);
  assert.doesNotMatch(byName.userMessage, /\(library:/);
  assert.doesNotMatch(byName.userMessage, /persona_roundtable|planId|raw `subagent`/);
  assert.doesNotMatch(byName.userMessage, /copy-editor/);

  const byPath = await resolveRoundtableSelectionRequest(root, {
    query: "Rewrite this opening.",
    activePersona: ".pi/agents/packs/writer-team/copy-editor.md",
  });
  assert.equal(byPath.pack, "writer-team");
  assert.equal(byPath.moderator.name, "writers-room");
  assert.deepEqual(byPath.candidates.map((agent) => agent.name), ["copy-editor"]);
});

test("one pack falls back automatically while multiple packs request a trusted choice", async (t) => {
  const root = await createWorkspace(t);
  await writePackAgent(root, "philosopher-7", "symposium", "generalist");
  await writePackAgent(root, "philosopher-7", "socrates", "specialist");

  const single = await resolveRoundtableSelectionRequest(root, {
    query: "Who let the dog out?",
  });
  assert.equal(single.pack, "philosopher-7");
  assert.equal(single.moderator.name, "symposium");

  await writePackAgent(root, "writer-team", "writers-room", "generalist");
  await writePackAgent(root, "writer-team", "copy-editor", "specialist");
  await assert.rejects(
    () => resolveRoundtableSelectionRequest(root, { query: "Who let the dog out?" }),
    (error) => {
      assert.equal(error.code, "ROUNDTABLE_PACK_REQUIRED");
      assert.deepEqual(error.packs, [
        { name: "philosopher-7", moderator: "symposium" },
        { name: "writer-team", moderator: "writers-room" },
      ]);
      assert.match(error.message, /philosopher-7 \(\[G\] symposium\)/);
      assert.match(error.message, /writer-team \(\[G\] writers-room\)/);
      return true;
    },
  );
});

test("launch revalidates the trusted pack and omits rebased chain reads", async (t) => {
  const root = await createWorkspace(t);
  await writeText(path.join(root, "library/personal/symposium/_index.md"), "Symposium index.\n");
  await writeText(path.join(root, "library/personal/socrates/_index.md"), "Socrates index.\n");
  await writePackAgent(root, "philosopher-7", "symposium", "generalist", ["library/personal/symposium/"]);
  await writePackAgent(root, "philosopher-7", "socrates", "specialist", ["library/personal/socrates/"]);
  await writePackAgent(root, "writer-team", "writers-room", "generalist");
  await writePackAgent(root, "writer-team", "copy-editor", "specialist");

  await assert.rejects(
    () => resolveRoundtableLaunchRequest(root, {
      query: "Challenge this assumption.",
      pack: "philosopher-7",
      selections: [{ name: "copy-editor", reason: "It can edit the wording." }],
    }),
    /outside trusted pack 'philosopher-7': copy-editor/,
  );
  await assert.rejects(
    () => resolveRoundtableLaunchRequest(root, {
      query: "Challenge this assumption.",
      activePersona: "copy-editor",
      pack: "philosopher-7",
      selections: [{ name: "socrates", reason: "It can question assumptions." }],
    }),
    /belongs to pack 'writer-team', not 'philosopher-7'/,
  );

  const roundtable = await resolveRoundtableLaunchRequest(root, {
    query: "Challenge this assumption.",
    activePersona: "symposium",
    pack: "philosopher-7",
    selections: [{ name: "socrates", reason: "It can question assumptions." }],
  });
  assert.equal(roundtable.pack, "philosopher-7");
  assert.equal(roundtable.moderator.name, "symposium");

  const calls = [];
  await runNativeRoundtable(roundtable, async ({ scope, task, index }) => {
    calls.push({ agent: scope.agent.name, task, index });
    return { text: `${scope.agent.name} answer` };
  });
  const roundOne = calls[0].task;
  const roundTwo = calls[1].task;
  const synthesis = calls[2].task;
  assert.match(roundOne, /Assigned contribution: It can question assumptions\./);
  assert.match(roundOne, /independent, self-contained specialist position/);
  assert.match(roundTwo, /Assigned contribution: It can question assumptions\./);
  assert.match(roundTwo, /Restate every claim and reason needed for synthesis/);
  assert.match(roundTwo, /Final claim and reasoning/);
  for (const heading of [
    "Answer",
    "Perspective contributions",
    "Real disagreements",
    "Conditions and tradeoffs",
    "Recommended decision",
    "What could change the answer",
  ]) {
    assert.match(synthesis, new RegExp(`## ${heading}`));
  }
  for (const call of calls) {
    assert.match(call.task, /\[Read from: library\/shared\/_index\.md/);
  }
});

test("pack scope requires exactly one generalist moderator", async (t) => {
  const root = await createWorkspace(t);
  await writePackAgent(root, "writer-team", "writers-room", "generalist");
  await writePackAgent(root, "writer-team", "editorial-desk", "generalist");
  await writePackAgent(root, "writer-team", "copy-editor", "specialist");

  await assert.rejects(
    () => resolveRoundtableSelectionRequest(root, {
      query: "Rewrite this opening.",
      pack: "writer-team",
    }),
    /requires exactly one moderator with role generalist; found 2/,
  );
});
