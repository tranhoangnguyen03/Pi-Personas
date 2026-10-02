import assert from "node:assert/strict";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveAgentScope, resolveScopedAgentDocs } from "../src/persona/resolver.js";
import {
  listBundledPersonaPacks,
  loadPersonaPackSource,
  materializePersonaPack,
  readPortablePersonaPack,
} from "../src/persona/pack-source.js";
import {
  __withFsHookForTesting,
  applyCustomPersonaPackDraft,
  cancelCustomPersonaPackDraft,
  deleteCustomPersonaPack,
  forkPersonaPack,
  installOfficialPersonaPack,
  listGlobalPersonaPacks,
  previewCustomPersonaPackDraft,
  stageCustomPersonaPackDraft,
  uninstallOfficialPersonaPack,
  updateOfficialPersonaPack,
} from "../src/persona/global-pack-store.js";
import { resolveInstalledQualifiedPersonaPackName, runGlobalPersonaPackAction } from "../src/persona/pack-lifecycle.js";
import { readGlobalDefaultPack, writeGlobalDefaultPack } from "../src/persona/pack-session.js";

async function tempDir(t, prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeText(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

function schema2Agent(name, role, { packDocs = [`${name}/`, "shared/"], extra = "" } = {}) {
  return `---
name: ${name}
role: ${role}
description: ${name} ${role}.
packDocs:
${packDocs.map((entry) => `  - ${entry}`).join("\n")}
${extra}---
${name} prompt body.
`;
}

async function writeSchema2Pack(root, options = {}) {
  const name = options.name ?? "schema2-team";
  await writeText(path.join(root, "pack.yaml"), [
    "schema: 2",
    `name: ${name}`,
    `version: ${options.version ?? "1.0.0"}`,
    `description: ${options.description ?? `${name} test pack.`}`,
  ].join("\n") + "\n");
  await writeText(path.join(root, "configure.md"), options.configure ?? `# Configure ${name}\n`);

  if (options.baseline !== false) {
    await writeText(
      path.join(root, "agents/_baseline.md"),
      options.baselineSource ?? `---\n---\nShared team instructions for ${name}.\n`,
    );
  }

  const leadName = options.leadName ?? `${name}-lead`;
  await writeText(
    path.join(root, "agents", `${leadName}.md`),
    options.leadSource ?? schema2Agent(leadName, "generalist"),
  );
  for (const specialist of options.specialists ?? ["member"]) {
    await writeText(
      path.join(root, "agents", `${specialist}.md`),
      options.specialistSources?.[specialist] ?? schema2Agent(specialist, "specialist"),
    );
  }

  if (options.references !== false) {
    for (const dirName of [leadName, ...(options.specialists ?? ["member"])]) {
      await writeText(path.join(root, "references", dirName, "_index.md"), `# ${dirName}\n`);
    }
    await writeText(path.join(root, "references", "shared", "_index.md"), "# shared\n");
  }

  return { leadName };
}

test("schema 2: optional _baseline.md is parsed as shared instructions and excluded from the roster", async (t) => {
  const root = await tempDir(t, "pi-persona-schema2-baseline-");
  const { leadName } = await writeSchema2Pack(root, { name: "council" });

  const source = await readPortablePersonaPack(root, { type: "path", ref: root });

  assert.deepEqual(
    new Set(source.personas.map((persona) => persona.name)),
    new Set([leadName, "member"]),
  );
  assert.ok(source.baseline);
  assert.equal(source.baseline.relativePath, "agents/_baseline.md");
  assert.match(source.baseline.body, /Shared team instructions for council/);
});

test("schema 2: materializing a pack that declares a baseline is rejected, not silently dropped", async (t) => {
  const root = await tempDir(t, "pi-persona-schema2-materialize-baseline-");
  await writeSchema2Pack(root, { name: "council" });

  const source = await readPortablePersonaPack(root, { type: "path", ref: root });
  assert.ok(source.baseline);

  assert.throws(
    () => materializePersonaPack(source),
    /persona pack 'council' declares agents\/_baseline\.md.*project-local materialization does not yet support/s,
  );
});

test("schema 2: baseline may be omitted entirely", async (t) => {
  const root = await tempDir(t, "pi-persona-schema2-no-baseline-");
  const { leadName } = await writeSchema2Pack(root, { name: "no-baseline-team", baseline: false, specialists: ["helper"] });

  const source = await readPortablePersonaPack(root, { type: "path", ref: root });
  assert.equal(source.baseline, null);
  assert.equal(source.personas.length, 2);

  // Without a baseline there is nothing to drop or collide with, so
  // materialization succeeds normally.
  const materialized = materializePersonaPack(source);
  assert.equal(materialized.has(`.pi/agents/packs/no-baseline-team/${leadName}.md`), true);
  assert.equal(materialized.has(`.pi/agents/packs/no-baseline-team/helper.md`), true);
});

test("root-aware resolution: packDocs resolve against the actual pack root's references/, docs resolve against the workspace root", async (t) => {
  const workspaceRoot = await tempDir(t, "pi-persona-root-workspace-");
  const packDir = await tempDir(t, "pi-persona-root-pack-");
  await writeSchema2Pack(packDir, { name: "root-team", specialists: ["socrates"] });

  // Use a real installed-pack layout (pack.yaml, agents/, references/) and
  // its actual root, the same root readPortablePersonaPack returns, rather
  // than a synthetic directory standing in for the pack's references root.
  const source = await readPortablePersonaPack(packDir, { type: "path", ref: packDir });
  const packRoot = source.root;
  const socrates = source.personas.find((persona) => persona.name === "socrates");

  await writeText(path.join(workspaceRoot, "library/shared/project-note.md"), "Workspace-only project note.\n");
  await writeText(path.join(packRoot, "references/socrates/method.md"), "Pack-owned method notes.\n");
  await writeText(path.join(packRoot, "references/shared/epistemic-contract.md"), "Pack-owned shared contract.\n");

  const resolved = await resolveScopedAgentDocs(
    { docs: ["library/shared/"], packDocs: socrates.packDocs },
    { workspaceRoot, packRoot },
  );

  assert.deepEqual(new Set(resolved.defaultReads), new Set([
    "library/shared/project-note.md",
    path.join(packRoot, "references/socrates/method.md"),
    path.join(packRoot, "references/socrates/_index.md"),
    path.join(packRoot, "references/shared/epistemic-contract.md"),
    path.join(packRoot, "references/shared/_index.md"),
  ]));

  const workspaceEntries = resolved.docManifest.filter((entry) => entry.origin === "workspace");
  const packEntries = resolved.docManifest.filter((entry) => entry.origin === "pack");
  assert.deepEqual(workspaceEntries.map((entry) => entry.declared), ["library/shared/"]);
  assert.deepEqual(new Set(packEntries.map((entry) => entry.declared)), new Set(["socrates/", "shared/"]));

  // Workspace reads stay workspace-relative; pack reads come back absolute.
  assert.ok(workspaceEntries.every((entry) => entry.files.every((filePath) => !path.isAbsolute(filePath))));
  assert.ok(packEntries.every((entry) => entry.files.every((filePath) => path.isAbsolute(filePath))));

  // A doc that exists only under the pack root must not leak into workspace resolution and vice versa.
  assert.ok(!resolved.defaultReads.includes("library/shared/project-note.md"
    .replace("library/shared/", path.join(packRoot, "references/socrates/"))));
});

test("root-aware resolution: pack-owned reads and their manifest/index paths stay readable from a real, different workspace cwd", async (t) => {
  const workspaceRoot = await tempDir(t, "pi-persona-cwd-workspace-");
  const packDir = await tempDir(t, "pi-persona-cwd-pack-");
  const { leadName } = await writeSchema2Pack(packDir, { name: "cwd-team", specialists: ["helper"] });

  const source = await readPortablePersonaPack(packDir, { type: "path", ref: packDir });
  const lead = source.personas.find((persona) => persona.name === leadName);

  await writeText(path.join(workspaceRoot, "library/shared/note.md"), "Workspace note.\n");

  const originalCwd = process.cwd();
  process.chdir(workspaceRoot);
  t.after(() => process.chdir(originalCwd));
  try {
    const resolved = await resolveScopedAgentDocs(
      { docs: ["library/shared/"], packDocs: lead.packDocs },
      { workspaceRoot, packRoot: source.root },
    );

    const packEntries = resolved.docManifest.filter((entry) => entry.origin === "pack");
    assert.ok(packEntries.length > 0);
    for (const entry of packEntries) {
      const expectedContent = `# ${entry.declared.replace(/\/$/, "")}\n`;
      for (const filePath of entry.files) {
        assert.ok(path.isAbsolute(filePath), `expected an absolute pack read: ${filePath}`);
        assert.equal(await readFile(filePath, "utf8"), expectedContent);
      }
      if (entry.indexFile) assert.ok(path.isAbsolute(entry.indexFile));
    }
    for (const entry of resolved.docIndexes.filter((index) => index.declared.startsWith(`${leadName}/`))) {
      assert.ok(path.isAbsolute(entry.indexFile));
      assert.equal(entry.content, `# ${leadName}\n`);
    }
  } finally {
    process.chdir(originalCwd);
  }
});

test("root-aware resolution: an optional workspace doc that is missing resolves to no reads instead of failing", async (t) => {
  const workspaceRoot = await tempDir(t, "pi-persona-root-missing-workspace-");

  const resolved = await resolveScopedAgentDocs(
    { docs: ["library/shared/not-created-yet/"], packDocs: [] },
    { workspaceRoot },
  );

  assert.deepEqual(resolved.defaultReads, []);
  assert.equal(resolved.docManifest[0].declared, "library/shared/not-created-yet/");
});

test("root-aware resolution: docs declared without a workspace root is rejected rather than silently ignored", async () => {
  await assert.rejects(
    () => resolveScopedAgentDocs({ docs: ["library/shared/"], packDocs: [] }, {}),
    /docs declared without a workspace root/,
  );
});

test("root-aware resolution: a missing packDocs reference is an honest, immediate diagnostic", async (t) => {
  const packRoot = await tempDir(t, "pi-persona-root-missing-pack-");
  await writeText(path.join(packRoot, "references/shared/_index.md"), "# shared\n");

  await assert.rejects(
    () => resolveScopedAgentDocs({ docs: [], packDocs: ["missing-specialist/"] }, { packRoot }),
    /pack reference not found: missing-specialist\/ \(missing\)/,
  );
});

test("root-aware resolution: packDocs cannot escape the pack's reference root, including through a symlink", async (t) => {
  const packRoot = await tempDir(t, "pi-persona-root-escape-pack-");
  const secret = await tempDir(t, "pi-persona-root-secret-");
  await writeText(path.join(secret, "hidden.md"), "Should never be reachable from the pack root.\n");
  await mkdir(path.join(packRoot, "references"), { recursive: true });
  await symlink(secret, path.join(packRoot, "references", "escaped"), "dir");

  await assert.rejects(
    () => resolveScopedAgentDocs({ docs: [], packDocs: ["escaped/"] }, { packRoot }),
    /pack reference not found: escaped\/ \(symlink-escape\)/,
  );

  await assert.rejects(
    () => resolveScopedAgentDocs({ docs: [], packDocs: ["../outside/"] }, { packRoot }),
    /pack reference not found: \.\.\/outside\/ \(escape\)/,
  );
});

test("root-aware resolution: packDocs may be omitted or empty, and may name a file instead of a directory", async (t) => {
  const packRoot = await tempDir(t, "pi-persona-root-file-pack-");
  await writeText(path.join(packRoot, "references/notes.md"), "A single pack-owned file, not a directory.\n");

  const omitted = await resolveScopedAgentDocs({ docs: [] }, { packRoot });
  assert.deepEqual(omitted.defaultReads, []);

  const empty = await resolveScopedAgentDocs({ docs: [], packDocs: [] }, { packRoot });
  assert.deepEqual(empty.defaultReads, []);

  const fileRef = await resolveScopedAgentDocs({ docs: [], packDocs: ["notes.md"] }, { packRoot });
  assert.deepEqual(fileRef.defaultReads, [path.join(packRoot, "references/notes.md")]);
});

test("pack-source: packDocs declared without a pack reference root is rejected rather than silently ignored", async () => {
  await assert.rejects(
    () => resolveScopedAgentDocs({ docs: [], packDocs: ["socrates/"] }, {}),
    /packDocs declared without a pack reference root/,
  );
});

test("schema 2 pack authoring: a missing declared packDocs reference fails at read time", async (t) => {
  const root = await tempDir(t, "pi-persona-schema2-missing-ref-");
  await writeSchema2Pack(root, {
    name: "broken-team",
    specialists: ["ghost"],
    references: false,
  });
  // Only create the lead's and shared references; leave the specialist's missing.
  const leadName = "broken-team-lead";
  await writeText(path.join(root, "references", leadName, "_index.md"), `# ${leadName}\n`);
  await writeText(path.join(root, "references", "shared", "_index.md"), "# shared\n");

  await assert.rejects(
    () => readPortablePersonaPack(root, { type: "path", ref: root }),
    /packDocs reference not found: ghost\//,
  );
});

test("schema 2 pack authoring: duplicate persona names within one pack are rejected", async (t) => {
  const root = await tempDir(t, "pi-persona-schema2-dup-name-");
  const { leadName } = await writeSchema2Pack(root, { name: "clashing-team", specialists: ["member"] });
  // Overwrite the specialist file so it declares the same name as the lead.
  await writeText(
    path.join(root, "agents/member.md"),
    schema2Agent(leadName, "specialist"),
  );

  await assert.rejects(
    () => readPortablePersonaPack(root, { type: "path", ref: root }),
    /duplicate persona name/,
  );
});

test("schema 2 pack authoring: packDocs may name any of the pack's own content, with no mandatory pair", async (t) => {
  const root = await tempDir(t, "pi-persona-schema2-extra-refs-");
  await writeSchema2Pack(root, {
    name: "cross-ref-team",
    specialists: ["helper", "researcher"],
    specialistSources: {
      // helper additionally references the researcher's own pack folder; this
      // stays inside the pack's reference root, so it is not a trust/data
      // boundary violation and should not be handcuffed by an allowlist.
      helper: schema2Agent("helper", "specialist", { packDocs: ["helper/", "shared/", "researcher/"] }),
    },
  });

  const source = await readPortablePersonaPack(root, { type: "path", ref: root });
  const helper = source.personas.find((persona) => persona.name === "helper");
  assert.deepEqual(helper.packDocs, ["helper/", "shared/", "researcher/"]);
});

test("schema 2 pack authoring: packDocs is optional — omitted or empty is a valid persona", async (t) => {
  const root = await tempDir(t, "pi-persona-schema2-no-packdocs-");
  await writeSchema2Pack(root, { name: "unscoped-team", specialists: ["quiet", "explicit-empty"] });
  // Overwrite the two specialists: one with no packDocs key at all, one with
  // an explicit empty list. Both must be as valid as declaring references.
  await writeText(
    path.join(root, "agents/quiet.md"),
    `---
name: quiet
role: specialist
description: quiet specialist.
---
quiet prompt body.
`,
  );
  await writeText(
    path.join(root, "agents/explicit-empty.md"),
    `---
name: explicit-empty
role: specialist
description: explicit-empty specialist.
packDocs: []
---
explicit-empty prompt body.
`,
  );

  const source = await readPortablePersonaPack(root, { type: "path", ref: root });
  const quiet = source.personas.find((persona) => persona.name === "quiet");
  const explicitEmpty = source.personas.find((persona) => persona.name === "explicit-empty");
  assert.deepEqual(quiet.packDocs, []);
  assert.deepEqual(explicitEmpty.packDocs, []);
});

test("schema 2 pack authoring: a packDocs entry may name a single file instead of only a directory", async (t) => {
  const root = await tempDir(t, "pi-persona-schema2-file-ref-");
  await writeSchema2Pack(root, {
    name: "file-ref-team",
    specialists: ["helper"],
    specialistSources: {
      helper: schema2Agent("helper", "specialist", { packDocs: ["notes.md"] }),
    },
  });
  await writeText(path.join(root, "references", "notes.md"), "A single pack-owned reference file.\n");

  const source = await readPortablePersonaPack(root, { type: "path", ref: root });
  const helper = source.personas.find((persona) => persona.name === "helper");
  assert.deepEqual(helper.packDocs, ["notes.md"]);
});

test("schema 2: the same persona name in two independent inactive packs does not conflict", async (t) => {
  const rootA = await tempDir(t, "pi-persona-schema2-inactive-a-");
  const rootB = await tempDir(t, "pi-persona-schema2-inactive-b-");
  await writeSchema2Pack(rootA, { name: "team-a", specialists: ["shared-name"] });
  await writeSchema2Pack(rootB, { name: "team-b", specialists: ["shared-name"] });

  const sourceA = await readPortablePersonaPack(rootA, { type: "path", ref: rootA });
  const sourceB = await readPortablePersonaPack(rootB, { type: "path", ref: rootB });

  assert.ok(sourceA.personas.some((persona) => persona.name === "shared-name"));
  assert.ok(sourceB.personas.some((persona) => persona.name === "shared-name"));
  assert.equal(sourceA.manifest.name, "team-a");
  assert.equal(sourceB.manifest.name, "team-b");
});

test("schema 2: configure.md need not be non-empty (no mandatory configuration completion)", async (t) => {
  const root = await tempDir(t, "pi-persona-schema2-empty-configure-");
  await writeSchema2Pack(root, { name: "quiet-team", specialists: ["helper"], configure: "" });

  const source = await readPortablePersonaPack(root, { type: "path", ref: root });
  assert.equal(source.manifest.schema, 2);
});

test("schema 1 is not silently reinterpreted as schema 2", async (t) => {
  const root = await tempDir(t, "pi-persona-schema1-strict-");
  await writeText(path.join(root, "pack.yaml"), [
    "schema: 1",
    "name: legacy-team",
    "version: 1.0.0",
    "description: Legacy schema 1 test pack.",
  ].join("\n") + "\n");
  // Schema 1 still requires a non-empty configuration guide.
  await writeText(path.join(root, "configure.md"), "");
  await writeText(
    path.join(root, "agents/legacy-lead.md"),
    `---
name: legacy-lead
role: generalist
description: Legacy lead.
packDocs:
  - legacy-lead/
  - shared/
---
Legacy lead prompt.
`,
  );
  await writeText(path.join(root, "references/legacy-lead/_index.md"), "# legacy-lead\n");
  await writeText(path.join(root, "references/shared/_index.md"), "# shared\n");

  // Empty configure.md is still mandatory under schema 1.
  await assert.rejects(
    () => readPortablePersonaPack(root, { type: "path", ref: root }),
    /configuration guide must not be empty/,
  );

  await writeText(path.join(root, "configure.md"), "# Configure legacy-team\n");

  // A schema 1 persona declaring only packDocs (no mandatory workspace docs) is still rejected;
  // schema 1's mandatory `docs` requirement is not satisfied by a schema 2 field.
  await assert.rejects(
    () => readPortablePersonaPack(root, { type: "path", ref: root }),
    /pack persona must declare its personal library/,
  );

  // An unsupported schema value fails clearly instead of falling back to schema 1 or 2.
  await writeText(path.join(root, "pack.yaml"), [
    "schema: 3",
    "name: legacy-team",
    "version: 1.0.0",
    "description: Legacy schema 1 test pack.",
  ].join("\n") + "\n");
  await assert.rejects(
    () => readPortablePersonaPack(root, { type: "path", ref: root }),
    /unsupported pack schema '3'/,
  );
});

test("schema 1 still forbids control agent files (no schema 2 baseline leniency)", async (t) => {
  const root = await tempDir(t, "pi-persona-schema1-no-baseline-");
  await writeText(path.join(root, "pack.yaml"), [
    "schema: 1",
    "name: legacy-strict-team",
    "version: 1.0.0",
    "description: Legacy schema 1 pack rejecting control files.",
  ].join("\n") + "\n");
  await writeText(path.join(root, "configure.md"), "# Configure\n");
  await writeText(path.join(root, "agents/_baseline.md"), "---\n---\nShared.\n");
  await writeText(
    path.join(root, "agents/lead.md"),
    `---
name: lead
role: generalist
description: Lead.
docs:
  - library/personal/lead/
  - library/shared/legacy-strict-team/
---
Lead prompt.
`,
  );
  await writeText(path.join(root, "references/lead/_index.md"), "# lead\n");
  await writeText(path.join(root, "references/shared/_index.md"), "# shared\n");

  await assert.rejects(
    () => readPortablePersonaPack(root, { type: "path", ref: root }),
    /persona packs cannot contain control agent files/,
  );
});

test("resolveAgentScope keeps its single-root default behavior unchanged", async (t) => {
  const root = await tempDir(t, "pi-persona-resolver-default-");
  await writeText(path.join(root, ".pi/agents/_baseline.md"), `---
docs:
  - library/shared/
skills: []
---
Shared baseline.
`);
  await writeText(path.join(root, ".pi/agents/solo.md"), `---
name: solo
role: generalist
description: Solo generalist.
docs:
  - library/personal/solo/
skills: []
---
Solo prompt.
`);
  await writeText(path.join(root, "library/shared/note.md"), "Shared note.\n");
  await writeText(path.join(root, "library/personal/solo/note.md"), "Personal note.\n");

  const scope = await resolveAgentScope(root, "solo");
  assert.deepEqual(new Set(scope.derived.defaultReads), new Set([
    "library/shared/note.md",
    "library/personal/solo/note.md",
  ]));
});

test("bundled philosopher-7 converted to schema 2 preserves its roster and prompts", async () => {
  const packs = await listBundledPersonaPacks();
  const philosopher = packs.find((pack) => pack.manifest.name === "philosopher-7");
  assert.equal(philosopher.manifest.schema, 2);
  assert.equal(philosopher.baseline, null);
  assert.deepEqual(
    new Set(philosopher.personas.map((persona) => persona.name)),
    new Set(["symposium", "socrates", "descartes", "kant", "hume", "aristotle", "hegel", "plato"]),
  );
  for (const persona of philosopher.personas) {
    assert.deepEqual(persona.packDocs, [`${persona.name}/`, "shared/"]);
  }
});

// ---- Task 3: global official/custom store ----

async function officialCatalogSource() {
  return loadPersonaPackSource("/unused-root-for-bundled-lookup", "philosopher-7");
}

async function customPackSourceFrom(root, options) {
  await writeSchema2Pack(root, options);
  return readPortablePersonaPack(root, { type: "path", ref: root });
}

function revisedLeadSource(name) {
  return `---
name: ${name}
role: generalist
description: ${name} generalist, revised.
packDocs:
  - ${name}/
  - shared/
---
${name} prompt body, revised.
`;
}

test("global store: installing an official pack writes self-contained content and changes no selection state", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-store-install-");
  const source = await officialCatalogSource();

  const result = await installOfficialPersonaPack(storeRoot, source);
  assert.equal(result.qualifiedName, "official/philosopher-7");

  const installed = await readPortablePersonaPack(path.join(storeRoot, "official/philosopher-7"), { type: "installed" });
  assert.equal(installed.manifest.name, "philosopher-7");
  assert.equal(installed.personas.length, 8);
  await readFile(path.join(storeRoot, "official/philosopher-7/pack.yaml"), "utf8");

  // Install is filesystem-only: nothing named after selection/default/session exists.
  assert.equal(await pathExistsForTest(path.join(storeRoot, "selection.json")), false);
});

test("global store: install does not overwrite an already-installed official pack", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-store-no-overwrite-");
  const source = await officialCatalogSource();
  await installOfficialPersonaPack(storeRoot, source);

  await assert.rejects(
    () => installOfficialPersonaPack(storeRoot, source),
    /already installed/,
  );

  const stillInstalled = await readPortablePersonaPack(path.join(storeRoot, "official/philosopher-7"), { type: "installed" });
  assert.equal(stillInstalled.personas.length, 8);
});

test("global store: listing reflects installed content, not the bundled catalog", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-store-list-vs-catalog-");
  assert.deepEqual(await listGlobalPersonaPacks(storeRoot), { official: [], custom: [] });

  const catalog = await listBundledPersonaPacks();
  assert.ok(catalog.some((pack) => pack.manifest.name === "philosopher-7"));

  await installOfficialPersonaPack(storeRoot, await officialCatalogSource());
  const { official, custom } = await listGlobalPersonaPacks(storeRoot);
  assert.deepEqual(custom, []);
  assert.equal(official.length, 1);
  assert.equal(official[0].qualifiedName, "official/philosopher-7");
  assert.equal(official[0].edited, false);
});

test("global store: create/edit flows through an inactive draft; drafts are never listed", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-store-draft-create-");
  const contentRoot = await tempDir(t, "pi-persona-store-draft-content-");
  const source = await customPackSourceFrom(contentRoot, { name: "council" });

  await stageCustomPersonaPackDraft(storeRoot, "council", source);
  // Staged but not applied: invisible to listing, no custom/council yet.
  assert.deepEqual((await listGlobalPersonaPacks(storeRoot)).custom, []);
  assert.equal(await pathExistsForTest(path.join(storeRoot, "custom/council")), false);

  const applied = await applyCustomPersonaPackDraft(storeRoot, "council");
  assert.equal(applied.qualifiedName, "custom/council");
  assert.equal(await pathExistsForTest(path.join(storeRoot, "drafts/council")), false);

  const installed = await readPortablePersonaPack(path.join(storeRoot, "custom/council"), { type: "installed" });
  assert.ok(installed.baseline, "self-contained custom pack keeps its baseline");
  await readFile(path.join(storeRoot, "custom/council/references/shared/_index.md"), "utf8");

  const { custom } = await listGlobalPersonaPacks(storeRoot);
  assert.equal(custom.length, 1);
  assert.equal(custom[0].qualifiedName, "custom/council");
});

test("global store: preview reports the diff against active content; cancel leaves it untouched", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-store-preview-cancel-");
  const originalRoot = await tempDir(t, "pi-persona-store-preview-original-");
  const editedRoot = await tempDir(t, "pi-persona-store-preview-edited-");

  const original = await customPackSourceFrom(originalRoot, { name: "council" });
  await stageCustomPersonaPackDraft(storeRoot, "council", original);
  await applyCustomPersonaPackDraft(storeRoot, "council");

  const edited = await customPackSourceFrom(editedRoot, {
    name: "council",
    leadSource: revisedLeadSource("council-lead"),
  });
  await stageCustomPersonaPackDraft(storeRoot, "council", edited);

  const preview = await previewCustomPersonaPackDraft(storeRoot, "council");
  assert.equal(preview.isNew, false);
  assert.ok(preview.diff.changed.includes("agents/council-lead.md"));

  await cancelCustomPersonaPackDraft(storeRoot, "council");
  assert.equal(await pathExistsForTest(path.join(storeRoot, "drafts/council")), false);

  const stillOriginal = await readPortablePersonaPack(path.join(storeRoot, "custom/council"), { type: "installed" });
  const lead = stillOriginal.personas.find((persona) => persona.description.includes("revised"));
  assert.equal(lead, undefined, "cancelled draft must not affect active custom content");
});

test("global store: apply re-validates a tampered draft; active content stays untouched", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-store-tampered-draft-");
  const contentRoot = await tempDir(t, "pi-persona-store-tampered-content-");
  const source = await customPackSourceFrom(contentRoot, { name: "council" });
  await stageCustomPersonaPackDraft(storeRoot, "council", source);
  await applyCustomPersonaPackDraft(storeRoot, "council");

  const editedRoot = await tempDir(t, "pi-persona-store-tampered-edit-");
  const edited = await customPackSourceFrom(editedRoot, { name: "council" });
  await stageCustomPersonaPackDraft(storeRoot, "council", edited);
  // Corrupt the staged draft directly on disk after staging.
  await rm(path.join(storeRoot, "drafts/council/pack.yaml"));

  await assert.rejects(() => applyCustomPersonaPackDraft(storeRoot, "council"));

  // The draft is preserved for retry; active content is untouched.
  assert.equal(await pathExistsForTest(path.join(storeRoot, "drafts/council")), true);
  const stillActive = await readPortablePersonaPack(path.join(storeRoot, "custom/council"), { type: "installed" });
  assert.equal(stillActive.manifest.name, "council");
});

test("global store: fork requires an independent, not-yet-existing custom name and excludes install bookkeeping", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-store-fork-");
  await installOfficialPersonaPack(storeRoot, await officialCatalogSource());

  const forked = await forkPersonaPack(storeRoot, "official/philosopher-7", "philosopher-7");
  assert.equal(forked.qualifiedName, "custom/philosopher-7");

  // Official and custom packs of the same name coexist without conflict.
  const { official, custom } = await listGlobalPersonaPacks(storeRoot);
  assert.equal(official[0].qualifiedName, "official/philosopher-7");
  assert.equal(custom[0].qualifiedName, "custom/philosopher-7");

  // A second fork into the same custom name is rejected without altering it.
  await assert.rejects(
    () => forkPersonaPack(storeRoot, "official/philosopher-7", "philosopher-7"),
    /already exists/,
  );

  // Forking does not carry official install bookkeeping (base hash / source ref) into the custom copy.
  const customMeta = JSON.parse(await readFile(path.join(storeRoot, "custom/philosopher-7.meta.json"), "utf8"));
  assert.equal(customMeta.forkedFrom, "official/philosopher-7");
  assert.equal(Object.hasOwn(customMeta, "baseHash"), false);
});

test("global store: official pack edits are hash-detected and block update until acknowledged", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-store-drift-");
  await installOfficialPersonaPack(storeRoot, await officialCatalogSource());

  const socratesPath = path.join(storeRoot, "official/philosopher-7/agents/socrates.md");
  const original = await readFile(socratesPath, "utf8");
  await writeFile(socratesPath, `${original}\nLocally added line.\n`, "utf8");

  await assert.rejects(
    async () => updateOfficialPersonaPack(storeRoot, await officialCatalogSource()),
    /local edits/,
  );
  // Blocked update must not touch the local edit.
  assert.match(await readFile(socratesPath, "utf8"), /Locally added line\./);

  const result = await updateOfficialPersonaPack(storeRoot, await officialCatalogSource(), { discardLocalEdits: true });
  assert.equal(result.discardedLocalEdits, true);
  assert.doesNotMatch(await readFile(socratesPath, "utf8"), /Locally added line\./);
});

test("global store: concurrent mutation is rejected rather than corrupting the store", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-store-concurrent-");
  await mkdir(storeRoot, { recursive: true });
  const lockHandle = await open(path.join(storeRoot, ".mutation.lock"), "wx");
  t.after(() => lockHandle.close().catch(() => {}));

  await assert.rejects(
    async () => installOfficialPersonaPack(storeRoot, await officialCatalogSource()),
    /another persona pack store operation is in progress/,
  );
  assert.equal(await pathExistsForTest(path.join(storeRoot, "official/philosopher-7")), false);
});

test("global store: a lock left by a process that died is cleared; a live owner's lock still blocks", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-store-stale-lock-");
  await mkdir(storeRoot, { recursive: true });
  const lockFile = path.join(storeRoot, ".mutation.lock");
  const { spawnSync } = await import("node:child_process");
  const deadPid = spawnSync(process.execPath, ["-e", "0"]).pid;

  await writeFile(lockFile, `${JSON.stringify({ pid: process.ppid })}\n`, "utf8");
  await assert.rejects(
    async () => installOfficialPersonaPack(storeRoot, await officialCatalogSource()),
    /another persona pack store operation is in progress/,
  );
  assert.equal(await pathExistsForTest(lockFile), true, "a live owner's lock is never removed");

  await writeFile(lockFile, `${JSON.stringify({ pid: deadPid })}\n`, "utf8");
  const result = await installOfficialPersonaPack(storeRoot, await officialCatalogSource());
  assert.equal(result.qualifiedName, "official/philosopher-7");
  assert.equal(await pathExistsForTest(lockFile), false, "the stale lock is gone and the new one released");
});

test("global store: a failed replacement recovers the original content", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-store-recovery-");
  const originalRoot = await tempDir(t, "pi-persona-store-recovery-original-");
  const original = await customPackSourceFrom(originalRoot, { name: "council" });
  await stageCustomPersonaPackDraft(storeRoot, "council", original);
  await applyCustomPersonaPackDraft(storeRoot, "council");

  const editedRoot = await tempDir(t, "pi-persona-store-recovery-edited-");
  const edited = await customPackSourceFrom(editedRoot, {
    name: "council",
    leadSource: revisedLeadSource("council-lead"),
  });
  await stageCustomPersonaPackDraft(storeRoot, "council", edited);

  // Deny write access to custom/ so the replace's evacuating rename fails
  // before anything is moved, then confirm recovery once access returns.
  const customParent = path.join(storeRoot, "custom");
  await chmod(customParent, 0o555);
  try {
    await assert.rejects(() => applyCustomPersonaPackDraft(storeRoot, "council"));
  } finally {
    await chmod(customParent, 0o755);
  }

  const recovered = await readPortablePersonaPack(path.join(storeRoot, "custom/council"), { type: "installed" });
  const lead = recovered.personas.find((persona) => persona.description.includes("revised"));
  assert.equal(lead, undefined, "original content must survive a failed replacement");
});

test("global store: a symlinked destination segment is rejected, not followed", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-store-dest-symlink-");
  const elsewhere = await tempDir(t, "pi-persona-store-dest-elsewhere-");
  await mkdir(storeRoot, { recursive: true });
  await symlink(elsewhere, path.join(storeRoot, "official"), "dir");

  await assert.rejects(
    async () => installOfficialPersonaPack(storeRoot, await officialCatalogSource()),
    /symbolic links are not supported in the persona pack store/,
  );
  assert.equal(await pathExistsForTest(path.join(elsewhere, "philosopher-7")), false);
});

test("global store: pack names reject path traversal", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-store-traversal-");
  await installOfficialPersonaPack(storeRoot, await officialCatalogSource());

  await assert.rejects(
    () => forkPersonaPack(storeRoot, "official/philosopher-7", "../escaped"),
    /must begin with a lowercase letter/,
  );
  await assert.rejects(
    () => forkPersonaPack(storeRoot, "official/../../etc", "copy"),
    /qualified persona pack identity must be 'official\/<name>' or 'custom\/<name>'/,
  );
});

test("global store: operations touch only the given storeRoot, never a sibling root", async (t) => {
  const storeRootA = await tempDir(t, "pi-persona-store-root-a-");
  const storeRootB = await tempDir(t, "pi-persona-store-root-b-");

  await installOfficialPersonaPack(storeRootA, await officialCatalogSource());

  assert.deepEqual(await listGlobalPersonaPacks(storeRootB), { official: [], custom: [] });
  assert.equal(await pathExistsForTest(path.join(storeRootB, "official")), false);
});

test("global store: uninstall and delete remove the pack directory and its metadata sidecar", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-store-remove-");
  await installOfficialPersonaPack(storeRoot, await officialCatalogSource());
  await forkPersonaPack(storeRoot, "official/philosopher-7", "philosopher-7-fork");

  await uninstallOfficialPersonaPack(storeRoot, "philosopher-7");
  assert.equal(await pathExistsForTest(path.join(storeRoot, "official/philosopher-7")), false);
  assert.equal(await pathExistsForTest(path.join(storeRoot, "official/philosopher-7.meta.json")), false);

  await deleteCustomPersonaPack(storeRoot, "philosopher-7-fork");
  assert.equal(await pathExistsForTest(path.join(storeRoot, "custom/philosopher-7-fork")), false);
  assert.equal(await pathExistsForTest(path.join(storeRoot, "custom/philosopher-7-fork.meta.json")), false);

  await assert.rejects(() => uninstallOfficialPersonaPack(storeRoot, "philosopher-7"), /not installed/);
  await assert.rejects(() => deleteCustomPersonaPack(storeRoot, "philosopher-7-fork"), /not installed/);
});

// ---- AGY findings: recovery, identity, and concurrency regressions ----

test("global store: schema 2 packs support a physically absent configure.md end-to-end", async (t) => {
  const root = await tempDir(t, "pi-persona-schema2-missing-configure-");
  await writeSchema2Pack(root, { name: "no-configure-team", specialists: ["helper"] });
  await rm(path.join(root, "configure.md"));

  const source = await readPortablePersonaPack(root, { type: "path", ref: root });
  assert.equal(source.manifest.schema, 2);
  assert.equal(source.files.has("configure.md"), false);

  const storeRoot = await tempDir(t, "pi-persona-store-missing-configure-");
  await stageCustomPersonaPackDraft(storeRoot, "no-configure-team", source);
  await applyCustomPersonaPackDraft(storeRoot, "no-configure-team");
  assert.equal(await pathExistsForTest(path.join(storeRoot, "custom/no-configure-team/configure.md")), false);

  const installed = await readPortablePersonaPack(path.join(storeRoot, "custom/no-configure-team"), { type: "installed" });
  assert.equal(installed.files.has("configure.md"), false);

  const { custom } = await listGlobalPersonaPacks(storeRoot);
  assert.equal(custom.find((pack) => pack.name === "no-configure-team")?.manifest.schema, 2);

  const forked = await forkPersonaPack(storeRoot, "custom/no-configure-team", "no-configure-team-fork");
  assert.equal(forked.qualifiedName, "custom/no-configure-team-fork");
  assert.equal(await pathExistsForTest(path.join(storeRoot, "custom/no-configure-team-fork/configure.md")), false);
});

test("global store: schema 1 still requires configure.md to physically exist, not just be non-empty", async (t) => {
  const root = await tempDir(t, "pi-persona-schema1-missing-configure-");
  await writeText(path.join(root, "pack.yaml"), [
    "schema: 1",
    "name: legacy-team",
    "version: 1.0.0",
    "description: Legacy schema 1 test pack.",
  ].join("\n") + "\n");
  await writeText(
    path.join(root, "agents/legacy-lead.md"),
    `---
name: legacy-lead
role: generalist
description: Legacy lead.
docs:
  - library/personal/legacy-lead/
  - library/shared/legacy-team/
---
Legacy lead prompt.
`,
  );
  await writeText(path.join(root, "references/legacy-lead/_index.md"), "# legacy-lead\n");
  await writeText(path.join(root, "references/shared/_index.md"), "# shared\n");

  await assert.rejects(
    () => readPortablePersonaPack(root, { type: "path", ref: root }),
    /missing required configure\.md/,
  );
});

test("global store: a qualified pack identity with extra path segments is rejected, not silently truncated to its first two components", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-store-qualified-extra-");
  await installOfficialPersonaPack(storeRoot, await officialCatalogSource());

  await assert.rejects(
    () => forkPersonaPack(storeRoot, "official/philosopher-7/extra", "extra-fork"),
    /qualified persona pack identity must be 'official\/<name>' or 'custom\/<name>'/,
  );
  // Confirm it was actually rejected, not silently resolved against 'official/philosopher-7'.
  assert.equal(await pathExistsForTest(path.join(storeRoot, "custom/extra-fork")), false);
});

test("global store: forking under a different name rewrites the manifest identity via the YAML parser, not regex", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-store-fork-rename-");
  await installOfficialPersonaPack(storeRoot, await officialCatalogSource());

  const forked = await forkPersonaPack(storeRoot, "official/philosopher-7", "philosopher-8");
  assert.equal(forked.qualifiedName, "custom/philosopher-8");

  const installed = await readPortablePersonaPack(path.join(storeRoot, "custom/philosopher-8"), { type: "installed" });
  assert.equal(installed.manifest.name, "philosopher-8");
  assert.equal(installed.personas.length, 8);

  const rawManifest = await readFile(path.join(storeRoot, "custom/philosopher-8/pack.yaml"), "utf8");
  assert.match(rawManifest, /^name: philosopher-8$/m);
  // Other manifest fields and formatting survive an in-place YAML edit rather than a hand-rolled regex rewrite.
  assert.match(rawManifest, /^schema: 2$/m);
  assert.match(rawManifest, /^version: \d+\.\d+\.\d+$/m);

  // Listing reflects the parsed (not merely directory-named) identity.
  const { custom } = await listGlobalPersonaPacks(storeRoot);
  assert.equal(custom.find((pack) => pack.name === "philosopher-8").manifest.name, "philosopher-8");
});

test("global store: staging a draft under a name that doesn't match its own manifest identity is rejected explicitly", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-store-draft-identity-");
  const contentRoot = await tempDir(t, "pi-persona-store-draft-identity-content-");
  const source = await customPackSourceFrom(contentRoot, { name: "council" });

  await assert.rejects(
    () => stageCustomPersonaPackDraft(storeRoot, "senate", source),
    /persona pack draft name mismatch.*'senate'.*'council'/s,
  );
  assert.equal(await pathExistsForTest(path.join(storeRoot, "drafts/senate")), false);
});

test("global store: preview for a brand-new draft reports every file as added instead of a null diff", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-store-preview-new-");
  const contentRoot = await tempDir(t, "pi-persona-store-preview-new-content-");
  const source = await customPackSourceFrom(contentRoot, { name: "brand-new" });

  await stageCustomPersonaPackDraft(storeRoot, "brand-new", source);
  const preview = await previewCustomPersonaPackDraft(storeRoot, "brand-new");

  assert.equal(preview.isNew, true);
  assert.ok(preview.diff, "a new pack should still report a diff shape, not null");
  assert.deepEqual(preview.diff.changed, []);
  assert.deepEqual(preview.diff.removed, []);
  assert.ok(preview.diff.added.includes("pack.yaml"));
  assert.ok(preview.diff.added.includes("configure.md"));
});

test("global store: the mutation lock file is removed if it is created but writing to it fails (no stuck store)", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-store-lock-write-fail-");
  await mkdir(storeRoot, { recursive: true });

  await assert.rejects(
    () => __withFsHookForTesting({
      open: async (...args) => {
        const handle = await open(...args);
        return {
          writeFile: async () => {
            await handle.close();
            throw Object.assign(new Error("simulated disk full while writing the lock file"), { code: "ENOSPC" });
          },
          close: async () => {},
        };
      },
    }, async () => installOfficialPersonaPack(storeRoot, await officialCatalogSource())),
    /simulated disk full while writing the lock file/,
  );

  assert.equal(await pathExistsForTest(path.join(storeRoot, ".mutation.lock")), false);
  // The store is not stuck: a subsequent operation succeeds normally.
  await installOfficialPersonaPack(storeRoot, await officialCatalogSource());
});

test("global store: a deterministic swap-in rename failure (not just an evacuation failure) still recovers the original content", async (t) => {
  // The existing recovery test denies write access before anything moves,
  // so the first rename fails and nothing was ever at risk — that proves
  // the "nothing moved yet" branch, not that a torn swap-in actually rolls
  // back. This test fails the *second* rename deterministically instead.
  const storeRoot = await tempDir(t, "pi-persona-store-second-rename-fail-");
  const originalRoot = await tempDir(t, "pi-persona-store-second-rename-original-");
  const original = await customPackSourceFrom(originalRoot, { name: "council" });
  await stageCustomPersonaPackDraft(storeRoot, "council", original);
  await applyCustomPersonaPackDraft(storeRoot, "council");

  const editedRoot = await tempDir(t, "pi-persona-store-second-rename-edited-");
  const edited = await customPackSourceFrom(editedRoot, {
    name: "council",
    leadSource: revisedLeadSource("council-lead"),
  });
  await stageCustomPersonaPackDraft(storeRoot, "council", edited);

  let renameCalls = 0;
  await assert.rejects(
    () => __withFsHookForTesting({
      rename: async (from, to) => {
        renameCalls += 1;
        // Call 1: evacuate custom/council -> backup (let it succeed).
        // Call 2: staging -> custom/council, the swap-in itself (fail it).
        if (renameCalls === 2) {
          throw Object.assign(new Error("simulated swap-in rename failure"), { code: "EIO" });
        }
        return rename(from, to);
      },
    }, () => applyCustomPersonaPackDraft(storeRoot, "council")),
    /simulated swap-in rename failure/,
  );
  assert.equal(renameCalls, 3, "the swap-in failure must trigger exactly one rollback rename attempt");

  // No leftover temp staging/backup directories after a successful rollback.
  const leftovers = (await readdir(storeRoot)).filter((entry) => entry.startsWith(".pack-"));
  assert.deepEqual(leftovers, []);

  const recovered = await readPortablePersonaPack(path.join(storeRoot, "custom/council"), { type: "installed" });
  const lead = recovered.personas.find((persona) => persona.description.includes("revised"));
  assert.equal(lead, undefined, "original content must survive a failed swap-in rename, not just a failed evacuation");

  // The draft is preserved for retry, exactly like the tampered-draft case.
  assert.equal(await pathExistsForTest(path.join(storeRoot, "drafts/council")), true);
});

test("global store: a swap-in failure whose rollback also fails preserves the backup and reports its exact recovery path", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-store-rollback-fail-");
  const originalRoot = await tempDir(t, "pi-persona-store-rollback-original-");
  const original = await customPackSourceFrom(originalRoot, { name: "council" });
  await stageCustomPersonaPackDraft(storeRoot, "council", original);
  await applyCustomPersonaPackDraft(storeRoot, "council");

  const editedRoot = await tempDir(t, "pi-persona-store-rollback-edited-");
  const edited = await customPackSourceFrom(editedRoot, {
    name: "council",
    leadSource: revisedLeadSource("council-lead"),
  });
  await stageCustomPersonaPackDraft(storeRoot, "council", edited);

  let renameCalls = 0;
  let capturedBackupPath;
  await assert.rejects(
    () => __withFsHookForTesting({
      rename: async (from, to) => {
        renameCalls += 1;
        if (renameCalls === 1) return rename(from, to); // evacuate: succeeds
        if (renameCalls === 2) {
          throw Object.assign(new Error("simulated swap-in rename failure"), { code: "EIO" });
        }
        // Call 3: the rollback attempt (backupTarget -> targetDir). Fail it too.
        capturedBackupPath = from;
        throw Object.assign(new Error("simulated rollback rename failure"), { code: "EIO" });
      },
    }, () => applyCustomPersonaPackDraft(storeRoot, "council")),
    (error) => {
      assert.match(error.message, /simulated swap-in rename failure/);
      assert.match(error.message, /simulated rollback rename failure/);
      assert.match(error.message, /preserved at/);
      assert.ok(error.message.includes(capturedBackupPath), "error must name the exact recovery path");
      assert.equal(error.backupPath, capturedBackupPath);
      return true;
    },
  );

  assert.ok(capturedBackupPath, "the rollback attempt must have been observed");
  // The previous content must not have been deleted: it is still recoverable from the reported path.
  const preserved = await readPortablePersonaPack(capturedBackupPath, { type: "installed" });
  const lead = preserved.personas.find((persona) => persona.description.includes("revised"));
  assert.equal(lead, undefined, "the pre-replacement content must still be fully intact at the reported backup path");
  assert.equal(preserved.manifest.name, "council");

  // The draft is preserved too, since apply never got to remove it.
  assert.equal(await pathExistsForTest(path.join(storeRoot, "drafts/council")), true);
});

test("global store: a failed metadata write during install rolls the content back, leaving nothing installed", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-store-install-meta-fail-");

  await assert.rejects(
    () => __withFsHookForTesting({
      writeFile: async (filePath, ...rest) => {
        if (String(filePath).includes(".meta.json.")) {
          throw Object.assign(new Error("simulated metadata write failure"), { code: "ENOSPC" });
        }
        return writeFile(filePath, ...rest);
      },
    }, async () => installOfficialPersonaPack(storeRoot, await officialCatalogSource())),
    /simulated metadata write failure/,
  );

  // Content and metadata are a coherent pair, not a "content first, metadata
  // best-effort" sequence: a failed metadata write rolls the just-landed
  // content back too, so nothing is left half-installed.
  assert.equal(await pathExistsForTest(path.join(storeRoot, "official/philosopher-7")), false);
  assert.equal(await pathExistsForTest(path.join(storeRoot, "official/philosopher-7.meta.json")), false);
  const leftovers = (await readdir(storeRoot)).filter((entry) => entry.startsWith(".pack-"));
  assert.deepEqual(leftovers, []);

  // The store is not stuck: install can be retried cleanly from scratch.
  const result = await installOfficialPersonaPack(storeRoot, await officialCatalogSource());
  assert.equal(result.qualifiedName, "official/philosopher-7");
});

test("global store: a failed metadata write during update restores the previous content and metadata together, not a torn pair", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-store-update-meta-fail-");
  await installOfficialPersonaPack(storeRoot, await officialCatalogSource());

  const metaPath = path.join(storeRoot, "official/philosopher-7.meta.json");
  const originalMeta = await readFile(metaPath, "utf8");

  // A "new version" of the bundled source with different content but the
  // same declared identity: revise one installed agent file's body so the
  // update is actually observable, then read it back as a fresh source.
  const revisedRoot = await tempDir(t, "pi-persona-store-update-meta-fail-source-");
  await cp(path.join(storeRoot, "official/philosopher-7"), revisedRoot, { recursive: true });
  const socratesPath = path.join(revisedRoot, "agents/socrates.md");
  await writeFile(socratesPath, `${await readFile(socratesPath, "utf8")}\nRevised body.\n`, "utf8");
  const revisedSource = await readPortablePersonaPack(revisedRoot, { type: "bundled", ref: "philosopher-7" });

  await assert.rejects(
    () => __withFsHookForTesting({
      writeFile: async (filePath, ...rest) => {
        if (String(filePath).includes(".meta.json.")) {
          throw Object.assign(new Error("simulated metadata write failure"), { code: "ENOSPC" });
        }
        return writeFile(filePath, ...rest);
      },
    }, async () => updateOfficialPersonaPack(storeRoot, revisedSource)),
    /simulated metadata write failure/,
  );

  // Content is rolled back to the pre-update version, not left as the
  // revised version paired with stale metadata.
  const content = await readPortablePersonaPack(path.join(storeRoot, "official/philosopher-7"), { type: "installed" });
  assert.ok(
    !content.files.get("agents/socrates.md").toString("utf8").includes("Revised body."),
    "content must be rolled back to the pre-update version, not left as the half-applied update",
  );
  // Metadata is untouched too: the old content+metadata pair is coherent.
  assert.equal(await readFile(metaPath, "utf8"), originalMeta);
  const leftovers = (await readdir(path.join(storeRoot, "official"))).filter((entry) => entry.startsWith(".pack-"));
  assert.deepEqual(leftovers, []);

  // The store is not stuck: a subsequent update (without the injected
  // fault) succeeds and actually lands the new content this time.
  const updated = await updateOfficialPersonaPack(storeRoot, revisedSource);
  assert.equal(updated.qualifiedName, "official/philosopher-7");
  const updatedContent = await readPortablePersonaPack(path.join(storeRoot, "official/philosopher-7"), { type: "installed" });
  assert.ok(updatedContent.files.get("agents/socrates.md").toString("utf8").includes("Revised body."));
});

test("global store: a pack directory removed between listing's readdir and its per-pack read raises an explicit busy error, not a partial list or a raw crash", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-store-list-race-");
  await installOfficialPersonaPack(storeRoot, await officialCatalogSource());

  await assert.rejects(
    () => __withFsHookForTesting({
      readdir: async (...args) => {
        const entries = await readdir(...args);
        // Simulate a concurrent replace finishing its evacuating rename
        // right after listing captured the directory entry but before it
        // reads that pack's contents — deterministic, no real race needed.
        await rm(path.join(storeRoot, "official/philosopher-7"), { recursive: true, force: true });
        return entries;
      },
    }, () => listGlobalPersonaPacks(storeRoot)),
    /persona pack store is busy: 'official\/philosopher-7' changed while listing; retry the listing/,
  );
});

async function pathExistsForTest(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

test("global default: missing selection.json reads as unconfigured, not an explicit null default", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-default-missing-");
  assert.equal(await readGlobalDefaultPack(storeRoot), null);
});

test("global default: setting and clearing a default is independent of installing/binding any session", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-default-set-");
  await installOfficialPersonaPack(storeRoot, await officialCatalogSource());

  const written = await writeGlobalDefaultPack(storeRoot, "official/philosopher-7");
  assert.deepEqual(written, { schema: 1, defaultPack: "official/philosopher-7" });
  assert.deepEqual(await readGlobalDefaultPack(storeRoot), { schema: 1, defaultPack: "official/philosopher-7" });

  // Explicit null is a real, distinguishable record -- not the same as the
  // file never having existed (asserted above).
  await writeGlobalDefaultPack(storeRoot, null);
  assert.deepEqual(await readGlobalDefaultPack(storeRoot), { schema: 1, defaultPack: null });
});

test("global default: cannot be set to a pack that isn't actually installed", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-default-uninstalled-");
  await assert.rejects(
    () => writeGlobalDefaultPack(storeRoot, "official/philosopher-7"),
    /not installed/,
  );
  assert.equal(await readGlobalDefaultPack(storeRoot), null);
});

test("global default: a corrupted selection.json is an honest error, not a silently ignored default", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-default-corrupt-");
  await mkdir(storeRoot, { recursive: true });
  await writeFile(path.join(storeRoot, "selection.json"), "{ not json", "utf8");
  await assert.rejects(() => readGlobalDefaultPack(storeRoot), /corrupted/);
});

// ---- runGlobalPersonaPackAction: the shared dispatcher extensions/pi-persona.ts's
// /persona pack command and persona_pack tool both call (see pack-lifecycle.js) ----

test("dispatcher: list reports installed packs plus the remaining bundled catalog", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-dispatch-list-");
  const before = await runGlobalPersonaPackAction(storeRoot, { action: "list" });
  assert.deepEqual(before.installed.official, []);
  assert.deepEqual(before.installed.custom, []);
  assert.deepEqual(before.catalog.map((pack) => pack.name), ["philosopher-7"]);

  await runGlobalPersonaPackAction(storeRoot, { action: "install", target: "philosopher-7" });
  const after = await runGlobalPersonaPackAction(storeRoot, { action: "list" });
  assert.deepEqual(after.installed.official.map((pack) => pack.qualifiedName), ["official/philosopher-7"]);
  assert.deepEqual(after.catalog, []);
});

test("dispatcher: install rejects an explicit local path (official packs come from the bundled catalog only)", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-dispatch-install-path-");
  const sourceRoot = await tempDir(t, "pi-persona-dispatch-install-path-src-");
  await writeSchema2Pack(sourceRoot, { name: "outside-source" });
  await assert.rejects(
    () => runGlobalPersonaPackAction(storeRoot, { action: "install", target: sourceRoot }),
    /is not in the bundled catalog\. Official packs install by catalog name only/,
  );
  // Refused before the path is read at all.
  await assert.rejects(
    () => runGlobalPersonaPackAction(storeRoot, { action: "install", target: "./no/such/pack" }),
    /is not in the bundled catalog/,
  );
});

test("dispatcher: create then apply requires an explicit confirm-required round trip, and a second create resumes the same draft", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-dispatch-create-");

  const started = await runGlobalPersonaPackAction(storeRoot, { action: "create", target: "council" });
  assert.equal(started.mode, "draft");
  assert.equal(started.resumed, false);
  assert.ok(started.draftPath.endsWith(path.join("drafts", "council")));

  const resumed = await runGlobalPersonaPackAction(storeRoot, { action: "create", target: "council" });
  assert.equal(resumed.mode, "draft");
  assert.equal(resumed.resumed, true, "a pending draft must be resumed, not silently restarted");

  const unconfirmed = await runGlobalPersonaPackAction(storeRoot, { action: "apply", target: "council" });
  assert.equal(unconfirmed.mode, "confirm-required");
  assert.ok(unconfirmed.planId);
  const { custom: beforeApply } = await listGlobalPersonaPacks(storeRoot);
  assert.equal(beforeApply.length, 0, "an unconfirmed apply must not mutate the store");

  const applied = await runGlobalPersonaPackAction(storeRoot, { action: "apply", target: "council", confirmed: true, planId: unconfirmed.planId });
  assert.equal(applied.mode, "apply");
  assert.equal(applied.qualifiedName, "custom/council");
  const { custom: afterApply } = await listGlobalPersonaPacks(storeRoot);
  assert.equal(afterApply.length, 1);
});

test("dispatcher: create refuses a name that already has active custom content; edit refuses a name with none", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-dispatch-create-edit-guard-");
  await runGlobalPersonaPackAction(storeRoot, { action: "create", target: "council" });
  const plan = await runGlobalPersonaPackAction(storeRoot, { action: "apply", target: "council" });
  await runGlobalPersonaPackAction(storeRoot, { action: "apply", target: "council", confirmed: true, planId: plan.planId });

  await assert.rejects(
    () => runGlobalPersonaPackAction(storeRoot, { action: "create", target: "council" }),
    /already exists; use \/persona pack edit council/,
  );
  await assert.rejects(
    () => runGlobalPersonaPackAction(storeRoot, { action: "edit", target: "no-such-pack" }),
    /does not exist yet; use \/persona pack create no-such-pack/,
  );
});

test("dispatcher: update is a no-op plan when already current, and requires discardLocalEdits once the installed pack was edited", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-dispatch-update-");
  await installOfficialPersonaPack(storeRoot, await officialCatalogSource());

  const upToDate = await runGlobalPersonaPackAction(storeRoot, { action: "update", target: "philosopher-7" });
  assert.equal(upToDate.upToDate, true, "installed and catalog are the same version in this fixture");

  // Roll the store back to an artificially older installed version (the
  // bundled catalog itself has one fixed version, so this is the only way
  // to exercise a real version bump through loadPersonaPackSource, exactly
  // like updateOfficialPersonaPack's own store-level tests do).
  const olderRoot = await tempDir(t, "pi-persona-dispatch-update-older-");
  const bundled = await officialCatalogSource();
  await cp(bundled.root, olderRoot, { recursive: true });
  await writeText(
    path.join(olderRoot, "pack.yaml"),
    (await readFile(path.join(olderRoot, "pack.yaml"), "utf8")).replace("1.0.0", "0.9.0"),
  );
  await rm(path.join(storeRoot, "official/philosopher-7"), { recursive: true, force: true });
  await rm(path.join(storeRoot, "official/philosopher-7.meta.json"), { force: true });
  await installOfficialPersonaPack(storeRoot, await readPortablePersonaPack(olderRoot, { type: "bundled", ref: "philosopher-7" }));

  // Simulate a local edit on the now-installed 0.9.0 copy.
  const officialAgentPath = path.join(storeRoot, "official/philosopher-7/agents/symposium.md");
  await writeFile(officialAgentPath, (await readFile(officialAgentPath, "utf8")).replace("Symposium", "Symposium (edited)"), "utf8");

  const plan = await runGlobalPersonaPackAction(storeRoot, { action: "update", target: "philosopher-7" });
  assert.equal(plan.mode, "confirm-required");
  assert.equal(plan.edited, true);
  assert.ok(plan.planId);
  assert.match(plan.summary, /has local edits/);
  assert.doesNotMatch(plan.summary, /confirmed|discardLocalEdits/);
  assert.deepEqual(plan.confirmParams, { confirmed: true, planId: plan.planId, discardLocalEdits: true });

  await assert.rejects(
    () => runGlobalPersonaPackAction(storeRoot, { action: "update", target: "philosopher-7", confirmed: true, planId: plan.planId }),
    /has local edits not present in the recorded install; pass discardLocalEdits: true/,
  );
  const stillEdited = await readPortablePersonaPack(path.join(storeRoot, "official/philosopher-7"), { type: "installed", ref: "official/philosopher-7" });
  assert.match(stillEdited.files.get("agents/symposium.md").toString("utf8"), /Symposium \(edited\)/);

  await assert.rejects(
    () => runGlobalPersonaPackAction(storeRoot, { action: "update", target: "philosopher-7", confirmed: true }),
    /The approval could not be matched to the displayed plan/,
    "confirmed:true without the exact planId from the plan must not be enough to apply",
  );

  const applied = await runGlobalPersonaPackAction(storeRoot, {
    action: "update",
    target: "philosopher-7",
    confirmed: true,
    planId: plan.planId,
    discardLocalEdits: true,
  });
  assert.equal(applied.version, "1.0.0");
  const updated = await readPortablePersonaPack(path.join(storeRoot, "official/philosopher-7"), { type: "installed", ref: "official/philosopher-7" });
  assert.doesNotMatch(updated.files.get("agents/symposium.md").toString("utf8"), /\(edited\)/);
});

test("dispatcher: uninstall/delete require confirmed:true, and clearing a matching default requires saying so explicitly", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-dispatch-uninstall-default-");
  await installOfficialPersonaPack(storeRoot, await officialCatalogSource());
  await writeGlobalDefaultPack(storeRoot, "official/philosopher-7");

  const plan = await runGlobalPersonaPackAction(storeRoot, { action: "uninstall", target: "philosopher-7" });
  assert.equal(plan.mode, "confirm-required");
  assert.equal(plan.isDefault, true);
  assert.ok(plan.planId);

  await assert.rejects(
    () => runGlobalPersonaPackAction(storeRoot, { action: "uninstall", target: "philosopher-7", confirmed: true, planId: plan.planId }),
    /is the current global default; pass clearDefaultConfirmed: true/,
  );
  assert.deepEqual(await readGlobalDefaultPack(storeRoot), { schema: 1, defaultPack: "official/philosopher-7" });

  await assert.rejects(
    () => runGlobalPersonaPackAction(storeRoot, { action: "uninstall", target: "philosopher-7", confirmed: true, clearDefaultConfirmed: true }),
    /The approval could not be matched to the displayed plan/,
    "confirmed:true without the exact planId from the plan must not be enough to apply, even with clearDefaultConfirmed",
  );

  const applied = await runGlobalPersonaPackAction(storeRoot, {
    action: "uninstall",
    target: "philosopher-7",
    confirmed: true,
    planId: plan.planId,
    clearDefaultConfirmed: true,
  });
  assert.equal(applied.clearedDefault, true);
  assert.deepEqual(await readGlobalDefaultPack(storeRoot), { schema: 1, defaultPack: null });
});

test("dispatcher: uninstall refuses a custom pack name (use delete); delete refuses an official pack name (use uninstall)", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-dispatch-verb-guard-");
  await installOfficialPersonaPack(storeRoot, await officialCatalogSource());
  await forkPersonaPack(storeRoot, "official/philosopher-7", "forked-team");

  await assert.rejects(
    () => runGlobalPersonaPackAction(storeRoot, { action: "uninstall", target: "forked-team", confirmed: true }),
    /is custom; use \/persona pack delete forked-team instead/,
  );
  await assert.rejects(
    () => runGlobalPersonaPackAction(storeRoot, { action: "delete", target: "philosopher-7", confirmed: true }),
    /is official; use \/persona pack uninstall philosopher-7 instead/,
  );
});

test("dispatcher: fork then edit seeds the draft from the fork's own current content, not a blank starter", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-dispatch-fork-edit-");
  await installOfficialPersonaPack(storeRoot, await officialCatalogSource());
  await runGlobalPersonaPackAction(storeRoot, { action: "fork", source: "philosopher-7", target: "my-fork" });

  const draft = await runGlobalPersonaPackAction(storeRoot, { action: "edit", target: "my-fork" });
  assert.equal(draft.resumed, false);
  assert.equal(draft.isNew, false);
  assert.deepEqual(draft.diff, { added: [], changed: [], removed: [] });
  assert.ok(draft.personas.some((persona) => persona.name === "symposium"));

  const cancelled = await runGlobalPersonaPackAction(storeRoot, { action: "cancel", target: "my-fork" });
  assert.equal(cancelled.cancelled, true);
  const { custom } = await listGlobalPersonaPacks(storeRoot);
  assert.equal(custom.length, 1, "cancelling a draft must not touch the still-active fork");
});

test("resolveInstalledQualifiedPersonaPackName: a qualified name must actually be installed under that exact kind, not merely well-formed", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-resolve-qualified-");
  await installOfficialPersonaPack(storeRoot, await officialCatalogSource());

  assert.equal(await resolveInstalledQualifiedPersonaPackName(storeRoot, "philosopher-7"), "official/philosopher-7");
  assert.equal(await resolveInstalledQualifiedPersonaPackName(storeRoot, "official/philosopher-7"), "official/philosopher-7");

  // A well-formed but never-installed qualified name was previously handed
  // back at face value instead of being checked against the store; callers
  // downstream (update/uninstall/fork/the default setter) either crashed on
  // an undefined lookup or built a confirm-required plan describing an
  // action on a pack that was never there.
  await assert.rejects(
    () => resolveInstalledQualifiedPersonaPackName(storeRoot, "official/does-not-exist"),
    /persona pack 'official\/does-not-exist' is not installed/,
  );
  // The kind half of the qualified name matters too: philosopher-7 is
  // official, not custom.
  await assert.rejects(
    () => resolveInstalledQualifiedPersonaPackName(storeRoot, "custom/philosopher-7"),
    /persona pack 'custom\/philosopher-7' is not installed/,
  );
});

test("global default: pointing it at a name that is not installed is rejected outright, qualified or not, and the default setter shares the same check", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-default-nonexistent-");
  await installOfficialPersonaPack(storeRoot, await officialCatalogSource());

  await assert.rejects(
    () => resolveInstalledQualifiedPersonaPackName(storeRoot, "official/nope"),
    /is not installed/,
  );
  await assert.rejects(
    () => writeGlobalDefaultPack(storeRoot, "official/nope"),
    /is not installed; install it before setting it as the default/,
  );
  assert.equal(await readGlobalDefaultPack(storeRoot), null, "a rejected default write must leave the store unconfigured, not a partial record");
});

test("dispatcher: update on a same-version but locally edited install is a real plan, not silently 'up to date', and restores the recorded content on approval", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-dispatch-update-same-version-drift-");
  await installOfficialPersonaPack(storeRoot, await officialCatalogSource());

  const officialAgentPath = path.join(storeRoot, "official/philosopher-7/agents/symposium.md");
  await writeFile(officialAgentPath, (await readFile(officialAgentPath, "utf8")).replace("Symposium", "Symposium (edited)"), "utf8");

  const plan = await runGlobalPersonaPackAction(storeRoot, { action: "update", target: "philosopher-7" });
  assert.equal(plan.mode, "confirm-required", "same version but edited must not report upToDate");
  assert.equal(plan.edited, true);
  assert.equal(plan.fromVersion, plan.toVersion);
  assert.match(plan.summary, /Restoring it will discard them/);
  assert.ok(plan.planId);

  const applied = await runGlobalPersonaPackAction(storeRoot, {
    action: "update",
    target: "philosopher-7",
    confirmed: true,
    planId: plan.planId,
    discardLocalEdits: true,
  });
  assert.match(applied.summary, /^Restored persona pack 'official\/philosopher-7'/);
  const restored = await readPortablePersonaPack(path.join(storeRoot, "official/philosopher-7"), { type: "installed", ref: "official/philosopher-7" });
  assert.doesNotMatch(restored.files.get("agents/symposium.md").toString("utf8"), /\(edited\)/);
});

test("dispatcher: apply refuses a draft that was edited after it was previewed, instead of silently applying the newer content", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-apply-draft-drift-");
  await runGlobalPersonaPackAction(storeRoot, { action: "create", target: "council" });

  const plan = await runGlobalPersonaPackAction(storeRoot, { action: "apply", target: "council" });
  assert.equal(plan.mode, "confirm-required");
  assert.ok(plan.planId);

  const draftLeadPath = path.join(storeRoot, "drafts/council/agents/council-lead.md");
  await writeFile(
    draftLeadPath,
    (await readFile(draftLeadPath, "utf8")).replace("Replace this starter prompt with real instructions.", "Drifted after preview."),
    "utf8",
  );

  await assert.rejects(
    () => runGlobalPersonaPackAction(storeRoot, { action: "apply", target: "council", confirmed: true, planId: plan.planId }),
    /persona pack draft 'council' changed since it was previewed/,
  );
  const { custom } = await listGlobalPersonaPacks(storeRoot);
  assert.equal(custom.length, 0, "a rejected drift-apply must not create the pack");
});

test("dispatcher: apply refuses when the active custom pack changed after the draft was previewed, instead of silently overwriting it", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-apply-active-drift-");
  await installOfficialPersonaPack(storeRoot, await officialCatalogSource());
  await runGlobalPersonaPackAction(storeRoot, { action: "fork", source: "philosopher-7", target: "my-fork" });
  await runGlobalPersonaPackAction(storeRoot, { action: "edit", target: "my-fork" });

  const plan = await runGlobalPersonaPackAction(storeRoot, { action: "apply", target: "my-fork" });
  assert.equal(plan.mode, "confirm-required");
  assert.ok(plan.planId);

  // Someone else mutates the active custom pack directly (a concurrent
  // update) after the draft was previewed.
  const activeAgentPath = path.join(storeRoot, "custom/my-fork/agents/symposium.md");
  await writeFile(activeAgentPath, (await readFile(activeAgentPath, "utf8")).replace("Symposium", "Symposium (drifted)"), "utf8");

  await assert.rejects(
    () => runGlobalPersonaPackAction(storeRoot, { action: "apply", target: "my-fork", confirmed: true, planId: plan.planId }),
    /persona pack draft 'my-fork' changed since it was previewed/,
  );
});

test("dispatcher: update refuses when the installed official pack's edit changed again after it was previewed, instead of discarding a newer edit than the one shown", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-update-active-drift-");
  await installOfficialPersonaPack(storeRoot, await officialCatalogSource());

  // Roll back to an artificially older installed version so update has a
  // real version bump to offer (same technique as the existing "update is a
  // no-op plan..." dispatcher test above).
  const olderRoot = await tempDir(t, "pi-persona-update-active-drift-older-");
  const bundled = await officialCatalogSource();
  await cp(bundled.root, olderRoot, { recursive: true });
  await writeText(
    path.join(olderRoot, "pack.yaml"),
    (await readFile(path.join(olderRoot, "pack.yaml"), "utf8")).replace("1.0.0", "0.9.0"),
  );
  await rm(path.join(storeRoot, "official/philosopher-7"), { recursive: true, force: true });
  await rm(path.join(storeRoot, "official/philosopher-7.meta.json"), { force: true });
  await installOfficialPersonaPack(storeRoot, await readPortablePersonaPack(olderRoot, { type: "bundled", ref: "philosopher-7" }));

  const officialAgentPath = path.join(storeRoot, "official/philosopher-7/agents/symposium.md");
  const original090 = await readFile(officialAgentPath, "utf8");
  await writeFile(officialAgentPath, original090.replace("Symposium", "Symposium (edit A)"), "utf8");

  const plan = await runGlobalPersonaPackAction(storeRoot, { action: "update", target: "philosopher-7" });
  assert.equal(plan.mode, "confirm-required");
  assert.equal(plan.edited, true);
  assert.ok(plan.planId);

  // A second, different edit lands after the plan was shown: merely knowing
  // the pack is edited is not enough consent to discard *this* edit -- the
  // approval must be for the exact content that was previewed.
  await writeFile(officialAgentPath, original090.replace("Symposium", "Symposium (edit B)"), "utf8");

  await assert.rejects(
    () => runGlobalPersonaPackAction(storeRoot, {
      action: "update",
      target: "philosopher-7",
      confirmed: true,
      planId: plan.planId,
      discardLocalEdits: true,
    }),
    /persona pack 'official\/philosopher-7' changed since it was previewed/,
  );
  const stillB = await readPortablePersonaPack(path.join(storeRoot, "official/philosopher-7"), { type: "installed", ref: "official/philosopher-7" });
  assert.match(stillB.files.get("agents/symposium.md").toString("utf8"), /\(edit B\)/, "the rejected apply must not have touched the drifted content");
});

test("dispatcher: confirmed:true with a fabricated or stale planId is rejected the same as no token at all", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-invalid-token-");
  await installOfficialPersonaPack(storeRoot, await officialCatalogSource());

  const plan = await runGlobalPersonaPackAction(storeRoot, { action: "uninstall", target: "philosopher-7" });
  assert.equal(plan.mode, "confirm-required");

  await assert.rejects(
    () => runGlobalPersonaPackAction(storeRoot, { action: "uninstall", target: "philosopher-7", confirmed: true, planId: "sha256:not-a-real-plan-id" }),
    /changed since it was previewed/,
  );
  const { official } = await listGlobalPersonaPacks(storeRoot);
  assert.equal(official.length, 1, "a bypass attempt with a fabricated token must not remove the pack");
});

test("dispatcher: a default changed after a removal was previewed is never touched by that removal's stale plan", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-removal-default-drift-");
  await installOfficialPersonaPack(storeRoot, await officialCatalogSource());
  await runGlobalPersonaPackAction(storeRoot, { action: "fork", source: "philosopher-7", target: "other" });
  await writeGlobalDefaultPack(storeRoot, "official/philosopher-7");

  const plan = await runGlobalPersonaPackAction(storeRoot, { action: "uninstall", target: "philosopher-7" });
  assert.equal(plan.mode, "confirm-required");
  assert.equal(plan.isDefault, true);
  assert.ok(plan.planId);

  // The default changes to a different, unrelated pack after the plan was
  // shown -- simulating a concurrent /persona team default call.
  await writeGlobalDefaultPack(storeRoot, "custom/other");

  await assert.rejects(
    () => runGlobalPersonaPackAction(storeRoot, { action: "uninstall", target: "philosopher-7", confirmed: true, planId: plan.planId, clearDefaultConfirmed: true }),
    /changed since it was previewed/,
  );
  assert.deepEqual(
    await readGlobalDefaultPack(storeRoot),
    { schema: 1, defaultPack: "custom/other" },
    "the unrelated default set after preview must survive a rejected stale removal untouched",
  );
});

test("dispatcher: a pack that became the default after its removal was previewed is not removed on a stale plan that said it wasn't", async (t) => {
  const storeRoot = await tempDir(t, "pi-persona-removal-newly-default-");
  await installOfficialPersonaPack(storeRoot, await officialCatalogSource());

  const plan = await runGlobalPersonaPackAction(storeRoot, { action: "uninstall", target: "philosopher-7" });
  assert.equal(plan.mode, "confirm-required");
  assert.equal(plan.isDefault, false);

  await writeGlobalDefaultPack(storeRoot, "official/philosopher-7");

  // Even granting clearDefaultConfirmed (as if the caller somehow already
  // knew to ask for it) must not be enough: the plan's own isDefault:false
  // is baked into planId, so the freshness check inside the store's lock
  // still refuses a plan that no longer matches reality, rather than only
  // being caught by the separate clearDefaultConfirmed gate.
  await assert.rejects(
    () => runGlobalPersonaPackAction(storeRoot, { action: "uninstall", target: "philosopher-7", confirmed: true, planId: plan.planId, clearDefaultConfirmed: true }),
    /changed since it was previewed/,
  );
  const { official } = await listGlobalPersonaPacks(storeRoot);
  assert.equal(official.length, 1, "a stale plan must not remove a pack that has since become the default");
});
