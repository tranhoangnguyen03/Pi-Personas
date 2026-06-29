import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ALLOWED_OPTIONS = new Set(["role", "description", "tools", "docs", "consults", "tags"]);
const LIST_OPTIONS = new Set(["tools", "docs", "consults", "tags"]);
const VALID_ROLES = new Set(["generalist", "specialist"]);

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

  return normalized;
}

export function renderAgentScaffold(agentName, options = {}) {
  const title = options.title ?? titleFromName(agentName);
  const role = normalizeRole(options.role ?? "specialist");
  const description = normalizeDescription(options.description ?? `${title} specialist.`);
  const tools = normalizeList(options.tools).join(", ");
  const docs = normalizeList(options.docs).join(", ");
  const consults = normalizeList(options.consults).join(", ");
  const tags = normalizeList(options.tags).join(", ");

  return `---
name: ${agentName}
role: ${role}
description: ${description}
tools:${tools ? ` ${tools}` : ""}
docs:${docs ? ` ${docs}` : ""}
consults:${consults ? ` ${consults}` : ""}
tags:${tags ? ` ${tags}` : ""}
---
You are ${agentName}.

Help with requests that match your role. Use only the docs, tools, and consult
permissions declared in this agent file plus the shared baseline assembled by
Pi Persona.
`;
}

export function parsePersonaNewArgs(args) {
  const tokens = tokenizeArgs(args);
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
  const relativePath = `.pi/agents/${agentName}.md`;
  const filePath = path.join(root, relativePath);
  const content = renderAgentScaffold(agentName, { ...options, title: titleFromName(rawName) });

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
    options: {
      role: normalizeRole(options.role ?? "specialist"),
      description: normalizeDescription(options.description ?? `${titleFromName(rawName)} specialist.`),
      tools: normalizeList(options.tools),
      docs: normalizeList(options.docs),
      consults: normalizeList(options.consults),
      tags: normalizeList(options.tags),
    },
  };
}

export function formatAgentScaffoldCreatedMessage(result) {
  const lines = [
    `Created ${result.relativePath}`,
    "",
    `Launch: /${result.agentName}`,
  ];
  if (result.options.docs.length > 0) {
    lines.push(`Docs: ${result.options.docs.join(", ")}`);
  } else {
    lines.push("Docs: none");
  }
  if (result.options.tools.length > 0) {
    lines.push(`Tools: ${result.options.tools.join(", ")}`);
  } else {
    lines.push("Tools: none");
  }
  lines.push("Next: run /persona doctor");
  return lines.join("\n");
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
  if (!VALID_ROLES.has(role)) {
    throw new Error("role must be generalist or specialist");
  }
  return role;
}

function normalizeDescription(value) {
  return String(value).trim();
}

function normalizeList(value) {
  if (!value) return [];
  const values = Array.isArray(value) ? value : String(value).split(",");
  return values
    .flatMap((entry) => String(entry).split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
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
    throw new Error("unterminated quoted value in /persona new arguments");
  }
  if (tokenStarted) {
    tokens.push(current);
  }

  return tokens;
}
