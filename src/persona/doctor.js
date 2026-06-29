import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { discoverPersonaProject, pathExists, resolveWorkspacePath } from "./agents.js";
import { validatePersonaSchema } from "./schema.js";

const KNOWN_TOOLS = new Set([
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "subagent",
  "intercom",
  "contact_supervisor",
]);

export async function runDoctor(root, options = {}) {
  const project = await discoverPersonaProject(root);
  const dependencyStatus = options.dependencyStatus ?? await detectDependencies();
  const issues = [];

  collectDependencyIssues(dependencyStatus, issues);
  collectParseIssues(project, issues);
  issues.push(...validatePersonaSchema(project));
  collectDuplicateNameIssues(project, issues);
  collectGeneralistIssues(project, issues);
  await collectDocsIssues(project, issues);
  collectConsultIssues(project, issues);
  collectToolIssues(project, issues);

  const status = issues.some((issue) => issue.severity === "error")
    ? "error"
    : issues.some((issue) => issue.severity === "warning")
      ? "warning"
      : "pass";

  return {
    status,
    root,
    dependencies: dependencyStatus,
    project,
    issues,
  };
}

export function formatDoctorReport(result) {
  const lines = [
    "# Pi Persona Doctor",
    "",
    `Status: ${result.status}`,
    "",
    "## Dependencies",
    dependencyLine("pi-subagents", result.dependencies.piSubagents),
    dependencyLine("pi-intercom", result.dependencies.piIntercom),
    "",
    "## Project",
    `Agents: ${result.project.agents.length} launchable`,
  ];

  const generalists = result.project.agents.filter((agent) => agent.role === "generalist");
  lines.push(`Generalist: ${generalists.length === 1 ? generalists[0].name : generalists.length}`);

  if (result.project.baseline) {
    lines.push(`Baseline: ${result.project.baseline.relativePath}`);
  } else {
    lines.push("Baseline: none");
  }

  lines.push("", "## Issues");
  if (result.issues.length === 0) {
    lines.push("- none");
  } else {
    for (const issue of result.issues) {
      lines.push(`- ${issue.severity.toUpperCase()}: ${issue.message}`);
    }
  }

  return lines.join("\n");
}

async function detectDependencies() {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi/agent");
  return {
    piSubagents: await detectPackage(path.join(agentDir, "npm/node_modules/pi-subagents")),
    piIntercom: await detectPackage(path.join(agentDir, "npm/node_modules/pi-intercom")),
  };
}

async function detectPackage(packagePath) {
  try {
    const packageJson = JSON.parse(await readFile(path.join(packagePath, "package.json"), "utf8"));
    return {
      ok: true,
      version: packageJson.version ?? "unknown",
      path: packagePath,
    };
  } catch {
    return {
      ok: false,
      path: packagePath,
    };
  }
}

function dependencyLine(name, dependency) {
  if (dependency?.ok) return `- ${name}: ${dependency.version} at ${dependency.path}`;
  return `- ${name}: missing at ${dependency?.path ?? "unknown"}`;
}

function collectDependencyIssues(dependencies, issues) {
  if (!dependencies.piSubagents?.ok) {
    issues.push({
      severity: "error",
      message: "missing required dependency pi-subagents",
    });
  }
  if (!dependencies.piIntercom?.ok) {
    issues.push({
      severity: "error",
      message: "missing required dependency pi-intercom",
    });
  }
}

function collectParseIssues(project, issues) {
  for (const file of project.files) {
    for (const parseError of file.parseErrors) {
      issues.push({
        severity: "error",
        message: parseError,
      });
    }
  }
}

function collectDuplicateNameIssues(project, issues) {
  const byName = new Map();
  for (const agent of project.agents) {
    const entries = byName.get(agent.name) ?? [];
    entries.push(agent);
    byName.set(agent.name, entries);
  }
  for (const [name, agents] of byName.entries()) {
    if (agents.length <= 1) continue;
    issues.push({
      severity: "error",
      message: `duplicate agent name '${name}' in ${agents.map((agent) => agent.relativePath).join(", ")}`,
    });
  }
}

function collectGeneralistIssues(project, issues) {
  const generalists = project.agents.filter((agent) => agent.role === "generalist");
  if (generalists.length === 0) {
    issues.push({
      severity: "error",
      message: "exactly one generalist required; found 0",
    });
  } else if (generalists.length > 1) {
    issues.push({
      severity: "error",
      message: `multiple generalist agents: ${generalists.map((agent) => agent.name).join(", ")}`,
    });
  }
}

async function collectDocsIssues(project, issues) {
  const docsEntries = [];
  if (project.baseline) {
    for (const docPath of project.baseline.frontmatter.docs ?? []) {
      docsEntries.push({ owner: project.baseline.relativePath, docPath });
    }
  }
  for (const agent of project.agents) {
    for (const docPath of agent.docs) {
      docsEntries.push({ owner: agent.relativePath, docPath });
    }
  }

  for (const entry of docsEntries) {
    const resolved = resolveWorkspacePath(project.root, entry.docPath);
    if (!resolved.ok) {
      issues.push({
        severity: "error",
        file: entry.owner,
        message: `${entry.owner}: docs path must stay inside workspace: ${entry.docPath}`,
      });
      continue;
    }
    if (!await pathExists(project.root, entry.docPath)) {
      issues.push({
        severity: "error",
        file: entry.owner,
        message: `${entry.owner}: docs path does not exist: ${entry.docPath}`,
      });
    }
  }
}

function collectConsultIssues(project, issues) {
  const names = new Set(project.agents.map((agent) => agent.name));
  for (const agent of project.agents) {
    for (const consult of agent.consults) {
      if (consult === "all") continue;
      if (!names.has(consult)) {
        issues.push({
          severity: "error",
          file: agent.relativePath,
          message: `${agent.relativePath}: consults unknown agent '${consult}'`,
        });
      }
    }
  }
}

function collectToolIssues(project, issues) {
  for (const agent of project.agents) {
    for (const tool of agent.tools) {
      if (!KNOWN_TOOLS.has(tool)) {
        issues.push({
          severity: "warning",
          file: agent.relativePath,
          message: `${agent.relativePath}: unknown tool '${tool}' in static doctor allowlist; verify Pi exposes it`,
        });
      }
    }
  }
}
