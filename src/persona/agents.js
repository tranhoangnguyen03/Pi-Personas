import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { parseFrontmatterDocument } from "./frontmatter.js";
import { validatePersonaFile } from "./schema.js";

const AGENT_DIR = ".pi/agents";

export async function discoverPersonaProject(root) {
  const resolvedAgentRoot = await resolveWorkspacePathForAccess(root, AGENT_DIR);
  if (!resolvedAgentRoot.ok) {
    throw new Error(`persona agent path must stay inside workspace: ${AGENT_DIR} (${resolvedAgentRoot.reason})`);
  }
  const agentRoot = resolvedAgentRoot.path;
  const files = await listMarkdownFiles(agentRoot).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });

  const parsedFiles = [];
  for (const filePath of files) {
    const source = await readFile(filePath, "utf8");
    const relativePath = path.relative(root, filePath).split(path.sep).join("/");
    const parsed = parseFrontmatterDocument(source, relativePath);
    const fileName = path.basename(filePath);
    const isControl = fileName.startsWith("_");
    const file = {
      filePath,
      relativePath,
      fileName,
      isControl,
      launchable: false,
      frontmatter: parsed.frontmatter,
      rawFrontmatter: parsed.rawFrontmatter,
      body: parsed.body,
      parseErrors: parsed.errors,
      name: parsed.frontmatter.name,
      role: parsed.frontmatter.role,
      description: parsed.frontmatter.description,
    };
    file.schemaIssues = validatePersonaFile(file);
    file.launchable = !isControl
      && file.parseErrors.length === 0
      && !file.schemaIssues.some((issue) => issue.severity === "error");
    parsedFiles.push(file);
  }

  const baseline = parsedFiles.find((file) => file.fileName === "_baseline.md") ?? null;
  const agents = parsedFiles.filter((file) => file.launchable).map(toAgent);
  const controlFiles = parsedFiles.filter((file) => file.isControl);

  return {
    root,
    agentRoot,
    files: parsedFiles,
    agents,
    baseline,
    controlFiles,
  };
}

export function findUniqueAgent(project, agentName, label = "agent") {
  const matches = project.agents.filter((candidate) => candidate.name === agentName);
  if (matches.length === 0) throw new Error(`Unknown ${label}: ${agentName}`);
  if (matches.length > 1) {
    throw new Error(`ambiguous ${label} name '${agentName}' in ${formatAgentPaths(matches)}`);
  }
  return matches[0];
}

export function assertUniqueAgentNames(project) {
  const byName = new Map();
  for (const agent of project.agents) {
    const entries = byName.get(agent.name) ?? [];
    entries.push(agent);
    byName.set(agent.name, entries);
  }

  for (const [name, agents] of byName.entries()) {
    if (agents.length > 1) {
      throw new Error(`ambiguous agent name '${name}' in ${formatAgentPaths(agents)}`);
    }
  }
}

export function getPrimaryGeneralistState(project) {
  const generalists = project.agents.filter((agent) => agent.role === "generalist");
  const explicitPrimary = generalists.filter((agent) => agent.primary === true);
  const primaryDeclared = generalists.some((agent) => agent.primaryDeclared);
  const effectivePrimary = explicitPrimary.length > 0
    ? explicitPrimary
    : !primaryDeclared && generalists.length === 1
      ? generalists
      : [];

  return {
    generalists,
    explicitPrimary,
    effectivePrimary,
    primaryDeclared,
  };
}

export function findPrimaryGeneralist(project, purpose = "generalist routing") {
  const state = getPrimaryGeneralistState(project);
  if (state.effectivePrimary.length === 1) return state.effectivePrimary[0];
  throw new Error(formatPrimaryGeneralistError(state, purpose));
}

export function formatPrimaryGeneralistError(state, purpose = "generalist routing") {
  if (state.generalists.length === 0) {
    return `exactly one primary generalist required for ${purpose}; found 0 generalists`;
  }

  if (state.explicitPrimary.length > 1) {
    return `multiple primary generalist agents for ${purpose}: ${formatAgentNamesAndPaths(state.explicitPrimary)}. Set exactly one generalist to primary: true and set the others to primary: false.`;
  }

  return `exactly one primary generalist required for ${purpose}; found 0 primary generalists among ${state.generalists.length} generalists: ${formatAgentNamesAndPaths(state.generalists)}. Set exactly one generalist to primary: true and set the others to primary: false.`;
}

function toAgent(file) {
  const primaryDeclared = Object.hasOwn(file.frontmatter, "primary");
  return {
    filePath: file.filePath,
    relativePath: file.relativePath,
    fileName: file.fileName,
    name: file.frontmatter.name,
    role: file.frontmatter.role ?? "specialist",
    primary: file.frontmatter.primary === true,
    primaryDeclared,
    description: file.frontmatter.description,
    model: file.frontmatter.model,
    tools: file.frontmatter.tools ?? [],
    docs: file.frontmatter.docs ?? [],
    skills: file.frontmatter.skills ?? [],
    consults: file.frontmatter.consults ?? [],
    tags: file.frontmatter.tags ?? [],
    frontmatter: file.frontmatter,
    body: file.body,
  };
}

function formatAgentPaths(agents) {
  return agents.map((agent) => agent.relativePath).join(", ");
}

function formatAgentNamesAndPaths(agents) {
  return agents.map((agent) => `${agent.name} (${agent.relativePath})`).join(", ");
}

async function listMarkdownFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listMarkdownFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

export async function pathExists(root, relativePath) {
  const resolved = await resolveWorkspacePathForAccess(root, relativePath);
  if (!resolved.ok) return false;
  try {
    await stat(resolved.path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export function resolveWorkspacePath(root, relativePath) {
  if (typeof relativePath !== "string" || relativePath.trim() === "") {
    return {
      ok: false,
      reason: "empty",
    };
  }
  if (path.isAbsolute(relativePath)) {
    return {
      ok: false,
      reason: "absolute",
    };
  }

  const workspaceRoot = path.resolve(root);
  const resolvedPath = path.resolve(workspaceRoot, relativePath);
  const relativeFromRoot = path.relative(workspaceRoot, resolvedPath);
  if (relativeFromRoot.startsWith("..") || path.isAbsolute(relativeFromRoot)) {
    return {
      ok: false,
      reason: "escape",
    };
  }

  return {
    ok: true,
    path: resolvedPath,
  };
}

export async function resolveWorkspacePathForAccess(root, relativePath) {
  const resolved = resolveWorkspacePath(root, relativePath);
  if (!resolved.ok) return resolved;

  const workspaceRoot = path.resolve(root);
  const realWorkspaceRoot = await realpath(workspaceRoot);
  let existingPath = resolved.path;

  while (true) {
    try {
      const realExistingPath = await realpath(existingPath);
      if (!isWithin(realWorkspaceRoot, realExistingPath)) {
        return {
          ok: false,
          reason: "symlink-escape",
        };
      }
      return resolved;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(existingPath);
      if (parent === existingPath) {
        return {
          ok: false,
          reason: "unresolvable",
        };
      }
      existingPath = parent;
    }
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
