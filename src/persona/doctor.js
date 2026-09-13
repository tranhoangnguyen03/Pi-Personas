import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  discoverPersonaProject,
  formatPrimaryGeneralistError,
  getPrimaryGeneralistState,
  resolveWorkspacePath,
} from "./agents.js";
import {
  detectDependencies,
  isPiSubagentsPackage,
  PI_SUBAGENTS_ROUNDTABLE_MINIMUM_VERSION,
  RUNTIME_PACKAGES,
  runtimePackages,
  versionAtLeast,
} from "./dependencies.js";
import { inspectDocPath } from "./doc-index.js";
import { findPersonaTemplatePlaceholders } from "./init-manifest.js";
import { validatePersonaSchema } from "./schema.js";
import { NATIVE_BUILTIN_TOOLS, resolvePersonaBackend } from "./runtime.js";

export { PI_SUBAGENTS_ROUNDTABLE_MINIMUM_VERSION };

export async function runDoctor(root, options = {}) {
  const backend = options.backend ?? await resolvePersonaBackend(root, options);
  const repairs = backend === "legacy" && !options.dependencyStatus ? await repairRuntimePackageDuplicates(root) : [];
  const project = await discoverPersonaProject(root);
  const dependencyStatus = options.dependencyStatus ?? (backend === "legacy" ? await detectDependencies(root) : { piSubagents: { required: false } });
  const issues = [];

  if (repairs.length > 0) {
    issues.push({
      severity: "warning",
      message: "duplicate pi-subagents configuration was repaired; reload Pi before running consults or round-tables",
    });
  }
  if (backend === "legacy") collectDependencyIssues(dependencyStatus, issues);
  collectParseIssues(project, issues);
  issues.push(...validatePersonaSchema(project));
  collectDuplicateNameIssues(project, issues);
  collectGeneralistIssues(project, issues);
  collectAgentTemplatePlaceholderIssues(project, issues);
  await collectDocsIssues(project, issues);
  collectSkillsIssues(project, issues);
  collectLegacyMetadataIssues(project, issues);
  if (backend === "native") collectNativeIssues(project, issues);

  const status = issues.some((issue) => issue.severity === "error")
    ? "error"
    : issues.some((issue) => issue.severity === "warning")
      ? "warning"
      : "pass";

  return {
    status,
    backend,
    root,
    dependencies: dependencyStatus,
    project,
    issues,
    repairs,
  };
}

export async function assertPersonaRuntimeReady(root, options = {}) {
  const backend = options.backend ?? await resolvePersonaBackend(root, options);
  if (backend === "native") {
    return { backend };
  }
  const repairs = options.dependencyStatus ? [] : await repairRuntimePackageDuplicates(root);
  if (repairs.length > 0) {
    throw new Error("Pi Persona repaired duplicate pi-subagents configuration. Reload Pi, then retry.");
  }
  const dependencyStatus = options.dependencyStatus ?? await detectDependencies(root);
  const problems = runtimeDependencyProblems(dependencyStatus, options.minimumPiSubagentsVersion);
  if (problems.length === 0) return dependencyStatus;

  throw new Error([
    "Pi Persona consults and round-tables require runtime packages.",
    "",
    "Problems:",
    ...problems.map((problem) => `- ${problem}`),
    "",
    "Install/configure with:",
    `pi install ${RUNTIME_PACKAGES.piSubagents.source}`,
    "",
    "Then restart Pi and run /persona doctor.",
  ].join("\n"));
}

export function formatDoctorReport(result) {
  const lines = [
    "# Pi Persona Doctor",
    "",
    `Status: ${result.status}`,
    `Backend: ${result.backend ?? "legacy"}`,
    "",
    "## Dependencies",
    result.backend === "native"
      ? "- pi-subagents: optional (native backend selected)"
      : dependencyLine("pi-subagents", result.dependencies.piSubagents),
    ...(result.backend === "native" ? [
      "",
      "## Native Checks",
      "- static doctor: resolved baseline + agent built-in tool names",
      "- live launch preflight: loaded skills, model, provider, and current authentication",
    ] : []),
    "",
    "## Project",
    `Agents: ${result.project.agents.length} launchable`,
  ];

  const primaryState = getPrimaryGeneralistState(result.project);
  lines.push(`Primary generalist: ${primaryState.effectivePrimary.length === 1 ? primaryState.effectivePrimary[0].name : primaryState.effectivePrimary.length}`);
  lines.push(`Generalists: ${primaryState.generalists.length}`);
  if (result.project.agents.length === 0) {
    lines.push("", "No persona setup found. Run /persona onboard.");
  }

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

  if (result.repairs?.length > 0) {
    lines.push("", "## Repairs");
    for (const repair of result.repairs) {
      lines.push(`- kept ${repair.kept}; removed ${repair.removed.length} duplicate declaration(s)`);
    }
    lines.push("- reload Pi to unload the duplicate runtime copy");
  }

  return lines.join("\n");
}

function collectNativeIssues(project, issues) {
  for (const agent of project.agents) {
    const tools = [...new Set([...(project.baseline?.frontmatter.tools ?? []), ...(agent.tools ?? [])])];
    const unknown = tools.filter((tool) => !NATIVE_BUILTIN_TOOLS.includes(tool));
    if (unknown.length > 0) {
      issues.push({
        severity: "error",
        file: agent.relativePath,
        message: `${agent.relativePath}: native child cannot load unknown built-in tools: ${unknown.join(", ")}`,
      });
    }
  }
}

export async function repairRuntimePackageDuplicates(root, options = {}) {
  const agentDir = options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi/agent");
  const settings = [
    await readSettings(path.join(agentDir, "settings.json"), "global"),
    await readSettings(path.join(root, ".pi/settings.json"), "project"),
  ].filter(Boolean);
  const global = settings.find((entry) => entry.scope === "global");
  const project = settings.find((entry) => entry.scope === "project" && entry.path !== global?.path);
  const globalPackages = runtimePackages(global?.value.packages);
  const projectPackages = runtimePackages(project?.value.packages);
  const repairs = [];

  if (globalPackages.length > 0) {
    const kept = globalPackages.find((entry) => packageSource(entry) === RUNTIME_PACKAGES.piSubagents.source) ?? globalPackages[0];
    await repairSettingsRuntimePackages(global, kept, repairs);
    await repairSettingsRuntimePackages(project, undefined, repairs, kept);
  } else if (projectPackages.length > 1) {
    await repairSettingsRuntimePackages(project, projectPackages[0], repairs);
  }

  return repairs;
}

async function readSettings(settingsPath, scope) {
  try {
    const value = JSON.parse(await readFile(settingsPath, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return { path: settingsPath, scope, value };
  } catch {
    return undefined;
  }
}

async function repairSettingsRuntimePackages(settings, kept, repairs, canonicalKept = kept) {
  if (!settings || !Array.isArray(settings.value.packages)) return;
  const configured = runtimePackages(settings.value.packages);
  const keptIndex = kept ? configured.indexOf(kept) : -1;
  const removed = configured.filter((_entry, index) => index !== keptIndex);
  if (removed.length === 0) return;

  let inserted = false;
  const packages = [];
  for (const entry of settings.value.packages) {
    if (!isPiSubagentsPackage(entry)) {
      packages.push(entry);
    } else if (!inserted && kept) {
      packages.push(kept);
      inserted = true;
    }
  }

  const backupPath = `${settings.path}.pi-personas.bak`;
  const temporaryPath = `${settings.path}.${process.pid}.tmp`;
  await copyFile(settings.path, backupPath);
  await writeFile(temporaryPath, `${JSON.stringify({ ...settings.value, packages }, null, 2)}\n`, "utf8");
  await rename(temporaryPath, settings.path);
  repairs.push({
    scope: settings.scope,
    settingsPath: settings.path,
    backupPath,
    kept: canonicalKept,
    removed,
  });
}

function packageSource(entry) {
  return typeof entry === "string" ? entry : entry?.source;
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
  if (dependency?.ok && !versionAtLeast(dependency.version, PI_SUBAGENTS_ROUNDTABLE_MINIMUM_VERSION)) {
    issues.push({
      severity: "warning",
      message: `${spec.name} ${dependency.version ?? "unknown"} is older than the supported round-table runtime; upgrade to >=${PI_SUBAGENTS_ROUNDTABLE_MINIMUM_VERSION}`,
    });
  }
}

function runtimeDependencyProblems(dependencies, minimumPiSubagentsVersion) {
  return [
    runtimeDependencyProblem(dependencies.piSubagents, RUNTIME_PACKAGES.piSubagents, minimumPiSubagentsVersion),
  ].filter(Boolean);
}

function runtimeDependencyProblem(dependency, spec, minimumVersion) {
  if (!dependency?.ok) return `${spec.name} is missing at ${dependency?.path ?? "unknown"}`;
  if (dependency.configured === false) return `${spec.name} is installed but not configured in Pi settings`;
  if (minimumVersion && !versionAtLeast(dependency.version, minimumVersion)) {
    return `${spec.name} ${dependency.version ?? "unknown"} is incompatible; round-tables require >=${minimumVersion}`;
  }
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

  const checkedFiles = new Set();
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
    const inspection = await inspectDocPath(project.root, entry.docPath);
    if (!inspection.ok) {
      issues.push({
        severity: "error",
        file: entry.owner,
        message: inspection.reason === "missing"
          ? `${entry.owner}: docs path does not exist: ${entry.docPath}`
          : `${entry.owner}: docs path must stay inside workspace: ${entry.docPath} (${inspection.reason})`,
      });
      continue;
    }

    if (inspection.type === "directory" && inspection.deferred.length > 0 && !inspection.indexFile) {
      issues.push({
        severity: "warning",
        file: entry.owner,
        message: `${entry.owner}: ${entry.docPath} has ${inspection.deferred.length} nested docs but no _index.md; run /persona index ${entry.docPath} or add an index manually for progressive discovery`,
      });
    }
    for (const filePath of [...inspection.files, ...inspection.deferred]) {
      if (checkedFiles.has(filePath)) continue;
      checkedFiles.add(filePath);
      const resolvedFile = resolveWorkspacePath(project.root, filePath);
      if (!resolvedFile.ok) continue;
      const content = await readFile(resolvedFile.path, "utf8");
      if (findPersonaTemplatePlaceholders(content).length > 0) {
        issues.push({
          severity: "error",
          file: filePath,
          message: `${filePath}: unresolved template placeholder; finish onboarding with real operating context`,
        });
      }
    }
  }
}

function collectAgentTemplatePlaceholderIssues(project, issues) {
  for (const file of project.files) {
    const fields = [file.rawFrontmatter?.description, file.body];
    if (!fields.some((value) => findPersonaTemplatePlaceholders(value).length > 0)) continue;
    issues.push({
      severity: "error",
      file: file.relativePath,
      message: `${file.relativePath}: unresolved template placeholder; finish onboarding with a real persona description and prompt`,
    });
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
        message: `${entry.owner}: skills entry looks like a path, but Pi Persona skills are Pi skill names: ${entry.skill}`,
      });
    }
  }
}

function looksLikePath(value) {
  return /[\\/]/.test(value) || value.startsWith(".") || value.endsWith(".md");
}

function collectLegacyMetadataIssues(project, issues) {
  for (const agent of project.agents) {
    for (const field of ["consults", "tags"]) {
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
    case "consults":
      return "route by agent descriptions instead";
    case "tags":
      return "prefer high-signal descriptions";
    default:
      return "review this field";
  }
}
