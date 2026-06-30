import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  discoverPersonaProject,
  formatPrimaryGeneralistError,
  getPrimaryGeneralistState,
  pathExists,
  resolveWorkspacePath,
} from "./agents.js";
import { validatePersonaSchema } from "./schema.js";
import { hasNestedConsultRuntimeOverride, readProjectSettings } from "./settings.js";

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
  await collectSkillsIssues(project, issues);
  await collectNestedConsultRuntimeIssues(project, issues);
  collectLegacyMetadataIssues(project, issues);

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

  const primaryState = getPrimaryGeneralistState(result.project);
  lines.push(`Primary generalist: ${primaryState.effectivePrimary.length === 1 ? primaryState.effectivePrimary[0].name : primaryState.effectivePrimary.length}`);
  lines.push(`Generalists: ${primaryState.generalists.length}`);

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
  const state = getPrimaryGeneralistState(project);
  if (state.effectivePrimary.length !== 1) {
    issues.push({
      severity: "error",
      message: formatPrimaryGeneralistError(state, "doctor"),
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

async function collectSkillsIssues(project, issues) {
  const skillEntries = [];
  if (project.baseline) {
    for (const skillPath of project.baseline.frontmatter.skills ?? []) {
      skillEntries.push({ owner: project.baseline.relativePath, skillPath });
    }
  }
  for (const agent of project.agents) {
    for (const skillPath of agent.skills) {
      skillEntries.push({ owner: agent.relativePath, skillPath });
    }
  }

  for (const entry of skillEntries) {
    const resolved = resolveWorkspacePath(project.root, entry.skillPath);
    if (!resolved.ok) {
      issues.push({
        severity: "error",
        file: entry.owner,
        message: `${entry.owner}: skills path must stay inside workspace: ${entry.skillPath}`,
      });
      continue;
    }

    let skillStat;
    try {
      skillStat = await stat(resolved.path);
    } catch (error) {
      if (error?.code === "ENOENT") {
        issues.push({
          severity: "warning",
          file: entry.owner,
          message: `${entry.owner}: skills path does not exist: ${entry.skillPath}`,
        });
        continue;
      }
      throw error;
    }

    if (skillStat.isDirectory() && !await pathExists(project.root, path.posix.join(entry.skillPath, "skills.md"))) {
      issues.push({
        severity: "warning",
        file: entry.owner,
        message: `${entry.owner}: ${entry.skillPath} exists but no skills.md was found`,
      });
    }
  }
}

function collectLegacyMetadataIssues(project, issues) {
  for (const agent of project.agents) {
    for (const field of ["tools", "consults", "tags"]) {
      if (!Object.hasOwn(agent.frontmatter, field)) continue;
      if ((agent.frontmatter[field] ?? []).length === 0) continue;
      const guidance = legacyGuidance(field);
      issues.push({
        severity: "warning",
        file: agent.relativePath,
        message: `${agent.relativePath}: legacy field ${field} found; ${guidance}`,
      });
    }
  }
}

async function collectNestedConsultRuntimeIssues(project, issues) {
  const settings = await readProjectSettings(project.root);
  for (const agent of project.agents) {
    if (!["generalist", "specialist"].includes(agent.role)) continue;
    if (hasNestedConsultRuntimeOverride(settings, agent)) continue;
    issues.push({
      severity: "warning",
      file: agent.relativePath,
      message: `${agent.relativePath}: nested persona consults need project runtime override tools: subagent in .pi/settings.json; /persona new creates this automatically`,
    });
  }
}

function legacyGuidance(field) {
  switch (field) {
    case "tools":
      return "migrate tool-use guidance to skills";
    case "consults":
      return "route by agent descriptions instead";
    case "tags":
      return "prefer high-signal descriptions";
    default:
      return "review this field";
  }
}
