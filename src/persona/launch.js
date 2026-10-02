import { resolveAgentScope } from "./resolver.js";
import { formatPersonaDisplayName } from "./agents.js";
import { formatDocReadPreamble } from "./runtime.js";
import { isDirectPersonaCommandName } from "./schema.js";

export function buildAgentLaunchRequest(scope, options = {}) {
  return {
    agentName: scope.agent.name,
    role: scope.agent.role,
    context: "active",
    userMessage: normalizeTask(options.task),
    docs: scope.docs,
    skills: scope.skills,
    tools: scope.tools,
    consults: scope.consults,
    tags: scope.tags,
    systemPrompt: buildActivePersonaSystemPrompt(scope),
  };
}

// `options.project`/`options.packRoot`, when supplied by a bound pack
// session, resolve the persona's scope from that retained snapshot instead of
// rediscovering `root`'s `.pi/agents`; see resolveAgentScope.
export async function resolveAgentLaunchRequest(root, agentName, options = {}) {
  const scope = await resolveAgentScope(root, agentName, options);
  return buildAgentLaunchRequest(scope, options);
}

export function formatPersonaList(project) {
  const lines = [
    "# Pi Personas",
    "",
  ];

  if (project.agents.length === 0) {
    lines.push(project.baseline
      ? "Project foundation is ready, but no persona packs are installed. Run /persona pack list or /persona pack author <name>."
      : "No project foundation found. Run /persona onboard.");
    return lines.join("\n");
  }

  for (const agent of project.agents) {
    lines.push(`- ${formatPersonaDisplayName(agent)} - ${agent.role}`);
    lines.push(`  ${agent.description}`);
    const pack = agent.relativePath.match(/^\.pi\/agents\/packs\/([^/]+)\//)?.[1];
    if (pack) lines.push(`  pack: ${pack}`);
    lines.push(`  library: ${agent.docs.length ? agent.docs.join(", ") : "none"}`);
    lines.push(`  skills: ${agent.skills.length ? agent.skills.join(", ") : "none"}`);
    lines.push(`  launch: ${isDirectPersonaCommandName(agent.name) ? `/${agent.name}` : `/persona use ${agent.name}`}`);
  }

  return lines.join("\n");
}

function buildActivePersonaSystemPrompt(scope) {
  const sections = [];
  const docPreamble = formatDocReadPreamble(scope);
  if (docPreamble) sections.push(docPreamble);

  sections.push([
    "## Active Pi Persona",
    "",
    `You are the active Pi Persona \`${scope.agent.name}\` for this chat session.`,
    `Agent: ${scope.agent.name}`,
    `Role: ${scope.agent.role}`,
    `Description: ${scope.agent.description}`,
    `Library: ${scope.docs.length ? scope.docs.join(", ") : "none"}`,
    `Skills: ${scope.skills.length ? scope.skills.join(", ") : "none"}`,
    "",
    "Answer the user's current request directly as this persona, using the active Pi chat session.",
    "Do not start a child run to answer a direct persona command.",
    "Stay in this persona until the user switches personas or runs /persona clear.",
  ].join("\n"));

  sections.push([
    "## Consult Execution",
    "",
    "Tool: persona_consult",
    "Consult known personas from the roster only when another persona's expertise is useful.",
    `requester: ${scope.agent.name}`,
    "Known personas:",
    ...formatRosterLines(scope.agentRoster),
    "Use only the known personas above as Pi Persona consultants.",
    "Do not use raw `subagent list` to discover Pi Persona consultants; it belongs to separately installed subagent packages.",
    "Raw `subagent` launches bypass Pi Persona consult semantics, active persona state, backend policy, and provenance.",
    "Default consult context: fresh",
    "Use context: fork only when the request genuinely requires full conversation context.",
    "You, the requesting agent, must write the consult summary before calling the consultant.",
    "Call persona_consult with requester, consultant, context, summary, question, constraints, and expectedOutput.",
    "When independent perspectives are useful, call multiple sibling persona_consult tools in parallel.",
    "Consultants are leaf tasks and must never launch further persona consultations.",
    "Use /persona-roundtable only when the specialists should see, challenge, or revise one another's positions.",
    "After persona_consult returns, synthesize the answer and preserve its compact provenance when useful.",
  ].join("\n"));

  const baseline = scope.promptSections.find((section) => section.label === "Baseline")?.body;
  if (baseline) {
    sections.push(["## Baseline Context", "", baseline].join("\n"));
  }

  const agent = scope.promptSections.find((section) => section.label === "Agent")?.body;
  if (agent) {
    sections.push(["## Agent Instructions", "", agent].join("\n"));
  }

  return sections.join("\n\n");
}

function formatRosterLines(agentRoster = []) {
  return agentRoster.map((agent) => `- ${agent.name} - ${agent.role}: ${agent.description}`);
}

function normalizeTask(task) {
  if (typeof task !== "string") return undefined;
  const trimmed = task.trim();
  return trimmed || undefined;
}
