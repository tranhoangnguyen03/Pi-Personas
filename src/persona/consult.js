import { discoverPersonaProject, findUniqueAgent } from "./agents.js";
import { resolveAgentScope } from "./resolver.js";
import { formatDocReadPreamble } from "./runtime.js";

export function buildConsultEnvelope(input) {
  const requester = requireText(input.requester, "requester");
  const consultant = requireText(input.consultant, "consultant");
  const question = requireText(input.question, "question");
  const summary = requireText(input.summary, "summary");
  const context = input.context === "fork" ? "fork" : "fresh";

  return {
    consult: {
      requester,
      consultant,
      question,
      summary,
      context,
      constraints: optionalText(input.constraints),
      expectedOutput: optionalText(input.expectedOutput),
    },
  };
}

// `options.project`/`options.packRoot`, when supplied by a bound pack
// session, resolve requester/consultant from that retained snapshot instead
// of rediscovering `root`'s `.pi/agents`; see resolveAgentScope.
export async function resolveConsultLaunchRequest(root, input, options = {}) {
  const project = options.project ?? await discoverPersonaProject(root);
  const requester = findAgent(project, input.requester, "requester");
  const consultant = findAgent(project, input.consultant, "consultant");
  if (requester.name === consultant.name) {
    throw new Error("consultant must be a different persona from requester");
  }

  const consultantScope = await resolveAgentScope(root, consultant.name, { project, packRoot: options.packRoot });
  const envelope = buildConsultEnvelope({
    ...input,
    requester: requester.name,
    consultant: consultant.name,
  });
  const task = buildConsultTask(consultantScope, envelope);

  return {
    requester,
    consultant,
    context: envelope.consult.context,
    envelope,
    docs: consultantScope.docs,
    skills: consultantScope.skills,
    tools: consultantScope.tools,
    consults: consultantScope.consults,
    tags: consultantScope.tags,
    scope: consultantScope,
    task,
  };
}

export function formatConsultProvenance(results) {
  const lines = ["Consulted:"];
  for (const result of results) {
    lines.push(`- ${result.consultant} (${result.status}): ${result.summary || "(no summary)"}`);
  }
  return lines.join("\n");
}

export function formatConsultBridgeResult(consultRequest, answerText, isError = false) {
  const text = normalizeAnswerText(answerText);
  return [
    `## ${consultRequest.consultant.name}`,
    "",
    text,
    "",
    formatConsultProvenance([{
      consultant: consultRequest.consultant.name,
      status: isError ? "failed" : "answered",
      summary: summarizeAnswer(text),
    }]),
  ].join("\n");
}

function buildConsultTask(scope, envelope) {
  const { consult } = envelope;
  const sections = [];
  const docPreamble = formatDocReadPreamble(scope);
  if (docPreamble) sections.push(docPreamble);

  sections.push([
    "## Pi Persona Consult",
    "",
    `requester: ${consult.requester}`,
    `consultant: ${consult.consultant}`,
    `context: ${consult.context}`,
    `summary: ${consult.summary}`,
    `question: ${consult.question}`,
    `constraints: ${consult.constraints || "none"}`,
    `expectedOutput: ${consult.expectedOutput || "focused answer for the requester"}`,
    "",
    "Answer the requester directly from your own resolved docs and skills.",
    "This consult is a leaf task.",
    "Do not call `persona_consult`, raw `subagent`, `subagent list`, `contact_supervisor`, or `intercom`.",
    "If blocked, report the blocker in your returned answer.",
  ].join("\n"));

  const baseline = scope.promptSections.find((section) => section.label === "Baseline")?.body;
  if (baseline) {
    sections.push(["## Baseline Context", "", baseline].join("\n"));
  }

  return sections.join("\n\n");
}

function findAgent(project, name, label) {
  const agentName = requireText(name, label);
  return findUniqueAgent(project, agentName, label);
}

function requireText(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`consult ${field} is required`);
  }
  return value.trim();
}

function optionalText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeAnswerText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "(no output)";
}

function summarizeAnswer(text) {
  const line = text
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry && !entry.startsWith("#"));
  if (!line) return "(no output)";
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}
