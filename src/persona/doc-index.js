import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { discoverPersonaProject, resolveWorkspacePath } from "./agents.js";
import { uniqueStrings } from "./frontmatter.js";

export const DOC_INDEX_FILE = "_index.md";
export const DOC_INDEX_BLOCK_START = "<!-- pi-persona-index:start -->";
export const DOC_INDEX_BLOCK_END = "<!-- pi-persona-index:end -->";

export function isIndexFileName(fileName) {
  return path.parse(fileName).name === "_index";
}

export async function inspectDocPath(root, docPath) {
  const resolved = resolveWorkspacePath(root, docPath);
  if (!resolved.ok) {
    return {
      ok: false,
      docPath,
      reason: resolved.reason,
      type: "invalid",
      files: [],
      deferred: [],
      indexFile: null,
    };
  }

  let fileStat;
  try {
    fileStat = await stat(resolved.path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        ok: false,
        docPath,
        reason: "missing",
        type: "missing",
        files: [],
        deferred: [],
        indexFile: null,
      };
    }
    throw error;
  }

  if (fileStat.isFile()) {
    return {
      ok: true,
      docPath,
      type: "file",
      files: [toWorkspacePath(root, resolved.path)],
      deferred: [],
      indexFile: null,
    };
  }

  if (!fileStat.isDirectory()) {
    return {
      ok: true,
      docPath,
      type: "other",
      files: [],
      deferred: [],
      indexFile: null,
    };
  }

  const expansion = await expandDirectory(root, resolved.path);
  return {
    ok: true,
    docPath,
    type: "directory",
    ...expansion,
  };
}

export async function createDocsIndex(root, options = {}) {
  const targets = options.all
    ? await collectDeclaredDocDirectories(root)
    : [options.target].filter(Boolean);

  if (targets.length === 0) {
    return {
      results: [],
    };
  }

  const results = [];
  for (const target of uniqueStrings(targets)) {
    try {
      results.push(await writeDocsIndex(root, target));
    } catch (error) {
      results.push({
        docPath: target,
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    results,
  };
}

export function formatDocsIndexReport(result) {
  const lines = [
    "# Pi Persona Docs Index",
    "",
  ];

  if (!result.results || result.results.length === 0) {
    lines.push("- no declared doc directories found");
    return lines.join("\n");
  }

  for (const entry of result.results) {
    if (entry.status === "updated") {
      lines.push(`- updated ${entry.indexPath}`);
      lines.push(`  top-level files: ${entry.files.length}`);
      lines.push(`  nested files: ${entry.deferred.length}`);
    } else {
      lines.push(`- error ${entry.docPath}: ${entry.message}`);
    }
  }

  return lines.join("\n");
}

export function parsePersonaIndexArgs(args) {
  const tokens = tokenizeArgs(args);
  if (tokens.length === 0) {
    return { all: true };
  }

  let all = false;
  let target = null;
  for (const token of tokens) {
    if (token === "--all") {
      all = true;
      continue;
    }
    if (target) {
      throw new Error(`unexpected /persona index argument: ${token}`);
    }
    target = token;
  }

  if (all && target) {
    throw new Error("Usage: /persona index [docs-dir] or /persona index --all");
  }

  return {
    all: all || !target,
    target,
  };
}

async function writeDocsIndex(root, docPath) {
  const inspection = await inspectDocPath(root, docPath);
  if (!inspection.ok) {
    throw new Error(`docs path cannot be indexed: ${docPath} (${inspection.reason})`);
  }
  if (inspection.type !== "directory") {
    throw new Error(`docs path is not a directory: ${docPath}`);
  }

  const resolved = resolveWorkspacePath(root, docPath);
  const indexPath = path.join(resolved.path, DOC_INDEX_FILE);
  const relativeIndexPath = toWorkspacePath(root, indexPath);
  const indexedInspection = withGeneratedIndexFile(inspection, relativeIndexPath);
  const managedBlock = renderManagedIndexBlock(indexedInspection);
  const nextContent = await mergeManagedBlock(indexPath, docPath, managedBlock);

  await writeFile(indexPath, nextContent, "utf8");

  return {
    status: "updated",
    docPath,
    indexPath: relativeIndexPath,
    files: indexedInspection.files,
    deferred: indexedInspection.deferred,
  };
}

async function collectDeclaredDocDirectories(root) {
  const project = await discoverPersonaProject(root);
  const declared = [];

  if (project.baseline) {
    declared.push(...(project.baseline.frontmatter.docs ?? []));
  }
  for (const agent of project.agents) {
    declared.push(...agent.docs);
  }

  const directories = [];
  for (const docPath of uniqueStrings(declared)) {
    const inspection = await inspectDocPath(root, docPath);
    if (inspection.ok && inspection.type === "directory") {
      directories.push(docPath);
    }
  }
  return directories;
}

async function mergeManagedBlock(indexPath, docPath, managedBlock) {
  let existing = "";
  try {
    existing = await readFile(indexPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  if (!existing.trim()) {
    return [
      `# ${docPath} Index`,
      "",
      "This file is the navigation catalogue for Pi Persona progressive discovery.",
      "Keep high-signal notes above the generated block. The generated block can be refreshed with `/persona index`.",
      "",
      managedBlock,
      "",
    ].join("\n");
  }

  const start = existing.indexOf(DOC_INDEX_BLOCK_START);
  const end = existing.indexOf(DOC_INDEX_BLOCK_END);
  if (start !== -1 && end !== -1 && end > start) {
    const before = existing.slice(0, start).replace(/\s+$/g, "");
    const after = existing.slice(end + DOC_INDEX_BLOCK_END.length).replace(/^\s+/g, "");
    return [before, managedBlock, after].filter(Boolean).join("\n\n") + "\n";
  }

  return `${existing.replace(/\s+$/g, "")}\n\n${managedBlock}\n`;
}

function renderManagedIndexBlock(inspection) {
  const lines = [
    DOC_INDEX_BLOCK_START,
    "## Reading Protocol",
    "",
    "- Start with this index and the first-layer files.",
    "- Open nested files deliberately when the request needs their content.",
    "- Keep human or agent annotations outside this generated block.",
    "",
    "## First Layer",
    "",
  ];

  if (inspection.files.length === 0) {
    lines.push("- none");
  } else {
    for (const filePath of inspection.files) {
      lines.push(`- \`${relativeToDocPath(inspection.docPath, filePath)}\``);
    }
  }

  lines.push("", "## Nested Catalogue", "");
  if (inspection.deferred.length === 0) {
    lines.push("- none");
  } else {
    for (const filePath of inspection.deferred) {
      lines.push(`- \`${relativeToDocPath(inspection.docPath, filePath)}\``);
    }
  }

  lines.push(DOC_INDEX_BLOCK_END);
  return lines.join("\n");
}

function withGeneratedIndexFile(inspection, relativeIndexPath) {
  if (inspection.files.includes(relativeIndexPath)) {
    return inspection;
  }
  return {
    ...inspection,
    files: sortIndexFirst([relativeIndexPath, ...inspection.files]),
    indexFile: inspection.indexFile ?? relativeIndexPath,
  };
}

async function expandDirectory(root, dirPath) {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const files = [];
  const deferred = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isFile()) {
      files.push(toWorkspacePath(root, fullPath));
    } else if (entry.isDirectory()) {
      deferred.push(...await listDirectoryFiles(root, fullPath));
    }
  }

  const sortedFiles = sortIndexFirst(files);
  return {
    files: sortedFiles,
    deferred: deferred.sort(),
    indexFile: sortedFiles.find((filePath) => isIndexFileName(path.basename(filePath))) ?? null,
  };
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

  return files;
}

function sortIndexFirst(files) {
  return [...files].sort((left, right) => {
    const leftIndex = isIndexFileName(path.basename(left)) ? 0 : 1;
    const rightIndex = isIndexFileName(path.basename(right)) ? 0 : 1;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    return left.localeCompare(right);
  });
}

function relativeToDocPath(docPath, filePath) {
  const normalizedDocPath = docPath.endsWith("/") ? docPath : `${docPath}/`;
  return filePath.startsWith(normalizedDocPath)
    ? filePath.slice(normalizedDocPath.length)
    : filePath;
}

function toWorkspacePath(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function tokenizeArgs(input) {
  const tokens = [];
  let current = "";
  let quote = null;
  let tokenStarted = false;

  for (const char of String(input)) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      tokenStarted = true;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (tokenStarted) {
        tokens.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }

    current += char;
    tokenStarted = true;
  }

  if (quote) {
    throw new Error("unterminated quote in /persona index arguments");
  }
  if (tokenStarted) {
    tokens.push(current);
  }

  return tokens;
}
