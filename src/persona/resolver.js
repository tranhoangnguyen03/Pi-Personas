import { readFile } from "node:fs/promises";
import path from "node:path";

import { discoverPersonaProject, findUniqueAgent } from "./agents.js";
import { inspectDocPath } from "./doc-index.js";
import { uniqueStrings } from "./frontmatter.js";

// `options.project`, when supplied, replaces workspace discovery (used by a
// bound pack session, whose roster comes from a retained snapshot instead of
// `root`'s `.pi/agents`). `options.packRoot`, when supplied, is that
// snapshot's own root: `docs` and `packDocs` both then resolve through
// `resolveScopedAgentDocs` (workspace docs against `root`, packDocs against
// `<packRoot>/references`), so a pack-bound scope keeps reading its own
// content by absolute path while `root`'s workspace docs stay live. Neither
// option changes the plain single-root behavior below when omitted.
export async function resolveAgentScope(root, agentName, options = {}) {
  const project = options.project ?? await discoverPersonaProject(root);
  const agent = findUniqueAgent(project, agentName);
  const packRoot = options.packRoot;

  const baselineFrontmatter = project.baseline?.frontmatter ?? {};
  const baselineBody = project.baseline?.body?.trim() ?? "";
  const agentBody = agent.body?.trim() ?? "";

  const docs = uniqueStrings([
    ...(baselineFrontmatter.docs ?? []),
    ...(agent.docs ?? []),
  ]);
  const docResolution = packRoot
    ? normalizeScopedDocResolution(await resolveScopedAgentDocs(
      {
        docs,
        packDocs: uniqueStrings([
          ...(baselineFrontmatter.packDocs ?? []),
          ...(agent.packDocs ?? []),
        ]),
      },
      { workspaceRoot: docs.length > 0 ? root : undefined, packRoot },
    ))
    : await resolveDocReads(project.root, docs);
  const skills = uniqueStrings([
    ...(baselineFrontmatter.skills ?? []),
    ...(agent.skills ?? []),
  ]);
  const tools = uniqueStrings([
    ...(baselineFrontmatter.tools ?? []),
    ...(agent.tools ?? []),
  ]);
  const agentRoster = project.agents.map((candidate) => ({
    name: candidate.name,
    role: candidate.role,
    description: candidate.description,
  }));

  const promptSections = [];
  if (baselineBody) {
    promptSections.push({
      label: "Baseline",
      body: baselineBody,
    });
  }
  if (agentRoster.length > 0) {
    promptSections.push({
      label: "Agent Roster",
      body: formatAgentRoster(agentRoster),
    });
  }
  if (agentBody) {
    promptSections.push({
      label: "Agent",
      body: agentBody,
    });
  }

  return {
    agent,
    baseline: project.baseline,
    docs,
    skills,
    tools,
    consults: agent.consults,
    tags: agent.tags,
    agentRoster,
    promptSections,
    prompt: promptSections.map((section) => `## ${section.label}\n\n${section.body}`).join("\n\n"),
    derived: {
      defaultReads: uniqueStrings(docResolution.reads),
      docManifest: docResolution.manifest,
      docIndexes: docResolution.indexes,
    },
  };
}

export const resolveAgentPreview = resolveAgentScope;

function normalizeScopedDocResolution(resolution) {
  return {
    reads: resolution.defaultReads,
    manifest: resolution.docManifest,
    indexes: resolution.docIndexes,
  };
}

/**
 * Resolves a persona's `docs` (workspace-relative) and `packDocs`
 * (pack-relative) declarations against their own explicit roots, reusing the
 * same containment/symlink-escape checks as ordinary workspace doc reads.
 * `packRoot` is the pack's own root — the same root `readPortablePersonaPack`
 * returns, containing `pack.yaml`, `agents/`, and `references/` — not a
 * pre-resolved references directory; `packDocs` is resolved deterministically
 * against `<packRoot>/references`, matching how pack-source validation
 * resolves the same field. `docs` stays optional read guidance when a
 * `workspaceRoot` is supplied (a missing or escaping entry resolves to no
 * reads); declaring `docs` without a `workspaceRoot`, like declaring
 * `packDocs` without a `packRoot`, is a caller error, not silently-empty
 * output. `packDocs` names content the pack itself ships, so a missing or
 * escaping entry is a clear pack-authoring error instead. Pack-owned reads
 * and their manifest/index paths come back as absolute filesystem paths, so
 * they stay directly readable regardless of the caller's current working
 * directory; workspace reads stay workspace-relative, matching
 * `resolveAgentScope`'s existing convention.
 */
export async function resolveScopedAgentDocs(agent, roots = {}) {
  const { workspaceRoot, packRoot } = roots;
  const docs = uniqueStrings(agent?.docs ?? []);
  const packDocs = uniqueStrings(agent?.packDocs ?? []);

  if (docs.length > 0 && !workspaceRoot) {
    throw new Error("docs declared without a workspace root");
  }
  if (packDocs.length > 0 && !packRoot) {
    throw new Error("packDocs declared without a pack reference root");
  }

  const workspaceResolution = workspaceRoot
    ? await resolveDocReads(workspaceRoot, docs)
    : { reads: [], manifest: [], indexes: [] };
  const packResolution = packRoot
    ? await resolveDocReads(path.join(packRoot, "references"), packDocs, { required: true, absolute: true })
    : { reads: [], manifest: [], indexes: [] };

  return {
    defaultReads: uniqueStrings([...workspaceResolution.reads, ...packResolution.reads]),
    docManifest: [
      ...workspaceResolution.manifest.map((entry) => ({ ...entry, origin: "workspace" })),
      ...packResolution.manifest.map((entry) => ({ ...entry, origin: "pack" })),
    ],
    docIndexes: [
      ...workspaceResolution.indexes.map((entry) => ({ ...entry, origin: "workspace" })),
      ...packResolution.indexes.map((entry) => ({ ...entry, origin: "pack" })),
    ],
  };
}

async function resolveDocReads(root, docs, options = {}) {
  const required = options.required === true;
  const absolute = options.absolute === true;
  const toOutput = absolute ? (relativePath) => path.join(root, relativePath) : (relativePath) => relativePath;
  const manifest = [];
  const reads = [];
  const indexes = [];

  for (const docPath of docs) {
    const inspection = await inspectDocPath(root, docPath);
    if (!inspection.ok) {
      if (required) {
        throw new Error(`pack reference not found: ${docPath} (${inspection.reason})`);
      }
      manifest.push({ declared: docPath, files: [], deferred: [], indexFile: null });
      continue;
    }
    const files = (inspection.files ?? []).map(toOutput);
    const deferred = (inspection.deferred ?? []).map(toOutput);
    const indexFile = inspection.indexFile ? toOutput(inspection.indexFile) : null;
    manifest.push({ declared: docPath, files, deferred, indexFile });
    reads.push(...files);
    if (indexFile) {
      indexes.push({
        declared: docPath,
        indexFile,
        content: await readFile(absolute ? indexFile : path.join(root, indexFile), "utf8"),
      });
    }
  }

  return {
    reads: uniqueStrings(reads),
    manifest,
    indexes,
  };
}

function formatAgentRoster(agentRoster) {
  return agentRoster
    .map((agent) => `- ${agent.name} - ${agent.role}: ${agent.description}`)
    .join("\n");
}
