import { readFile } from "node:fs/promises";

import {
  childResults,
  isIntercomReceiptText,
  normalizeAnswerText,
  requireText,
  stringifyAnswerValue,
} from "./answer-values.js";
import { assertUniqueAgentNames, discoverPersonaProject, findPrimaryGeneralist } from "./agents.js";
import { resolveAgentScope } from "./resolver.js";
import { buildScopedSubagentStep, formatDocReadPreamble } from "./runtime.js";

const MAX_ROSTER_SIZE = 5;
const ADVISORY_ACCEPTANCE = {
  level: "none",
  reason: "Round-table analysis is advisory and does not require repository changes.",
};

export async function resolveRoundtableLaunchRequest(root, input = {}) {
  const query = requireText(input.query, "roundtable query is required");
  const context = input.context === "fork" ? "fork" : "fresh";
  const project = await discoverPersonaProject(root);
  assertUniqueAgentNames(project);
  const generalist = findPrimaryGeneralist(project, "roundtable");
  const selections = validateSelections(project, input.selections);
  const roster = selections.map((selection) => selection.agent);

  const scopes = new Map();
  for (const agent of [generalist, ...roster]) {
    scopes.set(agent.name, await resolveAgentScope(root, agent.name));
  }

  const chain = buildRoundtableChain({
    query,
    generalist,
    generalistScope: scopes.get(generalist.name),
    roster,
    scopes,
  });

  return {
    query,
    context,
    generalist,
    selections,
    roster,
    subagentParams: {
      chain,
      task: `Advisory analysis only. Do not edit or modify files.\n\nQuery: ${query}`,
      clarify: false,
      agentScope: "both",
      context,
      resultDelivery: "response-only",
      control: {
        enabled: false,
        notifyOn: [],
        notifyChannels: [],
      },
    },
  };
}

export async function resolveRoundtableSelectionRequest(root, input = {}) {
  const query = requireText(input.query, "roundtable query is required");
  const context = input.context === "fork" ? "fork" : "fresh";
  const project = await discoverPersonaProject(root);
  assertUniqueAgentNames(project);
  const generalist = findPrimaryGeneralist(project, "roundtable selection");
  const specialists = project.agents.filter((agent) => agent.role === "specialist");
  if (specialists.length === 0) {
    throw new Error("roundtable requires at least one specialist agent");
  }

  return {
    query,
    context,
    generalist,
    candidates: specialists,
    userMessage: buildSelectionTask(query, generalist, specialists, context),
  };
}

export async function extractRoundtableAnswer(response, moderatorName) {
  const moderator = childResults(response)
    .filter((result) => result?.agent === moderatorName)
    .at(-1);
  if (moderator) {
    const structured = stringifyAnswerValue(moderator.structuredOutput);
    if (structured) return { text: structured, source: "structured" };
    const final = stringifyAnswerValue(moderator.finalOutput) || stringifyAnswerValue(moderator.output);
    if (final) return { text: final, source: "final" };

    const artifactPath = moderator.artifactPaths?.outputPath ?? moderator.savedOutputPath;
    if (typeof artifactPath === "string" && artifactPath) {
      try {
        const text = (await readFile(artifactPath, "utf8")).trim();
        if (text) return { text, source: "artifact", artifactPath };
      } catch {
        // The current run's exact synthesis artifact is optional; never search for another run.
      }
    }
  }

  const bridge = bridgeResponseText(response);
  if (!response?.isError && bridge && !isIntercomReceiptText(bridge)) {
    return { text: bridge, source: "bridge" };
  }
  return {
    text: "Round-table completed but no moderator synthesis was produced.",
    source: "missing",
  };
}

export function formatRoundtableBridgeResult(roundtable, answerText) {
  return [
    formatRoundtableRosterPreview(roundtable),
    "",
    "## Result",
    "",
    normalizeAnswerText(answerText),
  ].join("\n");
}

export function formatRoundtableBridgeFailure(roundtable, response) {
  const results = childResults(response);
  const completed = results.filter((result) => result?.exitCode === 0).map((result) => result.agent).filter(Boolean);
  const failed = results.filter((result) => result?.exitCode !== undefined && result.exitCode !== 0).map((result) => result.agent).filter(Boolean);
  const phase = roundtableFailurePhase(roundtable.roster.length, results.length);
  return [
    formatRoundtableRosterPreview(roundtable),
    "",
    "## Result",
    "",
    `Round-table did not complete during ${phase}; no moderator synthesis was produced.`,
    completed.length ? `Completed agents: ${[...new Set(completed)].join(", ")}.` : undefined,
    failed.length ? `Failed agents: ${[...new Set(failed)].join(", ")}.` : undefined,
    "You can retry the round-table; Pi Persona will not reuse results from another run.",
  ].filter(Boolean).join("\n");
}

export function formatRoundtableRosterPreview(roundtable) {
  const lines = [
    "# Pi Persona Round-table",
    "",
    `Query: ${roundtable.query}`,
    `Moderator: ${roundtable.generalist.name}`,
    `Context: ${roundtable.context}`,
    "",
    "## Roster",
  ];

  for (const agent of roundtable.roster) {
    lines.push(`- ${agent.name} - ${agent.description}`);
    const selection = roundtable.selections?.find((entry) => entry.agent.name === agent.name);
    if (selection?.reason) lines.push(`  selected because: ${selection.reason}`);
  }

  return lines.join("\n");
}

function buildRoundtableChain({ query, generalist, generalistScope, roster, scopes }) {
  return [
    {
      phase: "Round 1",
      parallel: roster.map((agent) => {
        const scope = scopes.get(agent.name);
        return advisoryStep(buildScopedSubagentStep(scope, buildRoundOneTask(scope, query, roster)));
      }),
    },
    {
      phase: "Round 2",
      parallel: roster.map((agent) => {
        const scope = scopes.get(agent.name);
        return advisoryStep(buildScopedSubagentStep(scope, buildRoundTwoTask(scope, query, roster)));
      }),
    },
    {
      phase: "Synthesis",
      ...advisoryStep(buildScopedSubagentStep(generalistScope, buildSynthesisTask(generalistScope, query, roster))),
    },
  ];
}

function buildSelectionTask(query, generalist, specialists, context) {
  return [
    "## Pi Persona Round-table Selection",
    "",
    `Primary generalist: ${generalist.name}`,
    `Query: ${query}`,
    `Context: ${context}`,
    "",
    "Available specialists:",
    ...specialists.map((agent) => `- ${agent.name}: ${agent.description} (docs: ${formatValues(agent.docs)}, skills: ${formatValues(agent.skills)})`),
    "",
    `Select between one and ${MAX_ROSTER_SIZE} specialists whose distinct perspectives are most useful for answering the query.`,
    "Choose only from the available specialists above.",
    "Give a concrete reason for every selection.",
    "Call `persona_roundtable` exactly once with the query unchanged, the selected specialist names and reasons, and this context.",
    "Do not call raw `subagent`, `persona_consult`, `contact_supervisor`, or `intercom` for this workflow.",
    "After the tool completes, present its returned moderator synthesis once. Do not inspect artifact directories, recover historical runs, or produce a second verdict.",
  ].join("\n");
}

function buildRoundOneTask(scope, query, roster) {
  return withDocs(scope, [
    "## Pi Persona Round-table",
    "",
    "Round 1 - Independent Position",
    "",
    `Specialist: ${scope.agent.name}`,
    `Roster: ${formatRosterNames(roster)}`,
    `Query: ${query}`,
    "",
    "Give your independent specialist position. Do not reference peer answers; you have not seen them yet.",
    "This round-table step is a leaf task.",
    "Do not call `persona_consult`, raw `subagent`, `subagent list`, `contact_supervisor`, or `intercom`.",
    "If blocked, report the blocker in your returned answer.",
  ].join("\n"));
}

function buildRoundTwoTask(scope, query, roster) {
  return withDocs(scope, [
    "## Pi Persona Round-table",
    "",
    "Round 2 - Reveal And Revise",
    "",
    `Specialist: ${scope.agent.name}`,
    `Roster: ${formatRosterNames(roster)}`,
    `Query: ${query}`,
    "",
    "Peer round-1 positions:",
    "{previous}",
    "",
    "Revise, qualify, reinforce, or concede your position after reading the peer positions.",
    "This round-table step is a leaf task.",
    "Do not call `persona_consult`, raw `subagent`, `subagent list`, `contact_supervisor`, or `intercom`.",
    "If blocked, report the blocker in your returned answer.",
  ].join("\n"));
}

function buildSynthesisTask(scope, query, roster) {
  return withDocs(scope, [
    "## Pi Persona Round-table",
    "",
    "Moderator Synthesis",
    "",
    `Moderator: ${scope.agent.name}`,
    `Roster: ${formatRosterNames(roster)}`,
    `Query: ${query}`,
    "",
    "Round-table outputs:",
    "{previous}",
    "",
    "Synthesize where specialists converged, where tensions remain, the recommended next action, and any specialist failures with their impact.",
  ].join("\n"));
}

function withDocs(scope, task) {
  return withResolvedScope(scope, task);
}

function withResolvedScope(scope, task) {
  const sections = [];
  const docPreamble = formatDocReadPreamble(scope);
  if (docPreamble) sections.push(docPreamble);
  const baseline = scope.promptSections?.find((section) => section.label === "Baseline")?.body;
  if (baseline) sections.push(["## Baseline Context", "", baseline].join("\n"));
  sections.push(task);
  return sections.join("\n\n");
}

function advisoryStep(step) {
  return { ...step, acceptance: { ...ADVISORY_ACCEPTANCE } };
}

function validateSelections(project, value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ROSTER_SIZE) {
    throw new Error(`roundtable selection must contain between 1 and ${MAX_ROSTER_SIZE} specialists`);
  }
  const specialists = new Map(
    project.agents
      .filter((agent) => agent.role === "specialist")
      .map((agent) => [agent.name, agent]),
  );
  const seen = new Set();
  return value.map((selection, index) => {
    if (!selection || typeof selection !== "object" || Array.isArray(selection)) {
      throw new Error(`roundtable selection[${index}] must be an object`);
    }
    const name = requireText(selection.name, `roundtable selection[${index}].name is required`);
    const reason = requireText(selection.reason, `roundtable selection[${index}].reason is required`);
    const agent = specialists.get(name);
    if (!agent) throw new Error(`roundtable selected unknown specialist: ${name}`);
    if (seen.has(name)) throw new Error(`roundtable selected duplicate specialist: ${name}`);
    seen.add(name);
    return { agent, reason };
  });
}

function formatRosterNames(roster) {
  return roster.map((agent) => agent.name).join(", ");
}

function formatValues(values = []) {
  return values.length > 0 ? values.join(", ") : "none";
}

// Round-table output must not expose bridge errorText, run ids, or artifact paths.
function bridgeResponseText(response) {
  const content = response?.result?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => part?.text)
    .filter((text) => typeof text === "string" && text.length > 0)
    .join("\n")
    .trim();
}

function roundtableFailurePhase(rosterSize, resultCount) {
  if (resultCount <= rosterSize) return "Round 1";
  if (resultCount <= rosterSize * 2) return "Round 2";
  return "moderator synthesis";
}
