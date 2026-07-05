import { discoverPersonaProject, findUniqueAgent } from "./agents.js";
import { inspectDocPath } from "./doc-index.js";
import { uniqueStrings } from "./frontmatter.js";

export async function resolveAgentScope(root, agentName) {
  const project = await discoverPersonaProject(root);
  const agent = findUniqueAgent(project, agentName);

  const baselineFrontmatter = project.baseline?.frontmatter ?? {};
  const baselineBody = project.baseline?.body?.trim() ?? "";
  const agentBody = agent.body?.trim() ?? "";

  const docs = uniqueStrings([
    ...(baselineFrontmatter.docs ?? []),
    ...(agent.docs ?? []),
  ]);
  const docResolution = await resolveDocReads(project.root, docs);
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
    },
  };
}

export const resolveAgentPreview = resolveAgentScope;

async function resolveDocReads(root, docs) {
  const manifest = [];
  const reads = [];

  for (const docPath of docs) {
    const expansion = await expandDocPath(root, docPath);
    manifest.push({
      declared: docPath,
      files: expansion.files,
      deferred: expansion.deferred,
      indexFile: expansion.indexFile,
    });
    reads.push(...expansion.files);
  }

  return {
    reads: uniqueStrings(reads),
    manifest,
  };
}

async function expandDocPath(root, docPath) {
  const inspection = await inspectDocPath(root, docPath);
  return {
    files: inspection.files ?? [],
    deferred: inspection.deferred ?? [],
    indexFile: inspection.indexFile ?? null,
  };
}

function formatAgentRoster(agentRoster) {
  return agentRoster
    .map((agent) => `- ${agent.name} - ${agent.role}: ${agent.description}`)
    .join("\n");
}
