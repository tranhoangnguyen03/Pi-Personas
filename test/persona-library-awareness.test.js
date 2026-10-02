import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { resolveAgentScope } from "../src/persona/resolver.js";
import { formatDocReadPreamble } from "../src/persona/runtime.js";

async function writeText(filePath, text) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text, "utf8");
}

test("library preamble includes index contents and filenames without other document bodies", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-persona-library-awareness-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeText(path.join(root, ".pi/agents/_baseline.md"), `---
docs: library/shared/
---
Shared baseline.
`);
  await writeText(path.join(root, ".pi/agents/socrates.md"), `---
name: socrates
role: specialist
description: Tests assumptions.
docs: library/personal/socrates/
---
Ask precise questions.
`);
  await writeText(path.join(root, "library/shared/_index.md"), "# Shared index\n\nProject-wide catalogue.\n");
  await writeText(path.join(root, "library/shared/project-brief.md"), "NON_INDEX_SHARED_BODY\n");
  await writeText(path.join(root, "library/shared/archive/decision.md"), "NON_INDEX_NESTED_BODY\n");
  await writeText(path.join(root, "library/personal/socrates/_index.md"), "# Socrates index\n\nPersonal catalogue.\n");
  await writeText(path.join(root, "library/personal/socrates/method.md"), "NON_INDEX_PERSONAL_BODY\n");

  const scope = await resolveAgentScope(root, "socrates");
  const preamble = formatDocReadPreamble(scope);

  assert.deepEqual(scope.derived.docIndexes, [
    {
      declared: "library/shared/",
      indexFile: "library/shared/_index.md",
      content: "# Shared index\n\nProject-wide catalogue.\n",
    },
    {
      declared: "library/personal/socrates/",
      indexFile: "library/personal/socrates/_index.md",
      content: "# Socrates index\n\nPersonal catalogue.\n",
    },
  ]);
  assert.match(preamble, /# Shared index\n\nProject-wide catalogue\./);
  assert.match(preamble, /# Socrates index\n\nPersonal catalogue\./);
  assert.match(preamble, /library\/shared\/project-brief\.md/);
  assert.match(preamble, /library\/shared\/archive\/decision\.md/);
  assert.match(preamble, /library\/personal\/socrates\/method\.md/);
  assert.doesNotMatch(preamble, /NON_INDEX_SHARED_BODY/);
  assert.doesNotMatch(preamble, /NON_INDEX_NESTED_BODY/);
  assert.doesNotMatch(preamble, /NON_INDEX_PERSONAL_BODY/);

  assert.deepEqual(scope.derived.defaultReads, [
    "library/shared/_index.md",
    "library/shared/project-brief.md",
    "library/personal/socrates/_index.md",
    "library/personal/socrates/method.md",
  ]);
  assert.ok(!scope.derived.defaultReads.includes("library/shared/archive/decision.md"));
});
