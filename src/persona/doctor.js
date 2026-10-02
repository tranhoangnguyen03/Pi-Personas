import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import {
  discoverPersonaProject,
  getPrimaryGeneralistState,
  resolveWorkspacePath,
} from "./agents.js";
import { inspectDocPath } from "./doc-index.js";
import { listGlobalPersonaPacks } from "./global-pack-store.js";
import { findPersonaTemplatePlaceholders } from "./init-manifest.js";
import { runPersonaPackAction } from "./pack-lifecycle.js";
import { readGlobalDefaultPack } from "./pack-session.js";
import { validatePersonaSchema } from "./schema.js";
import { assertNativeBackend, NATIVE_BUILTIN_TOOLS } from "./runtime.js";

// options.team, when supplied by the extension boundary, is this session's
// current global-team scope (see teamScopeState in extensions/pi-persona.ts):
// { state: "bound", qualifiedName } or { state: "legacy" | "none" |
// "missing-bound" | "migration-required" }. A bound global team does not
// need this project's own foundation/baseline or installed project packs --
// none of ctx.cwd's own agents are registered as commands while a team is
// bound (see registerProjectCommands), so demanding a project foundation in
// that state would be pure noise, not a real gap. options.storeRoot, when
// supplied, additionally reports on the global persona pack store itself
// (installed counts, pending drafts, default), independent of ctx.cwd.
export async function runDoctor(root, options = {}) {
  const project = await discoverPersonaProject(root);
  const issues = [];
  const team = options.team;
  const bound = team?.state === "bound";
  // "legacy" (or no team info at all, i.e. a caller outside the global-team-
  // aware extension boundary) is the only condition under which this
  // project's own ctx.cwd foundation/project-local packs are actually load-
  // bearing. "none", "missing-bound", and "migration-required" are every bit
  // as team-model-aware as "bound" -- they just haven't successfully bound
  // one yet -- so demanding a project foundation or flagging project-local
  // pack drift in those states is a false positive: the fix is /persona
  // team, never /persona onboard.
  const needsLegacyFoundationCheck = !team || team.state === "legacy";

  await collectBackendIssues(root, options, issues);
  collectParseIssues(project, issues);
  if (!project.baseline && needsLegacyFoundationCheck) {
    issues.push({
      severity: "error",
      message: "project foundation is missing; run /persona onboard",
    });
  }
  issues.push(...validatePersonaSchema(project));
  collectDuplicateNameIssues(project, issues);
  collectAgentTemplatePlaceholderIssues(project, issues);
  await collectDocsIssues(project, issues);
  collectSkillsIssues(project, issues);
  collectLegacyMetadataIssues(project, issues);
  let packStatus;
  try {
    packStatus = await runPersonaPackAction(root, { action: "status" });
    if (needsLegacyFoundationCheck) collectPackIssues(packStatus, issues);
  } catch (error) {
    issues.push({
      severity: "error",
      message: `persona pack state is invalid: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  collectNativeIssues(project, issues);

  let globalPackSummary;
  if (options.storeRoot) {
    try {
      globalPackSummary = await summarizeGlobalPackStore(options.storeRoot, team);
      issues.push(...globalPackSummary.issues);
    } catch (error) {
      issues.push({
        severity: "error",
        message: `persona pack store is invalid: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  const status = issues.some((issue) => issue.severity === "error")
    ? "error"
    : issues.some((issue) => issue.severity === "warning")
      ? "warning"
      : "pass";

  return {
    status,
    backend: "native",
    root,
    project,
    packStatus,
    team,
    globalPackSummary,
    issues,
  };
}

export async function assertPersonaRuntimeReady(root, options = {}) {
  await assertNativeBackend(root, options);
  return { backend: "native" };
}

// Pure, storeRoot-scoped summary (no Pi API, matches global-pack-store.js's
// and pack-session.js's own "explicit root" convention): installed/pending
// counts and default are always reported when options.storeRoot is passed to
// runDoctor; per-state team recovery guidance ("missing pack management
// recovery") is added only when the caller also passes options.team.
async function summarizeGlobalPackStore(storeRoot, team) {
  const { official, custom } = await listGlobalPersonaPacks(storeRoot);
  const defaultRecord = await readGlobalDefaultPack(storeRoot);
  let drafts = [];
  try {
    const entries = await readdir(path.join(storeRoot, "drafts"), { withFileTypes: true });
    drafts = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const issues = [];
  for (const draft of drafts) {
    issues.push({
      severity: "warning",
      message: `persona pack draft '${draft}' is unfinished; run /persona pack preview ${draft} and /persona pack apply ${draft}, or /persona pack cancel ${draft} to discard it`,
    });
  }
  if (team) {
    switch (team.state) {
      case "missing-bound":
        issues.push({
          severity: "error",
          message: `this session's persona team '${team.qualifiedName ?? "(unknown)"}' could not be loaded; run /persona team to choose a valid pack`,
        });
        break;
      case "migration-required":
        issues.push({
          severity: "warning",
          message: "this workspace's persona setup predates global persona packs; run /persona migrate inspect, then /persona migrate preview/apply, or run /persona team to choose an already-installed team",
        });
        break;
      case "none":
        issues.push({
          severity: "warning",
          message: "no persona team is bound for this session; run /persona team to choose one",
        });
        break;
      default:
        break;
    }
  }

  return {
    official: official.length,
    custom: custom.length,
    drafts: drafts.length,
    default: defaultRecord?.defaultPack ?? null,
    issues,
  };
}

export function formatDoctorReport(result) {
  const lines = [
    "# Pi Persona Doctor",
    "",
    `Status: ${result.status}`,
    "Backend: native",
    "",
    "## Native Checks",
    "- static doctor: resolved baseline + agent built-in tool names",
    "- live launch preflight: loaded skills, model, provider, and current authentication",
  ];
  if (result.globalPackSummary) {
    const summary = result.globalPackSummary;
    lines.push(
      "",
      "## Global Persona Packs",
      `Installed: ${summary.official} official, ${summary.custom} custom`,
      `Default: ${summary.default ?? "none configured"}`,
      `Pending drafts: ${summary.drafts}`,
    );
    if (result.team) {
      lines.push(`Session team: ${result.team.state === "bound" ? result.team.qualifiedName : result.team.state}`);
    }
  }
  lines.push(
    "",
    "## Project",
    `Agents: ${result.project.agents.length} launchable`,
  );

  const primaryState = getPrimaryGeneralistState(result.project);
  lines.push(`Generalists [G]: ${primaryState.generalists.length}`);
  if (result.packStatus) {
    lines.push(`Persona packs: ${result.packStatus.packs.length} installed, ${result.packStatus.drafts.length} unfinished`);
  }
  const needsLegacyFoundationCheck = !result.team || result.team.state === "legacy";
  if (!result.project.baseline && needsLegacyFoundationCheck) {
    lines.push("", "No project foundation found. Run /persona onboard.");
  } else if (result.project.agents.length === 0 && needsLegacyFoundationCheck) {
    lines.push("", "No project-local persona packs installed. Run /persona pack list to browse and install global persona packs.");
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

  return lines.join("\n");
}

async function collectBackendIssues(root, options, issues) {
  try {
    await assertNativeBackend(root, options);
  } catch (error) {
    issues.push({
      severity: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
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
        message: `${entry.owner}: library path must stay inside workspace: ${entry.docPath}`,
      });
      continue;
    }
    const inspection = await inspectDocPath(project.root, entry.docPath);
    if (!inspection.ok) {
      issues.push({
        severity: "error",
        file: entry.owner,
        message: inspection.reason === "missing"
          ? `${entry.owner}: library path does not exist: ${entry.docPath}`
          : `${entry.owner}: library path must stay inside workspace: ${entry.docPath} (${inspection.reason})`,
      });
      continue;
    }

    if (inspection.type === "directory" && inspection.deferred.length > 0 && !inspection.indexFile) {
      const nestedFiles = `${inspection.deferred.length} nested library file${inspection.deferred.length === 1 ? "" : "s"}`;
      issues.push({
        severity: "warning",
        file: entry.owner,
        message: `${entry.owner}: ${entry.docPath} has ${nestedFiles} but no _index.md; add one there or ask Pi to refresh the library index for progressive discovery`,
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
          message: `${filePath}: unresolved template placeholder; finish onboarding with real project context`,
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

// Project-local pack management commands (install/author/configure/update/
// remove) were retired from the command surface in favor of global packs
// (see /persona pack); an already-installed project-local pack still runs
// exactly as before through the unbound ctx.cwd fallback, but there is no
// longer a command that can act on these findings, so the messages below are
// read-only status, not a call to action that no longer exists.
function collectPackIssues(status, issues) {
  for (const pack of status.packs) {
    if (pack.configuration !== "complete") {
      issues.push({
        severity: "warning",
        message: `project-local persona pack '${pack.name}' configuration was never marked complete; it still runs with its current files (project-local pack management has moved to global packs -- see /persona pack)`,
      });
    }
    for (const problem of pack.problems) {
      issues.push({
        severity: "error",
        message: `persona pack '${pack.name}': ${problem}`,
      });
    }
    if (pack.update.includes("without version bump") || pack.update.startsWith("unavailable:")) {
      issues.push({
        severity: "warning",
        message: `persona pack '${pack.name}' update source: ${pack.update}`,
      });
    }
  }
  for (const draft of status.drafts) {
    issues.push({
      severity: "warning",
      message: `unfinished project-local persona pack draft '${draft}' at .pi/persona-pack-drafts/${draft}; project-local pack authoring has moved to global packs (see /persona pack create) -- remove this draft manually if it is no longer needed`,
    });
  }
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
