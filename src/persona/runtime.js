import { readFile } from "node:fs/promises";
import path from "node:path";

import { isPiSubagentsInstalled } from "./dependencies.js";

export const PERSONA_BACKENDS = new Set(["legacy", "native"]);
export const NATIVE_CHILD_TOOLS = Object.freeze(["read", "grep", "find", "ls"]);
export const NATIVE_BUILTIN_TOOLS = Object.freeze(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);

// No explicit PI_PERSONA_BACKEND and no .pi/persona.json backend preference: default to
// legacy only when pi-subagents is installed (detectDependencies' `ok` flag, the same
// existence check doctor uses), otherwise default to native. This is a one-shot pick at
// selection time - it never re-checks or falls back once a backend starts executing.
export async function resolvePersonaBackend(root, options = {}) {
  const configured = options.env?.PI_PERSONA_BACKEND ?? process.env.PI_PERSONA_BACKEND;
  if (configured) return requireBackend(configured, "PI_PERSONA_BACKEND");
  try {
    const value = JSON.parse(await readFile(path.join(root, ".pi/persona.json"), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(".pi/persona.json must contain a JSON object");
    }
    if (value.backend != null) return requireBackend(value.backend, ".pi/persona.json backend");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      if (error instanceof SyntaxError) throw new Error(`Invalid .pi/persona.json: ${error.message}`);
      throw error;
    }
  }
  return (await isPiSubagentsInstalled(root)) ? "legacy" : "native";
}

export function resolveNativeChildTools(tools = []) {
  const selected = tools.length ? [...new Set(tools)] : [...NATIVE_CHILD_TOOLS];
  const unknown = selected.filter((name) => !NATIVE_BUILTIN_TOOLS.includes(name));
  if (unknown.length > 0) {
    throw new Error(`Native child cannot load unknown built-in tools: ${unknown.join(", ")}. Child extensions stay disabled to keep delegation leaf-only.`);
  }
  return selected;
}

export function snapshotForkBranch(sessionManager, toolCallId) {
  const branch = structuredClone(sessionManager?.getBranch?.() ?? []);
  const inFlightIndex = branch.findIndex((entry) => entry?.type === "message"
    && entry.message?.role === "assistant"
    && entry.message.content?.some?.((part) => part?.type === "toolCall" && part.id === toolCallId));
  if (inFlightIndex < 0) {
    throw new Error(`Native fork context could not find the triggering tool call '${toolCallId}' on the active branch.`);
  }
  return branch.slice(0, inFlightIndex);
}

function requireBackend(value, source) {
  if (typeof value === "string" && PERSONA_BACKENDS.has(value)) return value;
  throw new Error(`${source} must be 'legacy' or 'native'`);
}

export function buildScopedSubagentParams(scope, task, options = {}) {
  const context = options.context === "fork" ? "fork" : "fresh";
  const params = {
    agent: scope.agent.name,
    task,
    async: false,
    agentScope: "both",
    context,
  };

  applyReadOverride(params, scope);
  applySkillOverride(params, scope);
  applyModelOverride(params, scope);
  return params;
}

export function buildScopedSubagentStep(scope, task) {
  const step = {
    agent: scope.agent.name,
    task,
  };

  applyReadOverride(step, scope);
  applySkillOverride(step, scope);
  applyModelOverride(step, scope);
  return step;
}

function applyReadOverride(target, scope) {
  const reads = getRuntimeReads(scope);
  if (reads.length === 0) return;
  target.reads = reads;
}

function applyModelOverride(target, scope) {
  if (!scope.agent.model) return;
  target.model = scope.agent.model;
}

function applySkillOverride(target, scope) {
  const skills = scope.skills ?? [];
  if (skills.length === 0) return;
  target.skill = skills;
}

export function formatDocReadPreamble(scope) {
  const reads = getRuntimeReads(scope);
  const manifestLines = formatDocManifest(scope);
  const progressiveLines = formatProgressiveDiscoveryManifest(scope);
  if (
    reads.length === 0
    && manifestLines.length === 0
    && progressiveLines.length === 0
  ) {
    return "";
  }

  const lines = reads.length > 0
    ? [`[Read from: ${reads.join(", ")}]`]
    : ["[Read from: none]"];
  if (manifestLines.length > 0) {
    lines.push("", "Resolved doc files:", ...manifestLines);
  }
  if (progressiveLines.length > 0) {
    lines.push("", "Progressive doc discovery:", ...progressiveLines);
  }

  return lines.join("\n");
}

function getRuntimeReads(scope) {
  return [...(scope.derived?.defaultReads ?? scope.docs ?? [])];
}

function formatDocManifest(scope) {
  const manifest = scope.derived?.docManifest ?? [];
  if (!manifest.some((entry) => entry.files?.length > 0 && (entry.files.length !== 1 || entry.files[0] !== entry.declared))) {
    return [];
  }

  return manifest
    .filter((entry) => entry.files?.length > 0)
    .map((entry) => `- ${entry.declared}: ${entry.files.join(", ")}`);
}

function formatProgressiveDiscoveryManifest(scope) {
  const manifest = scope.derived?.docManifest ?? [];
  return manifest
    .filter((entry) => entry.deferred?.length > 0)
    .map((entry) => {
      const noun = entry.deferred.length === 1 ? "nested file" : "nested files";
      const indexInstruction = entry.indexFile
        ? `read ${entry.indexFile} before opening deeper docs`
        : "no _index file was found; inspect deeper docs deliberately only if needed";
      return `- ${entry.declared}: ${entry.deferred.length} ${noun} not included in reads; ${indexInstruction}`;
    });
}
