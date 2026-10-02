/**
 * Legacy (pre-global-pack) persona project recognition, inspection, preview,
 * apply, and rollback support — pure filesystem operations, no Pi API calls.
 *
 * A "legacy" workspace is one with its own top-level generalist directly
 * under `.pi/agents/` (see agents.js's hasLegacyPersonaProject), predating
 * global official/custom packs. Migration converts that project-local
 * content into a global custom pack (see global-pack-store.js) without ever
 * touching the workspace's original files: apply is copy-only.
 *
 * The conversion pipeline is deliberately built on top of the exact same
 * primitives an ordinary custom-pack create/edit already uses
 * (stageCustomPersonaPackDraft / previewCustomPersonaPackDraft /
 * applyCustomPersonaPackDraft / cancelCustomPersonaPackDraft), including
 * readPortablePersonaPack's own schema validation — migration does not
 * reimplement or relax that validation, and does not invent a second store
 * mutation path.
 *
 * Reviewed-content approval is a maintainer decision, not an automated one:
 * there is no content classifier here. A legacy persona's body/description
 * prose can contain private project facts, so nothing is copied into the
 * global store unless the caller explicitly names it in `selection`
 * (`leadName` plus `approvedPersonas`, optionally `includeBaseline`). Every
 * legacy persona not named is simply left out of the destination pack and
 * reported back as excluded, not redacted or summarized.
 *
 * `docs:` (workspace-relative library references) are carried over verbatim
 * rather than copied into the pack's own `references/`: copying them would
 * globalize workspace-local content this module has no basis to review.
 * They only resolve again if the migrated persona later runs in a workspace
 * that happens to have the same relative paths — callers get that as an
 * explicit preview notice, not a silent promise.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stringify } from "yaml";

import {
  discoverPersonaProject,
  formatPrimaryGeneralistError,
  getPrimaryGeneralistState,
  hasLegacyPersonaProject,
  isPackScopedAgentPath,
  legacyRosterAgents,
} from "./agents.js";
import { inspectDocPath } from "./doc-index.js";
import { uniqueStrings } from "./frontmatter.js";
import {
  applyCustomPersonaPackDraft,
  assertNoSymlinkEscape,
  previewCustomPersonaPackDraft,
  stageCustomPersonaPackDraft,
} from "./global-pack-store.js";
import { readPortablePersonaPack, sha256 } from "./pack-source.js";
import { NATIVE_BUILTIN_TOOLS } from "./runtime.js";
import { isSafeAgentName } from "./schema.js";

const MIGRATION_DIRNAME = ".pi/persona-migration";
const MARKER_FILENAME = "marker.json";
const RECEIPT_FILENAME = "receipt.json";
const BACKUP_DIRNAME = "backup";
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

let cachedToolVersion;
async function toolVersion() {
  if (cachedToolVersion) return cachedToolVersion;
  try {
    const raw = await readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8");
    cachedToolVersion = JSON.parse(raw).version ?? "unknown";
  } catch {
    cachedToolVersion = "unknown";
  }
  return cachedToolVersion;
}

/**
 * Read-only recognition and inventory: versions/personas/coordinator,
 * baseline, declared docs paths, tool/skill capability names, other
 * installed (non-legacy) packs in the same project, source hashes, and
 * decisions a maintainer must make before this project can convert (an
 * unsupported multiple-lead shape, an unknown declared tool name). Never
 * writes anything.
 */
export async function inspectLegacyMigration(root) {
  const project = await discoverPersonaProject(root);
  const inspectedAt = new Date().toISOString();

  if (!hasLegacyPersonaProject(project)) {
    return {
      recognized: false,
      reason: "no top-level generalist persona was found outside installed packs; an ordinary .pi/agents directory with only specialists, or none at all, is not a Pi Persona setup to migrate",
      inspectedAt,
    };
  }

  const legacyAgents = legacyRosterAgents(project);
  const leadState = getPrimaryGeneralistState({ agents: legacyAgents });
  const supported = leadState.effectivePrimary.length === 1;
  const decisionsNeeded = [];
  if (!supported) {
    decisionsNeeded.push(formatPrimaryGeneralistError(leadState, "persona migration"));
  }

  const personas = [];
  const docsSet = new Map();
  for (const agent of legacyAgents) {
    const tools = uniqueStrings(agent.tools ?? []);
    const unknownTools = tools.filter((tool) => !NATIVE_BUILTIN_TOOLS.includes(tool));
    if (unknownTools.length > 0) {
      decisionsNeeded.push(`${agent.name} declares unknown built-in tool(s): ${unknownTools.join(", ")}; remove or fix them before approving this persona for migration`);
    }
    for (const docPath of agent.docs ?? []) {
      if (!docsSet.has(docPath)) docsSet.set(docPath, []);
      docsSet.get(docPath).push(agent.name);
    }
    personas.push({
      name: agent.name,
      role: agent.role,
      relativePath: agent.relativePath,
      description: agent.description,
      model: agent.model,
      tools,
      unknownTools,
      skills: uniqueStrings(agent.skills ?? []),
      docs: uniqueStrings(agent.docs ?? []),
      hash: sha256(await readFile(agent.filePath)),
    });
  }

  let baseline = null;
  if (project.baseline) {
    for (const docPath of project.baseline.frontmatter.docs ?? []) {
      if (!docsSet.has(docPath)) docsSet.set(docPath, []);
      docsSet.get(docPath).push("_baseline.md");
    }
    baseline = {
      relativePath: project.baseline.relativePath,
      docs: uniqueStrings(project.baseline.frontmatter.docs ?? []),
      skills: uniqueStrings(project.baseline.frontmatter.skills ?? []),
      hash: sha256(await readFile(project.baseline.filePath)),
    };
  }

  const docs = [];
  for (const [docPath, owners] of docsSet) {
    const inspection = await inspectDocPath(root, docPath);
    docs.push({
      path: docPath,
      owners,
      exists: inspection.ok,
      type: inspection.ok ? inspection.type : null,
    });
  }
  docs.sort((left, right) => left.path.localeCompare(right.path));

  const installedPacks = uniqueStrings(
    project.agents
      .filter((agent) => isPackScopedAgentPath(agent.relativePath))
      .map((agent) => agent.relativePath.slice(".pi/agents/packs/".length).split("/")[0]),
  ).sort();

  const digestInputs = [
    ...(baseline ? [{ relativePath: baseline.relativePath, hash: baseline.hash }] : []),
    ...personas.map((persona) => ({ relativePath: persona.relativePath, hash: persona.hash })),
  ].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const digest = createHash("sha256");
  for (const entry of digestInputs) {
    digest.update(entry.relativePath);
    digest.update("\0");
    digest.update(entry.hash);
    digest.update("\0");
  }

  return {
    recognized: true,
    supported,
    decisionsNeeded,
    leads: leadState.generalists.map((agent) => ({
      name: agent.name,
      relativePath: agent.relativePath,
      primary: agent.primary,
      primaryDeclared: agent.primaryDeclared,
    })),
    baseline,
    personas: personas.sort((left, right) => left.name.localeCompare(right.name)),
    docs,
    installedPacks,
    sourceDigest: `sha256:${digest.digest("hex")}`,
    inspectedAt,
  };
}

/**
 * Reads this workspace's migration marker/receipt (if any), without
 * checking whether the destination pack still exists — see
 * detectMigrationState for the live, store-aware version used to decide
 * whether the session-start migration gate applies.
 */
export async function readMigrationRecord(root) {
  await assertMigrationDirSafe(root);
  const marker = await readJsonIfPresent(markerPath(root));
  const receipt = await readJsonIfPresent(receiptPath(root));
  return marker || receipt ? { marker, receipt } : null;
}

/**
 * Live recognition + marker + destination-existence check, combined into
 * one of five states a caller (the session-start gate, /persona migrate
 * status) can act on directly:
 *   - "not-legacy": no recognized legacy project here; nothing to do.
 *   - "migration-required": recognized, never migrated.
 *   - "changed-source": migrated once, but the original files changed since
 *     (the recorded marker's source digest no longer matches); the earlier
 *     migration is left in place, but this is not silently re-imported.
 *   - "destination-missing": the marker's destination pack is no longer
 *     installed (removed, or a store the marker doesn't belong to); this
 *     never silently trusts the stale marker as "done".
 *   - "migrated": marker matches current source, destination still exists.
 */
export async function detectMigrationState(root, storeRoot) {
  const inspection = await inspectLegacyMigration(root);
  if (!inspection.recognized) return { state: "not-legacy", inspection };

  await assertMigrationDirSafe(root);
  const marker = await readJsonIfPresent(markerPath(root));
  if (!marker) {
    // No marker doesn't necessarily mean "never attempted": a store
    // mutation can succeed while the marker write itself fails (see
    // applyPersonaMigration's recovery error). Surfacing that leftover
    // receipt here, rather than only via a separate lookup, is what keeps
    // that failure mode an actionable, visible state instead of a silent
    // reset back to "nothing has happened yet".
    const receipt = await readJsonIfPresent(receiptPath(root));
    return { state: "migration-required", inspection, ...(receipt ? { receipt } : {}) };
  }

  if (marker.sourceDigest !== inspection.sourceDigest) {
    return { state: "changed-source", inspection, marker };
  }

  // Migration only ever creates custom/<name> (see applyPersonaMigration);
  // a marker claiming anything else -- a foreign "official/..." identity, a
  // qualified name with extra/missing segments, or a name that fails the
  // same isSafeAgentName check every real pack name must pass -- is not a
  // trustworthy destination to resolve a store path from, only a truthful
  // "this marker no longer points at a real destination" outcome.
  const destinationName = parseCustomMigrationDestination(marker.destination);
  let destinationExists = false;
  if (destinationName) {
    await assertNoSymlinkEscape(storeRoot, path.join("custom", destinationName));
    destinationExists = await pathExists(path.join(storeRoot, "custom", destinationName));
  }
  if (!destinationExists) return { state: "destination-missing", inspection, marker };

  return { state: "migrated", inspection, marker };
}

/**
 * Builds a schema 2 custom-pack draft from explicitly approved legacy
 * content and stages it through the existing global store draft pipeline
 * (same stageCustomPersonaPackDraft/previewCustomPersonaPackDraft used by
 * ordinary custom-pack create/edit), returning the same diff/isNew/personas
 * shape plus migration-specific notices. Does not touch the workspace's
 * original files and does not activate or default anything.
 */
export async function previewPersonaMigration(root, storeRoot, selection) {
  const inspection = await inspectLegacyMigration(root);
  if (!inspection.recognized) {
    throw new Error(`no recognized Pi Persona setup to migrate in ${root}: ${inspection.reason}`);
  }

  const destinationName = String(selection?.destinationName ?? "").trim();
  if (!isSafeAgentName(destinationName)) {
    throw new Error("migration destination name must begin with a lowercase letter and contain only lowercase letters, numbers, or hyphens");
  }

  const candidateLeads = inspection.leads;
  let leadName = selection?.leadName;
  if (!leadName) {
    if (candidateLeads.length !== 1) {
      throw new Error(`this project has ${candidateLeads.length} candidate lead(s), so a lead must be chosen explicitly: ${inspection.decisionsNeeded.join("; ") || "no single generalist could be selected automatically"}`);
    }
    leadName = candidateLeads[0].name;
  }
  if (!candidateLeads.some((lead) => lead.name === leadName)) {
    throw new Error(`'${leadName}' is not one of this project's legacy generalist(s): ${candidateLeads.map((lead) => lead.name).join(", ") || "(none)"}`);
  }

  const approvedNames = uniqueStrings([leadName, ...(selection?.approvedPersonas ?? [])]);
  const approvedPersonas = approvedNames.map((name) => {
    const persona = inspection.personas.find((candidate) => candidate.name === name);
    if (!persona) {
      throw new Error(`'${name}' is not one of this project's legacy personas: ${inspection.personas.map((candidate) => candidate.name).join(", ") || "(none)"}`);
    }
    return persona;
  });
  if (!approvedPersonas.some((persona) => persona.name === leadName && persona.role === "generalist")) {
    throw new Error(`'${leadName}' is not a generalist in this project's legacy roster`);
  }
  if (!approvedPersonas.some((persona) => persona.role === "specialist")) {
    throw new Error("at least one approved specialist is required; a migrated pack needs one generalist and at least one specialist, same as any persona pack");
  }
  const unresolvedTools = approvedPersonas.filter((persona) => persona.unknownTools.length > 0);
  if (unresolvedTools.length > 0) {
    throw new Error(`cannot migrate persona(s) with unknown declared tools: ${unresolvedTools.map((persona) => `${persona.name} (${persona.unknownTools.join(", ")})`).join("; ")}`);
  }

  const includeBaseline = selection?.includeBaseline === true && Boolean(inspection.baseline);
  const excludedPersonas = inspection.personas
    .filter((persona) => !approvedNames.includes(persona.name))
    .map((persona) => persona.name);

  const version = selection?.version ?? "1.0.0";
  const description = selection?.description
    ?? `Migrated from a project-local Pi Persona setup (${destinationName}).`;

  const manifestText = stringify({
    schema: 2,
    name: destinationName,
    version,
    description,
  }, { lineWidth: 0 });

  const docsNotices = [];
  const agentFiles = new Map();
  for (const persona of approvedPersonas) {
    const frontmatter = {
      name: persona.name,
      role: persona.role,
      description: persona.description,
      ...(persona.model ? { model: persona.model } : {}),
      ...(persona.tools.length > 0 ? { tools: persona.tools } : {}),
      ...(persona.skills.length > 0 ? { skills: persona.skills } : {}),
      ...(persona.docs.length > 0 ? { docs: persona.docs } : {}),
    };
    for (const docPath of persona.docs) {
      docsNotices.push(`${persona.name}: docs entry '${docPath}' stays workspace-relative and only resolves when this persona later runs in a workspace containing that path; it was not copied into the pack`);
    }
    agentFiles.set(`agents/${persona.name}.md`, Buffer.from(
      `---\n${manifestSafeFrontmatter(frontmatter)}---\n${await readAgentBody(root, persona.relativePath)}\n`,
      "utf8",
    ));
  }
  if (includeBaseline) {
    const baselineFrontmatter = {
      ...(inspection.baseline.docs.length > 0 ? { docs: inspection.baseline.docs } : {}),
      ...(inspection.baseline.skills.length > 0 ? { skills: inspection.baseline.skills } : {}),
    };
    for (const docPath of inspection.baseline.docs) {
      docsNotices.push(`_baseline.md: docs entry '${docPath}' stays workspace-relative and only resolves when this pack's baseline later runs in a workspace containing that path; it was not copied into the pack`);
    }
    agentFiles.set("agents/_baseline.md", Buffer.from(
      `---\n${manifestSafeFrontmatter(baselineFrontmatter)}---\n${await readAgentBody(root, inspection.baseline.relativePath)}\n`,
      "utf8",
    ));
  }

  await assertNoSymlinkEscape(storeRoot, path.join("custom", destinationName));
  if (await pathExists(path.join(storeRoot, "custom", destinationName))) {
    const record = await readMigrationRecord(root);
    if (!ownsMigrationDestination(record, destinationName)) {
      throw new Error(`persona pack 'custom/${destinationName}' already exists and is not this workspace's own migration destination; choose a different name, or run /persona migrate status to see the destination this workspace previously migrated to (${record?.marker?.destination ?? record?.receipt?.destination ?? "none recorded"})`);
    }
  }

  const tempRoot = await mkdtemp(path.join(tmpdir(), "pi-persona-migration-"));
  try {
    await writeFile(path.join(tempRoot, "pack.yaml"), manifestText, "utf8");
    await mkdir(path.join(tempRoot, "references"), { recursive: true });
    // A real file, not just an empty directory: the store's draft/apply
    // round-trip represents a pack as a flat file map (collectPackFiles in
    // global-pack-store.js), which has no way to record a directory that
    // contains no files -- an all-empty references/ would silently vanish
    // on the next read back. Migration never copies workspace references in
    // (see the module docstring), so references/ is genuinely always empty
    // otherwise; this file also doubles as a visible explanation of why.
    await writeFile(
      path.join(tempRoot, "references", "README.md"),
      "This pack was created by Pi Persona migration. No workspace references were copied in; each migrated persona's `docs:` entries (if any) stay workspace-relative, exactly as they were in the original project.\n",
    );
    await mkdir(path.join(tempRoot, "agents"), { recursive: true });
    for (const [relativePath, content] of agentFiles) {
      const destination = path.join(tempRoot, relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, content);
    }

    const source = await readPortablePersonaPack(tempRoot, { type: "migration", ref: root });
    await stageCustomPersonaPackDraft(storeRoot, destinationName, source);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }

  const staged = await previewCustomPersonaPackDraft(storeRoot, destinationName);
  return {
    ...staged,
    destinationName,
    qualifiedName: `custom/${destinationName}`,
    leadName,
    approvedPersonas: approvedNames,
    excludedPersonas,
    includeBaseline,
    baselinePath: inspection.baseline?.relativePath ?? null,
    docsNotices,
    sourceDigest: inspection.sourceDigest,
    inspectedAt: inspection.inspectedAt,
  };
}

/**
 * Copy-only apply: no default/activation side effects. Writes a durable
 * private backup and a "pending" receipt of the legacy source before
 * mutating the store, then applies the already-staged draft (created by
 * previewPersonaMigration) through the existing applyCustomPersonaPackDraft
 * path, and only then records the completion marker.
 *
 * Every check that decides whether this attempt is allowed to replace
 * `custom/<name>` is re-run immediately before the store mutation, inside
 * applyCustomPersonaPackDraft's own mutation lock (verifyBeforeApply below),
 * not trusted from an earlier, racy observation:
 *   - `expectedSourceDigest` (checked once here, then again inside the lock)
 *     refuses a legacy source that changed since it was previewed.
 *   - `expectedDraftIntegrity`, when given, refuses a staged draft edited
 *     after it was reviewed (the chat-approved apply always passes it).
 *   - `expectedActiveIntegrity`, when the caller has it (a preview run in
 *     this same runtime), refuses a destination pack that was edited after
 *     that preview -- reusing a valid marker/receipt for this destination is
 *     not, by itself, authorization to overwrite content someone else
 *     changed in the meantime.
 *   - the destination's existing marker/receipt (captured *before* this
 *     attempt writes its own pending receipt, so a concurrent, unrelated
 *     workspace targeting the same name can never authorize itself by
 *     reading back what it just wrote) must actually attribute
 *     `custom/<name>` to this workspace before an existing pack there may be
 *     replaced at all.
 *
 * The receipt is a truthful attempt record, not a pre-claimed success: it is
 * written "pending" before the store mutation, "failed" (with the error) if
 * that mutation does not go through -- in which case the just-staged backup
 * is discarded without ever replacing a previous, still-good one -- and only
 * "completed" once the store mutation has actually landed. If the store
 * mutation succeeds but the completion marker itself cannot be written, the
 * receipt still ends up "completed" (that is the true state of the store),
 * and the thrown error says so explicitly with a concrete recovery step,
 * rather than leaving a stuck workspace that a later preview would
 * misdiagnose as colliding with someone else's pack.
 */
export async function applyPersonaMigration(root, storeRoot, name, options = {}) {
  if (!isSafeAgentName(name)) throw new Error(`invalid migration destination name: ${name}`);
  const inspection = await inspectLegacyMigration(root);
  if (!inspection.recognized) {
    throw new Error(`no recognized Pi Persona setup to migrate in ${root}: ${inspection.reason}`);
  }
  if (options.expectedSourceDigest && options.expectedSourceDigest !== inspection.sourceDigest) {
    throw new Error(`this workspace's persona source changed since the migration was previewed (expected ${options.expectedSourceDigest}, found ${inspection.sourceDigest}); run /persona migrate preview again before applying`);
  }

  await assertMigrationDirSafe(root);
  // Captured before this attempt writes anything of its own, so the
  // ownership check inside verifyBeforeApply below can never read back this
  // same attempt's just-written "pending" receipt as if it were pre-existing
  // proof of ownership.
  const priorRecord = await readMigrationRecord(root);

  const backupStaging = await stageMigrationBackup(root);
  const attemptId = randomUUID();
  const receiptBase = {
    schema: 2,
    attemptId,
    sourceDigest: inspection.sourceDigest,
    destination: `custom/${name}`,
    previousBinding: options.previousBinding ?? null,
    migratedWithPackageVersion: await toolVersion(),
    createdAt: new Date().toISOString(),
  };
  try {
    await writeReceiptAtomically(root, { ...receiptBase, status: "pending" });
  } catch (error) {
    await discardMigrationBackupStaging(backupStaging);
    throw error;
  }

  const verifyBeforeApply = async ({ activeExists, activeIntegrity, draftIntegrity }) => {
    if (activeExists && !ownsMigrationDestination(priorRecord, name)) {
      throw new Error(`persona pack 'custom/${name}' already exists in the global persona pack store and is not recorded as this workspace's own migration destination; run /persona migrate status to review it, or choose a different destination name`);
    }
    if (options.expectedActiveIntegrity !== undefined) {
      const currentActiveIntegrity = activeExists ? activeIntegrity : null;
      if (currentActiveIntegrity !== options.expectedActiveIntegrity) {
        throw new Error(`persona pack 'custom/${name}' changed since it was last previewed; run /persona migrate preview ${name} again before applying, to review its current content before it is replaced`);
      }
    }
    if (options.expectedDraftIntegrity !== undefined && draftIntegrity !== options.expectedDraftIntegrity) {
      throw new Error(`the migration draft for 'custom/${name}' changed since it was last previewed; run /persona migrate preview ${name} again before applying`);
    }
    const recheck = await inspectLegacyMigration(root);
    if (recheck.sourceDigest !== inspection.sourceDigest) {
      throw new Error(`this workspace's persona source changed during apply (expected ${inspection.sourceDigest}, found ${recheck.sourceDigest}); run /persona migrate preview again before applying`);
    }
  };

  let result;
  try {
    result = await applyCustomPersonaPackDraft(storeRoot, name, { verifyBeforeApply });
  } catch (error) {
    await discardMigrationBackupStaging(backupStaging);
    await writeReceiptAtomically(root, {
      ...receiptBase,
      status: "failed",
      failedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => {});
    throw error;
  }

  // Only now -- store mutation confirmed -- may the previous backup (if any)
  // be replaced; a failed attempt above never reaches this line.
  await commitMigrationBackup(root, backupStaging);
  await writeReceiptAtomically(root, { ...receiptBase, status: "completed", completedAt: new Date().toISOString() });

  try {
    await writeJsonAtomically(markerPath(root), {
      schema: 1,
      sourceDigest: inspection.sourceDigest,
      destination: result.qualifiedName,
      completedAt: new Date().toISOString(),
    });
  } catch (markerError) {
    throw new Error(
      `persona pack '${result.qualifiedName}' now exists in the global persona pack store (the receipt for this attempt is recorded as completed), but this workspace's completion marker could not be written (${markerError instanceof Error ? markerError.message : String(markerError)}); `
      + `run /persona migrate apply ${name} again to repair the marker -- this workspace already owns '${result.qualifiedName}', so that retry is safe -- or run /persona migrate status for details`,
    );
  }

  return {
    ...result,
    receiptPath: receiptPath(root),
    markerPath: markerPath(root),
    backupPath: path.join(root, MIGRATION_DIRNAME, BACKUP_DIRNAME),
  };
}

/**
 * Invalidates this workspace's completion marker so a later
 * detectMigrationState/session-start gate no longer treats it as
 * "migrated" -- part of rollback's real contract (see /persona migrate
 * rollback in the extension boundary): the receipt, an immutable attempt
 * record, is left exactly as it is; only the live "is this done" signal is
 * revoked. Never touches the destination pack or the workspace's original
 * files.
 */
export async function invalidateMigrationMarker(root) {
  await assertMigrationDirSafe(root);
  await rm(markerPath(root), { force: true });
}

/**
 * A deliberate, user-requested rollback: records it truthfully in the
 * receipt (status "rolled-back" plus rolledBackAt; every other field of the
 * completed attempt, including completedAt and previousBinding, is kept as
 * the audit trail), then revokes the marker via invalidateMigrationMarker.
 * Without the receipt update, "completed receipt + no marker" is
 * indistinguishable from a marker write that genuinely failed, and status
 * would advise re-applying -- undoing the user's own decision. The receipt
 * is written first so a failure between the two steps leaves a still-valid
 * marker (re-runnable), never the failed-marker shape. Idempotent. Never
 * touches the destination pack, the private backup, or the workspace's
 * original files.
 */
export async function recordMigrationRollback(root) {
  await assertMigrationDirSafe(root);
  const receipt = await readJsonIfPresent(receiptPath(root));
  if (receipt?.status === "completed") {
    await writeReceiptAtomically(root, { ...receipt, status: "rolled-back", rolledBackAt: new Date().toISOString() });
  }
  await invalidateMigrationMarker(root);
}

// options.chat (all three report formatters): the persona_pack tool path,
// where the user talks to the agent, so slash-command syntax is left out.
export function formatMigrationInspectionReport(inspection, options = {}) {
  if (!inspection.recognized) {
    return `No recognized Pi Persona setup to migrate: ${inspection.reason}`;
  }
  const leads = inspection.leads.map((lead) => lead.name).join(", ") || "none";
  const specialists = inspection.personas.filter((persona) => persona.role !== "generalist").map((persona) => persona.name);
  const lines = [
    "# Pi Persona Migration Inspection",
    "",
    "## What migration would do",
    `- Copy this workspace's persona roster (lead: ${leads}; specialists: ${specialists.join(", ") || "none"}) from .pi/agents into a new global custom pack, custom/<name>, under a name you choose.`,
    "- Leave the original files in .pi/agents exactly as they are; migration never changes or deletes them.",
    `- Keep workspace docs local: ${inspection.docs.length} declared docs path(s) stay in this workspace by relative path and are not copied into the pack.`,
    options.chat
      ? `- Copy only what you approve in the preview: which specialists, which lead if there is more than one, and ${inspection.baseline ? `whether to include the shared baseline ${inspection.baseline.relativePath} (left out unless you choose it)` : "no shared baseline (this workspace has none)"}.`
      : `- Copy only what you approve in the preview: which specialists (--approve), which lead if there is more than one (--lead), and ${inspection.baseline ? `whether to include the shared baseline ${inspection.baseline.relativePath} (--baseline; left out unless you choose it)` : "no shared baseline (this workspace has none)"}.`,
    options.chat
      ? "- Not select the new pack for any session or make it the default; that is your separate choice afterward."
      : "- Not select the new pack for any session or make it the default; you choose it yourself afterward with /persona team.",
  ];
  if (inspection.decisionsNeeded.length > 0) {
    lines.push("", "## Decisions needed before migration");
    for (const decision of inspection.decisionsNeeded) lines.push(`- ${decision}`);
  }
  for (const doc of inspection.docs.filter((entry) => !entry.exists)) {
    lines.push(`- WARNING: declared doc '${doc.path}' (used by ${doc.owners.join(", ")}) does not exist`);
  }
  if (!options.chat) lines.push("", "Next: /persona migrate preview <name> --approve <specialist,...> [--baseline]");
  lines.push(
    "",
    "## Details",
    `Supported: ${inspection.supported ? "yes" : "no"}`,
    `Source digest: ${inspection.sourceDigest}`,
    `Baseline: ${inspection.baseline ? inspection.baseline.relativePath : "none"}`,
    `Candidate lead(s): ${leads}`,
    `Personas: ${inspection.personas.map((persona) => `${persona.name} (${persona.role})`).join(", ") || "none"}`,
    `Declared docs: ${inspection.docs.length}`,
    `Other installed packs in this project: ${inspection.installedPacks.join(", ") || "none"}`,
  );
  return lines.join("\n");
}

export function formatMigrationStatusReport(state, options = {}) {
  const lines = [`Migration state: ${state.state}`];
  const chat = options.chat === true;
  switch (state.state) {
    case "not-legacy":
      lines.push("No recognized Pi Persona setup predating global persona packs was found in this workspace.");
      break;
    case "migration-required":
      lines.push(chat
        ? "This workspace's persona setup can be reviewed, previewed and then migrated into a global custom pack."
        : "Run /persona migrate inspect to review this project, then /persona migrate preview <name> and /persona migrate apply <name>.");
      if (state.receipt?.status === "rolled-back") {
        lines.push(`Note: the migration to '${state.receipt.destination}' was rolled back at your request (${state.receipt.rolledBackAt ?? "time not recorded"}), so this workspace requires migration again. '${state.receipt.destination}' was kept in the global store and the private backup in .pi/persona-migration/backup/ was kept; neither is selected for this session. To migrate again later, ${chat ? "preview and apply it again" : "run /persona migrate preview and apply"} as a new, deliberate step.`);
      } else if (state.receipt?.status === "completed") {
        lines.push(`Note: a previous attempt's receipt says '${state.receipt.destination}' was completed, but this workspace has no completion marker (it likely failed to write). If that pack still exists, ${chat ? "applying the migration" : "run /persona migrate apply"} ${state.receipt.destination?.split("/")[1] ?? "<name>"} again ${chat ? "repairs" : "to repair"} the marker instead of starting over.`);
      } else if (state.receipt?.status === "failed") {
        lines.push(`Note: the last migration attempt (to '${state.receipt.destination}') failed: ${state.receipt.error ?? "see .pi/persona-migration/receipt.json"}. The previous good backup, if any, was preserved.`);
      } else if (state.receipt?.status === "pending") {
        lines.push(`Note: a migration attempt to '${state.receipt.destination}' was interrupted before it finished (receipt status "pending"). ${chat ? "Preview and apply it again" : "Run /persona migrate preview and apply again"}; this is safe to retry.`);
      }
      break;
    case "changed-source":
      lines.push(`Previously migrated to ${state.marker.destination}, but the original files changed since (recorded ${state.marker.sourceDigest}, now ${state.inspection.sourceDigest}). The earlier migration was left in place. ${chat ? "Inspect, preview and apply again" : "Run /persona migrate inspect, then preview/apply again"} to review the change.`);
      break;
    case "destination-missing":
      lines.push(`Previously migrated to ${state.marker.destination}, but that persona pack is no longer installed in this store. A private backup of the original source remains at .pi/persona-migration/backup/. ${chat ? "Previewing and applying the migration again recreates" : "Run /persona migrate preview/apply again to recreate"} the destination.`);
      break;
    case "migrated":
      lines.push(`Migrated to ${state.marker.destination} (completed ${state.marker.completedAt}). The original project persona files were left in place but are no longer used as a team; the migrated pack is not selected or made default automatically.${chat ? "" : ` Run /persona team ${state.marker.destination} to use it in this session.`}`);
      break;
    default:
      break;
  }
  return lines.join("\n");
}

export function formatMigrationPreviewReport(preview, options = {}) {
  const specialists = preview.approvedPersonas.filter((name) => name !== preview.leadName);
  const lines = [
    "# Pi Persona Migration Preview",
    "",
    "## What apply will do",
    `- Copy lead ${preview.leadName} and specialist(s) ${specialists.join(", ") || "none"} into the global custom pack ${preview.qualifiedName} (${preview.isNew ? "a new pack" : "replacing its current content"}).`,
    `- Leave every original file in .pi/agents unchanged${preview.excludedPersonas.length > 0 ? `; excluded personas (${preview.excludedPersonas.join(", ")}) stay only in this workspace` : ""}.`,
    preview.baselinePath
      ? `- Shared baseline ${preview.baselinePath}: ${preview.includeBaseline ? "included" : options.chat ? "not included (it can be added to the preview)" : "not included (add --baseline to the preview to include it)"}.`
      : "- Shared baseline: none in this workspace.",
    `- Keep workspace docs local: ${preview.docsNotices.length} docs entr${preview.docsNotices.length === 1 ? "y stays" : "ies stay"} workspace-relative and ${preview.docsNotices.length === 1 ? "is" : "are"} not copied into the pack.`,
    options.chat
      ? `- Not select ${preview.qualifiedName} for this session or make it the default; that is your separate choice afterward.`
      : `- Not select ${preview.qualifiedName} for this session or make it the default; you choose it yourself afterward with /persona team ${preview.qualifiedName}.`,
    "",
    "## Details",
    `Destination: ${preview.qualifiedName} (${preview.isNew ? "new" : "updates existing"})`,
    `Lead: ${preview.leadName}`,
    `Included personas: ${preview.approvedPersonas.join(", ")}`,
    `Excluded personas (left in the workspace, not copied): ${preview.excludedPersonas.join(", ") || "none"}`,
    `Baseline included: ${preview.includeBaseline ? "yes" : "no"}`,
    `Files added: ${preview.diff.added.length}, changed: ${preview.diff.changed.length}, removed: ${preview.diff.removed.length}`,
    `Source digest: ${preview.sourceDigest}`,
  ];
  if (preview.docsNotices.length > 0) {
    lines.push("", "## Semantic changes");
    for (const notice of preview.docsNotices) lines.push(`- ${notice}`);
  }
  return lines.join("\n");
}

// ---- internals ----

function markerPath(root) {
  return path.join(root, MIGRATION_DIRNAME, MARKER_FILENAME);
}

function receiptPath(root) {
  return path.join(root, MIGRATION_DIRNAME, RECEIPT_FILENAME);
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`${filePath} is corrupted: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function pathExists(candidate) {
  try {
    await stat(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function writeJsonAtomically(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

// Verbatim copy of the full legacy roster (not just the approved subset) so
// the private backup documents the complete original state at apply time,
// independent of which personas a maintainer chose to migrate. This is this
// module's own audit copy, never the workspace originals, so replacing it
// carries no data-loss risk for the workspace -- but a previous *good*
// backup (from an earlier, actually-completed apply) must survive a later
// attempt that fails, since it may be the only remaining copy of source
// content that has since changed or been reverted. So this writes into a
// fresh staging directory first; the caller only swaps it in (via
// commitMigrationBackup) once the store mutation it backs up has actually
// succeeded, exactly mirroring global-pack-store.js's own
// stage-then-swap replacePersonaPackDirectory pattern.
async function stageMigrationBackup(root) {
  const migrationDir = path.join(root, MIGRATION_DIRNAME);
  await mkdir(migrationDir, { recursive: true, mode: 0o700 });
  const stagingRoot = await mkdtemp(path.join(migrationDir, ".backup-stage-"));
  const project = await discoverPersonaProject(root);
  const legacyAgents = legacyRosterAgents(project);
  for (const agent of legacyAgents) {
    const destination = path.join(stagingRoot, agent.relativePath);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, await readFile(agent.filePath), { mode: 0o600 });
  }
  if (project.baseline) {
    const destination = path.join(stagingRoot, project.baseline.relativePath);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, await readFile(project.baseline.filePath), { mode: 0o600 });
  }
  return stagingRoot;
}

async function commitMigrationBackup(root, stagingRoot) {
  const backupRoot = path.join(root, MIGRATION_DIRNAME, BACKUP_DIRNAME);
  const displaced = `${backupRoot}.${process.pid}.tmp`;
  const hadExisting = await pathExists(backupRoot);
  if (hadExisting) await rename(backupRoot, displaced);
  try {
    await rename(stagingRoot, backupRoot);
  } catch (error) {
    if (hadExisting) await rename(displaced, backupRoot).catch(() => {});
    throw error;
  }
  if (hadExisting) await rm(displaced, { recursive: true, force: true });
}

async function discardMigrationBackupStaging(stagingRoot) {
  await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
}

async function writeReceiptAtomically(root, value) {
  await assertMigrationDirSafe(root);
  await writeJsonAtomically(receiptPath(root), value);
}

// Migration only ever creates custom/<name> destinations; requiring the
// exact "custom/<name>" shape (not just a loose split) and a name that
// passes the same isSafeAgentName check every real pack name must pass is
// the qualified-identity check a marker's destination must clear before any
// store path is resolved from it.
function parseCustomMigrationDestination(destination) {
  if (typeof destination !== "string") return null;
  const segments = destination.split("/");
  if (segments.length !== 2) return null;
  const [kind, name] = segments;
  if (kind !== "custom" || !isSafeAgentName(name)) return null;
  return name;
}

// Whether an already-fetched marker/receipt record attributes
// custom/<name> to this workspace's own migration -- a "pending",
// "completed", or "rolled-back" receipt counts (an in-flight or finished
// attempt by this same workspace; rollback keeps the pack, so this
// workspace may deliberately migrate into it again); a "failed" one does not, since applyCustomPersonaPackDraft's
// own rollback means a failed attempt never actually replaced the store
// content. Takes the record as a parameter (never reads it itself) so
// callers that must avoid reading back their own just-written pending
// receipt (see applyPersonaMigration) can pass one captured earlier.
function ownsMigrationDestination(record, name) {
  const destination = `custom/${name}`;
  return record?.marker?.destination === destination
    || (record?.receipt?.destination === destination && record.receipt.status !== "failed");
}

async function assertMigrationDirSafe(root) {
  await assertNoSymlinkEscape(root, MIGRATION_DIRNAME);
}

function manifestSafeFrontmatter(frontmatter) {
  return stringify(frontmatter, { lineWidth: 0 });
}

async function readAgentBody(root, relativePath) {
  const source = await readFile(path.join(root, relativePath), "utf8");
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return source.trim();
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) return source.trim();
  return lines.slice(end + 1).join("\n").trim();
}
