import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

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
  return `---
name: ${agentName}
role: specialist
description: ${title} specialist.
tools:
docs:
consults:
tags:
---
You are ${agentName}.

Help with requests that match your role. Use only the docs, tools, and consult
permissions declared in this agent file plus the shared baseline assembled by
Pi Persona.
`;
}

export async function createAgentScaffold(root, rawName) {
  const agentName = normalizeAgentName(rawName);
  const relativePath = `.pi/agents/${agentName}.md`;
  const filePath = path.join(root, relativePath);
  const content = renderAgentScaffold(agentName, { title: titleFromName(rawName) });

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
  };
}

function titleFromName(input) {
  return String(input)
    .trim()
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ") || "New Agent";
}
