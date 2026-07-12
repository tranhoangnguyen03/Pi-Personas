import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";

import {
  resolveWorkspacePath,
  resolveWorkspacePathForAccess,
} from "./agents.js";
import { tokenizeArgs } from "./command-args.js";
import { DOC_INDEX_BLOCK_START, DOC_INDEX_FILE } from "./doc-index.js";
import { formatYamlField, formatYamlScalar, uniqueStrings } from "./frontmatter.js";
import { normalizeAgentName } from "./scaffold.js";

const VALID_ROLES = new Set(["generalist", "specialist"]);
const TEMPLATE_PLACEHOLDERS = [
  "Add the user's business facts, priorities, constraints, audience, products, services, channels, and recurring decisions here.",
  "Replace this with the specialist's operating notes.",
  "Replace with the specialist's routing description.",
  "Replace this with the specialist's role, operating style, and expected output shape.",
  "add the behavior or spec under test here",
  "list anything still undecided",
].map(normalizePlaceholderText);

export function findPersonaTemplatePlaceholders(value) {
  const normalized = normalizePlaceholderText(value);
  if (!normalized) return [];
  return TEMPLATE_PLACEHOLDERS.filter((placeholder) => normalized.includes(placeholder));
}

export function parsePersonaInitArgs(args) {
  const tokens = tokenizeArgs(args, "unterminated quoted value in /persona init arguments");
  if (tokens.length === 0) return { mode: "basic" };
  if (tokens[0] === "draft") {
    const out = readOption(tokens.slice(1), "out");
    if (!out) throw new Error("missing --out <file> for /persona init draft");
    return { mode: "draft", out };
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

export async function createPersonaInitDraft(root, outPath) {
  const resolved = await resolveWorkspacePathForAccess(root, outPath);
  if (!resolved.ok) throw new Error(`draft path must stay inside workspace: ${outPath}`);

  const projectName = projectNameFromOutputPath(outPath);
  await mkdir(path.dirname(resolved.path), { recursive: true });
  try {
    await writeFile(resolved.path, renderStarterManifest(projectName), { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`draft manifest already exists: ${outPath}`);
    throw error;
  }

  return {
    mode: "draft",
    source: outPath,
    projectName,
  };
}

export async function planPersonaInitFromManifest(root, sourcePath) {
  const manifest = await readManifest(root, sourcePath);
  const actions = [];
  for (const entry of buildManifestEntries(manifest)) {
    actions.push({
      kind: "file",
      path: entry.path,
      status: await exists(root, entry.path) ? "preserve" : "create",
    });
  }

  return baseResult("plan", manifest, actions);
}

export async function applyPersonaInitFromManifest(root, sourcePath) {
  const manifest = await readManifest(root, sourcePath);
  const actions = [];
  for (const entry of buildManifestEntries(manifest)) {
    const created = await writeFileIfMissing(root, entry.path, entry.content);
    actions.push({
      kind: "file",
      path: entry.path,
      status: created ? "created" : "preserved",
    });
  }

  return baseResult("apply", manifest, actions);
}

export async function statusPersonaInitFromManifest(root, sourcePath) {
  const manifest = await readManifest(root, sourcePath);
  const items = [];
  for (const entry of buildManifestEntries(manifest)) {
    items.push({
      state: await exists(root, entry.path) ? "done" : "todo",
      label: entry.path,
    });
  }
  items.push(...await docsIndexStatusItems(root, manifest));

  return {
    mode: "status",
    source: manifest.source,
    projectName: manifest.projectName,
    items,
  };
}

export function formatPersonaInitManifestReport(result, options = {}) {
  if (result.mode === "draft") return formatDraftReport(result);
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

  lines.push(
    "",
    result.mode === "plan"
      ? `Next: run /persona init --from ${result.source}`
      : options.doctorIncluded
        ? "Persona doctor verification follows."
        : "Next: run /persona doctor",
  );
  return lines.join("\n");
}

function formatDraftReport(result) {
  return [
    "# Pi Persona Init Draft",
    "",
    `Created: ${result.source}`,
    `Project: ${result.projectName}`,
    "",
    "Starting assisted setup interview. The manifest is a working draft; answer the setup questions in this chat before applying it.",
    "",
    "Next: continue the interview. The assistant will preview the plan before asking to apply it.",
  ].join("\n");
}

export function formatPersonaInitDraftAuthoringPrompt(result) {
  return [
    `Help me shape the Pi Persona setup manifest at \`${result.source}\`.`,
    "",
    "Treat me as a new user who does not yet know what to put where.",
    "Do not ask me to manually edit YAML.",
    "Ask one question at a time, starting with what this workspace is for and what kind of help I want from the personas.",
    "As I answer, edit the manifest for me using conservative defaults: one primary generalist, small specialists with clear routing descriptions, shared facts in docs/shared/, and specialist facts in docs/workstreams/<name>/.",
    "Do not invent secrets, private business facts, unsupported skills, runtime-only fields, or legacy tools/consults/tags metadata.",
    "",
    `When the manifest has enough information, call persona_init with action: plan and source: ${result.source}. Summarize that plan and ask for explicit approval. Only after approval, call persona_init with action: apply, source: ${result.source}, and confirmed: true. The apply result includes persona doctor verification. Then call persona_init with action: status and follow its next-step guidance.`,
    "When explaining activation, use /persona use <name> or the direct slash command shown by /persona-list. Never use @name syntax.",
  ].join("\n");
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
  lines.push("", `[next] run ${nextStatusCommand(result.items)}`);
  return lines.join("\n");
}

function nextStatusCommand(items) {
  if (items.some((item) => item.state !== "done" && item.label.startsWith("docs index: "))) {
    return "/persona index --all";
  }
  return "/persona doctor";
}

function baseResult(mode, manifest, actions) {
  return {
    mode,
    source: manifest.source,
    projectName: manifest.projectName,
    actions,
  };
}

function projectNameFromOutputPath(outPath) {
  const baseName = path.basename(outPath).replace(/\.ya?ml$/i, "");
  return normalizeAgentName(baseName) || "business-operating-layer";
}

function renderStarterManifest(projectName) {
  return `version: 1
project:
  name: ${projectName}

baseline:
  docs:
    - docs/shared/
  skills: []
  prompt: |
    Shared operating context for every persona.

    Keep answers practical, concise, and grounded in the available docs. Answer
    directly when shared context is enough. Consult specialists when the request
    clearly needs their perspective.

docs:
  files:
    docs/shared/_index.md: |
      # Shared Docs Index

      - business-context.md: facts, priorities, constraints, and open questions.
    docs/shared/business-context.md: |
      # Business Context

      Add the user's business facts, priorities, constraints, audience,
      products, services, channels, and recurring decisions here.
    docs/workstreams/example-specialist/_index.md: |
      # Example Specialist Docs Index

      - brief.md: scope and output expectations.
    docs/workstreams/example-specialist/brief.md: |
      # Example Specialist Brief

      Replace this with the specialist's operating notes.

agents:
  - name: generalist
    role: generalist
    primary: true
    description: Routes requests, answers directly, and synthesizes specialist input.
    docs: []
    skills: []
    prompt: |
      You are the operating generalist. Answer directly when shared context is
      enough. Consult the best-fit specialist when the request clearly needs a
      specialist perspective.

  - name: example-specialist
    role: specialist
    description: Replace with the specialist's routing description.
    docs:
      - docs/workstreams/example-specialist/
    skills: []
    prompt: |
      You are the example specialist. Replace this with the specialist's role,
      operating style, and expected output shape.
`;
}

async function docsIndexStatusItems(root, manifest) {
  const docDirs = uniqueStrings([
    ...manifest.baseline.docs,
    ...manifest.agents.flatMap((agent) => agent.docs),
  ]).filter((docPath) => docPath.endsWith("/"));

  const items = [];
  for (const docPath of docDirs) {
    items.push({
      state: await hasManagedDocIndex(root, docPath) ? "done" : "todo",
      label: `docs index: ${docPath}`,
    });
  }
  return items;
}

async function hasManagedDocIndex(root, docPath) {
  const indexPath = `${docPath.replace(/\/+$/g, "")}/${DOC_INDEX_FILE}`;
  const resolved = await resolveWorkspacePathForAccess(root, indexPath);
  if (!resolved.ok) return false;
  try {
    const content = await readFile(resolved.path, "utf8");
    return content.includes(DOC_INDEX_BLOCK_START);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readManifest(root, sourcePath) {
  const resolved = await resolveWorkspacePathForAccess(root, sourcePath);
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
  const manifest = {
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
  assertNoTemplatePlaceholders(manifest);
  return manifest;
}

function assertNoTemplatePlaceholders(manifest) {
  const unresolved = [];
  if (findPersonaTemplatePlaceholders(manifest.baseline.prompt).length > 0) unresolved.push("baseline.prompt");
  for (const agent of manifest.agents) {
    if (findPersonaTemplatePlaceholders(agent.description).length > 0) unresolved.push(`agents.${agent.name}.description`);
    if (findPersonaTemplatePlaceholders(agent.prompt).length > 0) unresolved.push(`agents.${agent.name}.prompt`);
  }
  for (const file of manifest.docsFiles) {
    if (findPersonaTemplatePlaceholders(file.content).length > 0) unresolved.push(`docs.files.${file.path}`);
  }
  if (unresolved.length > 0) {
    throw new Error(`${manifest.source}: unresolved template placeholders: ${unresolved.join(", ")}. Finish assisted onboarding before planning or applying this manifest.`);
  }
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
  if (Object.hasOwn(raw, "primary") && typeof raw.primary !== "boolean") {
    throw new Error(`${label}: primary must be true or false`);
  }
  if (raw.primary === true && role !== "generalist") {
    throw new Error(`${label}: primary: true is only valid on role: generalist`);
  }
  if (Object.hasOwn(raw, "model") && raw.model !== null && raw.model !== undefined && !nonEmpty(raw.model)) {
    throw new Error(`${label}: model must be a non-empty string when provided`);
  }
  const primary = raw.primary === true;
  return {
    name,
    role,
    primary,
    description: String(raw.description).trim(),
    docs: normalizePathList(raw.docs, `${label}.docs`, root),
    skills: normalizeSkillList(raw.skills, `${label}.skills`),
    model: nonEmpty(raw.model) ? raw.model.trim() : "",
    prompt: String(raw.prompt).trim(),
  };
}

function normalizeDocsFiles(value, sourcePath, root) {
  if (value === undefined || value === null) return [];
  if (!isRecord(value)) throw new Error(`${sourcePath}: docs.files must be a mapping`);
  return Object.entries(value).map(([filePath, content]) => {
    assertWorkspacePath(root, filePath, `${sourcePath}: docs.files`);
    if (typeof content !== "string") {
      throw new Error(`${sourcePath}: docs.files.${filePath} must be a string`);
    }
    return {
      path: filePath,
      content: `${content.replace(/\r\n/g, "\n").trimEnd()}\n`,
    };
  });
}

function normalizePathList(value, label, root) {
  return normalizeList(value, label).map((entry) => {
    assertWorkspacePath(root, entry, label);
    return entry;
  });
}

function normalizeSkillList(value, label) {
  return normalizeList(value, label).map((entry) => {
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
  ];
}

function renderBaseline(baseline) {
  return `---
${renderListField("docs", baseline.docs)}${renderListField("skills", baseline.skills)}---
${baseline.prompt}
`;
}

function renderAgent(agent) {
  const modelLine = agent.model ? `${formatYamlField("model", agent.model)}\n` : "";
  const primaryLine = agent.role === "generalist" ? `primary: ${agent.primary ? "true" : "false"}\n` : "";
  return `---
name: ${agent.name}
role: ${agent.role}
${primaryLine}${formatYamlField("description", agent.description)}
${modelLine}${renderListField("docs", agent.docs)}${renderListField("skills", agent.skills)}---
${agent.prompt}
`;
}

function renderListField(field, values) {
  const unique = uniqueStrings(values);
  if (unique.length === 0) return `${field}: []\n`;
  return `${field}:\n${unique.map((value) => `  - ${formatYamlScalar(value)}`).join("\n")}\n`;
}

async function writeFileIfMissing(root, relativePath, content) {
  const resolved = await resolveWorkspacePathForAccess(root, relativePath);
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
  const resolved = await resolveWorkspacePathForAccess(root, relativePath);
  if (!resolved.ok) return false;
  try {
    await access(resolved.path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
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

function normalizeList(value, label) {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label}: must be a string or an array of non-empty strings`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`${label}[${index}]: must be a non-empty string`);
    }
    return item.trim();
  });
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

function normalizePlaceholderText(value) {
  return typeof value === "string" ? value.toLowerCase().replace(/\s+/g, " ").trim() : "";
}
