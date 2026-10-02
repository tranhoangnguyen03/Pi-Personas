import { randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseDocument, stringify } from "yaml";

import {
  discoverPersonaProject,
  formatPersonaDisplayName,
  resolveWorkspacePathForAccess,
} from "./agents.js";
import {
  applyCustomPersonaPackDraft,
  cancelCustomPersonaPackDraft,
  deleteCustomPersonaPack,
  forkPersonaPack,
  installOfficialPersonaPack,
  listGlobalPersonaPacks,
  previewCustomPersonaPackDraft,
  stageCustomPersonaPackDraft,
  uninstallOfficialPersonaPack,
  updateOfficialPersonaPack,
} from "./global-pack-store.js";
import {
  compareStableVersions,
  hashPersonaPackFiles,
  listBundledPersonaPacks,
  loadPersonaPackSource,
  loadRecordedPersonaPackSource,
  materializePersonaPack,
  materializePersonaPackLibrarySeeds,
  readPersonaPackDraft,
  readPortablePersonaPack,
  sha256,
  validateMaterializedPersonaPack,
} from "./pack-source.js";
import { readGlobalDefaultPack, writeGlobalDefaultPackWithinStoreLock } from "./pack-session.js";
import { isSafeAgentName } from "./schema.js";

const LOCK_PATH = ".pi/persona-packs.lock.yaml";
const DRAFT_ROOT = ".pi/persona-pack-drafts";
const MUTATION_LOCK_PATH = ".pi/.persona-pack-mutation.lock";
const CONFIGURATION_STATES = new Set(["pending", "complete"]);
const OPERATIONS = new Set(["install", "author", "configure", "update", "remove"]);

export async function runPersonaPackAction(root, params = {}) {
  switch (params.action) {
    case "list":
      return listPersonaPacks(root);
    case "status":
      return statusPersonaPacks(root, params.target);
    case "start":
      if (params.operation !== "author") {
        throw new Error("persona_pack start is available only for author");
      }
      return withMutationLock(root, () => startPersonaPackAuthoring(root, params.target));
    case "plan": {
      const built = params.operation === "author"
        ? await withMutationLock(root, () => buildPersonaPackPlan(root, params))
        : await buildPersonaPackPlan(root, params);
      return built.result;
    }
    case "apply": {
      if (params.confirmed !== true) {
        throw new Error("Please approve the displayed plan before applying these changes.");
      }
      if (typeof params.planId !== "string" || !params.planId) {
        throw new Error("The approval could not be matched to the displayed plan. Preview the changes again before applying them.");
      }
      return withMutationLock(root, async () => {
        const built = await buildPersonaPackPlan(root, params);
        if (!built.result.ready || !built.result.planId) {
          throw new Error("persona pack plan is not ready to apply");
        }
        if (built.result.planId !== params.planId) {
          throw new Error("persona pack plan changed; review the new plan before applying");
        }
        if (built.result.confirmation === "permanent-delete" && params.destructiveConfirmed !== true) {
          throw new Error("This removal permanently deletes customized or project-authored pack files. Explicit permanent-deletion confirmation is required before continuing.");
        }
        return applyPersonaPackPlan(root, built);
      });
    }
    default:
      throw new Error("persona_pack action must be list, status, start, plan, or apply");
  }
}

export function formatPersonaPackReport(result, options = {}) {
  if (result.mode === "list") return formatPackList(result);
  if (result.mode === "status") return formatPackStatus(result);
  if (result.mode === "author-start") return formatAuthorStart(result);
  if (result.mode === "plan") return formatPackPlan(result, options);
  if (result.mode === "apply") return formatPackApply(result);
  return "Persona pack operation complete.";
}

// ---- Global persona pack lifecycle (store-backed; official + custom) ----
//
// Distinct from the project-local functions above: every function here
// takes an explicit storeRoot (see global-pack-store.js) and never reads or
// writes a project workspace. This is the single dispatcher both
// `/persona pack` and the `persona_pack` tool call in extensions/pi-persona.ts,
// so the two surfaces share one backend instead of drifting into competing
// UXs.
//
// Confirmation model: install/fork/create/edit/preview/cancel are immediate
// -- nothing they touch is active/shared content (a fresh install, a new
// custom fork, or an inactive draft only the caller knows about). apply,
// update, uninstall, and delete instead return a `confirm-required` result
// describing exactly what will happen when called without
// `confirmed: true`; the caller (command or tool) shows that description and
// calls again with `confirmed: true` to actually mutate. `summary` is plain
// user-facing text (it is what the confirm dialog shows); the exact retry
// parameters live separately in `confirmParams`, so tool syntax never leaks
// into what a person reads. uninstall/delete
// additionally require `clearDefaultConfirmed: true` when the target is the
// current global default (the default is cleared, never silently replaced);
// update additionally requires `discardLocalEdits: true` when the installed
// official pack has local edits (never silently discarded -- fork instead to
// keep them).
const GLOBAL_PACK_OPERATIONS = new Set([
  "list", "status", "install", "update", "uninstall",
  "fork", "create", "edit", "preview", "apply", "cancel", "delete",
]);

export async function resolveInstalledQualifiedPersonaPackName(storeRoot, input) {
  const trimmed = String(input ?? "").trim();
  const { official, custom } = await listGlobalPersonaPacks(storeRoot);
  // A qualified input (`official/<name>` or `custom/<name>`) must still
  // resolve to something actually installed under that exact kind, not just
  // be accepted at face value: a typo'd or stale qualified name (e.g. from a
  // default record pointing at a since-removed pack) previously bypassed the
  // installed-check entirely and was handed straight to callers, several of
  // which then either crashed on an undefined pack lookup or built a
  // confirm-required plan describing an action on a pack that was never
  // there.
  const qualifiedMatch = /^(official|custom)\/([^/]+)$/.exec(trimmed);
  if (qualifiedMatch) {
    const [, kind, name] = qualifiedMatch;
    const list = kind === "official" ? official : custom;
    if (!list.some((pack) => pack.name === name)) {
      throw new Error(`persona pack '${trimmed}' is not installed. Run /persona pack list to see installed packs.`);
    }
    return `${kind}/${name}`;
  }
  const matches = [...official, ...custom].filter((pack) => pack.name === trimmed);
  if (matches.length === 0) {
    throw new Error(`persona pack '${trimmed}' is not installed. Run /persona pack list to see installed packs.`);
  }
  if (matches.length > 1) {
    throw new Error(`persona pack name '${trimmed}' is ambiguous (installed as both official/${trimmed} and custom/${trimmed}); use the qualified name.`);
  }
  return matches[0].qualifiedName;
}

// Minimal, deterministic token binding a confirm-required plan to the exact
// operation/target/content it described: preview computes it once from
// state read outside the lock (cheap, for display); apply recomputes it from
// state read fresh *inside* the store's mutation lock, right before doing
// anything destructive, and refuses to proceed if the two don't match. This
// is not a general approval framework -- just a hash over the handful of
// fields (operation, target, and whatever hashes/flags make that operation's
// outcome deterministic) that pack-lifecycle.js's own update/uninstall/
// delete/apply-draft flows below pass it.
function computeGlobalPackPlanId(parts) {
  return sha256(Buffer.from(JSON.stringify(parts), "utf8"));
}

export async function runGlobalPersonaPackAction(storeRoot, params = {}) {
  if (!GLOBAL_PACK_OPERATIONS.has(params.action)) {
    throw new Error(`persona pack action must be one of: ${[...GLOBAL_PACK_OPERATIONS].join(", ")}`);
  }
  switch (params.action) {
    case "list": return listGlobalPacksReport(storeRoot, params);
    case "status": return statusGlobalPackReport(storeRoot, params);
    case "install": return installGlobalPack(storeRoot, params);
    case "update": return updateGlobalPack(storeRoot, params);
    case "uninstall": return removeGlobalPack(storeRoot, "official", params);
    case "delete": return removeGlobalPack(storeRoot, "custom", params);
    case "fork": return forkGlobalPack(storeRoot, params);
    case "create": return startGlobalPackDraft(storeRoot, "create", params);
    case "edit": return startGlobalPackDraft(storeRoot, "edit", params);
    case "preview": return previewGlobalPackDraft(storeRoot, params);
    case "cancel": return cancelGlobalPackDraft(storeRoot, params);
    case "apply": return applyGlobalPackDraft(storeRoot, params);
    default: throw new Error(`unreachable persona pack action: ${params.action}`);
  }
}

// options.chat: the persona_pack tool path, where the user talks to the
// agent instead of typing /persona commands, so slash-command next steps
// are left out (the tool adds its own agent guidance instead).
export function formatGlobalPersonaPackReport(result, options = {}) {
  switch (result.mode) {
    case "list": return formatGlobalPackList(result);
    // Target-less status is the list plus pending drafts.
    case "status": return result.drafts ? formatGlobalPackList(result) : formatGlobalPackStatus(result, options);
    case "draft": return formatGlobalPackDraft(result, options);
    case "preview": return formatGlobalPackDiff(result);
    default: return result.summary ?? "Persona pack operation complete.";
  }
}

function requireGlobalPackTarget(value, verb) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) throw new Error(`persona pack ${verb} requires a name`);
  return trimmed;
}

// Draft-based actions (create/edit/preview/cancel/apply, fork destination)
// only ever act on custom packs, so accept "custom/<name>" as well as the
// bare name; an official pack must be forked first.
function requireCustomPackName(value, verb) {
  let name = requireGlobalPackTarget(value, verb);
  if (name.startsWith("official/")) {
    throw new Error(`'${name}' is an official pack and cannot be ${verb === "fork" ? "a fork destination" : "edited directly"}; fork it into a custom pack first`);
  }
  if (name.startsWith("custom/")) name = name.slice("custom/".length);
  if (!isSafeAgentName(name)) {
    throw new Error("persona pack name must begin with a lowercase letter and contain only lowercase letters, numbers, or hyphens");
  }
  return name;
}

function splitQualifiedPersonaPackName(qualifiedName) {
  const [kind, name] = String(qualifiedName).split("/");
  return { kind, name };
}

async function globalPackDraftExists(storeRoot, name) {
  return absolutePathExists(path.join(storeRoot, "drafts", name));
}

async function listGlobalDrafts(storeRoot) {
  const draftsRoot = path.join(storeRoot, "drafts");
  if (!await absolutePathExists(draftsRoot)) return [];
  const entries = await readdir(draftsRoot, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

function summarizeGlobalPack(pack, defaultRecord, currentSession) {
  return {
    qualifiedName: pack.qualifiedName,
    kind: pack.kind,
    name: pack.name,
    version: pack.manifest.version,
    description: pack.manifest.description,
    personas: pack.personas,
    edited: pack.edited,
    forkedFrom: pack.meta?.forkedFrom ?? null,
    isDefault: defaultRecord?.defaultPack === pack.qualifiedName,
    isCurrentSession: currentSession?.qualifiedName === pack.qualifiedName,
  };
}

async function listGlobalPacksReport(storeRoot, params) {
  const { official, custom } = await listGlobalPersonaPacks(storeRoot);
  const defaultRecord = await readGlobalDefaultPack(storeRoot);
  const bundled = await listBundledPersonaPacks();
  const catalog = bundled
    .filter((pack) => !official.some((installed) => installed.name === pack.manifest.name))
    .map((pack) => ({ name: pack.manifest.name, version: pack.manifest.version, description: pack.manifest.description }));
  return {
    mode: "list",
    installed: {
      official: official.map((pack) => summarizeGlobalPack(pack, defaultRecord, params.currentSession)),
      custom: custom.map((pack) => summarizeGlobalPack(pack, defaultRecord, params.currentSession)),
    },
    catalog,
    default: defaultRecord?.defaultPack ?? null,
  };
}

async function statusGlobalPackReport(storeRoot, params) {
  const target = String(params.target ?? "").trim();
  if (!target) {
    const drafts = await listGlobalDrafts(storeRoot);
    const listResult = await listGlobalPacksReport(storeRoot, params);
    return { ...listResult, mode: "status", drafts };
  }
  const name = target.includes("/") ? target.split("/")[1] : target;
  let qualifiedName = null;
  try {
    qualifiedName = await resolveInstalledQualifiedPersonaPackName(storeRoot, target);
  } catch (error) {
    if (!await globalPackDraftExists(storeRoot, name)) throw error;
  }
  const draftPending = await globalPackDraftExists(storeRoot, name);
  if (!qualifiedName) {
    return { mode: "status", target: name, installed: false, draftPending, qualifiedName: null };
  }
  const { official, custom } = await listGlobalPersonaPacks(storeRoot);
  const pack = [...official, ...custom].find((candidate) => candidate.qualifiedName === qualifiedName);
  const defaultRecord = await readGlobalDefaultPack(storeRoot);
  return {
    mode: "status",
    target: name,
    installed: true,
    qualifiedName,
    kind: pack.kind,
    version: pack.manifest.version,
    description: pack.manifest.description,
    personas: pack.personas,
    hasBaseline: pack.hasBaseline,
    edited: pack.edited,
    forkedFrom: pack.meta?.forkedFrom ?? null,
    isDefault: defaultRecord?.defaultPack === qualifiedName,
    isCurrentSession: params.currentSession?.qualifiedName === qualifiedName,
    draftPending,
  };
}

async function installGlobalPack(storeRoot, params) {
  const target = requireGlobalPackTarget(params.target, "install");
  if (!(await listBundledPersonaPacks()).some((pack) => pack.manifest.name === target)) {
    throw new Error(`'${target}' is not in the bundled catalog. Official packs install by catalog name only; to bring in your own pack, create or fork a custom pack instead.`);
  }
  const source = await loadPersonaPackSource(storeRoot, target);
  const result = await installOfficialPersonaPack(storeRoot, source);
  return { mode: "apply", operation: "install", ...result, summary: `Installed persona pack '${result.qualifiedName}' (${result.version}).` };
}

async function updateGlobalPack(storeRoot, params) {
  const qualifiedName = await resolveInstalledQualifiedPersonaPackName(storeRoot, requireGlobalPackTarget(params.target, "update"));
  const { kind, name } = splitQualifiedPersonaPackName(qualifiedName);
  if (kind !== "official") {
    throw new Error(`persona pack '${qualifiedName}' is custom; custom packs have no upstream to update. Use /persona pack edit ${name} instead.`);
  }
  const source = await loadPersonaPackSource(storeRoot, name);
  const { official } = await listGlobalPersonaPacks(storeRoot);
  const current = official.find((pack) => pack.qualifiedName === qualifiedName);
  if (!current) {
    throw new Error(`persona pack '${qualifiedName}' is not installed. Run /persona pack list to see installed packs.`);
  }
  const versionOrder = compareStableVersions(source.manifest.version, current.manifest.version);
  // Same version but locally edited is not "up to date": it is a drift the
  // user may want restored to the recorded upstream content. Only a strictly
  // older catalog, or an identical *and* unedited install, is a genuine no-op.
  const sameVersionDrift = versionOrder === 0 && current.edited;
  if (versionOrder < 0 || (versionOrder === 0 && !current.edited)) {
    return {
      mode: "status",
      operation: "update",
      qualifiedName,
      upToDate: true,
      summary: versionOrder === 0
        ? `persona pack '${qualifiedName}' is already up to date at ${current.manifest.version}.`
        : `the bundled catalog version ${source.manifest.version} is older than installed ${current.manifest.version}.`,
    };
  }
  const planId = computeGlobalPackPlanId({
    operation: "update",
    qualifiedName,
    catalogHash: source.integrity,
    activeHash: current.integrity,
  });
  if (!params.confirmed) {
    return {
      mode: "confirm-required",
      operation: "update",
      qualifiedName,
      planId,
      fromVersion: current.manifest.version,
      toVersion: source.manifest.version,
      edited: current.edited,
      confirmParams: { confirmed: true, planId, ...(current.edited ? { discardLocalEdits: true } : {}) },
      summary: sameVersionDrift
        ? `persona pack '${qualifiedName}' has local edits not present in the recorded ${current.manifest.version} install. Restoring it will discard them unless you fork it first (/persona pack fork ${qualifiedName} <new-name>).`
        : current.edited
          ? `persona pack '${qualifiedName}' has local edits not present in the recorded install. Updating to ${source.manifest.version} will discard them unless you fork it first (/persona pack fork ${qualifiedName} <new-name>).`
          : `Update '${qualifiedName}' from ${current.manifest.version} to ${source.manifest.version}?`,
    };
  }
  if (typeof params.planId !== "string" || !params.planId) {
    throw new Error("The approval could not be matched to the displayed plan. Preview the update again before applying it.");
  }
  if (current.edited && params.discardLocalEdits !== true) {
    throw new Error(`persona pack '${qualifiedName}' has local edits not present in the recorded install; pass discardLocalEdits: true (or --discard-edits) to replace them, or fork it first to keep them (/persona pack fork ${qualifiedName} <new-name>)`);
  }
  const result = await updateOfficialPersonaPack(storeRoot, source, {
    discardLocalEdits: params.discardLocalEdits === true,
    verifyBeforeApply: async ({ integrity }) => {
      const freshPlanId = computeGlobalPackPlanId({
        operation: "update",
        qualifiedName,
        catalogHash: source.integrity,
        activeHash: integrity,
      });
      if (freshPlanId !== params.planId) {
        throw new Error(`persona pack '${qualifiedName}' changed since it was previewed; preview the update again before applying it`);
      }
    },
  });
  return {
    mode: "apply",
    operation: "update",
    ...result,
    summary: sameVersionDrift
      ? `Restored persona pack '${result.qualifiedName}' to its recorded ${result.version} content. Local edits were discarded.`
      : `Updated persona pack '${result.qualifiedName}' to ${result.version}.${result.discardedLocalEdits ? " Local edits were discarded." : ""}`,
  };
}

async function removeGlobalPack(storeRoot, expectedKind, params) {
  const verb = expectedKind === "official" ? "uninstall" : "delete";
  const qualifiedName = await resolveInstalledQualifiedPersonaPackName(storeRoot, requireGlobalPackTarget(params.target, verb));
  const { kind, name } = splitQualifiedPersonaPackName(qualifiedName);
  if (kind !== expectedKind) {
    const otherVerb = expectedKind === "official" ? "delete" : "uninstall";
    throw new Error(`persona pack '${qualifiedName}' is ${kind}; use /persona pack ${otherVerb} ${name} instead`);
  }
  const { official, custom } = await listGlobalPersonaPacks(storeRoot);
  const pack = [...official, ...custom].find((candidate) => candidate.qualifiedName === qualifiedName);
  if (!pack) {
    throw new Error(`persona pack '${qualifiedName}' is not installed. Run /persona pack list to see installed packs.`);
  }
  const defaultRecord = await readGlobalDefaultPack(storeRoot);
  const isDefault = defaultRecord?.defaultPack === qualifiedName;
  const verbPast = verb === "uninstall" ? "Uninstalled" : "Deleted";
  const planId = computeGlobalPackPlanId({ operation: verb, qualifiedName, activeHash: pack.integrity, isDefault });
  if (!params.confirmed) {
    return {
      mode: "confirm-required",
      operation: verb,
      qualifiedName,
      isDefault,
      planId,
      confirmParams: { confirmed: true, planId, ...(isDefault ? { clearDefaultConfirmed: true } : {}) },
      summary: isDefault
        ? `Permanently ${verb} '${qualifiedName}'? It is currently the global default; the default will be cleared and no replacement will be chosen automatically.`
        : `Permanently ${verb} '${qualifiedName}'? Any session already using it keeps its own retained copy until that session ends.`,
    };
  }
  if (typeof params.planId !== "string" || !params.planId) {
    throw new Error("The approval could not be matched to the displayed plan. Preview the removal again before applying it.");
  }
  if (isDefault && params.clearDefaultConfirmed !== true) {
    throw new Error(`persona pack '${qualifiedName}' is the current global default; pass clearDefaultConfirmed: true to remove it and clear the default (no replacement is chosen automatically)`);
  }
  let clearedDefault = false;
  // Both checks below run inside removeOfficialPersonaPack/
  // deleteCustomPersonaPack's own store mutation lock, on state read fresh
  // at that moment -- not the isDefault/pack.integrity read above, which
  // happened before the lock and can be stale by the time it is held.
  const verifyBeforeRemove = async ({ integrity }) => {
    const freshDefaultRecord = await readGlobalDefaultPack(storeRoot);
    const freshIsDefault = freshDefaultRecord?.defaultPack === qualifiedName;
    const freshPlanId = computeGlobalPackPlanId({ operation: verb, qualifiedName, activeHash: integrity, isDefault: freshIsDefault });
    if (freshPlanId !== params.planId) {
      throw new Error(`persona pack '${qualifiedName}' changed since it was previewed; preview the removal again before applying it`);
    }
    if (freshIsDefault && params.clearDefaultConfirmed !== true) {
      throw new Error(`persona pack '${qualifiedName}' is the current global default; pass clearDefaultConfirmed: true to remove it and clear the default (no replacement is chosen automatically)`);
    }
  };
  const afterRemove = async () => {
    const freshDefaultRecord = await readGlobalDefaultPack(storeRoot);
    if (freshDefaultRecord?.defaultPack === qualifiedName) {
      await writeGlobalDefaultPackWithinStoreLock(storeRoot, null);
      clearedDefault = true;
    }
  };
  const result = expectedKind === "official"
    ? await uninstallOfficialPersonaPack(storeRoot, name, { verifyBeforeRemove, afterRemove })
    : await deleteCustomPersonaPack(storeRoot, name, { verifyBeforeRemove, afterRemove });
  return {
    mode: "apply",
    operation: verb,
    ...result,
    clearedDefault,
    summary: `${verbPast} persona pack '${qualifiedName}'.${clearedDefault ? " The global default was cleared." : ""}`,
  };
}

async function forkGlobalPack(storeRoot, params) {
  const sourceQualified = await resolveInstalledQualifiedPersonaPackName(storeRoot, requireGlobalPackTarget(params.source, "fork"));
  const newName = requireCustomPackName(params.target, "fork");
  const result = await forkPersonaPack(storeRoot, sourceQualified, newName);
  return { mode: "apply", operation: "fork", ...result, summary: `Forked '${sourceQualified}' into '${result.qualifiedName}'.` };
}

async function startGlobalPackDraft(storeRoot, operation, params) {
  const name = requireCustomPackName(params.target, operation);
  const draftPath = path.join(storeRoot, "drafts", name);
  if (await globalPackDraftExists(storeRoot, name)) {
    const preview = await previewCustomPersonaPackDraft(storeRoot, name);
    return {
      mode: "draft",
      operation,
      name,
      resumed: true,
      draftPath,
      ...preview,
      summary: `Resuming the pending draft for '${name}' at ${draftPath}.`,
      nextSteps: draftNextSteps(name),
    };
  }
  const activeExists = await absolutePathExists(path.join(storeRoot, "custom", name));
  if (operation === "create" && activeExists) {
    throw new Error(`custom persona pack '${name}' already exists; use /persona pack edit ${name} to revise it`);
  }
  if (operation === "edit" && !activeExists) {
    throw new Error(`custom persona pack '${name}' does not exist yet; use /persona pack create ${name} to start one`);
  }
  if (activeExists) {
    const seedSource = await readPortablePersonaPack(path.join(storeRoot, "custom", name), { type: "installed", ref: `custom/${name}` });
    await stageCustomPersonaPackDraft(storeRoot, name, seedSource);
  } else {
    // readPortablePersonaPack keeps source.root on the returned object and
    // global-pack-store.js's collectPackFiles re-reads pack.yaml from it
    // lazily at staging time (see its own comment), so the temp directory
    // must stay on disk until stageCustomPersonaPackDraft has actually read
    // it -- not just until readPortablePersonaPack itself returns.
    const tempRoot = await mkdtemp(path.join(tmpdir(), "pi-persona-pack-create-"));
    try {
      const seedSource = await writeStarterPersonaPack(tempRoot, name);
      await stageCustomPersonaPackDraft(storeRoot, name, seedSource);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
  const preview = await previewCustomPersonaPackDraft(storeRoot, name);
  return {
    mode: "draft",
    operation,
    name,
    resumed: false,
    draftPath,
    ...preview,
    summary: `${activeExists ? "Started editing" : "Started a new"} draft for '${name}' at ${draftPath}.`,
    nextSteps: draftNextSteps(name),
  };
}

function draftNextSteps(name) {
  return `Edit its pack.yaml/agents/references files directly, then run /persona pack preview ${name} and /persona pack apply ${name} (or /persona pack cancel ${name} to discard).`;
}

async function writeStarterPersonaPack(tempRoot, name) {
  await writeFile(path.join(tempRoot, "pack.yaml"), stringify({
    schema: 2,
    name,
    version: "0.1.0",
    description: `Custom persona pack ${name}.`,
  }, { lineWidth: 0 }), "utf8");
  await mkdir(path.join(tempRoot, "agents"), { recursive: true });
  await mkdir(path.join(tempRoot, "references"), { recursive: true });
  const leadName = `${name}-lead`;
  const specialistName = `${name}-specialist`;
  await writeFile(
    path.join(tempRoot, "agents", `${leadName}.md`),
    starterPersonaMarkdown(leadName, "generalist", `Coordinates the ${name} team.`),
    "utf8",
  );
  await writeFile(
    path.join(tempRoot, "agents", `${specialistName}.md`),
    starterPersonaMarkdown(specialistName, "specialist", `Reviews requests from the ${name} specialist perspective.`),
    "utf8",
  );
  await writeFile(
    path.join(tempRoot, "references", "README.md"),
    `Reference material for '${name}' goes here. Reference it from a persona's packDocs field.\n`,
    "utf8",
  );
  return readPortablePersonaPack(tempRoot, { type: "draft", ref: name });
}

function starterPersonaMarkdown(name, role, description) {
  return `---\n${stringify({ name, role, description }, { lineWidth: 0 })}---\nYou are ${name}. Replace this starter prompt with real instructions.\n`;
}

async function previewGlobalPackDraft(storeRoot, params) {
  const name = requireCustomPackName(params.target, "preview");
  const preview = await previewCustomPersonaPackDraft(storeRoot, name);
  return {
    mode: "preview",
    operation: "preview",
    name,
    ...preview,
    summary: `Draft for '${name}': ${preview.isNew ? "new pack" : `${preview.diff.added.length} added, ${preview.diff.changed.length} changed, ${preview.diff.removed.length} removed`}.`,
  };
}

async function cancelGlobalPackDraft(storeRoot, params) {
  const name = requireCustomPackName(params.target, "cancel");
  const result = await cancelCustomPersonaPackDraft(storeRoot, name);
  return { mode: "apply", operation: "cancel", ...result, summary: `Discarded the pending draft for '${name}'.` };
}

async function applyGlobalPackDraft(storeRoot, params) {
  const name = requireCustomPackName(params.target, "apply");
  if (!params.confirmed) {
    const preview = await previewCustomPersonaPackDraft(storeRoot, name);
    const planId = computeGlobalPackPlanId({
      operation: "apply",
      target: `custom/${name}`,
      draftHash: preview.draftIntegrity,
      activeHash: preview.activeIntegrity,
    });
    return {
      mode: "confirm-required",
      operation: "apply",
      name,
      planId,
      ...preview,
      confirmParams: { confirmed: true, planId },
      summary: `Apply the pending draft for '${name}'? ${preview.isNew ? "This creates a new custom pack." : `${preview.diff.added.length} added, ${preview.diff.changed.length} changed, ${preview.diff.removed.length} removed, replacing the active pack.`}`,
    };
  }
  if (typeof params.planId !== "string" || !params.planId) {
    throw new Error("The approval could not be matched to the displayed plan. Preview the draft again before applying it.");
  }
  const result = await applyCustomPersonaPackDraft(storeRoot, name, {
    verifyBeforeApply: async ({ activeIntegrity, draftIntegrity }) => {
      const freshPlanId = computeGlobalPackPlanId({
        operation: "apply",
        target: `custom/${name}`,
        draftHash: draftIntegrity,
        activeHash: activeIntegrity,
      });
      if (freshPlanId !== params.planId) {
        throw new Error(`persona pack draft '${name}' changed since it was previewed; preview it again before applying it`);
      }
    },
  });
  return { mode: "apply", operation: "apply", ...result, summary: `Applied the draft for '${result.qualifiedName}'.` };
}

function formatPackSummaryLine(pack) {
  const flags = [];
  if (pack.isDefault) flags.push("default");
  if (pack.isCurrentSession) flags.push("current session");
  if (pack.edited) flags.push("edited");
  if (pack.forkedFrom) flags.push(`forked from ${pack.forkedFrom}`);
  const generalist = pack.personas.find((persona) => persona.role === "generalist");
  return `${pack.qualifiedName} (${pack.version})${generalist ? ` — [G] ${generalist.name}` : ""}${flags.length ? ` [${flags.join(", ")}]` : ""}`;
}

function formatGlobalPackList(result) {
  const lines = ["# Persona Packs", "", "## Installed"];
  const all = [...result.installed.official, ...result.installed.custom];
  if (all.length === 0) {
    lines.push("- none");
  } else {
    for (const pack of all) lines.push(`- ${formatPackSummaryLine(pack)}`);
  }
  if (result.catalog.length > 0) {
    lines.push("", "## Available to install (bundled catalog)");
    for (const pack of result.catalog) lines.push(`- ${pack.name} (${pack.version}) — ${pack.description}`);
  }
  lines.push("", `Default: ${result.default ?? "none configured"}`);
  if (result.drafts) {
    lines.push("", "## Pending drafts");
    lines.push(result.drafts.length === 0 ? "- none" : result.drafts.map((draft) => `- ${draft}`).join("\n"));
  }
  return lines.join("\n");
}

function formatGlobalPackStatus(result, options = {}) {
  if (!result.installed) {
    return [
      `Persona pack '${result.target}' is not installed.`,
      result.draftPending ? (options.chat ? "A pending draft exists." : `A pending draft exists; run /persona pack preview ${result.target}.`) : "",
    ].filter(Boolean).join("\n");
  }
  const lines = [
    `# Persona pack: ${result.qualifiedName}`,
    "",
    `Version: ${result.version}`,
    `Description: ${result.description}`,
    `Default: ${result.isDefault ? "yes" : "no"}`,
    `Current session: ${result.isCurrentSession ? "yes" : "no"}`,
  ];
  if (result.kind === "official") lines.push(`Edited since install: ${result.edited ? "yes" : "no"}`);
  if (result.forkedFrom) lines.push(`Forked from: ${result.forkedFrom}`);
  lines.push(`Draft pending: ${result.draftPending ? "yes" : "no"}`);
  lines.push("", "## Roster");
  for (const persona of result.personas) {
    lines.push(`- ${persona.role === "generalist" ? "[G] " : ""}${persona.name}`);
  }
  return lines.join("\n");
}

function formatDraftDiffLines(result) {
  if (result.isNew) return "New pack; no active content to compare against.";
  const lines = [];
  if (result.diff.added.length) lines.push(`Added: ${result.diff.added.join(", ")}`);
  if (result.diff.changed.length) lines.push(`Changed: ${result.diff.changed.join(", ")}`);
  if (result.diff.removed.length) lines.push(`Removed: ${result.diff.removed.join(", ")}`);
  return lines.length ? lines.join("\n") : "No differences from the active pack.";
}

function formatGlobalPackDraft(result, options = {}) {
  const summary = options.chat || !result.nextSteps ? result.summary : `${result.summary} ${result.nextSteps}`;
  return [summary, "", formatDraftDiffLines(result)].filter(Boolean).join("\n");
}

function formatGlobalPackDiff(result) {
  return [result.summary, "", formatDraftDiffLines(result)].filter(Boolean).join("\n");
}

async function listPersonaPacks(root) {
  const lock = await readPackLock(root);
  const bundled = await listBundledPersonaPacks();
  const installed = [];
  for (const name of Object.keys(lock.packs).sort()) {
    const status = await inspectInstalledPack(root, name, getPackEntry(lock, name), { checkSource: false });
    installed.push({
      name,
      configuration: status.configuration,
      personas: status.personas,
      source: status.source,
      health: status.health,
    });
  }
  return {
    mode: "list",
    installed,
    available: bundled.map((pack) => ({
      name: pack.manifest.name,
      version: pack.manifest.version,
      description: pack.manifest.description,
      personas: pack.personas,
      installed: Object.hasOwn(lock.packs, pack.manifest.name),
    })),
  };
}

async function statusPersonaPacks(root, target) {
  const lock = await readPackLock(root);
  const drafts = await listDrafts(root);
  if (target) {
    assertPackName(target);
    const entry = getPackEntry(lock, target);
    if (!entry) {
      if (drafts.includes(target)) {
        return {
          mode: "status",
          packs: [],
          drafts: [target],
          nextAction: `/persona pack author ${target}`,
        };
      }
      throw missingPackError(target, [...Object.keys(lock.packs), ...drafts]);
    }
    const status = await inspectInstalledPack(root, target, entry, { checkSource: true });
    return {
      mode: "status",
      detailed: true,
      packs: [status],
      drafts: drafts.filter((name) => name === target),
      nextAction: status.nextAction,
    };
  }

  const packs = [];
  for (const name of Object.keys(lock.packs).sort()) {
    packs.push(await inspectInstalledPack(root, name, getPackEntry(lock, name), { checkSource: true }));
  }
  return {
    mode: "status",
    detailed: false,
    packs,
    drafts,
    nextAction: packs.length === 0
      ? "/persona pack list"
      : packs.find((pack) => pack.nextAction !== "ready")?.nextAction ?? "ready",
  };
}

async function startPersonaPackAuthoring(root, target) {
  await assertPackFoundation(root);
  assertPackName(target);
  const lock = await readPackLock(root);
  const installed = getPackEntry(lock, target);
  if (installed && installed.source.type !== "project") {
    throw new Error(`persona pack '${target}' comes from ${installed.source.type}; choose a new name for a project-native pack`);
  }

  const draftRoot = packDraftRoot(root, target);
  await assertPathComponentsNotSymlinks(root, path.relative(root, draftRoot));
  if (await absolutePathExists(draftRoot)) {
    await readArbitraryFiles(root, draftRoot, `${DRAFT_ROOT}/${target}`);
    return {
      mode: "author-start",
      name: target,
      resumed: true,
      draftPath: `${DRAFT_ROOT}/${target}`,
      assistantPrompt: authoringPrompt(target, true),
    };
  }

  await mkdir(path.join(draftRoot, "agents"), { recursive: true });
  await mkdir(path.join(draftRoot, "references"), { recursive: true });
  if (installed) {
    const current = await readInstalledPackFiles(root, target);
    await writeDraftFromMaterialized(draftRoot, target, current);
  } else {
    await writeFile(
      path.join(draftRoot, "configure.md"),
      starterConfigurationGuide(target),
      "utf8",
    );
  }

  return {
    mode: "author-start",
    name: target,
    resumed: false,
    draftPath: `${DRAFT_ROOT}/${target}`,
    assistantPrompt: authoringPrompt(target, false),
  };
}

async function buildPersonaPackPlan(root, params) {
  if (!OPERATIONS.has(params.operation)) {
    throw new Error("persona_pack plan requires operation install, author, configure, update, or remove");
  }
  if (typeof params.target !== "string" || !params.target.trim()) {
    throw new Error(`persona pack ${params.operation} requires a target`);
  }

  switch (params.operation) {
    case "install":
      return buildInstallPlan(root, params.target);
    case "author":
      return buildAuthorPlan(
        root,
        params.target,
        params.action === "plan" ? params.files : undefined,
        params.action === "plan" ? params.personas : undefined,
      );
    case "configure":
      return buildConfigurePlan(root, params.target, params.files, params.configurationComplete);
    case "update":
      return buildUpdatePlan(root, params.target, params.resolutions);
    case "remove":
      return buildRemovePlan(root, params.target);
    default:
      throw new Error(`unsupported persona pack operation '${params.operation}'`);
  }
}

async function buildInstallPlan(root, target) {
  await assertPackFoundation(root);
  const source = await loadPersonaPackSource(root, target);
  const name = source.manifest.name;
  const lock = await readPackLock(root);
  if (getPackEntry(lock, name)) {
    throw new Error(`persona pack '${name}' is already installed; use /persona pack update ${name}`);
  }
  await assertPackRootsUnowned(root, name);
  await assertNoPersonaNameCollisions(root, name, source.personas);

  const files = materializePersonaPack(source);
  const seedFiles = materializePersonaPackLibrarySeeds(source);
  const actions = [...files.keys()].sort().map((filePath) => ({
    path: filePath,
    action: "create",
  }));
  const libraryChanges = await planPersonaLibraryScaffolds(root, source.personas, seedFiles);
  actions.push(...libraryChanges.map((change) => ({
    path: change.path,
    action: "seed editable library",
  })));
  actions.push({ path: LOCK_PATH, action: "record installation" });
  const descriptor = {
    operation: "install",
    name,
    source: source.provenance,
    sourceIntegrity: source.integrity,
    files: hashPersonaPackFiles(files),
  };
  return {
    result: planResult({
      operation: "install",
      name,
      summary: `Install ${source.manifest.name} ${source.manifest.version} from ${formatSource(source.provenance)}.`,
      actions,
      confirmation: "ordinary",
      descriptor,
      highlights: buildPackHighlights(name, source.personas, files),
    }),
    data: { source, files, lock, libraryChanges },
  };
}

async function buildAuthorPlan(root, target, rawChanges, rawPersonas) {
  await assertPackFoundation(root);
  assertPackName(target);
  const lock = await readPackLock(root);
  const installed = getPackEntry(lock, target);
  if (installed && installed.source.type !== "project") {
    throw new Error(`persona pack '${target}' is portable; project-native revisions require a different pack name`);
  }

  const draftRoot = packDraftRoot(root, target);
  await assertPathComponentsNotSymlinks(root, `${DRAFT_ROOT}/${target}`);
  if (!await absolutePathExists(draftRoot)) {
    throw new Error(`persona pack draft '${target}' does not exist; start /persona pack author ${target}`);
  }
  const authoredPersonas = normalizeAuthoredPersonas(target, rawPersonas);
  const changes = normalizeFileChanges(root, target, [
    ...(rawChanges ?? []),
    ...authoredPersonas,
  ]);
  const build = async () => {
    if (changes.length > 0) await applyChangesToDraft(root, draftRoot, target, changes);

    let source = await readPersonaPackDraft(draftRoot, target);
    if (source.files.get("configure.md").toString("utf8") === starterConfigurationGuide(target)) {
      await writeFile(
        path.join(draftRoot, "configure.md"),
        tailoredConfigurationGuide(target, source.personas),
        "utf8",
      );
      source = await readPersonaPackDraft(draftRoot, target);
    }
    await assertNoPersonaNameCollisions(root, target, source.personas, installed ? target : null);
    const files = materializePersonaPack(source);
    const current = installed ? await readInstalledPackFiles(root, target) : new Map();
    if (!installed) await assertPackRootsUnowned(root, target);
    const actions = diffFileMaps(current, files);
    const seedFiles = materializePersonaPackLibrarySeeds(source);
    const libraryChanges = await planPersonaLibraryScaffolds(root, source.personas, seedFiles);
    if (installed && actions.length === 0 && libraryChanges.length === 0) {
      await rm(draftRoot, { recursive: true, force: true });
      return {
        result: {
          mode: "plan",
          operation: "author",
          name: target,
          summary: `Project-native persona pack '${target}' already matches its draft.`,
          actions: [],
          conflicts: [],
          ready: false,
          planId: null,
          confirmation: "none",
        },
        data: null,
      };
    }
    actions.push(...libraryChanges.map((change) => ({
      path: change.path,
      action: "seed editable library",
    })));
    actions.push({ path: LOCK_PATH, action: installed ? "update project pack record" : "record project pack" });
    const descriptor = {
      operation: "author",
      name: target,
      installed: installed ?? null,
      current: hashPersonaPackFiles(current),
      proposed: hashPersonaPackFiles(files),
    };
    return {
      result: planResult({
        operation: "author",
        name: target,
        summary: `${installed ? "Revise" : "Create"} project-native persona pack '${target}'.`,
        actions,
        confirmation: "ordinary",
        descriptor,
        highlights: buildPackHighlights(target, source.personas, files),
      }),
      data: { files, lock, draftRoot, libraryChanges },
    };
  };
  return withPackRollback(root, target, { includeActive: false, includeDraft: true }, build);
}

async function buildConfigurePlan(root, target, rawChanges, configurationComplete) {
  assertPackName(target);
  const lock = await readPackLock(root);
  const entry = requireInstalledPack(lock, target);
  const current = await readInstalledPackFiles(root, target);
  const guidePath = `.pi/persona-packs/${target}/configure.md`;
  const guide = current.get(guidePath);
  if (!guide) throw new Error(`persona pack '${target}' has no installed configuration guide`);

  const installedPersonas = validateMaterializedPersonaPack(target, current);
  const changes = normalizeFileChanges(root, target, rawChanges, {
    libraryPersonas: installedPersonas.map((persona) => persona.name),
  });
  const packChanges = changes.filter((change) => isPackFilePath(target, change.path));
  const libraryChanges = changes.filter((change) => !isPackFilePath(target, change.path));
  const proposed = applyChangesToMap(current, packChanges);
  const personas = validateMaterializedPersonaPack(target, proposed);
  await assertNoPersonaNameCollisions(root, target, personas, target);
  if (changes.length === 0 && configurationComplete !== true) {
    return {
      result: {
        mode: "plan",
        operation: "configure",
        name: target,
        summary: `Review the optional project context for '${target}'.`,
        actions: [],
        conflicts: [],
        guide: guide.toString("utf8"),
        highlights: buildPackHighlights(target, personas, current),
        ready: false,
        confirmation: "none",
        planId: null,
        guideOnly: true,
        assistantPrompt: configurationInterviewPrompt(target, personas),
      },
      data: null,
    };
  }
  const libraryCurrent = await readLibraryChangeHashes(root, libraryChanges);
  const actions = changes.map((change) => ({
    path: change.path,
    action: change.action === "delete"
      ? "delete"
      : (
        current.has(change.path)
        || (Object.hasOwn(libraryCurrent, change.path) && libraryCurrent[change.path] !== null)
      ) ? "replace" : "create",
  }));
  actions.push({
    path: LOCK_PATH,
    action: configurationComplete === true ? "mark configuration complete" : "keep configuration pending",
  });
  const descriptor = {
    operation: "configure",
    name: target,
    installed: entry,
    current: hashPersonaPackFiles(current),
    changes: changes.map(describeChange),
    libraryCurrent,
    configurationComplete: configurationComplete === true,
  };
  return {
    result: planResult({
      operation: "configure",
      name: target,
      summary: configurationComplete === true
        ? `Apply pack-local configuration changes and mark '${target}' complete.`
        : `Apply pack-local configuration changes; '${target}' remains pending.`,
      actions,
      confirmation: "ordinary",
      descriptor,
      guide: guide.toString("utf8"),
    }),
    data: {
      packChanges,
      libraryChanges,
      lock,
      entry,
      configurationComplete: configurationComplete === true,
    },
  };
}

async function buildUpdatePlan(root, target, rawResolutions) {
  assertPackName(target);
  const lock = await readPackLock(root);
  const entry = requireInstalledPack(lock, target);
  if (entry.source.type === "project") {
    throw new Error(`persona pack '${target}' has no upstream; revise it with /persona pack author ${target}`);
  }

  const source = await loadRecordedPersonaPackSource(root, target, entry.source);
  if (source.manifest.name !== target) {
    throw new Error(`recorded source now declares '${source.manifest.name}', expected '${target}'`);
  }
  const versionOrder = compareStableVersions(source.manifest.version, entry.version);
  if (versionOrder < 0) {
    throw new Error(`recorded source version ${source.manifest.version} is older than installed ${entry.version}`);
  }
  if (versionOrder === 0) {
    if (source.integrity !== entry.source.integrity) {
      throw new Error(`source content changed without a version bump from ${entry.version}`);
    }
    return {
      result: {
        mode: "plan",
        operation: "update",
        name: target,
        summary: `Persona pack '${target}' is already up to date at ${entry.version}.`,
        actions: [],
        conflicts: [],
        ready: false,
        planId: null,
        confirmation: "none",
      },
      data: null,
    };
  }

  const nextFiles = materializePersonaPack(source);
  const local = await readInstalledPackFiles(root, target);
  const update = classifyUpdate(entry, local, nextFiles);
  const resolutions = normalizeResolutions(rawResolutions, update.conflicts);
  const unresolved = update.conflicts.filter((conflict) => !resolutions.has(conflict.path));
  const resolved = resolveUpdate(update, resolutions);
  const proposed = applyUpdateToMap(local, nextFiles, resolved.filesystemActions);
  const ready = unresolved.length === 0;
  let proposedPersonas = [];
  if (ready) {
    try {
      proposedPersonas = validateMaterializedPersonaPack(target, proposed);
    } catch (error) {
      throw new Error([
        `update would leave persona pack '${target}' invalid: ${error instanceof Error ? error.message : String(error)}`,
        "Move or revise the affected local pack file, then plan the update again.",
      ].join("\n"));
    }
    await assertNoPersonaNameCollisions(root, target, proposedPersonas, target);
  } else {
    const conflictPaths = new Set(update.conflicts.map((conflict) => conflict.path));
    const unavoidableUpstreamPersonas = source.personas.filter((persona) => {
      const filePath = `.pi/agents/packs/${target}/${persona.sourcePath.slice("agents/".length)}`;
      return !conflictPaths.has(filePath) || resolutions.get(filePath) === "accept-upstream";
    });
    await assertNoPersonaNameCollisions(root, target, unavoidableUpstreamPersonas, target);
  }
  const libraryChanges = ready
    ? await planPersonaLibraryScaffolds(
      root,
      proposedPersonas,
      materializePersonaPackLibrarySeeds(source),
    )
    : [];
  const publicActions = ready
    ? [
      ...resolved.publicActions,
      ...libraryChanges.map((change) => ({
        path: change.path,
        action: "seed editable library",
      })),
      { path: LOCK_PATH, action: "update lifecycle record" },
    ]
    : resolved.publicActions;
  const descriptor = {
    operation: "update",
    name: target,
    installed: entry,
    from: entry.version,
    to: source.manifest.version,
    sourceIntegrity: source.integrity,
    local: hashPersonaPackFiles(local),
    resolutions: [...resolutions.entries()].sort(([left], [right]) => left.localeCompare(right)),
    actions: publicActions,
    proposed: hashPersonaPackFiles(proposed),
    nextBase: resolved.nextBase,
    detached: resolved.detached,
  };
  return {
    result: planResult({
      operation: "update",
      name: target,
      summary: `Update '${target}' from ${entry.version} to ${source.manifest.version}.`,
      actions: publicActions,
      conflicts: unresolved,
      confirmation: "ordinary",
      descriptor,
      ready,
      highlights: ready
        ? buildPackHighlights(target, proposedPersonas, proposed)
        : undefined,
    }),
    data: {
      source,
      nextFiles,
      lock,
      entry,
      filesystemActions: resolved.filesystemActions,
      nextBase: resolved.nextBase,
      detached: resolved.detached,
      libraryChanges,
    },
  };
}

async function buildRemovePlan(root, target) {
  assertPackName(target);
  const lock = await readPackLock(root);
  const draftRoot = packDraftRoot(root, target);
  const draftExists = await absolutePathExists(draftRoot);
  const draftFiles = await readArbitraryFiles(root, draftRoot, `${DRAFT_ROOT}/${target}`);
  const entry = getPackEntry(lock, target);
  if (!entry && !draftExists) {
    throw missingPackError(target, [...Object.keys(lock.packs), ...await listDrafts(root)]);
  }
  const current = entry ? await readInstalledPackFiles(root, target) : new Map();
  const states = entry ? classifyInstalledFiles(entry, current) : [];
  const destructive = !entry
    || entry.source.type === "project"
    || states.some((item) => item.state !== "pristine")
    || draftFiles.size > 0;
  const actions = [
    ...[...current.keys()].sort().map((filePath) => ({ path: filePath, action: "delete" })),
    ...[...draftFiles.keys()].sort().map((filePath) => ({ path: filePath, action: "delete draft" })),
  ];
  if (entry) actions.push({ path: `${LOCK_PATH}#packs.${target}`, action: "delete lifecycle record" });
  if (draftExists && draftFiles.size === 0) {
    actions.push({ path: `${DRAFT_ROOT}/${target}/`, action: "delete empty draft" });
  }
  const descriptor = {
    operation: "remove",
    name: target,
    entry,
    current: hashPersonaPackFiles(current),
    draft: hashPersonaPackFiles(draftFiles),
    draftExists,
  };
  return {
    result: planResult({
      operation: "remove",
      name: target,
      summary: !entry
        ? `Permanently discard unfinished persona pack draft '${target}'. No archive will be kept.`
        : destructive
          ? `Permanently delete '${target}', including customized or project-authored work. No archive will be kept.`
          : `Remove pristine persona pack '${target}'. No archive will be kept.`,
      actions,
      confirmation: destructive ? "permanent-delete" : "ordinary",
      descriptor,
    }),
    data: { lock, includeDraft: draftExists, installed: Boolean(entry) },
  };
}

async function applyPersonaPackPlan(root, built) {
  const { result, data } = built;
  switch (result.operation) {
    case "install":
      return applyInstall(root, result, data);
    case "author":
      return applyAuthor(root, result, data);
    case "configure":
      return applyConfigure(root, result, data);
    case "update":
      return applyUpdate(root, result, data);
    case "remove":
      return applyRemove(root, result, data);
    default:
      throw new Error(`unsupported persona pack apply operation '${result.operation}'`);
  }
}

async function applyInstall(root, plan, data) {
  const {
    source,
    files,
    lock,
    libraryChanges,
  } = data;
  const name = source.manifest.name;
  await withLibraryRollback(root, libraryChanges, () => (
    withPackRollback(root, name, {}, async () => {
      await replacePackRoots(root, name, files);
      await applyPersonaLibraryScaffolds(root, libraryChanges);
      lock.packs[name] = {
        source: {
          ...source.provenance,
          integrity: source.integrity,
        },
        version: source.manifest.version,
        configuration: "pending",
        files: hashPersonaPackFiles(files),
        detached: [],
      };
      await writePackLock(root, lock);
    })
  ));
  return appliedResult(plan, {
    summary: `Installed '${name}' ${source.manifest.version}. Its managed pack files and editable starter libraries are now in this project; configuration is next.`,
    followUpPrompt: configurationFollowUp(name),
  });
}

async function applyAuthor(root, plan, data) {
  const {
    files,
    lock,
    draftRoot,
    libraryChanges,
  } = data;
  const name = plan.name;
  await withLibraryRollback(root, libraryChanges, () => (
    withPackRollback(root, name, { includeDraft: true }, async () => {
      await replacePackRoots(root, name, files);
      await applyPersonaLibraryScaffolds(root, libraryChanges);
      lock.packs[name] = {
        source: { type: "project" },
        configuration: "pending",
      };
      await writePackLock(root, lock);
      await rm(draftRoot, { recursive: true, force: true });
    })
  ));
  return appliedResult(plan, {
    summary: `${plan.summary.replace(/\.$/, "")}. Its managed persona files and editable libraries are now in this project; configuration is next.`,
    followUpPrompt: configurationFollowUp(name),
  });
}

async function applyConfigure(root, plan, data) {
  const {
    packChanges,
    libraryChanges,
    lock,
    entry,
    configurationComplete,
  } = data;
  await withLibraryRollback(root, libraryChanges, () => (
    withPackRollback(root, plan.name, {}, async () => {
      await applyInstalledFileChanges(root, packChanges);
      await applyLibraryChanges(root, libraryChanges);
      entry.configuration = configurationComplete ? "complete" : "pending";
      await writePackLock(root, lock);
    })
  ));
  return appliedResult(plan, {
    summary: configurationComplete
      ? `Configuration is complete for '${plan.name}'. The pack is ready, and its editable library files remain yours to change.`
      : `Saved editable library changes for '${plan.name}'; configuration is still waiting for your confirmation.`,
    followUpPrompt: configurationComplete ? undefined : configurationFollowUp(plan.name),
  });
}

async function applyUpdate(root, plan, data) {
  const {
    source,
    nextFiles,
    lock,
    entry,
    filesystemActions,
    nextBase,
    detached,
    libraryChanges,
  } = data;
  await withLibraryRollback(root, libraryChanges, () => (
    withPackRollback(root, plan.name, {}, async () => {
      for (const action of orderFilesystemActions(filesystemActions)) {
        const resolved = await resolveWorkspacePathForAccess(root, action.path);
        if (!resolved.ok) throw new Error(`update path must stay inside project: ${action.path}`);
        if (action.action === "delete") {
          await rm(resolved.path, { force: true });
        } else {
          await rm(resolved.path, { recursive: true, force: true });
          await mkdir(path.dirname(resolved.path), { recursive: true });
          await writeFile(resolved.path, nextFiles.get(action.path));
        }
      }
      await applyPersonaLibraryScaffolds(root, libraryChanges);
      entry.source = {
        ...entry.source,
        integrity: source.integrity,
      };
      entry.version = source.manifest.version;
      entry.configuration = "pending";
      entry.files = nextBase;
      entry.detached = detached;
      await writePackLock(root, lock);
    })
  ));
  return appliedResult(plan, {
    summary: `Updated '${plan.name}' to ${source.manifest.version}. Its managed pack files are current, its editable libraries were kept, and configuration is next.`,
    followUpPrompt: configurationFollowUp(plan.name),
  });
}

async function applyRemove(root, plan, data) {
  await withPackRollback(root, plan.name, {
    includeActive: data.installed,
    includeDraft: data.includeDraft,
  }, async () => {
    if (data.installed) {
      await rm(packAgentRoot(root, plan.name), { recursive: true, force: true });
      await rm(packArtifactRoot(root, plan.name), { recursive: true, force: true });
    }
    if (data.includeDraft) {
      await rm(packDraftRoot(root, plan.name), { recursive: true, force: true });
    }
    if (data.installed) {
      delete data.lock.packs[plan.name];
      await writePackLock(root, data.lock);
    }
  });
  return appliedResult(plan, {
    summary: data.installed
      ? `'${plan.name}' is no longer installed. Its managed persona and pack files were removed. Its editable pack-shared library at \`library/shared/${plan.name}/\` and persona libraries under \`library/personal/\` were kept. No archive was created.`
      : `Discarded unfinished draft '${plan.name}'. It was never installed, no library files were removed, and no archive was created.`,
  });
}

async function inspectInstalledPack(root, name, entry, options) {
  let local = new Map();
  const problems = [];
  try {
    local = await readInstalledPackFiles(root, name);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  const fileStates = classifyInstalledFiles(entry, local);
  if (!local.has(`.pi/persona-packs/${name}/configure.md`)) {
    problems.push("configuration guide is missing");
  }
  const project = await discoverPersonaProject(root);
  const prefix = `.pi/agents/packs/${name}/`;
  const personas = project.agents
    .filter((agent) => agent.relativePath.startsWith(prefix))
    .map((agent) => ({
      name: agent.name,
      role: agent.role,
      description: agent.description,
    }));
  if (personas.length === 0) problems.push("no launchable personas found");

  let update = "not applicable";
  if (options.checkSource && entry.source.type !== "project") {
    try {
      const source = await loadRecordedPersonaPackSource(root, name, entry.source);
      if (source.manifest.name !== name) {
        throw new Error(`recorded source now declares '${source.manifest.name}'`);
      }
      const comparison = compareStableVersions(source.manifest.version, entry.version);
      update = comparison > 0
        ? `${source.manifest.version} available`
        : comparison === 0 && source.integrity === entry.source.integrity
          ? "up to date"
          : comparison === 0
            ? "source changed without version bump"
            : `recorded source is older (${source.manifest.version})`;
    } catch (error) {
      update = `unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  const nextAction = entry.configuration !== "complete"
    ? `/persona pack configure ${name}`
    : update.endsWith(" available")
      ? `/persona pack update ${name}`
      : problems.length > 0
        ? `/persona pack status ${name}`
        : "ready";
  return {
    name,
    source: formatSource(entry.source),
    version: entry.version ?? null,
    configuration: entry.configuration,
    personas,
    files: fileStates,
    update,
    problems,
    health: problems.length > 0 ? "needs attention" : "ready",
    nextAction,
  };
}

function classifyUpdate(entry, local, nextFiles) {
  const oldBase = entry.files ?? {};
  const nextHashes = hashPersonaPackFiles(nextFiles);
  const detached = new Set(entry.detached ?? []);
  const paths = new Set([...Object.keys(oldBase), ...Object.keys(nextHashes)]);
  const safe = [];
  const conflicts = [];

  for (const filePath of [...paths].sort()) {
    if (detached.has(filePath)) continue;
    const oldHash = oldBase[filePath];
    const nextHash = nextHashes[filePath];
    const localHash = local.has(filePath) ? sha256(local.get(filePath)) : null;
    if (!oldHash) {
      if (!localHash || localHash === nextHash) {
        safe.push({ path: filePath, action: "write", reason: "upstream addition" });
      } else {
        conflicts.push({ path: filePath, local: "local file", upstream: "new file" });
      }
      continue;
    }
    if (!nextHash) {
      if (!localHash) {
        safe.push({ path: filePath, action: "preserve", reason: "already absent or locally replaced" });
      } else if (localHash === oldHash) {
        safe.push({ path: filePath, action: "delete", reason: "upstream deletion" });
      } else {
        conflicts.push({ path: filePath, local: "customized file", upstream: "deleted file" });
      }
      continue;
    }
    if (localHash === oldHash) {
      if (nextHash !== oldHash) safe.push({ path: filePath, action: "write", reason: "upstream change" });
    } else if (localHash === nextHash || nextHash === oldHash) {
      safe.push({ path: filePath, action: "preserve", reason: localHash ? "local customization" : "local deletion" });
    } else {
      conflicts.push({
        path: filePath,
        local: localHash ? "customized file" : "deleted file",
        upstream: "changed file",
      });
    }
  }
  return { safe, conflicts, detached, nextHashes };
}

function resolveUpdate(update, resolutions) {
  const filesystemActions = [];
  const publicActions = [];
  const nextBase = {};
  const detached = new Set(update.detached);

  for (const action of update.safe) {
    publicActions.push(action);
    if (action.action === "write" || action.action === "delete") filesystemActions.push(action);
  }
  for (const conflict of update.conflicts) {
    const choice = resolutions.get(conflict.path);
    if (!choice) continue;
    if (choice === "keep-local") {
      detached.add(conflict.path);
      publicActions.push({ path: conflict.path, action: "keep local and detach", reason: conflict.upstream });
    } else {
      const action = update.nextHashes[conflict.path] ? "write" : "delete";
      filesystemActions.push({ path: conflict.path, action });
      publicActions.push({
        path: conflict.path,
        action: `accept upstream ${action}`,
        reason: `${conflict.local} will be permanently ${action === "write" ? "replaced" : "deleted"}`,
      });
    }
  }
  for (const [filePath, hash] of Object.entries(update.nextHashes)) {
    if (!detached.has(filePath)) nextBase[filePath] = hash;
  }

  return {
    filesystemActions,
    publicActions: publicActions.sort((left, right) => left.path.localeCompare(right.path)),
    nextBase,
    detached: [...detached].sort(),
  };
}

function normalizeResolutions(rawResolutions, conflicts) {
  const conflictPaths = new Set(conflicts.map((conflict) => conflict.path));
  const resolutions = new Map();
  for (const resolution of rawResolutions ?? []) {
    if (!resolution || typeof resolution.path !== "string" || !conflictPaths.has(resolution.path)) {
      throw new Error(`update resolution does not match a current conflict: ${resolution?.path ?? "(missing path)"}`);
    }
    if (!["keep-local", "accept-upstream"].includes(resolution.choice)) {
      throw new Error(`unknown update resolution '${resolution.choice}' for ${resolution.path}`);
    }
    if (resolutions.has(resolution.path)) {
      throw new Error(`duplicate update resolution for ${resolution.path}`);
    }
    resolutions.set(resolution.path, resolution.choice);
  }
  return resolutions;
}

function classifyInstalledFiles(entry, local) {
  if (entry.source.type === "project") {
    return [...local.keys()].sort().map((filePath) => ({ path: filePath, state: "project-authored" }));
  }
  const base = entry.files ?? {};
  const detached = new Set(entry.detached ?? []);
  const states = [];
  for (const [filePath, expected] of Object.entries(base).sort(([left], [right]) => left.localeCompare(right))) {
    states.push({
      path: filePath,
      state: !local.has(filePath)
        ? "missing"
        : sha256(local.get(filePath)) === expected ? "pristine" : "customized",
    });
  }
  for (const filePath of [...detached].sort()) {
    states.push({ path: filePath, state: local.has(filePath) ? "detached" : "detached-missing" });
  }
  for (const filePath of [...local.keys()].sort()) {
    if (!Object.hasOwn(base, filePath) && !detached.has(filePath)) {
      states.push({ path: filePath, state: "local" });
    }
  }
  return states;
}

function normalizeAuthoredPersonas(packName, rawPersonas) {
  if (rawPersonas === undefined) return [];
  if (!Array.isArray(rawPersonas)) {
    throw new Error("persona_pack author personas must be a list");
  }
  const seen = new Set();
  return rawPersonas.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("authored persona must be a mapping");
    }
    const allowed = new Set(["name", "role", "description", "prompt", "docs", "skills"]);
    const unexpected = Object.keys(raw).filter((key) => !allowed.has(key));
    if (unexpected.length > 0) {
      throw new Error(`authored persona '${raw.name ?? "(unnamed)"}' has unknown fields: ${unexpected.join(", ")}`);
    }
    if (!isSafeAgentName(raw.name)) {
      throw new Error("authored persona name must begin with a lowercase letter and contain only lowercase letters, numbers, or hyphens");
    }
    if (seen.has(raw.name)) throw new Error(`duplicate authored persona: ${raw.name}`);
    seen.add(raw.name);
    if (!["generalist", "specialist"].includes(raw.role)) {
      throw new Error(`authored persona '${raw.name}' role must be generalist or specialist`);
    }
    const description = requireAuthoredText(raw.description, `${raw.name} description`);
    const prompt = requireAuthoredText(raw.prompt, `${raw.name} prompt`);
    const docs = uniqueTextList(raw.docs, `${raw.name} docs`);
    const personalLibrary = `library/personal/${raw.name}/`;
    if (!docs.includes(personalLibrary)) docs.unshift(personalLibrary);
    const sharedPackLibrary = `library/shared/${packName}/`;
    if (!docs.includes(sharedPackLibrary)) docs.push(sharedPackLibrary);
    const skills = uniqueTextList(raw.skills, `${raw.name} skills`);
    const frontmatter = {
      name: raw.name,
      role: raw.role,
      description,
      docs,
      skills,
    };
    return {
      path: `.pi/agents/packs/${packName}/${raw.name}.md`,
      action: "write",
      content: `---\n${stringify(frontmatter, { lineWidth: 0 })}---\n${prompt}\n`,
    };
  });
}

function requireAuthoredText(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`authored persona ${label} must be a non-empty string`);
  }
  return value.trim();
}

function uniqueTextList(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`authored persona ${label} must be a list of non-empty strings`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function normalizeFileChanges(root, name, rawChanges, options = {}) {
  const changes = [];
  const seen = new Set();
  for (const raw of rawChanges ?? []) {
    if (!raw || typeof raw.path !== "string") throw new Error("pack file change requires a path");
    const filePath = raw.path.trim();
    const normalized = path.posix.normalize(filePath);
    if (!filePath || normalized !== filePath || filePath.includes("\\") || filePath.endsWith("/")) {
      throw new Error(`invalid project-relative pack file path: ${filePath}`);
    }
    if (isPackFilePath(name, filePath)) {
      assertPathInPack(name, filePath);
    } else {
      assertConfigurationLibraryPath(filePath, options.libraryPersonas ?? []);
    }
    if (filePath.startsWith(`.pi/agents/packs/${name}/`) && !filePath.endsWith(".md")) {
      throw new Error(`persona pack agent files must use .md: ${filePath}`);
    }
    if (seen.has(filePath)) throw new Error(`duplicate pack file change: ${filePath}`);
    seen.add(filePath);
    const action = raw.action ?? "write";
    if (!["write", "delete"].includes(action)) {
      throw new Error(`unknown pack file action '${action}' for ${filePath}`);
    }
    if (action === "write" && typeof raw.content !== "string") {
      throw new Error(`pack file write requires complete text content: ${filePath}`);
    }
    const resolved = path.resolve(root, filePath);
    if (!isWithin(path.resolve(root), resolved)) {
      throw new Error(`pack file path must stay inside project: ${filePath}`);
    }
    changes.push({
      path: filePath,
      action,
      content: action === "write" ? Buffer.from(raw.content, "utf8") : null,
    });
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path));
}

function isPackFilePath(name, filePath) {
  return filePath.startsWith(`.pi/agents/packs/${name}/`)
    || filePath.startsWith(`.pi/persona-packs/${name}/`);
}

function assertConfigurationLibraryPath(filePath, personaNames) {
  if (filePath.startsWith("library/shared/")) return;
  for (const name of personaNames) {
    if (filePath.startsWith(`library/personal/${name}/`)) return;
  }
  throw new Error(`file path is outside this persona pack and its libraries: ${filePath}`);
}

function applyChangesToMap(current, changes) {
  const proposed = new Map(current);
  for (const change of changes) {
    if (change.action === "delete") proposed.delete(change.path);
    else proposed.set(change.path, change.content);
  }
  return proposed;
}

function applyUpdateToMap(local, nextFiles, actions) {
  const proposed = new Map(local);
  for (const action of actions) {
    if (action.action === "delete") proposed.delete(action.path);
    else proposed.set(action.path, nextFiles.get(action.path));
  }
  return proposed;
}

async function applyChangesToDraft(root, draftRoot, name, changes) {
  const draftPrefix = `${DRAFT_ROOT}/${name}/`;
  const current = new Map();
  for (const [filePath, content] of await readArbitraryFiles(root, draftRoot, `${DRAFT_ROOT}/${name}`)) {
    current.set(draftToMaterializedPath(name, filePath.slice(draftPrefix.length)), content);
  }
  const proposed = applyChangesToMap(current, changes);
  validateMaterializedPersonaPack(name, proposed);
  for (const change of orderFilesystemActions(changes)) {
    const draftPath = materializedToDraftPath(draftRoot, name, change.path);
    if (change.action === "delete") {
      await rm(draftPath, { force: true });
    } else {
      await rm(draftPath, { recursive: true, force: true });
      await mkdir(path.dirname(draftPath), { recursive: true });
      await writeFile(draftPath, change.content);
    }
  }
}

async function applyInstalledFileChanges(root, changes) {
  for (const change of orderFilesystemActions(changes)) {
    const resolved = await resolveWorkspacePathForAccess(root, change.path);
    if (!resolved.ok) throw new Error(`pack file path must stay inside project: ${change.path}`);
    if (change.action === "delete") {
      await rm(resolved.path, { force: true });
    } else {
      await rm(resolved.path, { recursive: true, force: true });
      await mkdir(path.dirname(resolved.path), { recursive: true });
      await writeFile(resolved.path, change.content);
    }
  }
}

async function planPersonaLibraryScaffolds(root, personas, seedFiles = new Map()) {
  const changes = [];
  const planned = new Set();

  for (const [filePath, content] of [...seedFiles.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (!filePath.startsWith("library/")) {
      throw new Error(`persona pack seed path must stay in the project library: ${filePath}`);
    }
    let resolved;
    try {
      await assertPathComponentsNotSymlinks(root, filePath);
      resolved = await resolveWorkspacePathForAccess(root, filePath);
    } catch (error) {
      if (error?.code === "ENOTDIR") continue;
      throw error;
    }
    if (!resolved.ok) throw new Error(`library seed path must stay inside project: ${filePath}`);
    try {
      await lstat(resolved.path);
      continue;
    } catch (error) {
      if (error?.code === "ENOTDIR") continue;
      if (error?.code !== "ENOENT") throw error;
    }
    changes.push({
      path: filePath,
      action: "write",
      content,
    });
    planned.add(filePath);
  }

  for (const persona of personas) {
    const filePath = `library/personal/${persona.name}/_index.md`;
    if (planned.has(filePath)) continue;
    const resolved = await resolveWorkspacePathForAccess(root, filePath);
    if (!resolved.ok) throw new Error(`personal library path must stay inside project: ${filePath}`);
    await assertPathComponentsNotSymlinks(root, filePath);
    try {
      const details = await lstat(resolved.path);
      if (!details.isFile()) throw new Error(`personal library index must be a file: ${filePath}`);
      continue;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    changes.push({
      path: filePath,
      action: "write",
      content: Buffer.from(personalLibraryIndex(persona), "utf8"),
    });
  }
  return changes;
}

function personalLibraryIndex(persona) {
  return [
    `# ${persona.name} Personal Library`,
    "",
    `Project context placed here is loaded for ${persona.name} by default.`,
    "",
    "Useful additions include briefs, examples, decisions, preferences, and",
    "reference material that this persona should curate without loading it for",
    "every other persona by default. This is context scoping, not access control.",
    "",
  ].join("\n");
}

async function applyPersonaLibraryScaffolds(root, changes) {
  for (const change of changes) {
    const resolved = await resolveWorkspacePathForAccess(root, change.path);
    if (!resolved.ok) throw new Error(`personal library path must stay inside project: ${change.path}`);
    await mkdir(path.dirname(resolved.path), { recursive: true });
    try {
      await writeFile(resolved.path, change.content, { flag: "wx" });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
}

async function applyLibraryChanges(root, changes) {
  for (const change of orderFilesystemActions(changes)) {
    const resolved = await resolveWorkspacePathForAccess(root, change.path);
    if (!resolved.ok) throw new Error(`library path must stay inside project: ${change.path}`);
    if (change.action === "delete") {
      await rm(resolved.path, { force: true });
    } else {
      await mkdir(path.dirname(resolved.path), { recursive: true });
      await writeFile(resolved.path, change.content);
    }
  }
}

async function readLibraryChangeHashes(root, changes) {
  const snapshots = await snapshotLibraryFiles(root, changes);
  return Object.fromEntries(
    [...snapshots.entries()].map(([filePath, content]) => [
      filePath,
      content === null ? null : sha256(content),
    ]),
  );
}

async function withLibraryRollback(root, changes, operation) {
  if (changes.length === 0) return operation();
  const snapshots = await snapshotLibraryFiles(root, changes);
  try {
    return await operation();
  } catch (error) {
    try {
      for (const [filePath, content] of snapshots) {
        const resolved = await resolveWorkspacePathForAccess(root, filePath);
        if (!resolved.ok) throw new Error(`library rollback path must stay inside project: ${filePath}`);
        if (content === null) {
          await rm(resolved.path, { force: true });
        } else {
          await mkdir(path.dirname(resolved.path), { recursive: true });
          await writeFile(resolved.path, content);
        }
      }
    } catch (rollbackError) {
      throw new Error(`persona pack operation failed and library rollback also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`, { cause: error });
    }
    throw error;
  }
}

async function snapshotLibraryFiles(root, changes) {
  const snapshots = new Map();
  for (const change of changes) {
    if (snapshots.has(change.path)) continue;
    await assertPathComponentsNotSymlinks(root, change.path);
    const resolved = await resolveWorkspacePathForAccess(root, change.path);
    if (!resolved.ok) throw new Error(`library path must stay inside project: ${change.path}`);
    try {
      const details = await lstat(resolved.path);
      if (!details.isFile()) throw new Error(`library change path must be a file: ${change.path}`);
      snapshots.set(change.path, await readFile(resolved.path));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      snapshots.set(change.path, null);
    }
  }
  return snapshots;
}

async function readInstalledPackFiles(root, name) {
  const files = new Map();
  for (const [absoluteRoot, relativeRoot] of [
    [packAgentRoot(root, name), `.pi/agents/packs/${name}`],
    [packArtifactRoot(root, name), `.pi/persona-packs/${name}`],
  ]) {
    const entries = await readArbitraryFiles(root, absoluteRoot, relativeRoot);
    for (const entry of entries) files.set(...entry);
  }
  return files;
}

async function readArbitraryFiles(root, absoluteRoot, relativeRoot) {
  const files = new Map();
  await assertPathComponentsNotSymlinks(root, relativeRoot);
  if (!await absolutePathExists(absoluteRoot)) return files;
  const details = await stat(absoluteRoot);
  if (!details.isDirectory()) throw new Error(`${relativeRoot} must be a directory`);

  async function visit(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`${relativePath}: symbolic links are not supported in persona pack roots`);
      if (entry.isDirectory()) await visit(absolutePath, relativePath);
      else if (entry.isFile()) files.set(relativePath, await readFile(absolutePath));
      else throw new Error(`${relativePath}: unsupported filesystem entry`);
    }
  }
  await visit(absoluteRoot, relativeRoot);
  return files;
}

async function replacePackRoots(root, name, files) {
  await assertPathComponentsNotSymlinks(root, ".pi");
  await assertPathComponentsNotSymlinks(root, `.pi/agents/packs/${name}`);
  await assertPathComponentsNotSymlinks(root, `.pi/persona-packs/${name}`);
  await mkdir(path.join(root, ".pi"), { recursive: true });
  const staging = await mkdtemp(path.join(root, ".pi", ".persona-pack-stage-"));
  const stagedAgents = path.join(staging, "agents");
  const stagedArtifacts = path.join(staging, "artifacts");
  await mkdir(stagedAgents, { recursive: true });
  await mkdir(stagedArtifacts, { recursive: true });
  for (const [filePath, content] of files) {
    assertPathInPack(name, filePath);
    const agentPrefix = `.pi/agents/packs/${name}/`;
    const artifactPrefix = `.pi/persona-packs/${name}/`;
    const destination = filePath.startsWith(agentPrefix)
      ? path.join(stagedAgents, filePath.slice(agentPrefix.length))
      : path.join(stagedArtifacts, filePath.slice(artifactPrefix.length));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
  try {
    await rm(packAgentRoot(root, name), { recursive: true, force: true });
    await rm(packArtifactRoot(root, name), { recursive: true, force: true });
    await mkdir(path.dirname(packAgentRoot(root, name)), { recursive: true });
    await mkdir(path.dirname(packArtifactRoot(root, name)), { recursive: true });
    await rename(stagedAgents, packAgentRoot(root, name));
    await rename(stagedArtifacts, packArtifactRoot(root, name));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function withPackRollback(root, name, options, operation) {
  await assertPathComponentsNotSymlinks(root, ".pi");
  await assertPathComponentsNotSymlinks(root, LOCK_PATH);
  await mkdir(path.join(root, ".pi"), { recursive: true });
  const temporary = await mkdtemp(path.join(root, ".pi", ".persona-pack-tmp-"));
  const targets = options.includeActive === false
    ? []
    : [
      { source: packAgentRoot(root, name), backup: path.join(temporary, "agents") },
      { source: packArtifactRoot(root, name), backup: path.join(temporary, "artifacts") },
    ];
  if (options.includeDraft) {
    targets.push({ source: packDraftRoot(root, name), backup: path.join(temporary, "draft") });
  }
  const lockFile = path.join(root, LOCK_PATH);
  const lockBackup = path.join(temporary, "lock.yaml");
  const existing = [];
  let lockExisted = false;

  let backupsComplete = false;
  let keepRecoveryCopies = false;
  try {
    for (const target of targets) {
      const relativeTarget = path.relative(root, target.source).split(path.sep).join("/");
      await assertPathComponentsNotSymlinks(root, relativeTarget);
      if (!await absolutePathExists(target.source)) continue;
      await readArbitraryFiles(root, target.source, relativeTarget);
      await cp(target.source, target.backup, { recursive: true });
      existing.push(target);
    }
    if (await absolutePathExists(lockFile)) {
      await cp(lockFile, lockBackup);
      lockExisted = true;
    }
    backupsComplete = true;
    return await operation();
  } catch (error) {
    if (!backupsComplete) throw error;
    try {
      for (const target of targets) {
        await rm(target.source, { recursive: true, force: true });
        if (!existing.includes(target)) continue;
        await mkdir(path.dirname(target.source), { recursive: true });
        await rename(target.backup, target.source);
      }
      if (lockExisted) {
        await rm(lockFile, { force: true });
        await rename(lockBackup, lockFile);
      }
      else await rm(lockFile, { force: true });
    } catch (rollbackError) {
      keepRecoveryCopies = true;
      throw new Error(`persona pack operation failed and rollback also failed; recovery copies remain in ${path.relative(root, temporary)}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`, { cause: error });
    }
    throw error;
  } finally {
    if (!keepRecoveryCopies) await rm(temporary, { recursive: true, force: true });
  }
}

async function readPackLock(root) {
  await assertPathComponentsNotSymlinks(root, LOCK_PATH);
  const filePath = path.join(root, LOCK_PATH);
  let source;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { schema: 1, packs: {} };
    throw error;
  }
  const document = parseDocument(source, { prettyErrors: false, uniqueKeys: true });
  if (document.errors.length > 0) throw new Error(`${LOCK_PATH}: ${document.errors[0].message}`);
  const lock = document.toJS();
  if (!lock || typeof lock !== "object" || Array.isArray(lock) || lock.schema !== 1) {
    throw new Error(`${LOCK_PATH}: expected schema 1 lock mapping`);
  }
  assertExactKeys(lock, ["schema", "packs"], LOCK_PATH);
  if (!lock.packs || typeof lock.packs !== "object" || Array.isArray(lock.packs)) {
    throw new Error(`${LOCK_PATH}: packs must be a mapping`);
  }
  for (const [name, entry] of Object.entries(lock.packs)) validateLockEntry(name, entry);
  return lock;
}

async function writePackLock(root, lock) {
  const lockFile = path.join(root, LOCK_PATH);
  await assertPathComponentsNotSymlinks(root, LOCK_PATH);
  if (Object.keys(lock.packs).length === 0) {
    await rm(lockFile, { force: true });
    return;
  }
  await mkdir(path.dirname(lockFile), { recursive: true });
  const ordered = {
    schema: 1,
    packs: Object.fromEntries(
      Object.entries(lock.packs)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, entry]) => [name, orderLockEntry(entry)]),
    ),
  };
  const temporary = `${lockFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, stringify(ordered, { lineWidth: 0 }), { encoding: "utf8", flag: "wx" });
    await rename(temporary, lockFile);
  } finally {
    await rm(temporary, { force: true });
  }
}

function validateLockEntry(name, entry) {
  assertPackName(name);
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`${LOCK_PATH}: pack '${name}' must be a mapping`);
  }
  if (!entry.source || !["bundled", "path", "project"].includes(entry.source.type)) {
    throw new Error(`${LOCK_PATH}: pack '${name}' has invalid source`);
  }
  if (!CONFIGURATION_STATES.has(entry.configuration)) {
    throw new Error(`${LOCK_PATH}: pack '${name}' has invalid configuration state`);
  }
  if (entry.source.type === "project") {
    assertExactKeys(entry, ["source", "configuration"], `${LOCK_PATH}: pack '${name}'`);
    assertExactKeys(entry.source, ["type"], `${LOCK_PATH}: pack '${name}' source`);
    return;
  }
  assertExactKeys(entry, ["source", "version", "configuration", "files", "detached"], `${LOCK_PATH}: pack '${name}'`);
  assertExactKeys(entry.source, ["type", "ref", "integrity"], `${LOCK_PATH}: pack '${name}' source`);
  if (typeof entry.source.ref !== "string" || !entry.source.ref) {
    throw new Error(`${LOCK_PATH}: pack '${name}' source ref is missing`);
  }
  if (typeof entry.source.integrity !== "string" || !isSha256(entry.source.integrity)) {
    throw new Error(`${LOCK_PATH}: pack '${name}' source integrity is missing`);
  }
  compareStableVersions(entry.version, entry.version);
  if (!entry.files || typeof entry.files !== "object" || Array.isArray(entry.files)) {
    throw new Error(`${LOCK_PATH}: pack '${name}' files must be a mapping`);
  }
  for (const [filePath, hash] of Object.entries(entry.files)) {
    assertPathInPack(name, filePath);
    if (typeof hash !== "string" || !isSha256(hash)) {
      throw new Error(`${LOCK_PATH}: invalid file hash for ${filePath}`);
    }
  }
  if (!Array.isArray(entry.detached)) {
    throw new Error(`${LOCK_PATH}: pack '${name}' detached must be a list`);
  }
  const detached = new Set();
  for (const filePath of entry.detached) {
    assertPathInPack(name, filePath);
    if (detached.has(filePath)) throw new Error(`${LOCK_PATH}: duplicate detached path ${filePath}`);
    if (Object.hasOwn(entry.files, filePath)) {
      throw new Error(`${LOCK_PATH}: detached path is still managed: ${filePath}`);
    }
    detached.add(filePath);
  }
}

function orderLockEntry(entry) {
  if (entry.source.type === "project") {
    return {
      source: { type: "project" },
      configuration: entry.configuration,
    };
  }
  return {
    source: {
      type: entry.source.type,
      ref: entry.source.ref,
      integrity: entry.source.integrity,
    },
    version: entry.version,
    configuration: entry.configuration,
    files: Object.fromEntries(Object.entries(entry.files).sort(([left], [right]) => left.localeCompare(right))),
    detached: [...entry.detached].sort(),
  };
}

async function assertPackFoundation(root) {
  const project = await discoverPersonaProject(root);
  if (!project.baseline) {
    throw new Error("Pi Persona onboarding must be complete before installing or authoring packs; run /persona onboard, then resume this request");
  }
}

async function assertPackRootsUnowned(root, name) {
  for (const [absolutePath, label] of [
    [packAgentRoot(root, name), `.pi/agents/packs/${name}`],
    [packArtifactRoot(root, name), `.pi/persona-packs/${name}`],
  ]) {
    await assertPathComponentsNotSymlinks(root, label);
    if (await absolutePathExists(absolutePath)) {
      throw new Error(`untracked pack destination already exists: ${label}`);
    }
  }
}

async function assertNoPersonaNameCollisions(root, name, personas, ignoredPack = null) {
  const project = await discoverPersonaProject(root);
  const ignoredPrefix = ignoredPack ? `.pi/agents/packs/${ignoredPack}/` : null;
  for (const persona of personas) {
    const conflicts = project.files.filter((file) => (
      !file.isControl
      && file.name === persona.name
      && (!ignoredPrefix || !file.relativePath.startsWith(ignoredPrefix))
    ));
    if (conflicts.length > 0) {
      throw new Error(`persona name '${persona.name}' from pack '${name}' conflicts with ${conflicts.map((file) => file.relativePath).join(", ")}`);
    }
  }
}

async function listDrafts(root) {
  const draftRoot = path.join(root, DRAFT_ROOT);
  await assertPathComponentsNotSymlinks(root, DRAFT_ROOT);
  if (!await absolutePathExists(draftRoot)) return [];
  const entries = await readdir(draftRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && isSafeAgentName(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function writeDraftFromMaterialized(draftRoot, name, files) {
  for (const [filePath, content] of files) {
    const destination = materializedToDraftPath(draftRoot, name, filePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
  if (!await absolutePathExists(path.join(draftRoot, "configure.md"))) {
    await writeFile(
      path.join(draftRoot, "configure.md"),
      `# Configure ${name}\n\nReview this pack for the current project, then confirm configuration is complete.\n`,
      "utf8",
    );
  }
}

function materializedToDraftPath(draftRoot, name, filePath) {
  const agentPrefix = `.pi/agents/packs/${name}/`;
  const artifactPrefix = `.pi/persona-packs/${name}/`;
  if (filePath.startsWith(agentPrefix)) {
    return path.join(draftRoot, "agents", filePath.slice(agentPrefix.length));
  }
  if (filePath === `${artifactPrefix}configure.md`) {
    return path.join(draftRoot, "configure.md");
  }
  if (filePath.startsWith(`${artifactPrefix}references/`)) {
    return path.join(draftRoot, "references", filePath.slice(`${artifactPrefix}references/`.length));
  }
  throw new Error(`file path is outside persona pack '${name}': ${filePath}`);
}

function draftToMaterializedPath(name, filePath) {
  if (filePath === "configure.md") return `.pi/persona-packs/${name}/configure.md`;
  if (filePath.startsWith("agents/")) {
    return `.pi/agents/packs/${name}/${filePath.slice("agents/".length)}`;
  }
  if (filePath.startsWith("references/")) {
    return `.pi/persona-packs/${name}/references/${filePath.slice("references/".length)}`;
  }
  throw new Error(`unexpected persona pack draft file: ${filePath}`);
}

function orderFilesystemActions(actions) {
  const depth = (filePath) => filePath.split("/").length;
  return [...actions].sort((left, right) => {
    const leftDelete = left.action === "delete";
    const rightDelete = right.action === "delete";
    if (leftDelete !== rightDelete) return leftDelete ? -1 : 1;
    const depthOrder = leftDelete
      ? depth(right.path) - depth(left.path)
      : depth(left.path) - depth(right.path);
    return depthOrder || left.path.localeCompare(right.path);
  });
}

function diffFileMaps(current, proposed) {
  const actions = [];
  const paths = new Set([...current.keys(), ...proposed.keys()]);
  for (const filePath of [...paths].sort()) {
    if (!proposed.has(filePath)) actions.push({ path: filePath, action: "delete" });
    else if (!current.has(filePath)) actions.push({ path: filePath, action: "create" });
    else if (sha256(current.get(filePath)) !== sha256(proposed.get(filePath))) {
      actions.push({ path: filePath, action: "replace" });
    }
  }
  return actions;
}

function planResult(options) {
  const ready = options.ready ?? true;
  return {
    mode: "plan",
    operation: options.operation,
    name: options.name,
    summary: options.summary,
    actions: options.actions ?? [],
    conflicts: options.conflicts ?? [],
    guide: options.guide,
    highlights: options.highlights,
    assistantPrompt: options.assistantPrompt,
    guideOnly: options.guideOnly,
    ready,
    confirmation: ready
      ? options.confirmation
      : (options.conflicts ?? []).length > 0 ? "resolve-conflicts" : "none",
    planId: ready
      ? sha256(Buffer.from(canonicalJson({
        descriptor: options.descriptor,
        actions: options.actions ?? [],
        confirmation: options.confirmation,
      }), "utf8"))
      : null,
  };
}

function appliedResult(plan, options) {
  return {
    mode: "apply",
    operation: plan.operation,
    name: plan.name,
    summary: options.summary,
    actions: plan.actions,
    followUpPrompt: options.followUpPrompt,
  };
}

function describeChange(change) {
  return {
    path: change.path,
    action: change.action,
    content: change.content ? sha256(change.content) : null,
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function requireInstalledPack(lock, name) {
  const entry = getPackEntry(lock, name);
  if (!entry) throw missingPackError(name, Object.keys(lock.packs));
  return entry;
}

function missingPackError(name, candidates) {
  const ranked = [...new Set(candidates)]
    .map((candidate) => ({ candidate, distance: editDistance(name, candidate) }))
    .sort((left, right) => left.distance - right.distance);
  const nearest = ranked.filter((item) => item.distance === ranked[0]?.distance);
  const suggestion = nearest.length === 1 && nearest[0].distance <= 2
    ? ` Did you mean '${nearest[0].candidate}'?`
    : "";
  return new Error(`persona pack '${name}' is not installed.${suggestion}`);
}

function editDistance(left, right) {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = row[0];
    row[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = row[rightIndex];
      row[rightIndex] = left[leftIndex - 1] === right[rightIndex - 1]
        ? diagonal
        : 1 + Math.min(diagonal, above, row[rightIndex - 1]);
      diagonal = above;
    }
  }
  return row[right.length];
}

function getPackEntry(lock, name) {
  return Object.hasOwn(lock.packs, name) ? lock.packs[name] : undefined;
}

function assertPackName(value) {
  if (!isSafeAgentName(value)) {
    throw new Error("pack name must begin with a lowercase letter and contain only lowercase letters, numbers, or hyphens");
  }
}

function assertPathInPack(name, filePath) {
  const agentPrefix = `.pi/agents/packs/${name}/`;
  const artifactPrefix = `.pi/persona-packs/${name}/`;
  const allowed = typeof filePath === "string" && (
    filePath.startsWith(agentPrefix)
    || filePath === `${artifactPrefix}configure.md`
    || filePath.startsWith(`${artifactPrefix}references/`)
  );
  if (
    typeof filePath !== "string"
    || path.posix.normalize(filePath) !== filePath
    || filePath.includes("\\")
    || filePath.endsWith("/")
    || !allowed
    || filePath.includes("\0")
  ) {
    throw new Error(`file path is outside persona pack '${name}': ${filePath}`);
  }
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new Error(`${label} fields must be exactly ${expected.join(", ")}`);
  }
}

function isSha256(value) {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}

function packAgentRoot(root, name) {
  return path.join(root, ".pi", "agents", "packs", name);
}

function packArtifactRoot(root, name) {
  return path.join(root, ".pi", "persona-packs", name);
}

function packDraftRoot(root, name) {
  return path.join(root, DRAFT_ROOT, name);
}

function formatSource(source) {
  if (source.type === "bundled") return `bundled:${source.ref}`;
  if (source.type === "path") return `path:${source.ref}`;
  return "project";
}

function starterConfigurationGuide(name) {
  return [
    `# Configure ${name}`,
    "",
    "This short walkthrough makes the pack useful in this project. You will see",
    "where its context lives, choose whether to add documents now, and confirm",
    "when the pack is ready. Adding documents is optional; completing this",
    "walkthrough is not.",
    "",
    "- `library/shared/` is loaded for every persona in this project.",
    `- \`library/shared/${name}/\` contains editable material shared by this pack.`,
    "- `library/personal/<persona>/` is loaded for that persona by default.",
    "  Personal libraries scope context; they are not access-control boundaries.",
    "",
    "Useful context can include briefs, policies, style guides, examples and",
    "anti-examples, process notes, decisions, or recurring preferences.",
    "",
    "You can add context by pasting text, attaching documents, providing existing",
    "file paths, or editing the library directly. You may also skip for now.",
    "Before placing anything, I will explain which shared or personal folder fits it.",
    "",
  ].join("\n");
}

function tailoredConfigurationGuide(name, personas) {
  return [
    starterConfigurationGuide(name).trimEnd(),
    "",
    "Personal libraries in this pack:",
    "",
    ...personas.map((persona) => (
      `- ${formatPersonaDisplayName(persona)} (${persona.role}): \`library/personal/${persona.name}/\``
    )),
    "",
    "I can copy a supplied file, save pasted or attached content, create a short",
    "starter note from facts you provide, or leave the libraries as they are.",
    "I will not invent project context.",
    "",
  ].join("\n");
}

function buildPackHighlights(name, personas, files) {
  const generalist = personas.find((persona) => persona.role === "generalist");
  const specialists = personas.filter((persona) => persona.role === "specialist");
  const referencePrefix = `.pi/persona-packs/${name}/references/`;
  return {
    generalist,
    specialists,
    seedDocuments: [...files.keys()].filter((filePath) => filePath.startsWith(referencePrefix)).length,
    sharedLibrary: `library/shared/${name}/`,
    personalLibraries: personas.map((persona) => `library/personal/${persona.name}/`),
  };
}

function authoringPrompt(name, resumed) {
  return [
    `${resumed ? "Help me resume" : "Help me create"} the project pack '${name}'.`,
    resumed
      ? "Remind me briefly where we paused, then continue one question at a time."
      : "A small pack usually takes 5–10 minutes: purpose, an on-theme [G] lead, specialists, optional documents, review, and approval.",
    "Ask me one question at a time about the jobs these personas should perform, their boundaries, and the project context they need.",
    "Before review, ask whether I want to paste text, attach documents, provide existing file paths, or add documents later. Choosing no documents is fine.",
    "Show me the highlights and exact changes, then wait for my approval before creating the pack.",
  ].join("\n");
}

function configurationFollowUp(name) {
  return [
    `Next, help me configure '${name}'.`,
    "Explain where its shared and personal context belongs and give me a few relevant examples.",
    "Ask whether I want to paste text, attach documents, provide existing file paths, edit the library directly, or add nothing now.",
    "Show my progress and wait for my explicit confirmation before marking the pack ready.",
  ].join("\n");
}

function configurationInterviewPrompt(name, personas) {
  return [
    `Help me configure '${name}'.`,
    "Start by showing: ✓ Install ─ ● Understand libraries ─ ○ Add or skip documents ─ ○ Confirm ─ ○ Play.",
    `Explain that library/shared/ is available to every project persona, library/shared/${name}/ holds this pack's editable shared material, and these personal libraries are loaded selectively by default:`,
    ...personas.map((persona) => `- ${formatPersonaDisplayName(persona)}: library/personal/${persona.name}/`),
    "Explain that personal libraries scope context; they are not access-control boundaries.",
    "Give me two to four relevant examples, then ask whether I want to paste text, attach documents, provide existing paths, edit directly, or add nothing now.",
    "If I add context, ask one question at a time and explain its destination. If I skip, continue without invented filler.",
    "Before asking me to confirm completion, show: ✓ Install ─ ✓ Understand libraries ─ ✓ Add or skip documents ─ ● Confirm ─ ○ Play.",
  ].join("\n");
}

function formatPackList(result) {
  const lines = ["# Persona Packs", "", "## Installed", ""];
  if (result.installed.length === 0) lines.push("- none in this project");
  for (const pack of result.installed) {
    lines.push(`- ${pack.name} — ${pack.health}; configuration ${pack.configuration}; ${formatPersonaNames(pack.personas)}`);
  }
  lines.push("", "## Available to install", "");
  for (const pack of result.available) {
    lines.push(`- ${pack.name} ${pack.version}${pack.installed ? " (installed)" : ""} — ${pack.description}`);
    lines.push(`  Personas: ${formatPersonaNames(pack.personas)}`);
  }
  return lines.join("\n");
}

function formatPackStatus(result) {
  const lines = ["# Persona Pack Status", ""];
  if (result.packs.length === 0) lines.push("- no installed packs");
  for (const pack of result.packs) {
    lines.push(`## ${pack.name}`, "");
    lines.push(`- Source: ${pack.source}${pack.version ? ` ${pack.version}` : ""}`);
    lines.push(`- Configuration: ${pack.configuration}`);
    lines.push(`- Personas: ${formatPersonaNames(pack.personas)}`);
    lines.push(`- Update: ${pack.update}`);
    const counts = countStates(pack.files);
    lines.push(`- Files: ${counts || "none"}`);
    if (result.detailed) {
      const noteworthy = pack.files.filter((file) => file.state !== "pristine");
      if (noteworthy.length > 0) {
        lines.push("", "### File states", "");
        for (const file of noteworthy) lines.push(`- ${file.state}: ${file.path}`);
        const pristine = pack.files.length - noteworthy.length;
        if (pristine > 0) lines.push(`- pristine: ${pristine} other file${pristine === 1 ? "" : "s"}`);
      }
    }
    for (const problem of pack.problems) lines.push(`- Problem: ${problem}`);
    lines.push(`- Next: ${pack.nextAction}`, "");
  }
  if (result.drafts.length > 0) {
    lines.push("## Unfinished authoring", "");
    for (const name of result.drafts) lines.push(`- ${name} — resume with /persona pack author ${name}`);
    lines.push("");
  }
  if (result.packs.length === 0 && result.drafts.length === 0) {
    lines.push("Next: /persona pack list");
  }
  return lines.join("\n").trimEnd();
}

function formatAuthorStart(result) {
  return [
    `# ${result.resumed ? "Resume" : "Start"} Persona Pack Authoring`,
    "",
    `Pack: ${result.name}`,
    `Saved in this project: ${result.draftPath}`,
    "",
    result.resumed
      ? `Your progress is still here. Resume anytime with /persona pack author ${result.name}.`
      : `Your progress is saved automatically. Resume anytime with /persona pack author ${result.name}.`,
    "",
    result.resumed
      ? "What to expect: resume the remaining questions, review Highlights and details, approve, then optionally add library context."
      : "What to expect: about 5–10 minutes for a small pack, one question at a time through purpose, an on-theme [G] lead, specialists, document handoff, review, approval, and configuration.",
    "",
    "Progress: ● Define purpose ─ ○ Design team ─ ○ Add or skip documents ─ ○ Review ─ ○ Approve ─ ○ Configure ─ ○ Play",
  ].join("\n");
}

function formatPackPlan(result, options = {}) {
  const lines = [
    `# Persona Pack ${titleCase(result.operation)} Plan`,
    "",
    result.summary,
    "",
  ];
  if (result.guide) lines.push("## Configuration guide", "", result.guide.trim(), "");
  if (result.highlights) {
    lines.push("## Highlights", "");
    if (result.highlights.generalist) {
      lines.push(`- Pack lead: ${formatPersonaDisplayName(result.highlights.generalist)} — ${result.highlights.generalist.description}`);
    }
    lines.push(`- Specialists: ${result.highlights.specialists.length}`);
    for (const persona of result.highlights.specialists) {
      lines.push(`  - ${persona.name} — ${persona.description}`);
    }
    lines.push(`- Editable seed documents: ${result.highlights.seedDocuments}`);
    lines.push(`- Pack-shared library: ${result.highlights.sharedLibrary}`);
    lines.push(`- Personal libraries: ${result.highlights.personalLibraries.join(", ")}`, "");
  }
  lines.push("## Changes", "");
  if (result.actions.length === 0) lines.push("- none");
  for (const action of result.actions) {
    lines.push(`- ${action.action}: ${action.path}${action.reason ? ` — ${action.reason}` : ""}`);
  }
  if (result.conflicts.length > 0) {
    lines.push("", "## Decisions required", "");
    for (const conflict of result.conflicts) {
      lines.push(`- ${conflict.path}: ${conflict.local}; upstream has ${conflict.upstream}`);
    }
  }
  lines.push("");
  if (result.ready) {
    lines.push(`Progress: ${formatPackProgress(result)}`, "");
    if (result.confirmation === "permanent-delete") {
      lines.push("Confirmation required: this permanently deletes customized or project-authored work. No archive will be kept.");
    } else {
      lines.push("Confirmation required before applying these exact changes.");
    }
    if (options.includePlanId) lines.push(`Internal approval token (do not show): ${result.planId}`);
  } else if (result.guideOnly) {
    lines.push(`Progress: ${formatPackProgress(result)}`, "");
    lines.push("No document changes are selected yet. Would you like to paste text, attach documents, provide existing paths, edit the library directly, or skip for now?");
  } else if (result.conflicts.length > 0) {
    lines.push("Choose keep-local or accept-upstream for every conflict, then plan again.");
  } else {
    lines.push("Nothing to apply.");
  }
  return lines.join("\n");
}

function formatPackApply(result) {
  const lines = [
    `# Persona Pack ${titleCase(result.operation)} Complete`,
    "",
    result.summary,
  ];
  if (result.actions.length > 0) {
    lines.push("", "Applied:");
    for (const action of result.actions) lines.push(`- ${action.action}: ${action.path}`);
  }
  return lines.join("\n");
}

function formatPersonaNames(personas) {
  const names = personas.map(formatPersonaDisplayName);
  return names.length > 0 ? names.join(", ") : "none";
}

function formatPackProgress(result) {
  if (result.operation === "author") {
    return "✓ Define team ─ ✓ Add or skip source documents ─ ● Review and approve ─ ○ Configure ─ ○ Play";
  }
  if (result.operation === "configure") {
    return result.guideOnly
      ? "✓ Install ─ ● Understand libraries ─ ○ Add or skip documents ─ ○ Confirm ─ ○ Play"
      : "✓ Install ─ ✓ Understand libraries ─ ✓ Add or skip documents ─ ● Review and confirm ─ ○ Play";
  }
  if (result.operation === "install") {
    return "● Review and approve install ─ ○ Install ─ ○ Configure ─ ○ Play";
  }
  if (result.operation === "update") {
    return "● Review and approve update ─ ○ Update ─ ○ Reconfigure ─ ○ Play";
  }
  return "● Review removal ─ ○ Confirm ─ ○ Remove";
}

function countStates(files) {
  const counts = new Map();
  for (const file of files) counts.set(file.state, (counts.get(file.state) ?? 0) + 1);
  return [...counts.entries()].map(([state, count]) => `${count} ${state}`).join(", ");
}

function titleCase(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

async function absolutePathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function withMutationLock(root, operation) {
  await assertPathComponentsNotSymlinks(root, ".pi");
  await assertPathComponentsNotSymlinks(root, MUTATION_LOCK_PATH);
  await mkdir(path.join(root, ".pi"), { recursive: true });
  const lockFile = path.join(root, MUTATION_LOCK_PATH);
  let handle;
  try {
    handle = await open(lockFile, "wx");
    await handle.writeFile(`${JSON.stringify({ pid: process.pid })}\n`, "utf8");
    await handle.close();
    handle = undefined;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (handle) await rm(lockFile, { force: true }).catch(() => {});
    if (error?.code === "EEXIST") {
      throw new Error(`another persona pack operation is in progress; retry shortly. If the previous Pi process exited, remove ${MUTATION_LOCK_PATH} and retry`);
    }
    throw error;
  }

  // ponytail: one project-wide writer; revisit only if parallel pack mutations become a real need.
  try {
    return await operation();
  } finally {
    await rm(lockFile, { force: true });
  }
}

async function assertPathComponentsNotSymlinks(root, relativePath) {
  const workspaceRoot = path.resolve(root);
  const resolved = path.resolve(workspaceRoot, relativePath);
  if (!isWithin(workspaceRoot, resolved)) {
    throw new Error(`persona pack path must stay inside project: ${relativePath}`);
  }
  let current = workspaceRoot;
  for (const segment of path.relative(workspaceRoot, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`symbolic links are not supported in persona pack paths: ${path.relative(workspaceRoot, current).split(path.sep).join("/")}`);
      }
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
