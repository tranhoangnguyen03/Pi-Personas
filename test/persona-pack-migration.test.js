import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { __withFsHookForTesting, cancelCustomPersonaPackDraft, listGlobalPersonaPacks } from "../src/persona/global-pack-store.js";
import {
  applyPersonaMigration,
  detectMigrationState,
  formatMigrationInspectionReport,
  formatMigrationPreviewReport,
  formatMigrationStatusReport,
  inspectLegacyMigration,
  invalidateMigrationMarker,
  previewPersonaMigration,
  readMigrationRecord,
  recordMigrationRollback,
} from "../src/persona/pack-migration.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASIC_FIXTURE = path.join(HERE, "fixtures", "legacy-persona", "basic");

async function tempDir(t, prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeText(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

// The fixture keeps its agent files under a plain agents/ directory (not
// .pi/agents/) so it can be a normal checked-in file: .pi/ is globally
// gitignored in this repo. Copy it into the real .pi/agents/ layout that
// discoverPersonaProject expects only inside a disposable test workspace.
async function basicWorkspace(t) {
  const root = await tempDir(t, "pi-persona-migration-ws-");
  await cp(path.join(BASIC_FIXTURE, "agents"), path.join(root, ".pi/agents"), { recursive: true });
  await cp(path.join(BASIC_FIXTURE, "library"), path.join(root, "library"), { recursive: true });
  return root;
}

test("inspectLegacyMigration: an ordinary .pi/agents directory with no generalist is not recognized", async (t) => {
  const root = await tempDir(t, "pi-persona-migration-unrelated-");
  await writeText(
    path.join(root, ".pi/agents/helper.md"),
    "---\nname: helper\nrole: specialist\ndescription: Just a specialist, no coordinator.\n---\nHelper prompt.\n",
  );
  const inspection = await inspectLegacyMigration(root);
  assert.equal(inspection.recognized, false);
  assert.match(inspection.reason, /no top-level generalist/);
});

test("inspectLegacyMigration: an empty workspace is not recognized", async (t) => {
  const root = await tempDir(t, "pi-persona-migration-empty-");
  const inspection = await inspectLegacyMigration(root);
  assert.equal(inspection.recognized, false);
});

test("inspectLegacyMigration: recognizes a genuine legacy setup and reports inventory/hashes/decisions", async (t) => {
  const root = await basicWorkspace(t);
  const inspection = await inspectLegacyMigration(root);
  assert.equal(inspection.recognized, true);
  assert.equal(inspection.supported, true);
  assert.deepEqual(inspection.decisionsNeeded, []);
  assert.equal(inspection.leads.length, 1);
  assert.equal(inspection.leads[0].name, "coordinator");
  assert.equal(inspection.baseline.relativePath, ".pi/agents/_baseline.md");
  assert.match(inspection.baseline.hash, /^sha256:/);
  const names = inspection.personas.map((persona) => persona.name).sort();
  assert.deepEqual(names, ["coordinator", "writer"]);
  for (const persona of inspection.personas) {
    assert.match(persona.hash, /^sha256:/);
  }
  assert.match(inspection.sourceDigest, /^sha256:/);
  assert.deepEqual(inspection.installedPacks, []);

  const report = formatMigrationInspectionReport(inspection);
  assert.match(report, /Supported: yes/);
});

test("inspectLegacyMigration: unsupported multiple-lead shape is reported as a decision, not silently resolved", async (t) => {
  const root = await tempDir(t, "pi-persona-migration-multi-lead-");
  await writeText(
    path.join(root, ".pi/agents/lead-a.md"),
    "---\nname: lead-a\nrole: generalist\ndescription: First candidate lead.\n---\nLead A prompt.\n",
  );
  await writeText(
    path.join(root, ".pi/agents/lead-b.md"),
    "---\nname: lead-b\nrole: generalist\ndescription: Second candidate lead.\n---\nLead B prompt.\n",
  );
  await writeText(
    path.join(root, ".pi/agents/helper.md"),
    "---\nname: helper\nrole: specialist\ndescription: A specialist.\n---\nHelper prompt.\n",
  );

  const inspection = await inspectLegacyMigration(root);
  assert.equal(inspection.recognized, true);
  assert.equal(inspection.supported, false);
  assert.equal(inspection.decisionsNeeded.length, 1);
  assert.match(inspection.decisionsNeeded[0], /multiple primary generalist|exactly one primary generalist/);
  assert.equal(inspection.leads.length, 2);

  // Preview still works if the maintainer explicitly names which lead to use.
  const storeRoot = await tempDir(t, "pi-persona-migration-multi-lead-store-");
  const preview = await previewPersonaMigration(root, storeRoot, {
    destinationName: "multi-lead-team",
    leadName: "lead-a",
    approvedPersonas: ["helper"],
  });
  assert.equal(preview.leadName, "lead-a");
  assert.deepEqual(preview.approvedPersonas.sort(), ["helper", "lead-a"]);

  // Without an explicit lead, preview refuses instead of silently picking one.
  await assert.rejects(
    () => previewPersonaMigration(root, storeRoot, { destinationName: "multi-lead-team-2", approvedPersonas: ["helper"] }),
    /candidate lead/,
  );
});

test("inspectLegacyMigration: unknown declared tools are reported as decisions and block migration until fixed", async (t) => {
  const root = await tempDir(t, "pi-persona-migration-unknown-tool-");
  await writeText(
    path.join(root, ".pi/agents/lead.md"),
    "---\nname: lead\nrole: generalist\ndescription: Lead.\n---\nLead prompt.\n",
  );
  await writeText(
    path.join(root, ".pi/agents/helper.md"),
    "---\nname: helper\nrole: specialist\ndescription: A specialist.\ntools:\n  - not-a-real-tool\n---\nHelper prompt.\n",
  );

  const inspection = await inspectLegacyMigration(root);
  const helper = inspection.personas.find((persona) => persona.name === "helper");
  assert.deepEqual(helper.unknownTools, ["not-a-real-tool"]);
  assert.ok(inspection.decisionsNeeded.some((decision) => decision.includes("not-a-real-tool")));

  const storeRoot = await tempDir(t, "pi-persona-migration-unknown-tool-store-");
  await assert.rejects(
    () => previewPersonaMigration(root, storeRoot, { destinationName: "team", leadName: "lead", approvedPersonas: ["helper"] }),
    /unknown declared tools/,
  );
});

test("previewPersonaMigration -> applyPersonaMigration: copy-only, originals unchanged, destination created, excluded personas reported", async (t) => {
  const root = await basicWorkspace(t);
  const storeRoot = await tempDir(t, "pi-persona-migration-store-");

  const originalCoordinator = await readFile(path.join(root, ".pi/agents/coordinator.md"));
  const originalWriter = await readFile(path.join(root, ".pi/agents/writer.md"));
  const originalBaseline = await readFile(path.join(root, ".pi/agents/_baseline.md"));

  const preview = await previewPersonaMigration(root, storeRoot, {
    destinationName: "legacy-team",
    approvedPersonas: ["writer"],
    includeBaseline: true,
  });
  assert.equal(preview.qualifiedName, "custom/legacy-team");
  assert.equal(preview.isNew, true);
  assert.equal(preview.leadName, "coordinator");
  assert.deepEqual(preview.approvedPersonas.sort(), ["coordinator", "writer"]);
  assert.deepEqual(preview.excludedPersonas, []);
  assert.equal(preview.includeBaseline, true);
  assert.ok(preview.docsNotices.some((notice) => notice.includes("library/shared/")));
  assert.ok(preview.diff.added.includes("agents/coordinator.md"));
  assert.ok(preview.diff.added.includes("agents/writer.md"));
  assert.ok(preview.diff.added.includes("agents/_baseline.md"));

  const report = formatMigrationPreviewReport(preview);
  assert.match(report, /Destination: custom\/legacy-team/);

  // Originals must be byte-identical after a preview (stage only touches the
  // global store's own drafts/ directory).
  assert.deepEqual(await readFile(path.join(root, ".pi/agents/coordinator.md")), originalCoordinator);
  assert.deepEqual(await readFile(path.join(root, ".pi/agents/writer.md")), originalWriter);
  assert.deepEqual(await readFile(path.join(root, ".pi/agents/_baseline.md")), originalBaseline);

  const inspection = await inspectLegacyMigration(root);
  const result = await applyPersonaMigration(root, storeRoot, "legacy-team", {
    expectedSourceDigest: inspection.sourceDigest,
    previousBinding: { status: "none" },
  });
  assert.equal(result.qualifiedName, "custom/legacy-team");

  // Still copy-only: applying never touches the workspace originals.
  assert.deepEqual(await readFile(path.join(root, ".pi/agents/coordinator.md")), originalCoordinator);
  assert.deepEqual(await readFile(path.join(root, ".pi/agents/writer.md")), originalWriter);
  assert.deepEqual(await readFile(path.join(root, ".pi/agents/_baseline.md")), originalBaseline);

  const { custom } = await listGlobalPersonaPacks(storeRoot);
  assert.ok(custom.some((pack) => pack.qualifiedName === "custom/legacy-team"));

  // Durable private backup/receipt exist and reflect what was migrated.
  const receipt = JSON.parse(await readFile(result.receiptPath, "utf8"));
  assert.equal(receipt.destination, "custom/legacy-team");
  assert.equal(receipt.sourceDigest, inspection.sourceDigest);
  assert.deepEqual(receipt.previousBinding, { status: "none" });
  assert.equal(typeof receipt.migratedWithPackageVersion, "string");
  const backedUpCoordinator = await readFile(path.join(result.backupPath, ".pi/agents/coordinator.md"));
  assert.deepEqual(backedUpCoordinator, originalCoordinator);

  const marker = JSON.parse(await readFile(result.markerPath, "utf8"));
  assert.equal(marker.destination, "custom/legacy-team");
  assert.equal(marker.sourceDigest, inspection.sourceDigest);
});

test("previewPersonaMigration excludes unapproved personas by default; only approved content leaves the workspace", async (t) => {
  const root = await tempDir(t, "pi-persona-migration-mixed-");
  await writeText(
    path.join(root, ".pi/agents/lead.md"),
    "---\nname: lead\nrole: generalist\ndescription: Lead.\n---\nLead prompt.\n",
  );
  await writeText(
    path.join(root, ".pi/agents/reviewed.md"),
    "---\nname: reviewed\nrole: specialist\ndescription: Already reviewed and safe to share.\n---\nReviewed prompt.\n",
  );
  await writeText(
    path.join(root, ".pi/agents/private-notes.md"),
    "---\nname: private-notes\nrole: specialist\ndescription: Contains private client facts.\n---\nSynthetic private-looking body text.\n",
  );
  const storeRoot = await tempDir(t, "pi-persona-migration-mixed-store-");

  const preview = await previewPersonaMigration(root, storeRoot, {
    destinationName: "reviewed-team",
    approvedPersonas: ["reviewed"],
  });
  assert.deepEqual(preview.approvedPersonas.sort(), ["lead", "reviewed"]);
  assert.deepEqual(preview.excludedPersonas, ["private-notes"]);
  assert.ok(!preview.diff.added.some((entry) => entry.includes("private-notes")));
});

test("destination collision: an unrelated existing custom pack with the same name blocks migration", async (t) => {
  const root = await basicWorkspace(t);
  const storeRoot = await tempDir(t, "pi-persona-migration-collision-store-");
  await writeText(path.join(storeRoot, "custom/taken/pack.yaml"), [
    "schema: 2",
    "name: taken",
    "version: 1.0.0",
    "description: Unrelated pre-existing custom pack.",
  ].join("\n") + "\n");
  await writeText(path.join(storeRoot, "custom/taken/agents/lead.md"), "---\nname: lead\nrole: generalist\ndescription: Unrelated lead.\n---\nBody.\n");
  await writeText(path.join(storeRoot, "custom/taken/agents/helper.md"), "---\nname: helper\nrole: specialist\ndescription: Unrelated helper.\n---\nBody.\n");
  await mkdir(path.join(storeRoot, "custom/taken/references"), { recursive: true });

  await assert.rejects(
    () => previewPersonaMigration(root, storeRoot, { destinationName: "taken", approvedPersonas: ["writer"] }),
    /already exists and is not this workspace's own migration destination/,
  );
});

test("cancel: a staged migration draft can be discarded without creating a destination pack", async (t) => {
  const root = await basicWorkspace(t);
  const storeRoot = await tempDir(t, "pi-persona-migration-cancel-store-");
  await previewPersonaMigration(root, storeRoot, { destinationName: "legacy-team", approvedPersonas: ["writer"] });
  await cancelCustomPersonaPackDraft(storeRoot, "legacy-team");
  const { custom } = await listGlobalPersonaPacks(storeRoot);
  assert.deepEqual(custom, []);
});

test("repeat operation is safe: previewing/applying twice with unchanged originals does not duplicate or corrupt the destination", async (t) => {
  const root = await basicWorkspace(t);
  const storeRoot = await tempDir(t, "pi-persona-migration-repeat-store-");

  const inspection = await inspectLegacyMigration(root);
  await previewPersonaMigration(root, storeRoot, { destinationName: "legacy-team", approvedPersonas: ["writer"] });
  const first = await applyPersonaMigration(root, storeRoot, "legacy-team", { expectedSourceDigest: inspection.sourceDigest });

  // Re-running the same migration for the same workspace/destination (an
  // explicit maintainer action, e.g. after reviewing more content) is
  // allowed because the local marker already attributes 'custom/legacy-team'
  // to this workspace -- it is not an unrelated-pack overwrite.
  await previewPersonaMigration(root, storeRoot, { destinationName: "legacy-team", approvedPersonas: ["writer"] });
  const second = await applyPersonaMigration(root, storeRoot, "legacy-team", { expectedSourceDigest: inspection.sourceDigest });
  assert.equal(second.qualifiedName, first.qualifiedName);

  const state = await detectMigrationState(root, storeRoot);
  assert.equal(state.state, "migrated");
});

test("detectMigrationState: migration-required, then migrated, then changed-source, then destination-missing", async (t) => {
  const root = await basicWorkspace(t);
  const storeRoot = await tempDir(t, "pi-persona-migration-state-store-");

  let state = await detectMigrationState(root, storeRoot);
  assert.equal(state.state, "migration-required");
  assert.match(formatMigrationStatusReport(state), /migration-required/);

  const inspection = await inspectLegacyMigration(root);
  await previewPersonaMigration(root, storeRoot, { destinationName: "legacy-team", approvedPersonas: ["writer"] });
  await applyPersonaMigration(root, storeRoot, "legacy-team", { expectedSourceDigest: inspection.sourceDigest });

  state = await detectMigrationState(root, storeRoot);
  assert.equal(state.state, "migrated");

  // The original source changes after migration: the earlier migration is
  // left in place, but the workspace is not silently treated as "done".
  await writeText(
    path.join(root, ".pi/agents/writer.md"),
    "---\nname: writer\nrole: specialist\ndescription: Synthetic legacy specialist; drafts customer-facing copy (edited).\ntools:\n  - read\ndocs:\n  - library/personal/writer/\n---\nEdited body.\n",
  );
  state = await detectMigrationState(root, storeRoot);
  assert.equal(state.state, "changed-source");
  assert.match(formatMigrationStatusReport(state), /changed since/);

  // Restore the source and instead remove the destination pack to exercise
  // destination-missing recovery instead of silently trusting a stale marker.
  await writeText(
    path.join(root, ".pi/agents/writer.md"),
    "---\nname: writer\nrole: specialist\ndescription: Synthetic legacy specialist; drafts customer-facing copy.\ntools:\n  - read\ndocs:\n  - library/personal/writer/\n---\nYou are the writer for this synthetic legacy fixture project. Produce clear, concise customer-facing copy.\n",
  );
  await rm(path.join(storeRoot, "custom", "legacy-team"), { recursive: true, force: true });
  state = await detectMigrationState(root, storeRoot);
  assert.equal(state.state, "destination-missing");
  assert.match(formatMigrationStatusReport(state), /no longer installed/);
});

test("applyPersonaMigration refuses when the source changed since the digest it was told to expect", async (t) => {
  const root = await basicWorkspace(t);
  const storeRoot = await tempDir(t, "pi-persona-migration-freshness-store-");
  await previewPersonaMigration(root, storeRoot, { destinationName: "legacy-team", approvedPersonas: ["writer"] });
  await assert.rejects(
    () => applyPersonaMigration(root, storeRoot, "legacy-team", { expectedSourceDigest: "sha256:stale" }),
    /source changed since/,
  );
});

test("readMigrationRecord: rollback data (previousBinding) survives in the receipt for explicit, non-destructive recovery", async (t) => {
  const root = await basicWorkspace(t);
  const storeRoot = await tempDir(t, "pi-persona-migration-rollback-store-");
  await previewPersonaMigration(root, storeRoot, { destinationName: "legacy-team", approvedPersonas: ["writer"] });
  await applyPersonaMigration(root, storeRoot, "legacy-team", {
    previousBinding: { status: "pack", qualifiedName: "custom/other-team" },
  });

  const record = await readMigrationRecord(root);
  assert.equal(record.receipt.previousBinding.qualifiedName, "custom/other-team");
  assert.equal(record.marker.destination, "custom/legacy-team");
  assert.equal(record.receipt.status, "completed");
  assert.equal(typeof record.receipt.attemptId, "string");

  // Original workspace files remain exactly as authored; migration never
  // deletes or rewrites them, so there is nothing to "restore" on disk --
  // only a session's team selection is ever rolled back (exercised at the
  // extension layer, not here).
  const coordinator = await readFile(path.join(root, ".pi/agents/coordinator.md"), "utf8");
  assert.match(coordinator, /Delegate work to the right specialist/);
});

test("invalidateMigrationMarker: rollback's real contract -- clears the completion marker (so a later check is 'migration-required' again), leaves the receipt and the destination pack untouched", async (t) => {
  const root = await basicWorkspace(t);
  const storeRoot = await tempDir(t, "pi-persona-migration-invalidate-store-");
  await previewPersonaMigration(root, storeRoot, { destinationName: "legacy-team", approvedPersonas: ["writer"] });
  await applyPersonaMigration(root, storeRoot, "legacy-team");

  let state = await detectMigrationState(root, storeRoot);
  assert.equal(state.state, "migrated");

  await invalidateMigrationMarker(root);

  state = await detectMigrationState(root, storeRoot);
  assert.equal(state.state, "migration-required");
  // A leftover completed receipt keeps this actionable rather than looking
  // like nothing was ever attempted.
  assert.equal(state.receipt.status, "completed");
  assert.equal(state.receipt.destination, "custom/legacy-team");

  // The receipt itself, an immutable attempt record, is untouched.
  const record = await readMigrationRecord(root);
  assert.equal(record.receipt.status, "completed");
  assert.equal(record.marker, null);

  // The destination pack and the workspace's own files are both untouched.
  const { custom } = await listGlobalPersonaPacks(storeRoot);
  assert.ok(custom.some((pack) => pack.qualifiedName === "custom/legacy-team"));
  await invalidateMigrationMarker(root); // idempotent
});

test("recordMigrationRollback records a deliberate rollback truthfully, distinct from a genuinely failed marker write", async (t) => {
  const root = await basicWorkspace(t);
  const storeRoot = await tempDir(t, "pi-persona-migration-rollback-record-store-");
  await previewPersonaMigration(root, storeRoot, { destinationName: "legacy-team", approvedPersonas: ["writer"] });
  await applyPersonaMigration(root, storeRoot, "legacy-team", { previousBinding: { status: "migration-required" } });
  const completed = (await readMigrationRecord(root)).receipt;

  // A genuinely failed marker write (completed receipt, no marker) still
  // gets the actionable repair advice.
  await invalidateMigrationMarker(root);
  let state = await detectMigrationState(root, storeRoot);
  assert.match(formatMigrationStatusReport(state), /likely failed to write[\s\S]*migrate apply legacy-team again to repair/);

  // A deliberate rollback is recorded as such and never advises re-applying
  // as a "repair" of the user's own decision.
  await writeText(path.join(root, ".pi/persona-migration/marker.json"), JSON.stringify({ schema: 1, sourceDigest: completed.sourceDigest, destination: "custom/legacy-team", completedAt: completed.completedAt }));
  await recordMigrationRollback(root);
  const record = await readMigrationRecord(root);
  assert.equal(record.marker, null);
  assert.equal(record.receipt.status, "rolled-back");
  assert.equal(typeof record.receipt.rolledBackAt, "string");
  // Audit trail of the completed attempt is kept.
  assert.equal(record.receipt.attemptId, completed.attemptId);
  assert.equal(record.receipt.completedAt, completed.completedAt);
  assert.deepEqual(record.receipt.previousBinding, { status: "migration-required" });

  state = await detectMigrationState(root, storeRoot);
  assert.equal(state.state, "migration-required");
  const report = formatMigrationStatusReport(state);
  assert.match(report, /was rolled back at your request/);
  assert.match(report, /requires migration again/);
  assert.doesNotMatch(report, /repair|failed to write/);

  // Idempotent; the destination pack and the private backup are kept.
  await recordMigrationRollback(root);
  assert.equal((await readMigrationRecord(root)).receipt.rolledBackAt, record.receipt.rolledBackAt);
  const { custom } = await listGlobalPersonaPacks(storeRoot);
  assert.ok(custom.some((pack) => pack.qualifiedName === "custom/legacy-team"));
  await readFile(path.join(root, ".pi/persona-migration/backup/.pi/agents/coordinator.md"));

  // The workspace may deliberately migrate into its kept pack again.
  await previewPersonaMigration(root, storeRoot, { destinationName: "legacy-team", approvedPersonas: ["writer"] });
  await applyPersonaMigration(root, storeRoot, "legacy-team");
  assert.equal((await detectMigrationState(root, storeRoot)).state, "migrated");
});

test("migration inspect/preview/status reports lead with the plain-language consequences; digests and file counts are secondary", async (t) => {
  const root = await basicWorkspace(t);
  const storeRoot = await tempDir(t, "pi-persona-migration-copy-store-");

  const inspectReport = formatMigrationInspectionReport(await inspectLegacyMigration(root));
  const inspectExplanation = inspectReport.indexOf("## What migration would do");
  assert.ok(inspectExplanation > 0 && inspectExplanation < inspectReport.indexOf("## Details"));
  assert.ok(inspectReport.indexOf("## Details") < inspectReport.indexOf("Source digest:"));
  assert.match(inspectReport, /from \.pi\/agents into a new global custom pack, custom\/<name>/);
  assert.match(inspectReport, /never changes or deletes them/);
  assert.match(inspectReport, /workspace docs local/);
  assert.match(inspectReport, /shared baseline \.pi\/agents\/_baseline\.md \(--baseline; left out unless you choose it\)/);
  assert.match(inspectReport, /Not select the new pack for any session or make it the default/);

  const preview = await previewPersonaMigration(root, storeRoot, { destinationName: "legacy-team", approvedPersonas: ["writer"] });
  const previewReport = formatMigrationPreviewReport(preview);
  assert.ok(previewReport.indexOf("## What apply will do") < previewReport.indexOf("## Details"));
  assert.ok(previewReport.indexOf("## Details") < previewReport.indexOf("Files added:"));
  assert.match(previewReport, /Copy lead coordinator and specialist\(s\) writer into the global custom pack custom\/legacy-team \(a new pack\)/);
  assert.match(previewReport, /Leave every original file in \.pi\/agents unchanged/);
  assert.match(previewReport, /Shared baseline \.pi\/agents\/_baseline\.md: not included/);
  assert.match(previewReport, /Keep workspace docs local/);
  assert.match(previewReport, /Not select custom\/legacy-team for this session or make it the default/);

  await applyPersonaMigration(root, storeRoot, "legacy-team");
  const migratedReport = formatMigrationStatusReport(await detectMigrationState(root, storeRoot));
  assert.doesNotMatch(migratedReport, /no longer gated/);
  assert.match(migratedReport, /no longer used as a team/);
  assert.match(migratedReport, /not selected or made default automatically/);
});

test("a corrupted marker surfaces as an actionable error, never as a silent 'nothing recorded' or a silently authorized overwrite", async (t) => {
  const root = await basicWorkspace(t);
  const storeRoot = await tempDir(t, "pi-persona-migration-corrupt-marker-store-");
  await previewPersonaMigration(root, storeRoot, { destinationName: "legacy-team", approvedPersonas: ["writer"] });
  await applyPersonaMigration(root, storeRoot, "legacy-team");

  await writeText(path.join(root, ".pi/persona-migration/marker.json"), "{ not valid json");

  await assert.rejects(() => detectMigrationState(root, storeRoot), /marker\.json is corrupted/);
  await assert.rejects(() => readMigrationRecord(root), /marker\.json is corrupted/);
  // Re-previewing the same, already-owned destination must fail loudly
  // (cannot determine ownership) rather than silently treating the corrupt
  // marker as "no record" and refusing as an unrelated-pack collision, or
  // silently treating it as "owned" and proceeding.
  await assert.rejects(
    () => previewPersonaMigration(root, storeRoot, { destinationName: "legacy-team", approvedPersonas: ["writer"] }),
    /marker\.json is corrupted/,
  );
  await assert.rejects(
    () => applyPersonaMigration(root, storeRoot, "legacy-team"),
    /marker\.json is corrupted/,
  );
});

test("a failed apply preserves the previous good backup untouched, leaves the marker pointing at the last real success, and records the receipt as failed rather than a false success", async (t) => {
  const root = await basicWorkspace(t);
  const storeRoot = await tempDir(t, "pi-persona-migration-failed-apply-store-");

  const originalWriter = await readFile(path.join(root, ".pi/agents/writer.md"), "utf8");
  const firstInspection = await inspectLegacyMigration(root);
  await previewPersonaMigration(root, storeRoot, { destinationName: "legacy-team", approvedPersonas: ["writer"] });
  const first = await applyPersonaMigration(root, storeRoot, "legacy-team", { expectedSourceDigest: firstInspection.sourceDigest });
  assert.equal(await readFile(path.join(first.backupPath, ".pi/agents/writer.md"), "utf8"), originalWriter);

  // Change the source so a second, genuine re-migration attempt makes sense.
  await writeText(
    path.join(root, ".pi/agents/writer.md"),
    "---\nname: writer\nrole: specialist\ndescription: Synthetic legacy specialist; drafts customer-facing copy (edited for retry test).\ntools:\n  - read\ndocs:\n  - library/personal/writer/\n---\nEdited body for retry test.\n",
  );
  await previewPersonaMigration(root, storeRoot, { destinationName: "legacy-team", approvedPersonas: ["writer"] });
  const secondInspection = await inspectLegacyMigration(root);

  await assert.rejects(
    () => __withFsHookForTesting(
      { rename: async () => { throw new Error("simulated store failure"); } },
      () => applyPersonaMigration(root, storeRoot, "legacy-team", { expectedSourceDigest: secondInspection.sourceDigest }),
    ),
    /simulated store failure/,
  );

  // The previous good backup (from the first, successful attempt) must
  // survive a later failed attempt untouched -- never wiped just because a
  // later attempt started.
  assert.equal(await readFile(path.join(first.backupPath, ".pi/agents/writer.md"), "utf8"), originalWriter);

  // The marker still reflects the first, successful migration; the failed
  // second attempt never earned a new one.
  const marker = JSON.parse(await readFile(first.markerPath, "utf8"));
  assert.equal(marker.sourceDigest, firstInspection.sourceDigest);

  // The receipt is a truthful record of the failed attempt, not a claimed
  // success.
  const receipt = JSON.parse(await readFile(first.receiptPath, "utf8"));
  assert.equal(receipt.status, "failed");
  assert.match(receipt.error, /simulated store failure/);
  assert.equal(receipt.sourceDigest, secondInspection.sourceDigest);

  // Not silently "migrated" against stale content either: the marker's
  // digest no longer matches the (now edited) source.
  const state = await detectMigrationState(root, storeRoot);
  assert.equal(state.state, "changed-source");
});

test("apply refuses a destination pack that was edited after it was previewed, instead of silently overwriting the edit (reusing a valid marker is not, by itself, authorization)", async (t) => {
  const root = await basicWorkspace(t);
  const storeRoot = await tempDir(t, "pi-persona-migration-freshness2-store-");

  await previewPersonaMigration(root, storeRoot, { destinationName: "legacy-team", approvedPersonas: ["writer"] });
  await applyPersonaMigration(root, storeRoot, "legacy-team");

  const preview = await previewPersonaMigration(root, storeRoot, { destinationName: "legacy-team", approvedPersonas: ["writer"] });
  assert.equal(preview.isNew, false);
  assert.match(preview.activeIntegrity, /^sha256:/);

  // Someone else edits the destination pack directly (not through this
  // workspace's own migration) between preview and apply.
  const editedAgentPath = path.join(storeRoot, "custom/legacy-team/agents/writer.md");
  const beforeEdit = await readFile(editedAgentPath, "utf8");
  const editedContent = `${beforeEdit}\n\nEdited by someone else after preview.\n`;
  await writeFile(editedAgentPath, editedContent, "utf8");

  await assert.rejects(
    () => applyPersonaMigration(root, storeRoot, "legacy-team", { expectedActiveIntegrity: preview.activeIntegrity }),
    /changed since it was last previewed/,
  );

  // The edit survives the refused apply.
  assert.equal(await readFile(editedAgentPath, "utf8"), editedContent);
});

test("apply's own collision guard refuses to overwrite a destination an unrelated workspace's own migration owns, closing the narrow preview/apply race the front-door preview check cannot", async (t) => {
  const rootA = await basicWorkspace(t);
  const storeRoot = await tempDir(t, "pi-persona-migration-race-store-");
  await previewPersonaMigration(rootA, storeRoot, { destinationName: "race-team", approvedPersonas: ["writer"] });
  await applyPersonaMigration(rootA, storeRoot, "race-team");

  // Simulate a draft staged by an unrelated workspace before A's apply
  // landed: previewPersonaMigration's own front-door collision check would
  // already have refused this workspace's *preview* once custom/race-team
  // existed, so this writes the draft directly to exercise the apply path's
  // own inside-the-lock guard -- the one window that front-door check alone
  // cannot close.
  const draftDir = path.join(storeRoot, "drafts", "race-team");
  await writeText(path.join(draftDir, "pack.yaml"), "schema: 2\nname: race-team\nversion: 1.0.0\ndescription: Unrelated draft staged by another workspace.\n");
  await writeText(path.join(draftDir, "references", "README.md"), "placeholder\n");
  await writeText(path.join(draftDir, "agents", "lead.md"), "---\nname: lead\nrole: generalist\ndescription: Unrelated lead.\n---\nBody.\n");
  await writeText(path.join(draftDir, "agents", "helper.md"), "---\nname: helper\nrole: specialist\ndescription: Unrelated helper.\n---\nBody.\n");

  const rootB = await tempDir(t, "pi-persona-migration-race-ws-b-");
  await writeText(path.join(rootB, ".pi/agents/lead-b.md"), "---\nname: lead-b\nrole: generalist\ndescription: B's own lead.\n---\nBody.\n");
  await writeText(path.join(rootB, ".pi/agents/helper-b.md"), "---\nname: helper-b\nrole: specialist\ndescription: B's own helper.\n---\nBody.\n");

  await assert.rejects(
    () => applyPersonaMigration(rootB, storeRoot, "race-team"),
    /already exists in the global persona pack store and is not recorded as this workspace's own migration destination/,
  );

  // A's content is untouched by B's refused attempt.
  const { custom } = await listGlobalPersonaPacks(storeRoot);
  const raceTeam = custom.find((pack) => pack.qualifiedName === "custom/race-team");
  assert.ok(raceTeam.personas.some((persona) => persona.name === "writer"));
  assert.ok(!raceTeam.personas.some((persona) => persona.name === "lead"));
});
