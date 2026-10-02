import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parse } from "yaml";

import {
  createPersonaProjectScaffold,
  formatPersonaPackReport,
  runDoctor,
  runPersonaPackAction,
} from "../src/persona/index.js";

async function temporaryProject(t, prefix, onboard = true) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (onboard) await createPersonaProjectScaffold(root);
  return root;
}

async function writeText(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

function agentSource(
  name,
  packName,
  body = `${name} guidance.`,
  role = "specialist",
) {
  const docs = [
    `library/personal/${name}/`,
    `library/shared/${packName}/`,
  ];
  return `---
name: ${name}
role: ${role}
description: ${name} ${role}.
docs:
${docs.map((entry) => `  - ${entry}`).join("\n")}
skills: []
---
${body}
`;
}

function authoredTeam(packName, specialists = ["member"], options = {}) {
  return [
    {
      name: `${packName}-coordinator`,
      role: "generalist",
      description: options.generalistDescription ?? `Coordinates ${packName}: routes work and synthesizes results.`,
      prompt: `Lead ${packName}, route work, and synthesize specialist results.`,
      docs: options.generalistReferences ?? [],
      skills: [],
    },
    ...specialists.map((name) => ({
      name,
      role: "specialist",
      description: `${name} specialist.`,
      prompt: options.prompts?.[name] ?? `${name} guidance.`,
      docs: options.references?.[name] ?? [],
      skills: [],
    })),
  ];
}

async function writePortablePack(directory, options = {}) {
  const name = options.name ?? "portable-team";
  const version = options.version ?? "1.0.0";
  const agents = options.agents ?? { analyst: "Analyze the request." };
  const references = options.references ?? {};
  const generalistName = options.generalistName ?? `${name}-coordinator`;

  await rm(directory, { recursive: true, force: true });
  await writeText(path.join(directory, "pack.yaml"), [
    "schema: 1",
    `name: ${name}`,
    `version: ${version}`,
    `description: ${options.description ?? `${name} test pack.`}`,
    options.manifestExtra ?? "",
  ].filter(Boolean).join("\n") + "\n");
  await writeText(
    path.join(directory, "configure.md"),
    options.configure ?? `# Configure ${name}\n\nReview the pack context.\n`,
  );
  if (options.generalist !== false) {
    await writeText(
      path.join(directory, "agents", `${generalistName}.md`),
      agentSource(
        generalistName,
        name,
        options.generalistPrompt ?? `Coordinate ${name}.`,
        "generalist",
      ),
    );
  }
  for (const [agentName, value] of Object.entries(agents)) {
    const definition = typeof value === "string" ? { body: value } : value;
    await writeText(
      path.join(directory, "agents", `${agentName}.md`),
      agentSource(agentName, name, definition.body),
    );
  }
  await mkdir(path.join(directory, "references"), { recursive: true });
  for (const [relativePath, content] of Object.entries(references)) {
    await writeText(path.join(directory, "references", relativePath), content);
  }
}

async function plan(root, operation, target, options = {}) {
  return runPersonaPackAction(root, {
    action: "plan",
    operation,
    target,
    ...options,
  });
}

async function applyApproved(root, operation, target, approvedPlan, options = {}) {
  return runPersonaPackAction(root, {
    action: "apply",
    operation,
    target,
    ...options,
    confirmed: true,
    planId: approvedPlan.planId,
  });
}

async function readLock(root) {
  return parse(await readFile(path.join(root, ".pi/persona-packs.lock.yaml"), "utf8"));
}

async function exists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch (error) {
    if (error?.code === "EISDIR") return true;
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

test("bundled list and empty status are useful and read-only", async (t) => {
  const root = await temporaryProject(t, "pi-persona-pack-list-");

  const listed = await runPersonaPackAction(root, { action: "list" });
  assert.deepEqual(listed.installed, []);
  const philosopher = listed.available.find((pack) => pack.name === "philosopher-7");
  assert.equal(philosopher.version, "1.0.0");
  assert.equal(philosopher.installed, false);
  assert.deepEqual(
    new Set(philosopher.personas.map((persona) => persona.name)),
    new Set(["symposium", "socrates", "descartes", "kant", "hume", "aristotle", "hegel", "plato"]),
  );
  assert.deepEqual(
    philosopher.personas.filter((persona) => persona.role === "generalist").map((persona) => persona.name),
    ["symposium"],
  );
  assert.equal(philosopher.personas.filter((persona) => persona.role === "specialist").length, 7);
  assert.match(formatPersonaPackReport(listed), /\[G\] symposium/);
  const symposiumPrompt = await readFile(
    path.join(process.cwd(), "packs/philosopher-7/agents/symposium.md"),
    "utf8",
  );
  assert.match(symposiumPrompt, /use `expectedOutput` to ask for a self-contained/);
  assert.match(symposiumPrompt, /## Perspective\s+contributions/);
  assert.match(symposiumPrompt, /## What could change the answer/);

  const status = await runPersonaPackAction(root, { action: "status" });
  assert.deepEqual(status.packs, []);
  assert.deepEqual(status.drafts, []);
  assert.equal(status.nextAction, "/persona pack list");
  assert.equal(await exists(path.join(root, ".pi/persona-packs.lock.yaml")), false);
  assert.equal(await exists(path.join(root, ".pi/persona-pack-drafts")), false);
});

test("install requires onboarding and rejects malformed, unowned, and colliding sources", async (t) => {
  const root = await temporaryProject(t, "pi-persona-pack-validation-", false);
  await assert.rejects(
    () => plan(root, "install", "philosopher-7"),
    /onboarding must be complete/,
  );
  await writeText(path.join(root, ".pi/agents/_baseline.md"), `---
docs:
  - library/shared/
skills: []
---
Shared project foundation.
`);
  await writeText(path.join(root, "library/shared/_index.md"), "# Shared Library\n");
  assert.equal((await plan(root, "install", "philosopher-7")).ready, true);

  const invalidManifest = path.join(root, "sources", "invalid-manifest");
  await writePortablePack(invalidManifest, {
    name: "invalid-manifest",
    manifestExtra: "profiles: []",
  });
  await assert.rejects(
    () => plan(root, "install", invalidManifest),
    /manifest fields must be exactly schema, name, version, description/,
  );

  const invalidLayout = path.join(root, "sources", "invalid-layout");
  await writePortablePack(invalidLayout, { name: "invalid-layout" });
  await writeText(path.join(invalidLayout, "notes.txt"), "not part of the portable convention\n");
  await assert.rejects(
    () => plan(root, "install", invalidLayout),
    /unexpected source entry 'notes.txt'/,
  );

  const noGeneralist = path.join(root, "sources", "no-generalist");
  await writePortablePack(noGeneralist, {
    name: "no-generalist",
    generalist: false,
  });
  await assert.rejects(
    () => plan(root, "install", noGeneralist),
    /exactly one generalist; found 0/,
  );

  const noSpecialist = path.join(root, "sources", "no-specialist");
  await writePortablePack(noSpecialist, {
    name: "no-specialist",
    agents: {},
  });
  await assert.rejects(
    () => plan(root, "install", noSpecialist),
    /must contain at least one specialist/,
  );

  const noSharedLibrary = path.join(root, "sources", "no-shared-library");
  await writePortablePack(noSharedLibrary, { name: "no-shared-library" });
  const noSharedAgent = path.join(noSharedLibrary, "agents/analyst.md");
  await writeText(
    noSharedAgent,
    (await readFile(noSharedAgent, "utf8")).replace("  - library/shared/no-shared-library/\n", ""),
  );
  await assert.rejects(
    () => plan(root, "install", noSharedLibrary),
    /pack persona must declare its pack-shared library: library\/shared\/no-shared-library\//,
  );

  const hiddenReference = path.join(root, "sources", "hidden-reference");
  await writePortablePack(hiddenReference, {
    name: "hidden-reference",
    references: { "context.md": "Raw source artifact.\n" },
  });
  const hiddenReferenceAgent = path.join(hiddenReference, "agents/analyst.md");
  await writeText(
    hiddenReferenceAgent,
    (await readFile(hiddenReferenceAgent, "utf8")).replace(
      "  - library/shared/hidden-reference/\n",
      "  - library/shared/hidden-reference/\n  - .pi/persona-packs/hidden-reference/references/context.md\n",
    ),
  );
  await assert.rejects(
    () => plan(root, "install", hiddenReference),
    /docs may use only library\/personal\/analyst\/ and library\/shared\/hidden-reference\//,
  );

  const malformedAgent = path.join(root, "sources", "malformed-agent");
  await writePortablePack(malformedAgent, { name: "malformed-agent" });
  await writeText(
    path.join(malformedAgent, "agents/analyst.md"),
    agentSource("analyst", "malformed-agent").replace(
      "description: analyst specialist.",
      "description: Research support: facts and sources.",
    ),
  );
  await assert.rejects(
    () => plan(root, "install", malformedAgent),
    (error) => {
      assert.match(error.message, /Nested mappings are not allowed/);
      assert.doesNotMatch(error.message, /missing required field/);
      return true;
    },
  );

  const collision = path.join(root, "sources", "collision-pack");
  await writeText(
    path.join(root, ".pi/agents/generalist.md"),
    agentSource("generalist", "legacy", "Legacy project persona.", "generalist"),
  );
  await writePortablePack(collision, {
    name: "collision-pack",
    agents: { generalist: "Conflicts with the project generalist." },
  });
  await assert.rejects(
    () => plan(root, "install", collision),
    /persona name 'generalist'.*conflicts/,
  );

  const occupied = path.join(root, "sources", "occupied-pack");
  await writePortablePack(occupied, { name: "occupied-pack" });
  await writeText(
    path.join(root, ".pi/agents/packs/occupied-pack/local.md"),
    "Untracked local content.\n",
  );
  await assert.rejects(
    () => plan(root, "install", occupied),
    /untracked pack destination already exists/,
  );

  await assert.rejects(
    () => runPersonaPackAction(root, {
      action: "start",
      operation: "author",
      target: "Bad Name",
    }),
    /pack name must begin with a lowercase letter/,
  );
});

test("pack mutations serialize and valid object-property names remain ordinary packs", async (t) => {
  const root = await temporaryProject(t, "pi-persona-pack-lock-");
  const source = path.join(root, "sources", "constructor");
  await writePortablePack(source, { name: "constructor" });
  const installPlan = await plan(root, "install", source);
  const mutationLock = path.join(root, ".pi/.persona-pack-mutation.lock");
  await writeText(mutationLock, "{}\n");
  await assert.rejects(
    () => applyApproved(root, "install", source, installPlan),
    /another persona pack operation is in progress/,
  );
  assert.equal(await exists(path.join(root, ".pi/agents/packs/constructor")), false);
  await rm(mutationLock);

  await applyApproved(root, "install", source, installPlan);
  const status = await runPersonaPackAction(root, { action: "status", target: "constructor" });
  assert.equal(status.packs[0].name, "constructor");
  const listed = await runPersonaPackAction(root, { action: "list" });
  assert.match(
    formatPersonaPackReport(listed),
    /constructor — ready; configuration pending; analyst/,
  );
});

test("portable install rejects stale approval, then configures only its own roots", async (t) => {
  const root = await temporaryProject(t, "pi-persona-pack-install-");
  const baselinePath = path.join(root, ".pi/agents/_baseline.md");
  const generalistPath = path.join(root, ".pi/agents/generalist.md");
  const baselineBefore = await readFile(baselinePath);
  const generalistBefore = await readFile(generalistPath);
  const source = path.join(root, "sources", "portable-team");
  await writePortablePack(source);

  const stale = await plan(root, "install", source);
  assert.equal(stale.ready, true);
  assert.equal(stale.confirmation, "ordinary");
  await writeText(path.join(source, "configure.md"), "# Configure portable-team\n\nChanged after preview.\n");
  await assert.rejects(
    () => applyApproved(root, "install", source, stale),
    /plan changed; review the new plan/,
  );
  assert.equal(await exists(path.join(root, ".pi/agents/packs/portable-team")), false);

  const installPlan = await plan(root, "install", source);
  assert.ok(installPlan.actions.some((action) => (
    action.path === ".pi/persona-packs.lock.yaml"
    && action.action === "record installation"
  )));
  const installed = await applyApproved(root, "install", source, installPlan);
  assert.match(installed.summary, /editable starter libraries are now in this project; configuration is next/);
  assert.match(installed.followUpPrompt, /Next, help me configure 'portable-team'/);
  assert.doesNotMatch(installed.followUpPrompt, /persona_pack|action plan|configurationComplete|the user/);
  assert.equal(await exists(path.join(root, ".pi/agents/packs/portable-team/analyst.md")), true);
  assert.equal(
    await exists(path.join(root, "library/personal/analyst/_index.md")),
    true,
  );
  assert.equal(
    await exists(path.join(root, "library/personal/portable-team-coordinator/_index.md")),
    true,
  );
  let lock = await readLock(root);
  assert.equal(lock.packs["portable-team"].source.type, "path");
  assert.equal(lock.packs["portable-team"].version, "1.0.0");
  assert.equal(lock.packs["portable-team"].configuration, "pending");
  const dependencyStatus = {
    piSubagents: {
      ok: true,
      version: "0.34.0",
      path: "/test/pi-subagents",
      configured: true,
    },
  };
  const pendingDoctor = await runDoctor(root, { dependencyStatus });
  assert.ok(pendingDoctor.issues.some((issue) => (
    issue.message.includes("project-local persona pack 'portable-team' configuration was never marked complete")
  )));

  await assert.rejects(
    () => plan(root, "configure", "portable-team", {
      files: [{ path: "README.md", action: "write", content: "escape\n" }],
    }),
    /outside this persona pack and its libraries/,
  );
  await assert.rejects(
    () => plan(root, "configure", "portable-team", {
      files: [{
        path: ".pi/persona-packs/portable-team/configure.md",
        action: "delete",
      }],
    }),
    /must contain a non-empty configuration guide/,
  );

  const guideOnly = await plan(root, "configure", "portable-team");
  assert.equal(guideOnly.ready, false);
  assert.equal(guideOnly.confirmation, "none");
  assert.equal(guideOnly.planId, null);
  assert.equal(guideOnly.guideOnly, true);
  assert.match(guideOnly.assistantPrompt, /library\/shared\//);
  assert.match(guideOnly.assistantPrompt, /library\/personal\/analyst\//);
  assert.match(formatPersonaPackReport(guideOnly), /No document changes are selected yet/);
  assert.doesNotMatch(formatPersonaPackReport(guideOnly), /ask whether the user|The assistant/);

  const contextPath = "library/shared/portable-team-project-context.md";
  await writeText(path.join(root, contextPath), "Original project context.\n");
  const staleLibraryOptions = {
    files: [{ path: contextPath, action: "write", content: "Approved project context.\n" }],
    configurationComplete: false,
  };
  const staleLibraryPlan = await plan(root, "configure", "portable-team", staleLibraryOptions);
  await writeText(path.join(root, contextPath), "Changed after preview.\n");
  await assert.rejects(
    () => applyApproved(root, "configure", "portable-team", staleLibraryPlan, staleLibraryOptions),
    /plan changed; review the new plan/,
  );
  assert.equal(await readFile(path.join(root, contextPath), "utf8"), "Changed after preview.\n");

  const configureOptions = {
    files: [{ path: contextPath, action: "write", content: "Project-specific context.\n" }],
    configurationComplete: true,
  };
  const configurePlan = await plan(root, "configure", "portable-team", configureOptions);
  assert.match(configurePlan.guide, /Changed after preview/);
  await applyApproved(root, "configure", "portable-team", configurePlan, configureOptions);
  assert.equal(await readFile(path.join(root, contextPath), "utf8"), "Project-specific context.\n");

  lock = await readLock(root);
  assert.equal(lock.packs["portable-team"].configuration, "complete");
  const configuredDoctor = await runDoctor(root, { dependencyStatus });
  assert.equal(configuredDoctor.issues.some((issue) => (
    issue.message.includes("persona pack 'portable-team' configuration is pending")
  )), false);
  const status = await runPersonaPackAction(root, { action: "status", target: "portable-team" });
  assert.equal(status.packs[0].configuration, "complete");
  assert.deepEqual(
    status.packs[0].personas.map((persona) => persona.name),
    ["analyst", "portable-team-coordinator"],
  );

  const nestedPath = ".pi/persona-packs/portable-team/references/shape/child.md";
  const nestedOptions = {
    files: [{ path: nestedPath, action: "write", content: "Nested context.\n" }],
    configurationComplete: true,
  };
  const nestedPlan = await plan(root, "configure", "portable-team", nestedOptions);
  await applyApproved(root, "configure", "portable-team", nestedPlan, nestedOptions);
  const flattenedPath = ".pi/persona-packs/portable-team/references/shape";
  const flattenedOptions = {
    files: [
      { path: nestedPath, action: "delete" },
      { path: flattenedPath, action: "write", content: "Flat context.\n" },
    ],
    configurationComplete: true,
  };
  const flattenedPlan = await plan(root, "configure", "portable-team", flattenedOptions);
  await applyApproved(root, "configure", "portable-team", flattenedPlan, flattenedOptions);
  assert.equal(await readFile(path.join(root, flattenedPath), "utf8"), "Flat context.\n");
  assert.deepEqual(await readFile(baselinePath), baselineBefore);
  assert.deepEqual(await readFile(generalistPath), generalistBefore);
});

test("project-native authoring starts, resumes, applies, and keeps a minimal lock entry", async (t) => {
  const root = await temporaryProject(t, "pi-persona-pack-author-");
  const start = await runPersonaPackAction(root, {
    action: "start",
    operation: "author",
    target: "research-team",
  });
  assert.equal(start.resumed, false);
  assert.match(start.assistantPrompt, /5–10 minutes/);
  assert.match(start.assistantPrompt, /paste text, attach documents, provide existing file paths/);
  assert.match(start.assistantPrompt, /Ask me one question at a time/);
  assert.doesNotMatch(start.assistantPrompt, /persona_pack|planId|the user/);
  assert.match(formatPersonaPackReport(start), /on-theme \[G\] lead, specialists, document handoff/);
  assert.match(formatPersonaPackReport(start), /● Define purpose/);
  assert.equal(await exists(path.join(root, ".pi/persona-pack-drafts/research-team/configure.md")), true);
  assert.equal(await exists(path.join(root, ".pi/agents/packs/research-team")), false);

  const resumed = await runPersonaPackAction(root, {
    action: "start",
    operation: "author",
    target: "research-team",
  });
  assert.equal(resumed.resumed, true);

  const authorOptions = {
    personas: authoredTeam("research-team", ["researcher"], {
      prompts: { researcher: "Investigate evidence." },
    }),
    files: [
      {
        path: ".pi/persona-packs/research-team/references/researcher/context.md",
        action: "write",
        content: "# Research context\n",
      },
    ],
  };
  const authorPlan = await plan(root, "author", "research-team", authorOptions);
  assert.equal(authorPlan.ready, true);
  assert.equal(authorPlan.highlights.generalist.name, "research-team-coordinator");
  assert.deepEqual(authorPlan.highlights.specialists.map((persona) => persona.name), ["researcher"]);
  assert.match(formatPersonaPackReport(authorPlan), /## Highlights/);
  assert.match(formatPersonaPackReport(authorPlan), /Pack lead: \[G\] research-team-coordinator/);
  assert.match(formatPersonaPackReport(authorPlan), /Editable seed documents: 1/);
  assert.match(formatPersonaPackReport(authorPlan), /Coordinates research-team: routes work/);
  assert.doesNotMatch(formatPersonaPackReport(authorPlan), /Plan ID|approval token/);
  assert.match(
    formatPersonaPackReport(authorPlan, { includePlanId: true }),
    /Internal approval token \(do not show\):/,
  );
  assert.ok(authorPlan.actions.some((action) => (
    action.path === ".pi/persona-packs.lock.yaml"
    && action.action === "record project pack"
  )));
  const authoredPack = await applyApproved(root, "author", "research-team", authorPlan, authorOptions);
  assert.match(authoredPack.summary, /editable libraries are now in this project; configuration is next/);
  assert.match(authoredPack.followUpPrompt, /Next, help me configure 'research-team'/);

  assert.equal(await exists(path.join(root, ".pi/persona-pack-drafts/research-team")), false);
  assert.equal(await exists(path.join(root, ".pi/agents/packs/research-team/researcher.md")), true);
  assert.equal(
    await exists(path.join(root, "library/personal/research-team-coordinator/_index.md")),
    true,
  );
  assert.equal(
    await exists(path.join(root, "library/personal/researcher/_index.md")),
    true,
  );
  assert.equal(
    await readFile(path.join(root, "library/personal/researcher/context.md"), "utf8"),
    "# Research context\n",
  );
  assert.match(
    await readFile(path.join(root, ".pi/persona-packs/research-team/configure.md"), "utf8"),
    /Personal libraries in this pack/,
  );
  assert.match(
    await readFile(path.join(root, ".pi/agents/packs/research-team/research-team-coordinator.md"), "utf8"),
    /description: "Coordinates research-team: routes work and synthesizes results\."/,
  );
  assert.doesNotMatch(
    await readFile(path.join(root, ".pi/agents/packs/research-team/research-team-coordinator.md"), "utf8"),
    /primary:/,
  );
  const entry = (await readLock(root)).packs["research-team"];
  assert.deepEqual(entry, {
    source: { type: "project" },
    configuration: "pending",
  });

  const revision = await runPersonaPackAction(root, {
    action: "start",
    operation: "author",
    target: "research-team",
  });
  assert.equal(revision.resumed, false);
  const noChange = await plan(root, "author", "research-team");
  assert.equal(noChange.ready, false);
  assert.equal(noChange.confirmation, "none");
  assert.equal(await exists(path.join(root, ".pi/persona-pack-drafts/research-team")), false);
  await runPersonaPackAction(root, {
    action: "start",
    operation: "author",
    target: "research-team",
  });

  const revisionOptions = {
    personas: authoredTeam("research-team", ["researcher"], {
      prompts: { researcher: "Approved revision." },
    }),
  };
  const approvedRevision = await plan(root, "author", "research-team", revisionOptions);
  const draftAgent = path.join(root, ".pi/persona-pack-drafts/research-team/agents/researcher.md");
  await writeText(
    draftAgent,
    (await readFile(draftAgent, "utf8")).replace("Approved revision.", "Changed after approval."),
  );
  await assert.rejects(
    () => applyApproved(root, "author", "research-team", approvedRevision, revisionOptions),
    /plan changed; review the new plan/,
  );
  assert.match(await readFile(draftAgent, "utf8"), /Changed after approval/);
  const status = await runPersonaPackAction(root, { action: "status", target: "research-team" });
  assert.deepEqual(status.drafts, ["research-team"]);
});

test("author draft writes roll back on failure and no-op cleanup rejects symlinked roots", async (t) => {
  const atomic = await temporaryProject(t, "pi-persona-pack-author-atomic-");
  await runPersonaPackAction(atomic, {
    action: "start",
    operation: "author",
    target: "atomic-team",
  });
  const victimPath = ".pi/persona-packs/atomic-team/references/victim.md";
  await plan(atomic, "author", "atomic-team", {
    personas: authoredTeam("atomic-team"),
    files: [
      { path: victimPath, action: "write", content: "Keep me.\n" },
    ],
  });
  const oversizedPath = `.pi/persona-packs/atomic-team/references/${"x".repeat(300)}.md`;
  await assert.rejects(
    () => plan(atomic, "author", "atomic-team", {
      files: [
        { path: victimPath, action: "delete" },
        { path: oversizedPath, action: "write", content: "Cannot be written.\n" },
      ],
    }),
    /ENAMETOOLONG|name too long/i,
  );
  assert.equal(
    await readFile(path.join(atomic, ".pi/persona-pack-drafts/atomic-team/references/victim.md"), "utf8"),
    "Keep me.\n",
  );

  const linked = await temporaryProject(t, "pi-persona-pack-author-linked-");
  await runPersonaPackAction(linked, {
    action: "start",
    operation: "author",
    target: "linked-team",
  });
  const authorOptions = {
    personas: authoredTeam("linked-team"),
  };
  const authorPlan = await plan(linked, "author", "linked-team", authorOptions);
  await applyApproved(linked, "author", "linked-team", authorPlan, authorOptions);
  await runPersonaPackAction(linked, {
    action: "start",
    operation: "author",
    target: "linked-team",
  });

  const external = await mkdtemp(path.join(tmpdir(), "pi-persona-pack-external-drafts-"));
  t.after(() => rm(external, { recursive: true, force: true }));
  const draftsRoot = path.join(linked, ".pi/persona-pack-drafts");
  const externalDrafts = path.join(external, "drafts");
  await rename(draftsRoot, externalDrafts);
  await symlink(externalDrafts, draftsRoot, "dir");
  await assert.rejects(
    () => plan(linked, "author", "linked-team"),
    /symbolic links are not supported/,
  );
  assert.equal(
    await exists(path.join(externalDrafts, "linked-team/configure.md")),
    true,
  );
});

test("portable update handles safe changes and explicit keep-local or accept-upstream conflicts", async (t) => {
  const root = await temporaryProject(t, "pi-persona-pack-update-");
  const source = path.join(root, "sources", "update-team");
  await writePortablePack(source, {
    name: "update-team",
    agents: {
      alpha: "Alpha upstream v1.",
      beta: "Beta upstream v1.",
    },
    references: {
      "old.md": "Removed in v2.\n",
      "stable.md": "Stable context.\n",
    },
    configure: "# Configure update-team\n\nVersion one guide.\n",
  });
  const installPlan = await plan(root, "install", source);
  await applyApproved(root, "install", source, installPlan);

  const alphaPath = path.join(root, ".pi/agents/packs/update-team/alpha.md");
  const betaPath = path.join(root, ".pi/agents/packs/update-team/beta.md");
  await writeText(alphaPath, agentSource("alpha", "update-team", "Alpha local customization."));
  await writeText(betaPath, agentSource("beta", "update-team", "Beta local customization."));

  await writePortablePack(source, {
    name: "update-team",
    version: "1.1.0",
    agents: {
      alpha: "Alpha upstream v1.1.",
      beta: "Beta upstream v1.1.",
      generalist: "Would collide with the project generalist.",
    },
  });
  await assert.rejects(
    () => plan(root, "update", "update-team"),
    /persona name 'generalist'.*conflicts/,
  );

  await writePortablePack(source, {
    name: "update-team",
    version: "2.0.0",
    agents: {
      alpha: "Alpha upstream v2.",
      beta: "Beta upstream v2.",
    },
    references: {
      "new.md": "Added in v2.\n",
      "stable.md": "Stable context.\n",
    },
    configure: "# Configure update-team\n\nVersion two guide.\n",
  });

  const unresolved = await plan(root, "update", "update-team");
  assert.equal(unresolved.ready, false);
  assert.equal(unresolved.planId, null);
  assert.deepEqual(
    unresolved.conflicts.map((conflict) => conflict.path),
    [
      ".pi/agents/packs/update-team/alpha.md",
      ".pi/agents/packs/update-team/beta.md",
    ],
  );
  assert.ok(unresolved.actions.some((action) => (
    action.path === ".pi/persona-packs/update-team/references/new.md"
    && action.reason === "upstream addition"
  )));
  assert.ok(unresolved.actions.some((action) => (
    action.path === ".pi/persona-packs/update-team/references/old.md"
    && action.action === "delete"
  )));

  const updateOptions = {
    resolutions: [
      { path: ".pi/agents/packs/update-team/alpha.md", choice: "keep-local" },
      { path: ".pi/agents/packs/update-team/beta.md", choice: "accept-upstream" },
    ],
  };
  const updatePlan = await plan(root, "update", "update-team", updateOptions);
  assert.equal(updatePlan.ready, true);
  await applyApproved(root, "update", "update-team", updatePlan, updateOptions);

  assert.match(await readFile(alphaPath, "utf8"), /Alpha local customization/);
  assert.match(await readFile(betaPath, "utf8"), /Beta upstream v2/);
  assert.equal(await exists(path.join(root, ".pi/persona-packs/update-team/references/old.md")), false);
  assert.equal(
    await readFile(path.join(root, ".pi/persona-packs/update-team/references/new.md"), "utf8"),
    "Added in v2.\n",
  );
  const entry = (await readLock(root)).packs["update-team"];
  assert.equal(entry.version, "2.0.0");
  assert.equal(entry.configuration, "pending");
  assert.deepEqual(entry.detached, [".pi/agents/packs/update-team/alpha.md"]);
  assert.equal(Object.hasOwn(entry.files, ".pi/agents/packs/update-team/alpha.md"), false);

  await writeText(path.join(source, "references/new.md"), "Changed without a version bump.\n");
  await assert.rejects(
    () => plan(root, "update", "update-team"),
    /source content changed without a version bump from 2\.0\.0/,
  );
});

test("updates safely reshape files and directories and reject local topology collisions", async (t) => {
  const root = await temporaryProject(t, "pi-persona-pack-topology-");
  const source = path.join(root, "sources", "shape-team");
  await writePortablePack(source, {
    name: "shape-team",
    references: { "shape/child.md": "Version one.\n" },
  });
  const installPlan = await plan(root, "install", source);
  await applyApproved(root, "install", source, installPlan);
  assert.equal(
    await readFile(path.join(root, "library/shared/shape-team/shape/child.md"), "utf8"),
    "Version one.\n",
  );

  await writePortablePack(source, {
    name: "shape-team",
    version: "2.0.0",
    references: { shape: "Version two.\n" },
  });
  const flattenPlan = await plan(root, "update", "shape-team");
  assert.equal(flattenPlan.ready, true);
  assert.ok(flattenPlan.actions.some((action) => (
    action.path === ".pi/persona-packs.lock.yaml"
    && action.action === "update lifecycle record"
  )));
  await applyApproved(root, "update", "shape-team", flattenPlan);
  assert.equal(
    await readFile(path.join(root, ".pi/persona-packs/shape-team/references/shape"), "utf8"),
    "Version two.\n",
  );
  assert.equal(
    await readFile(path.join(root, "library/shared/shape-team/shape/child.md"), "utf8"),
    "Version one.\n",
  );

  await writePortablePack(source, {
    name: "shape-team",
    version: "3.0.0",
    references: { "shape/child.md": "Version three.\n" },
  });
  const nestPlan = await plan(root, "update", "shape-team");
  await applyApproved(root, "update", "shape-team", nestPlan);
  assert.equal(
    await readFile(path.join(root, ".pi/persona-packs/shape-team/references/shape/child.md"), "utf8"),
    "Version three.\n",
  );
  assert.equal(
    await readFile(path.join(root, "library/shared/shape-team/shape/child.md"), "utf8"),
    "Version one.\n",
  );

  await writeText(
    path.join(root, ".pi/persona-packs/shape-team/references/local-parent"),
    "Local file.\n",
  );
  await writePortablePack(source, {
    name: "shape-team",
    version: "4.0.0",
    references: {
      "shape/child.md": "Version four.\n",
      "local-parent/child.md": "Upstream child.\n",
    },
  });
  await assert.rejects(
    () => plan(root, "update", "shape-team"),
    /cannot be both a file and a directory/,
  );
  assert.equal(
    await readFile(path.join(root, ".pi/persona-packs/shape-team/references/local-parent"), "utf8"),
    "Local file.\n",
  );

  const inverseRoot = await temporaryProject(t, "pi-persona-pack-topology-inverse-");
  const inverseSource = path.join(inverseRoot, "sources", "shape-team");
  await writePortablePack(inverseSource, {
    name: "shape-team",
    references: { shape: "Flat version one.\n" },
  });
  const inverseInstall = await plan(inverseRoot, "install", inverseSource);
  await applyApproved(inverseRoot, "install", inverseSource, inverseInstall);
  await writePortablePack(inverseSource, {
    name: "shape-team",
    version: "2.0.0",
    references: { "shape/child.md": "Nested version two.\n" },
  });
  const inverseUpdate = await plan(inverseRoot, "update", "shape-team");
  await applyApproved(inverseRoot, "update", "shape-team", inverseUpdate);
  assert.equal(
    await readFile(path.join(inverseRoot, ".pi/persona-packs/shape-team/references/shape/child.md"), "utf8"),
    "Nested version two.\n",
  );
  assert.equal(
    await readFile(path.join(inverseRoot, "library/shared/shape-team/shape"), "utf8"),
    "Flat version one.\n",
  );
});

test("library seed paths reject symlink ancestors", async (t) => {
  const root = await temporaryProject(t, "pi-persona-pack-seed-symlink-");
  const source = path.join(root, "sources", "linked-seed-team");
  await writePortablePack(source, {
    name: "linked-seed-team",
    references: { "shape/child.md": "Seed content.\n" },
  });
  const target = path.join(root, "existing-library-file.md");
  const link = path.join(root, "library/shared/linked-seed-team/shape");
  await writeText(target, "Existing user content.\n");
  await mkdir(path.dirname(link), { recursive: true });
  await symlink(target, link);

  await assert.rejects(
    () => plan(root, "install", source),
    /symbolic links are not supported in persona pack paths/,
  );
});

test("updates expose unresolved replacement conflicts before validating the final pack", async (t) => {
  const root = await temporaryProject(t, "pi-persona-pack-replacement-");
  const source = path.join(root, "sources", "replacement-team");
  await writePortablePack(source, {
    name: "replacement-team",
    agents: { old: "Old upstream." },
  });
  await writeText(
    path.join(source, "agents/old.md"),
    agentSource("member", "replacement-team", "Old upstream."),
  );
  const installPlan = await plan(root, "install", source);
  await applyApproved(root, "install", source, installPlan);
  await writeText(
    path.join(root, ".pi/agents/packs/replacement-team/old.md"),
    agentSource("member", "replacement-team", "Local customization."),
  );

  await writePortablePack(source, {
    name: "replacement-team",
    version: "2.0.0",
    agents: { next: "New upstream." },
  });
  await writeText(
    path.join(source, "agents/next.md"),
    agentSource("member", "replacement-team", "New upstream."),
  );
  const unresolved = await plan(root, "update", "replacement-team");
  assert.equal(unresolved.ready, false);
  assert.deepEqual(
    unresolved.conflicts.map((conflict) => conflict.path),
    [".pi/agents/packs/replacement-team/old.md"],
  );

  const options = {
    resolutions: [{
      path: ".pi/agents/packs/replacement-team/old.md",
      choice: "accept-upstream",
    }],
  };
  const replacementPlan = await plan(root, "update", "replacement-team", options);
  assert.equal(replacementPlan.ready, true);
  await applyApproved(root, "update", "replacement-team", replacementPlan, options);
  assert.equal(await exists(path.join(root, ".pi/agents/packs/replacement-team/old.md")), false);
  assert.match(
    await readFile(path.join(root, ".pi/agents/packs/replacement-team/next.md"), "utf8"),
    /New upstream/,
  );

  await writeText(
    path.join(root, ".pi/agents/packs/replacement-team/next.md"),
    agentSource("member", "replacement-team", "Second local customization."),
  );
  await writePortablePack(source, {
    name: "replacement-team",
    version: "3.0.0",
    agents: { next: "Would rename to the project generalist." },
  });
  await writeText(
    path.join(source, "agents/next.md"),
    agentSource("generalist", "replacement-team", "Would rename to the project generalist."),
  );
  const renameConflict = await plan(root, "update", "replacement-team");
  assert.equal(renameConflict.ready, false);
  assert.deepEqual(
    renameConflict.conflicts.map((conflict) => conflict.path),
    [".pi/agents/packs/replacement-team/next.md"],
  );
  const keepLocal = await plan(root, "update", "replacement-team", {
    resolutions: [{
      path: ".pi/agents/packs/replacement-team/next.md",
      choice: "keep-local",
    }],
  });
  assert.equal(keepLocal.ready, true);
});

test("removal distinguishes pristine and user-owned work, leaves no archive, and projects stay isolated", async (t) => {
  const first = await temporaryProject(t, "pi-persona-pack-scope-a-");
  const sibling = await temporaryProject(t, "pi-persona-pack-scope-b-");
  const bundledPlan = await plan(first, "install", "philosopher-7");
  await applyApproved(first, "install", "philosopher-7", bundledPlan);
  assert.match(
    await readFile(path.join(first, "library/personal/socrates/background/biography.md"), "utf8"),
    /Socrates/,
  );
  assert.match(
    await readFile(path.join(first, "library/personal/socrates/method.md"), "utf8"),
    /question/,
  );
  await writeText(
    path.join(first, "library/personal/socrates/local-note.md"),
    "Keep this user note.\n",
  );

  const siblingList = await runPersonaPackAction(sibling, { action: "list" });
  assert.deepEqual(siblingList.installed, []);
  assert.equal(siblingList.available.find((pack) => pack.name === "philosopher-7").installed, false);
  assert.equal(await exists(path.join(sibling, ".pi/persona-packs.lock.yaml")), false);
  assert.equal(await exists(path.join(sibling, ".pi/agents/packs/philosopher-7")), false);

  const ordinary = await plan(first, "remove", "philosopher-7");
  assert.equal(ordinary.confirmation, "ordinary");
  assert.equal(await exists(path.join(first, ".pi/agents/packs/philosopher-7")), true);
  await assert.rejects(
    () => runPersonaPackAction(first, {
      action: "apply",
      operation: "remove",
      target: "philosopher-7",
      confirmed: false,
      planId: ordinary.planId,
    }),
    /approve the displayed plan/,
  );
  assert.equal(await exists(path.join(first, ".pi/agents/packs/philosopher-7")), true);
  const removed = await applyApproved(first, "remove", "philosopher-7", ordinary);
  assert.match(removed.summary, /'philosopher-7' is no longer installed/);
  assert.match(removed.summary, /managed persona and pack files were removed/);
  assert.match(removed.summary, /library\/shared\/philosopher-7\//);
  assert.match(removed.summary, /persona libraries under `library\/personal\/` were kept/);
  assert.equal(await exists(path.join(first, ".pi/agents/packs/philosopher-7")), false);
  assert.equal(await exists(path.join(first, ".pi/persona-packs/philosopher-7")), false);
  assert.equal(
    await readFile(path.join(first, "library/personal/socrates/local-note.md"), "utf8"),
    "Keep this user note.\n",
  );
  assert.equal(
    await exists(path.join(first, "library/personal/socrates/background/biography.md")),
    true,
  );
  assert.equal(await exists(path.join(first, ".pi/persona-packs.lock.yaml")), false);
  assert.equal((await readdir(path.join(first, ".pi"))).some((name) => (
    name.includes("archive") || name.startsWith(".persona-pack-tmp-")
  )), false);

  const authored = await temporaryProject(t, "pi-persona-pack-remove-owned-");
  await runPersonaPackAction(authored, {
    action: "start",
    operation: "author",
    target: "owned-team",
  });
  const authorOptions = {
    personas: authoredTeam("owned-team", ["owner"], {
      prompts: { owner: "Own the project context." },
    }),
  };
  const authorPlan = await plan(authored, "author", "owned-team", authorOptions);
  await applyApproved(authored, "author", "owned-team", authorPlan, authorOptions);

  const destructive = await plan(authored, "remove", "owned-team");
  assert.equal(destructive.confirmation, "permanent-delete");
  await assert.rejects(
    () => applyApproved(authored, "remove", "owned-team", destructive),
    /Explicit permanent-deletion confirmation is required/,
  );
  assert.equal(await exists(path.join(authored, ".pi/agents/packs/owned-team/owner.md")), true);
  const removedAuthored = await applyApproved(authored, "remove", "owned-team", destructive, {
    destructiveConfirmed: true,
  });
  assert.match(removedAuthored.summary, /'owned-team' is no longer installed/);
  assert.match(removedAuthored.summary, /library\/shared\/owned-team\//);
  assert.match(removedAuthored.summary, /persona libraries under `library\/personal\/` were kept/);
  assert.equal(await exists(path.join(authored, ".pi/agents/packs/owned-team")), false);
  assert.equal(await exists(path.join(authored, ".pi/persona-packs/owned-team")), false);
  assert.equal(
    await exists(path.join(authored, "library/personal/owner/_index.md")),
    true,
  );
  assert.equal(await exists(path.join(authored, ".pi/persona-pack-drafts/owned-team")), false);
  assert.equal(await exists(path.join(authored, ".pi/persona-packs.lock.yaml")), false);
  assert.equal((await readdir(path.join(authored, ".pi"))).some((name) => (
    name.includes("archive") || name.startsWith(".persona-pack-tmp-")
  )), false);
});

test("missing installed pack names suggest one close match without changing state", async (t) => {
  const root = await temporaryProject(t, "pi-persona-pack-suggestion-");
  const installPlan = await plan(root, "install", "philosopher-7");
  await applyApproved(root, "install", "philosopher-7", installPlan);
  const expected = /persona pack 'philosophy-7' is not installed\. Did you mean 'philosopher-7'\?/;

  await assert.rejects(
    () => runPersonaPackAction(root, { action: "status", target: "philosophy-7" }),
    expected,
  );
  for (const operation of ["configure", "update", "remove"]) {
    await assert.rejects(() => plan(root, operation, "philosophy-7"), expected);
  }

  const status = await runPersonaPackAction(root, { action: "status", target: "philosopher-7" });
  assert.equal(status.packs[0].name, "philosopher-7");
});

test("remove can permanently discard an unfinished draft without installing it", async (t) => {
  const root = await temporaryProject(t, "pi-persona-pack-draft-remove-");
  await runPersonaPackAction(root, {
    action: "start",
    operation: "author",
    target: "discard-me",
  });
  const removePlan = await plan(root, "remove", "discard-me");
  assert.equal(removePlan.confirmation, "permanent-delete");
  await applyApproved(root, "remove", "discard-me", removePlan, {
    destructiveConfirmed: true,
  });
  assert.equal(await exists(path.join(root, ".pi/persona-pack-drafts/discard-me")), false);
  assert.equal(await exists(path.join(root, ".pi/persona-packs.lock.yaml")), false);
});
