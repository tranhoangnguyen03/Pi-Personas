import { resolveAgentScope } from "./resolver.js";
import { getPrimaryGeneralistState } from "./agents.js";
import { buildScopedSubagentParams, formatDocReadPreamble } from "./runtime.js";

const DEFAULT_EMPTY_TASK = "Start a fresh role-aware persona session. Ask the user what they need if no request was supplied.";

export function buildAgentLaunchRequest(scope, options = {}) {
  const context = options.context === "fork" ? "fork" : "fresh";
  const userTask = normalizeTask(options.task);
  const task = buildLaunchTask(scope, userTask);
  const subagentParams = buildScopedSubagentParams(scope, task, { context });

  return {
    agentName: scope.agent.name,
    context,
    docs: scope.docs,
    skills: scope.skills,
    tools: scope.tools,
    consults: scope.consults,
    tags: scope.tags,
    subagentParams,
  };
}

export async function resolveAgentLaunchRequest(root, agentName, options = {}) {
  const scope = await resolveAgentScope(root, agentName);
  return buildAgentLaunchRequest(scope, options);
}

export function formatPersonaList(project) {
  const lines = [
    "# Pi Personas",
    "",
  ];

  if (project.agents.length === 0) {
    lines.push("- none");
    return lines.join("\n");
  }

  const primaryPaths = new Set(getPrimaryGeneralistState(project).effectivePrimary.map((agent) => agent.relativePath));
  for (const agent of project.agents) {
    const roleLabel = primaryPaths.has(agent.relativePath) ? `${agent.role} (primary)` : agent.role;
    lines.push(`- ${agent.name} - ${roleLabel}`);
    lines.push(`  ${agent.description}`);
    lines.push(`  docs: ${agent.docs.length ? agent.docs.join(", ") : "none"}`);
    lines.push(`  skills: ${agent.skills.length ? agent.skills.join(", ") : "none"}`);
  }

  return lines.join("\n");
}

function buildLaunchTask(scope, userTask) {
  const sections = [];
  const docPreamble = formatDocReadPreamble(scope);
  if (docPreamble) sections.push(docPreamble);

  sections.push([
    "## Pi Persona Awareness",
    "",
    `Agent: ${scope.agent.name}`,
    `Role: ${scope.agent.role}`,
    `Description: ${scope.agent.description}`,
    `Docs: ${scope.docs.length ? scope.docs.join(", ") : "none"}`,
    `Skills: ${scope.skills.length ? scope.skills.join(", ") : "none"}`,
  ].join("\n"));

  sections.push([
    "## Consult Execution",
    "",
    "Tool: subagent",
    "Consult known personas from the roster when specialist expertise is useful.",
    `requester: ${scope.agent.name}`,
    "Known personas:",
    ...formatRosterLines(scope.agentRoster),
    "Default consult context: fresh",
    "Use context: fork only when the request genuinely requires full conversation context.",
    "You, the requesting agent, must write the consult summary before calling the consultant.",
    "Include these fields in the consultant task: requester, consultant, context, summary, question, constraints, expectedOutput.",
    "After the subagent result returns, synthesize the answer and append compact provenance when useful:",
    "Consulted:",
    "- <consultant> (answered|failed): <one-line summary>",
  ].join("\n"));

  const baseline = scope.promptSections.find((section) => section.label === "Baseline")?.body;
  if (baseline) {
    sections.push(["## Baseline Context", "", baseline].join("\n"));
  }

  sections.push(["## User Request", "", userTask].join("\n"));
  return sections.join("\n\n");
}

function formatRosterLines(agentRoster = []) {
  return agentRoster.map((agent) => `- ${agent.name} - ${agent.role}: ${agent.description}`);
}

function normalizeTask(task) {
  if (typeof task !== "string") return DEFAULT_EMPTY_TASK;
  const trimmed = task.trim();
  return trimmed || DEFAULT_EMPTY_TASK;
}
