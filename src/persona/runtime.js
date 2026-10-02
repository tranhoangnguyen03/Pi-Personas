import { readFile } from "node:fs/promises";
import path from "node:path";

export const NATIVE_CHILD_TOOLS = Object.freeze(["read", "grep", "find", "ls"]);
export const NATIVE_BUILTIN_TOOLS = Object.freeze(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);

// Pi Persona runs natively only; the pi-subagents bridge backend has been retired.
// An explicit "native" setting is a harmless no-op. Any other explicit value (most
// notably the removed "legacy" backend) is diagnosed with an actionable error instead
// of being silently ignored, so a stale setting from a pre-native install is surfaced.
export async function assertNativeBackend(root, options = {}) {
  const env = options.env ?? process.env;
  const configuredEnv = env.PI_PERSONA_BACKEND;
  if (configuredEnv !== undefined) {
    requireNativeBackendValue(configuredEnv, "PI_PERSONA_BACKEND environment variable", "unset PI_PERSONA_BACKEND or set it to 'native'");
  }

  let configuredFile;
  try {
    const value = JSON.parse(await readFile(path.join(root, ".pi/persona.json"), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(".pi/persona.json must contain a JSON object");
    }
    configuredFile = value.backend;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      if (error instanceof SyntaxError) throw new Error(`Invalid .pi/persona.json: ${error.message}`);
      throw error;
    }
  }
  if (configuredFile !== undefined) {
    requireNativeBackendValue(configuredFile, "backend field in .pi/persona.json", "remove the backend field, or set it to 'native'");
  }
}

function requireNativeBackendValue(value, source, remediation) {
  if (value === "native") return;
  if (value === "legacy") {
    throw new Error(`${source} is set to 'legacy', but Pi Persona has retired the pi-subagents backend and now runs natively only; ${remediation}.`);
  }
  throw new Error(`${source} must be 'native' (found ${JSON.stringify(value)}); Pi Persona runs natively only; ${remediation}.`);
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

export function formatDocReadPreamble(scope) {
  const reads = getRuntimeReads(scope);
  const manifestLines = formatDocManifest(scope);
  const nestedManifestLines = formatNestedDocManifest(scope);
  const indexSections = formatDocIndexContents(scope);
  const progressiveLines = formatProgressiveDiscoveryManifest(scope);
  if (
    reads.length === 0
    && manifestLines.length === 0
    && nestedManifestLines.length === 0
    && indexSections.length === 0
    && progressiveLines.length === 0
  ) {
    return "";
  }

  const lines = reads.length > 0
    ? [`[Read from: ${reads.join(", ")}]`]
    : ["[Read from: none]"];
  if (manifestLines.length > 0 || nestedManifestLines.length > 0) {
    lines.push("", "Live library catalogue:");
  }
  if (manifestLines.length > 0) {
    lines.push("Resolved doc files:", ...manifestLines);
  }
  if (nestedManifestLines.length > 0) {
    lines.push("Nested doc files:", ...nestedManifestLines);
  }
  if (indexSections.length > 0) {
    lines.push(
      "",
      "Library index contents:",
      "These catalogues are already in context. Read a relevant non-index document before relying on its claims.",
      "Do not infer a document's contents from its filename or index description.",
      ...indexSections,
    );
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

function formatNestedDocManifest(scope) {
  const manifest = scope.derived?.docManifest ?? [];
  return manifest
    .filter((entry) => entry.deferred?.length > 0)
    .map((entry) => `- ${entry.declared}: ${entry.deferred.join(", ")}`);
}

function formatDocIndexContents(scope) {
  const indexes = scope.derived?.docIndexes ?? [];
  return indexes.flatMap((entry) => [
    "",
    `### ${entry.indexFile}`,
    // The index's own body lists sibling paths relative to the directory
    // containing it (see doc-index.js's relativeToDocPath), not to the
    // index file itself or to any other root; stating that containing
    // directory explicitly here avoids the model guessing a base for those
    // relative names, without rewriting the index's own Markdown content.
    `(paths below are relative to ${path.dirname(entry.indexFile)})`,
    "",
    entry.content.trim() || "(empty index)",
  ]);
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
