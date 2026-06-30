import { discoverPersonaProject, findUniqueAgent } from "./agents.js";
import { resolveAgentScope } from "./resolver.js";
import { buildScopedSubagentParams, formatDocReadPreamble } from "./runtime.js";

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

export async function resolveConsultLaunchRequest(root, input) {
  const project = await discoverPersonaProject(root);
  const requester = findAgent(project, input.requester, "requester");
  const consultant = findAgent(project, input.consultant, "consultant");
  assertCanConsult(requester, consultant);

  const consultantScope = await resolveAgentScope(root, consultant.name);
  const envelope = buildConsultEnvelope({
    ...input,
    requester: requester.name,
    consultant: consultant.name,
  });
  const task = buildConsultTask(consultantScope, envelope);
  const subagentParams = buildScopedSubagentParams(consultantScope, task, { context: envelope.consult.context });

  return {
    requester,
    consultant,
    context: envelope.consult.context,
    envelope,
    docs: consultantScope.docs,
    tools: consultantScope.tools,
    consults: consultantScope.consults,
    tags: consultantScope.tags,
    subagentParams,
  };
}

export function formatConsultProvenance(results) {
  const lines = ["Consulted:"];
  for (const result of results) {
    lines.push(`- ${result.consultant} (${result.status}): ${result.summary || "(no summary)"}`);
  }
  return lines.join("\n");
}

export function formatConsultSubagentInstructions(consultRequest) {
  const provenance = formatConsultProvenance([{
    consultant: consultRequest.consultant.name,
    status: "answered",
    summary: "<one-line summary>",
  }]);

  return [
    "Prepared Pi Persona consult request.",
    "",
    "Call the `subagent` tool with this exact request:",
    "",
    "```json",
    JSON.stringify(consultRequest.subagentParams, null, 2),
    "```",
    "",
    "After the `subagent` result returns, synthesize the answer for the user.",
    "Append compact provenance using this shape, replacing the placeholder summary:",
    "",
    provenance,
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
    "Do not call persona_consult from this consult response. Answer the requester directly from your own scope.",
  ].join("\n"));

  const baseline = scope.promptSections.find((section) => section.label === "Baseline")?.body;
  if (baseline) {
    sections.push(["## Baseline Context", "", baseline].join("\n"));
  }

  return sections.join("\n\n");
}

function assertCanConsult(requester, consultant) {
  if (requester.consults.includes("all")) return;
  if (requester.consults.includes(consultant.name)) return;
  throw new Error(`${requester.name} cannot consult ${consultant.name}`);
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
