import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { parseFrontmatterDocument } from "./frontmatter.js";

const AGENT_DIR = ".pi/agents";

export async function discoverPersonaProject(root) {
  const agentRoot = path.join(root, AGENT_DIR);
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
    const launchable = !isControl && Boolean(parsed.frontmatter.name && parsed.frontmatter.description);

    parsedFiles.push({
      filePath,
      relativePath,
      fileName,
      isControl,
      launchable,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      parseErrors: parsed.errors,
      name: parsed.frontmatter.name,
      role: parsed.frontmatter.role,
      description: parsed.frontmatter.description,
    });
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

function toAgent(file) {
  return {
    filePath: file.filePath,
    relativePath: file.relativePath,
    fileName: file.fileName,
    name: file.frontmatter.name,
    role: file.frontmatter.role ?? "specialist",
    description: file.frontmatter.description,
    model: file.frontmatter.model,
    tools: file.frontmatter.tools ?? [],
    docs: file.frontmatter.docs ?? [],
    consults: file.frontmatter.consults ?? [],
    tags: file.frontmatter.tags ?? [],
    frontmatter: file.frontmatter,
    body: file.body,
  };
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
  const resolved = resolveWorkspacePath(root, relativePath);
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
