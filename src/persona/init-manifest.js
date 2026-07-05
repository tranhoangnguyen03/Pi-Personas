import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";

import { resolveWorkspacePath } from "./agents.js";
import { uniqueStrings } from "./frontmatter.js";
import { normalizeAgentName } from "./scaffold.js";
import { ensureNestedConsultRuntimeOverride, readProjectSettings } from "./settings.js";

const VALID_ROLES = new Set(["generalist", "specialist"]);

export function parsePersonaInitArgs(args) {
  const tokens = tokenizeArgs(args);
  if (tokens.length === 0) return { mode: "basic" };
  if (tokens[0] === "draft") {
    throw new Error("/persona init draft is not implemented yet; create or edit the YAML manifest manually, then run /persona init --from <file>");
  }

  const status = tokens[0] === "status";
  const optionTokens = status ? tokens.slice(1) : tokens;
  const plan = optionTokens.includes("--plan");
  const from = readOption(optionTokens, "from");
  if (!from) throw new Error("missing --from <file> for manifest-backed /persona init");
  if (status && plan) throw new Error("/persona init status does not accept --plan");

  return {
    mode: status ? "status" : plan ? "plan" : "apply",
    from,
  };
}

export async function planPersonaInitFromManifest(root, sourcePath) {
  const manifest = await readManifest(root, sourcePath);
  const actions = [];
  for (const entry of buildManifestEntries(manifest)) {
    if (entry.kind === "file") {
      actions.push({
        kind: "file",
        path: entry.path,
        status: await exists(root, entry.path) ? "preserve" : "create",
      });
      continue;
    }
    actions.push({
      kind: "runtime",
      agent: entry.agent,
      status: await hasRuntimeOverride(root, entry.agent) ? "present" : "update",
    });
  }

  return baseResult("plan", manifest, actions);
}

export async function applyPersonaInitFromManifest(root, sourcePath) {
  const manifest = await readManifest(root, sourcePath);
  const actions = [];
  for (const entry of buildManifestEntries(manifest)) {
    if (entry.kind === "file") {
      const created = await writeFileIfMissing(root, entry.path, entry.content);
      actions.push({
        kind: "file",
        path: entry.path,
        status: created ? "created" : "preserved",
      });
      continue;
    }

    if (await hasRuntimeOverride(root, entry.agent)) {
      actions.push({ kind: "runtime", agent: entry.agent, status: "present" });
    } else {
      await ensureNestedConsultRuntimeOverride(root, entry.agent);
      actions.push({ kind: "runtime", agent: entry.agent, status: "updated" });
    }
  }

  return baseResult("apply", manifest, actions);
}

export async function statusPersonaInitFromManifest(root, sourcePath) {
  const manifest = await readManifest(root, sourcePath);
  const items = [];
  for (const entry of buildManifestEntries(manifest)) {
    if (entry.kind === "file") {
      items.push({
        state: await exists(root, entry.path) ? "done" : "todo",
        label: entry.path,
      });
      continue;
    }
    items.push({
      state: await hasRuntimeOverride(root, entry.agent) ? "done" : "todo",
      label: `runtime override: ${entry.agent}`,
    });
  }

  return {
    mode: "status",
    source: manifest.source,
    projectName: manifest.projectName,
    items,
  };
}

export function formatPersonaInitManifestReport(result) {
  if (result.mode === "status") return formatStatusReport(result);
  const title = result.mode === "apply" ? "Pi Persona Init Applied" : "Pi Persona Init Plan";
  const lines = [
    `# ${title}`,
    "",
    `Source: ${result.source}`,
    `Project: ${result.projectName}`,
    "",
    "## Files",
  ];

  const fileActions = result.actions.filter((action) => action.kind === "file");
  if (fileActions.length === 0) {
    lines.push("- none");
  } else {
    for (const action of fileActions) {
      lines.push(`- ${action.status} ${action.path}`);
    }
  }

  lines.push("", "## Runtime");
  const runtimeActions = result.actions.filter((action) => action.kind === "runtime");
  if (runtimeActions.length === 0) {
    lines.push("- none");
  } else {
    for (const action of runtimeActions) {
      lines.push(`- ${action.status} runtime override: ${action.agent}`);
    }
  }

  lines.push(
    "",
    result.mode === "plan"
      ? `Next: run /persona init --from ${result.source}`
      : "Next: run /persona doctor",
  );
  return lines.join("\n");
}

function formatStatusReport(result) {
  const lines = [
    "# Pi Persona Init Status",
    "",
    `Source: ${result.source}`,
    `Project: ${result.projectName}`,
    "",
  ];
  for (const item of result.items) {
    lines.push(`[${item.state}] ${item.label}`);
  }
  lines.push("", "[next] run /persona doctor");
  return lines.join("\n");
}

function baseResult(mode, manifest, actions) {
  return {
    mode,
    source: manifest.source,
    projectName: manifest.projectName,
    actions,
  };
}

async function readManifest(root, sourcePath) {
  const resolved = resolveWorkspacePath(root, sourcePath);
  if (!resolved.ok) throw new Error(`manifest path must stay inside workspace: ${sourcePath}`);
  const source = await readFile(resolved.path, "utf8");
  const document = parseDocument(source, {
    prettyErrors: false,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error(`${sourcePath}: ${document.errors[0].message}`);
  }
  return normalizeManifest(document.toJS(), sourcePath, root);
}

function normalizeManifest(raw, sourcePath, root) {
  if (!isRecord(raw)) throw new Error(`${sourcePath}: manifest must be a YAML mapping`);
  if (raw.version !== 1) throw new Error(`${sourcePath}: version must be 1`);
  if (!isRecord(raw.project) || !nonEmpty(raw.project.name)) {
    throw new Error(`${sourcePath}: project.name is required`);
  }
  if (!isRecord(raw.baseline) || !nonEmpty(raw.baseline.prompt)) {
    throw new Error(`${sourcePath}: baseline.prompt is required`);
  }
  if (!Array.isArray(raw.agents) || raw.agents.length === 0) {
    throw new Error(`${sourcePath}: agents must contain at least one agent`);
  }

  const agents = raw.agents.map((agent, index) => normalizeAgent(agent, `${sourcePath}: agents[${index}]`, root));
  const names = new Set();
  for (const agent of agents) {
    if (names.has(agent.name)) throw new Error(`${sourcePath}: duplicate agent name: ${agent.name}`);
    names.add(agent.name);
  }
  const primaryGeneralists = agents.filter((agent) => agent.role === "generalist" && agent.primary === true);
  if (primaryGeneralists.length !== 1) {
    throw new Error(`${sourcePath}: exactly one generalist must have primary: true`);
  }

  const docsFiles = normalizeDocsFiles(raw.docs?.files, sourcePath, root);
  const baselineDocs = normalizePathList(raw.baseline.docs, `${sourcePath}: baseline.docs`, root);
  return {
    source: sourcePath,
    projectName: String(raw.project.name).trim(),
    baseline: {
      docs: baselineDocs,
      skills: normalizeSkillList(raw.baseline.skills, `${sourcePath}: baseline.skills`),
      prompt: String(raw.baseline.prompt).trim(),
    },
    docsFiles,
    agents,
  };
}

function normalizeAgent(raw, label, root) {
  if (!isRecord(raw)) throw new Error(`${label}: agent must be a mapping`);
  for (const field of ["name", "role", "description", "prompt"]) {
    if (!nonEmpty(raw[field])) throw new Error(`${label}: ${field} is required`);
  }
  const name = String(raw.name).trim();
  if (normalizeAgentName(name) !== name) {
    throw new Error(`${label}: name must already be command-safe: ${normalizeAgentName(name)}`);
  }
  const role = String(raw.role).trim();
  if (!VALID_ROLES.has(role)) throw new Error(`${label}: role must be generalist or specialist`);
  const primary = raw.primary === true;
  return {
    name,
    role,
    primary,
    description: String(raw.description).trim(),
    docs: normalizePathList(raw.docs, `${label}.docs`, root),
    skills: normalizeSkillList(raw.skills, `${label}.skills`),
    model: nonEmpty(raw.model) ? String(raw.model).trim() : "",
    prompt: String(raw.prompt).trim(),
  };
}

function normalizeDocsFiles(value, sourcePath, root) {
  if (value === undefined || value === null) return [];
  if (!isRecord(value)) throw new Error(`${sourcePath}: docs.files must be a mapping`);
  return Object.entries(value).map(([filePath, content]) => {
    assertWorkspacePath(root, filePath, `${sourcePath}: docs.files`);
    return {
      path: filePath,
      content: `${String(content ?? "").replace(/\r\n/g, "\n").trimEnd()}\n`,
    };
  });
}

function normalizePathList(value, label, root) {
  return normalizeList(value).map((entry) => {
    assertWorkspacePath(root, entry, label);
    return entry;
  });
}

function normalizeSkillList(value, label) {
  return normalizeList(value).map((entry) => {
    if (looksLikePath(entry)) {
      throw new Error(`${label}: skills must be native pi-subagents skill names, not paths: ${entry}`);
    }
    return entry;
  });
}

function buildManifestEntries(manifest) {
  return [
    {
      kind: "file",
      path: ".pi/agents/_baseline.md",
      content: renderBaseline(manifest.baseline),
    },
    ...manifest.agents.map((agent) => ({
      kind: "file",
      path: `.pi/agents/${agent.name}.md`,
      content: renderAgent(agent),
    })),
    ...manifest.docsFiles.map((file) => ({
      kind: "file",
      path: file.path,
      content: file.content,
    })),
    ...manifest.agents.map((agent) => ({
      kind: "runtime",
      agent: agent.name,
    })),
  ];
}

function renderBaseline(baseline) {
  return `---
${renderListField("docs", baseline.docs)}${renderListField("skills", baseline.skills)}---
${baseline.prompt}
`;
}

function renderAgent(agent) {
  const modelLine = agent.model ? `model: ${agent.model}\n` : "";
  const primaryLine = agent.role === "generalist" ? `primary: ${agent.primary ? "true" : "false"}\n` : "";
  return `---
name: ${agent.name}
role: ${agent.role}
${primaryLine}description: ${agent.description}
${modelLine}${renderListField("docs", agent.docs)}${renderListField("skills", agent.skills)}---
${agent.prompt}
`;
}

function renderListField(field, values) {
  const unique = uniqueStrings(values);
  if (unique.length === 0) return `${field}:\n`;
  return `${field}:\n${unique.map((value) => `  - ${value}`).join("\n")}\n`;
}

async function writeFileIfMissing(root, relativePath, content) {
  const resolved = resolveWorkspacePath(root, relativePath);
  if (!resolved.ok) throw new Error(`path must stay inside workspace: ${relativePath}`);
  await mkdir(path.dirname(resolved.path), { recursive: true });
  try {
    await writeFile(resolved.path, content, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
}

async function exists(root, relativePath) {
  const resolved = resolveWorkspacePath(root, relativePath);
  if (!resolved.ok) return false;
  try {
    await access(resolved.path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function hasRuntimeOverride(root, agentName) {
  const settings = await readProjectSettings(root);
  const tools = settings?.subagents?.agentOverrides?.[agentName]?.tools;
  return normalizeList(tools).includes("subagent");
}

function assertWorkspacePath(root, relativePath, label) {
  const resolved = resolveWorkspacePath(root, relativePath);
  if (!resolved.ok) throw new Error(`${label}: path must stay inside workspace: ${relativePath}`);
}

function readOption(tokens, key) {
  const prefix = `--${key}=`;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.startsWith(prefix)) return token.slice(prefix.length);
    if (token === `--${key}`) return tokens[index + 1];
  }
  return "";
}

function tokenizeArgs(input) {
  const tokens = [];
  let current = "";
  let quote = null;
  for (const char of String(input).trim()) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (quote) throw new Error("unterminated quoted value in /persona init arguments");
  if (current) tokens.push(current);
  return tokens;
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

function looksLikePath(value) {
  return /[\\/]/.test(value) || value.startsWith(".") || value.endsWith(".md");
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}
