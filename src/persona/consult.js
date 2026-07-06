import { readFile } from "node:fs/promises";
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
    skills: consultantScope.skills,
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

export async function extractConsultAnswer(response) {
  const structured = firstChildText(response, "structuredOutput");
  if (structured) return { text: structured, source: "structured" };

  const final = firstChildText(response, "finalOutput") || firstChildText(response, "output");
  if (final) return { text: final, source: "final" };

  for (const artifactPath of artifactOutputPaths(response)) {
    try {
      const text = normalizeAnswerText(await readFile(artifactPath, "utf8"));
      if (text !== "(no output)") {
        return { text, source: "artifact", artifactPath };
      }
    } catch {
      // Ignore missing/stale artifacts; the bridge text fallback below still gives context.
    }
  }

  const bridge = bridgeResponseText(response);
  if (bridge) return { text: bridge, source: "bridge" };

  return {
    text: missingAnswerText(response),
    source: "missing",
  };
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

function firstChildText(response, key) {
  for (const result of childResults(response)) {
    const value = result?.[key];
    const text = stringifyAnswerValue(value);
    if (text) return text;
  }
  return undefined;
}

function stringifyAnswerValue(value) {
  if (typeof value === "string") return value.trim() || undefined;
  if (value === undefined || value === null) return undefined;
  return JSON.stringify(value, null, 2);
}

function childResults(response) {
  const results = response?.result?.details?.results;
  return Array.isArray(results) ? results : [];
}

function artifactOutputPaths(response) {
  const paths = [];
  for (const result of childResults(response)) {
    const outputPath = result?.artifactPaths?.outputPath ?? result?.savedOutputPath;
    if (typeof outputPath === "string" && outputPath) paths.push(outputPath);
  }
  const artifactPath = response?.result?.details?.artifactPath;
  if (typeof artifactPath === "string" && artifactPath) paths.push(artifactPath);
  const children = response?.result?.details?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      if (typeof child?.artifactPath === "string" && child.artifactPath) paths.push(child.artifactPath);
    }
  }
  return [...new Set(paths)];
}

function bridgeResponseText(response) {
  if (response?.errorText) return response.errorText;
  const content = response?.result?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => part?.text)
      .filter((text) => typeof text === "string" && text.length > 0)
      .join("\n")
      .trim();
  }
  return "";
}

function missingAnswerText(response) {
  const metadata = [
    response?.requestId ? `request: ${response.requestId}` : undefined,
    response?.result?.details?.runId ? `run: ${response.result.details.runId}` : undefined,
    ...artifactOutputPaths(response).map((artifactPath) => `artifact: ${artifactPath}`),
  ].filter(Boolean);
  return [
    "Consult completed but no answer text was found.",
    metadata.length ? metadata.join("\n") : "No run or artifact metadata was available.",
  ].join("\n");
}

function summarizeAnswer(text) {
  const line = text
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry && !entry.startsWith("#"));
  if (!line) return "(no output)";
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}
