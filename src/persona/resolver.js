import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { discoverPersonaProject, findUniqueAgent, resolveWorkspacePath } from "./agents.js";
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
  const skillResolution = await resolveSkillReads(project.root, skills);
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
      defaultReads: uniqueStrings([
        ...skillResolution.reads,
        ...docResolution.reads,
      ]),
      docManifest: docResolution.manifest,
      skillManifest: skillResolution.manifest,
    },
  };
}

export const resolveAgentPreview = resolveAgentScope;

async function resolveDocReads(root, docs) {
  const manifest = [];
  const reads = [];

  for (const docPath of docs) {
    const files = await expandDocPath(root, docPath);
    manifest.push({
      declared: docPath,
      files,
    });
    reads.push(...files);
  }

  return {
    reads: uniqueStrings(reads),
    manifest,
  };
}

async function resolveSkillReads(root, skills) {
  const manifest = [];
  const reads = [];

  for (const skillPath of skills) {
    const files = await expandSkillPath(root, skillPath);
    manifest.push({
      declared: skillPath,
      files,
    });
    reads.push(...files);
  }

  return {
    reads: uniqueStrings(reads),
    manifest,
  };
}

async function expandDocPath(root, docPath) {
  const resolved = resolveWorkspacePath(root, docPath);
  if (!resolved.ok) return [];

  let fileStat;
  try {
    fileStat = await stat(resolved.path);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  if (fileStat.isFile()) {
    return [toWorkspacePath(root, resolved.path)];
  }
  if (!fileStat.isDirectory()) {
    return [];
  }

  return listDirectoryFiles(root, resolved.path);
}

async function expandSkillPath(root, skillPath) {
  const resolved = resolveWorkspacePath(root, skillPath);
  if (!resolved.ok) return [];

  let fileStat;
  try {
    fileStat = await stat(resolved.path);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  if (fileStat.isFile()) {
    return [toWorkspacePath(root, resolved.path)];
  }
  if (!fileStat.isDirectory()) {
    return [];
  }

  const skillFile = path.join(resolved.path, "skills.md");
  try {
    const skillStat = await stat(skillFile);
    return skillStat.isFile() ? [toWorkspacePath(root, skillFile)] : [];
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function listDirectoryFiles(root, dirPath) {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listDirectoryFiles(root, fullPath));
    } else if (entry.isFile()) {
      files.push(toWorkspacePath(root, fullPath));
    }
  }

  return files.sort();
}

function toWorkspacePath(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function formatAgentRoster(agentRoster) {
  return agentRoster
    .map((agent) => `- ${agent.name} - ${agent.role}: ${agent.description}`)
    .join("\n");
}
