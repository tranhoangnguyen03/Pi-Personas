import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  discoverPersonaProject,
  formatPrimaryGeneralistError,
  getPrimaryGeneralistState,
  pathExists,
  resolveWorkspacePath,
} from "./agents.js";
import { inspectDocPath } from "./doc-index.js";
import { validatePersonaSchema } from "./schema.js";

const RUNTIME_PACKAGES = {
  piSubagents: {
    name: "pi-subagents",
    source: "npm:pi-subagents",
    path: "npm/node_modules/pi-subagents",
    missing: "pi-subagents missing; consults and round-tables are unavailable",
  },
  piIntercom: {
    name: "pi-intercom",
    source: "npm:pi-intercom",
    path: "npm/node_modules/pi-intercom",
    missing: "pi-intercom missing; native child result delivery may be unavailable",
  },
};

export async function runDoctor(root, options = {}) {
  const project = await discoverPersonaProject(root);
  const dependencyStatus = options.dependencyStatus ?? await detectDependencies(root);
  const issues = [];

  collectDependencyIssues(dependencyStatus, issues);
  collectParseIssues(project, issues);
  issues.push(...validatePersonaSchema(project));
  collectDuplicateNameIssues(project, issues);
  collectGeneralistIssues(project, issues);
  await collectDocsIssues(project, issues);
  collectSkillsIssues(project, issues);
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

export async function assertPersonaRuntimeReady(root, options = {}) {
  const dependencyStatus = options.dependencyStatus ?? await detectDependencies(root);
  const problems = runtimeDependencyProblems(dependencyStatus);
  if (problems.length === 0) return dependencyStatus;

  throw new Error([
    "Pi Persona consults and round-tables require runtime packages.",
    "",
    "Problems:",
    ...problems.map((problem) => `- ${problem}`),
    "",
    "Install/configure with:",
    `pi install ${RUNTIME_PACKAGES.piSubagents.source}`,
    `pi install ${RUNTIME_PACKAGES.piIntercom.source}`,
    "",
    "Then restart Pi and run /persona doctor.",
  ].join("\n"));
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

async function detectDependencies(root) {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi/agent");
  const configuredPackages = await detectConfiguredPackages(agentDir, root);
  return {
    piSubagents: await detectPackage(agentDir, configuredPackages, RUNTIME_PACKAGES.piSubagents),
    piIntercom: await detectPackage(agentDir, configuredPackages, RUNTIME_PACKAGES.piIntercom),
  };
}

async function detectPackage(agentDir, configuredPackages, spec) {
  const packagePath = path.join(agentDir, spec.path);
  const configured = configuredPackages.has(spec.source);
  try {
    const packageJson = JSON.parse(await readFile(path.join(packagePath, "package.json"), "utf8"));
    return {
      ok: true,
      version: packageJson.version ?? "unknown",
      path: packagePath,
      configured,
      packageSource: spec.source,
    };
  } catch {
    return {
      ok: false,
      path: packagePath,
      configured,
      packageSource: spec.source,
    };
  }
}

async function detectConfiguredPackages(agentDir, root) {
  const packages = new Set([
    ...await readSettingsPackages(path.join(agentDir, "settings.json")),
    ...await readSettingsPackages(path.join(root, ".pi/settings.json")),
  ]);
  return packages;
}

async function readSettingsPackages(settingsPath) {
  try {
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    return Array.isArray(settings.packages)
      ? settings.packages.filter((entry) => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function dependencyLine(name, dependency) {
  if (dependency?.ok) {
    const configured = dependency.configured === true
      ? " (configured)"
      : dependency.configured === false
        ? " (not configured in Pi settings)"
        : "";
    return `- ${name}: ${dependency.version} at ${dependency.path}${configured}`;
  }
  return `- ${name}: missing at ${dependency?.path ?? "unknown"}`;
}

function collectDependencyIssues(dependencies, issues) {
  collectRuntimePackageIssue(dependencies.piSubagents, RUNTIME_PACKAGES.piSubagents, issues);
  collectRuntimePackageIssue(dependencies.piIntercom, RUNTIME_PACKAGES.piIntercom, issues);
}

function collectRuntimePackageIssue(dependency, spec, issues) {
  if (!dependency?.ok) {
    issues.push({
      severity: "warning",
      message: `${spec.missing}; run \`${dependency?.packageSource ? `pi install ${dependency.packageSource}` : `pi install ${spec.source}`}\``,
    });
  }
  if (dependency?.ok && dependency.configured === false) {
    issues.push({
      severity: "warning",
      message: `${spec.name} installed but not configured in Pi settings; run \`pi install ${dependency.packageSource ?? spec.source}\``,
    });
  }
}

function runtimeDependencyProblems(dependencies) {
  return [
    runtimeDependencyProblem(dependencies.piSubagents, RUNTIME_PACKAGES.piSubagents),
    runtimeDependencyProblem(dependencies.piIntercom, RUNTIME_PACKAGES.piIntercom),
  ].filter(Boolean);
}

function runtimeDependencyProblem(dependency, spec) {
  if (!dependency?.ok) return `${spec.name} is missing at ${dependency?.path ?? "unknown"}`;
  if (dependency.configured === false) return `${spec.name} is installed but not configured in Pi settings`;
  return "";
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
      continue;
    }

    const inspection = await inspectDocPath(project.root, entry.docPath);
    if (inspection.type === "directory" && inspection.deferred.length > 0 && !inspection.indexFile) {
      issues.push({
        severity: "warning",
        file: entry.owner,
        message: `${entry.owner}: ${entry.docPath} has ${inspection.deferred.length} nested docs but no _index.md; run /persona index ${entry.docPath} or add an index manually for progressive discovery`,
      });
    }
  }
}

function collectSkillsIssues(project, issues) {
  const skillEntries = [];
  if (project.baseline) {
    for (const skill of project.baseline.frontmatter.skills ?? []) {
      skillEntries.push({ owner: project.baseline.relativePath, skill });
    }
  }
  for (const agent of project.agents) {
    for (const skill of agent.skills) {
      skillEntries.push({ owner: agent.relativePath, skill });
    }
  }

  for (const entry of skillEntries) {
    if (looksLikePath(entry.skill)) {
      issues.push({
        severity: "warning",
        file: entry.owner,
        message: `${entry.owner}: skills entry looks like a path, but Pi Persona skills are native pi-subagents skill names: ${entry.skill}`,
      });
    }
  }
}

function looksLikePath(value) {
  return /[\\/]/.test(value) || value.startsWith(".") || value.endsWith(".md");
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

function legacyGuidance(field) {
  switch (field) {
    case "tools":
      return "migrate tool-use guidance to native pi-subagents skills";
    case "consults":
      return "route by agent descriptions instead";
    case "tags":
      return "prefer high-signal descriptions";
    default:
      return "review this field";
  }
}
