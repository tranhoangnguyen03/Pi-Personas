import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  discoverPersonaProject,
  resolveWorkspacePathForAccess,
} from "./agents.js";
import { tokenizeArgs } from "./command-args.js";
import { formatYamlField, formatYamlScalar } from "./frontmatter.js";
import {
  isAuthorablePersonaRole,
  isDirectPersonaCommandName,
  isSafeAgentName,
} from "./schema.js";

const ALLOWED_OPTIONS = new Set(["role", "description", "docs", "skills"]);
const LIST_OPTIONS = new Set(["docs", "skills"]);

export function normalizeAgentName(input) {
  const normalized = String(input)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  if (!normalized) {
    throw new Error("agent name must contain at least one letter or number");
  }

  return /^[a-z]/.test(normalized) ? normalized : `agent-${normalized}`;
}

export function renderAgentScaffold(agentName, options = {}) {
  if (!isSafeAgentName(agentName)) {
    throw new Error("agent name must begin with a lowercase letter and contain only lowercase letters, numbers, or hyphens");
  }
  const title = options.title ?? titleFromName(agentName);
  const role = normalizeRole(options.role ?? "specialist");
  const description = normalizeDescription(options.description ?? `${title} specialist.`);
  const primaryLine = role === "generalist" && typeof options.primary === "boolean"
    ? `primary: ${options.primary}\n`
    : "";

  return `---
name: ${agentName}
role: ${role}
${primaryLine}${formatYamlField("description", description)}
${renderInlineListField("docs", options.docs)}${renderInlineListField("skills", options.skills)}
---
You are ${agentName}.

Help with requests that match your role. Use the shared baseline plus any docs
declared in this agent file. Any skills declared here are native pi-subagents
skill names, not file paths.
`;
}

export function parsePersonaNewArgs(args) {
  const tokens = tokenizeArgs(args, "unterminated quoted value in /persona new arguments");
  const nameTokens = [];
  const options = {};
  let optionsStarted = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      if (optionsStarted) {
        throw new Error(`unexpected /persona new argument after options: ${token}`);
      }
      nameTokens.push(token);
      continue;
    }

    optionsStarted = true;
    const option = parseOptionToken(token);
    if (!ALLOWED_OPTIONS.has(option.key)) {
      throw new Error(`unknown /persona new option: --${option.key}`);
    }

    let value = option.value;
    if (value === undefined) {
      index += 1;
      value = tokens[index];
      if (!value || value.startsWith("--")) {
        throw new Error(`missing value for /persona new option: --${option.key}`);
      }
    }

    if (LIST_OPTIONS.has(option.key)) {
      options[option.key] = [
        ...normalizeList(options[option.key]),
        ...normalizeList(value),
      ];
    } else if (option.key === "role") {
      options.role = normalizeRole(value);
    } else {
      options[option.key] = normalizeDescription(value);
    }
  }

  const rawName = nameTokens.join(" ").trim();
  if (!rawName) {
    throw new Error("Usage: /persona new <name>");
  }

  return { rawName, options };
}

export async function createAgentScaffold(root, rawName, options = {}) {
  const agentName = normalizeAgentName(rawName);
  const role = normalizeRole(options.role ?? "specialist");
  const primary = await defaultPrimaryForRole(root, role);
  const warnings = buildPrimaryWarnings(agentName, primary);
  const relativePath = `.pi/agents/${agentName}.md`;
  const resolved = await resolveWorkspacePathForAccess(root, relativePath);
  if (!resolved.ok) throw new Error(`agent path must stay inside workspace: ${relativePath}`);
  const filePath = resolved.path;
  const content = renderAgentScaffold(agentName, {
    ...options,
    role,
    primary,
    title: titleFromName(rawName),
  });

  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    await writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`agent file already exists: ${relativePath}`);
    }
    throw error;
  }

  return {
    agentName,
    filePath,
    relativePath,
    content,
    warnings,
    options: {
      role,
      primary,
      description: normalizeDescription(options.description ?? `${titleFromName(rawName)} specialist.`),
      docs: normalizeList(options.docs),
      skills: normalizeList(options.skills),
    },
  };
}

export async function createPersonaProjectScaffold(root) {
  const created = [];
  const skipped = [];

  await writeScaffoldFile(root, ".pi/agents/_baseline.md", renderBaselineScaffold(), created, skipped);
  await writeScaffoldFile(
    root,
    ".pi/agents/generalist.md",
    renderAgentScaffold("generalist", {
      role: "generalist",
      primary: true,
      description: "Routes requests to the right specialist persona.",
    }),
    created,
    skipped,
  );
  await writeScaffoldFile(root, "docs/shared/_index.md", renderSharedDocsIndexScaffold(), created, skipped);

  return {
    created,
    skipped,
    primaryGeneralist: "generalist",
  };
}

export function formatAgentScaffoldCreatedMessage(result) {
  const lines = [
    `Created ${result.relativePath}`,
    "",
    `Launch: ${formatLaunchCommand(result.agentName)}`,
  ];
  if (result.options.docs.length > 0) {
    lines.push(`Docs: ${result.options.docs.join(", ")}`);
  } else {
    lines.push("Docs: none");
  }
  if (result.options.skills.length > 0) {
    lines.push(`Skills: ${result.options.skills.join(", ")}`);
  } else {
    lines.push("Skills: none");
  }
  if (result.options.role === "generalist") {
    lines.push(`Primary: ${result.options.primary ? "true" : "false"}`);
  }
  if (result.warnings?.length > 0) {
    lines.push("", "Warning:");
    for (const warning of result.warnings) {
      lines.push(`- ${warning}`);
    }
  }
  lines.push("Next: run /persona doctor");
  return lines.join("\n");
}

export function formatPersonaProjectScaffoldCreatedMessage(result) {
  const lines = [
    "Initialized Pi Persona project",
  ];

  if (result.created.length > 0) {
    lines.push("", "Created:");
    for (const filePath of result.created) {
      lines.push(`- ${filePath}`);
    }
  }
  if (result.skipped.length > 0) {
    lines.push("", "Preserved:");
    for (const filePath of result.skipped) {
      lines.push(`- ${filePath}`);
    }
  }

  lines.push(
    "",
    `Primary generalist: /${result.primaryGeneralist}`,
    "Next: add specialists with /persona new <name>, then run /persona doctor",
  );
  return lines.join("\n");
}

async function writeScaffoldFile(root, relativePath, content, created, skipped) {
  const resolved = await resolveWorkspacePathForAccess(root, relativePath);
  if (!resolved.ok) throw new Error(`scaffold path must stay inside workspace: ${relativePath}`);
  const filePath = resolved.path;
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    await writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
    created.push(relativePath);
  } catch (error) {
    if (error?.code === "EEXIST") {
      skipped.push(relativePath);
      return;
    }
    throw error;
  }
}

function renderBaselineScaffold() {
  return `---
docs: docs/shared/
skills: []
---
Shared operating context for every Pi Persona agent.

Use the agent roster to decide when specialist help is useful. Keep consults
focused, summarize relevant context, and prefer fresh context unless full
history is deliberately needed.
`;
}

function renderSharedDocsIndexScaffold() {
  return `# Shared Docs Index

Add shared reference docs here. Keep this index current so agents can discover
the folder progressively before opening deeper files.
`;
}

async function defaultPrimaryForRole(root, role) {
  if (role !== "generalist") return undefined;
  const project = await discoverPersonaProject(root);
  return project.agents.filter((agent) => agent.role === "generalist").length === 0;
}

function buildPrimaryWarnings(agentName, primary) {
  if (primary !== false) return [];
  return [
    `${agentName} was created as primary: false because another generalist already exists. Set exactly one generalist to primary: true and set the others to primary: false before using primary generalist routing.`,
  ];
}

function titleFromName(input) {
  return String(input)
    .trim()
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ") || "New Agent";
}

function normalizeRole(value) {
  const role = String(value).trim().toLowerCase();
  if (!isAuthorablePersonaRole(role)) {
    throw new Error("role must be generalist or specialist");
  }
  return role;
}

function normalizeDescription(value) {
  const description = String(value).trim();
  if (!description) throw new Error("description must be a non-empty string");
  return description;
}

function normalizeList(value) {
  if (!value) return [];
  const values = Array.isArray(value) ? value : String(value).split(",");
  return values
    .flatMap((entry) => {
      if (typeof entry !== "string") {
        throw new Error("list values must be non-empty strings");
      }
      return entry.split(",");
    })
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function renderInlineListField(field, value) {
  const values = normalizeList(value);
  if (values.length === 0) return `${field}: []\n`;
  return `${field}: ${formatYamlScalar(values.join(", "))}\n`;
}

function formatLaunchCommand(agentName) {
  return isDirectPersonaCommandName(agentName)
    ? `/${agentName}`
    : `/persona use ${agentName}`;
}

function parseOptionToken(token) {
  const raw = token.slice(2);
  const equalsIndex = raw.indexOf("=");
  if (equalsIndex === -1) {
    return { key: raw, value: undefined };
  }
  return {
    key: raw.slice(0, equalsIndex),
    value: raw.slice(equalsIndex + 1),
  };
}
