/**
 * Bounded, private, runtime-owned copies of a selected persona pack, plus the
 * pure global-default and session-binding-entry logic the session-binding
 * controller (extensions/pi-persona.ts) uses to decide when to load, rebind,
 * or dispose one.
 *
 * `loadPackSession` reads one installed pack from the global store
 * (official/<name> or custom/<name>), copies its content once into a
 * private, owner-only directory this runtime does not share with the store
 * or with any other loaded session, and hands back a narrow handle the
 * binding controller resolves scopes and passes resolved teams from.
 * Mutating or deleting the installed pack afterward cannot affect an
 * already-loaded session: its snapshot is an independent copy, not a
 * reference into the store.
 *
 * This module owns copy-in, bounds, permissions, and disposal, plus reading
 * and writing the store-wide default (readGlobalDefaultPack/
 * writeGlobalDefaultPack) and interpreting a session's own binding entries
 * (inspectTeamEntries). It does not itself call pi.appendEntry(),
 * ctx.sessionManager.getBranch(), or ctx.reload() -- those Pi host calls, and
 * deciding when a session should be (re)bound relative to a live chat
 * session, belong to the binding controller. `dispose()` here only refuses
 * to run while native children are still using the snapshot; it does not
 * itself track chat-session lifetime.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { discoverPersonaProject } from "./agents.js";
import { assertNoSymlinkEscape, withStoreMutationLock } from "./global-pack-store.js";
import { estimatePortablePersonaPackSize, readPortablePersonaPack } from "./pack-source.js";
import { isSafeAgentName } from "./schema.js";

const KINDS = ["official", "custom"];
const RUNTIME_SESSIONS_DIRNAME = ".runtime-sessions";
const MAX_SNAPSHOT_BYTES = 50 * 1024 * 1024;
const MAX_SNAPSHOT_FILES = 2000;
const PACK_AGENT_DIR = "agents";
const SELECTION_FILENAME = "selection.json";

// Session custom-entry types the extension boundary (Task 5) reads/writes
// through pi.appendEntry()/ctx.sessionManager.getBranch(); see
// inspectTeamEntries below for why there are two, not one.
export const TEAM_BINDING_ENTRY_TYPE = "pi-persona-team";
export const TEAM_PENDING_ENTRY_TYPE = "pi-persona-team-pending";

// Injectable seam over the couple of fs operations disposal/cleanup need to
// fail deterministically in tests (a stuck removal that must be retryable, a
// partial write that must clean itself up). Restored in `finally`, same
// pattern as global-pack-store.js's __withFsHookForTesting.
const defaultFsHooks = { writeFile, rm };
const activeFsHooks = { ...defaultFsHooks };

export async function __withFsHookForTesting(overrides, run) {
  const previous = { ...activeFsHooks };
  Object.assign(activeFsHooks, overrides);
  try {
    return await run();
  } finally {
    Object.assign(activeFsHooks, previous);
  }
}

export async function loadPackSession(storeRoot, qualifiedName) {
  const { kind, name } = parseQualifiedPackName(qualifiedName);
  await assertNoSymlinkEscape(storeRoot, path.join(kind, name));
  const installedDir = path.join(storeRoot, kind, name);

  // Enforce the private-snapshot bounds against a stat-only prewalk, before
  // any file content is read into memory: an oversized or overcrowded
  // installed pack is rejected here, not after readPortablePersonaPack has
  // already buffered its content.
  const estimate = await estimatePortablePersonaPackSize(installedDir);
  assertWithinSnapshotBounds(qualifiedName, estimate.files, estimate.bytes);

  const source = await readPortablePersonaPack(installedDir, { type: "installed", ref: qualifiedName });
  if (source.manifest.name !== name) {
    throw new Error(
      `persona pack '${qualifiedName}' has a corrupted store entry: its manifest declares name '${source.manifest.name}', not '${name}'`,
    );
  }
  const files = await collectSnapshotFiles(source);

  await assertNoSymlinkEscape(storeRoot, RUNTIME_SESSIONS_DIRNAME);
  const sessionId = randomUUID();
  const root = path.join(storeRoot, RUNTIME_SESSIONS_DIRNAME, sessionId);
  const ownerMetaPath = path.join(storeRoot, RUNTIME_SESSIONS_DIRNAME, `${sessionId}.owner.json`);

  let project;
  try {
    await writeSnapshot(root, files);
    await writeOwnerMetadata(ownerMetaPath, { qualifiedName, revision: source.integrity });
    project = await discoverPersonaProject(root, PACK_AGENT_DIR);
  } catch (error) {
    await activeFsHooks.rm(root, { recursive: true, force: true }).catch(() => {});
    await activeFsHooks.rm(ownerMetaPath, { force: true }).catch(() => {});
    throw error;
  }

  return createPackSession({
    qualifiedName,
    manifest: source.manifest,
    revision: source.integrity,
    root,
    ownerMetaPath,
    project,
  });
}

// Global default pack: a store-wide record independent of any individual
// session's remembered team (inspectTeamEntries below). Distinguishes
// "missing" (this store has never had a default configured -- `null`
// return) from an explicit `{ defaultPack: null }` record (the user
// deliberately cleared a previously configured default): design draft §3,
// "Null means no default; missing means unconfigured."
export async function readGlobalDefaultPack(storeRoot) {
  let raw;
  try {
    raw = await readFile(path.join(storeRoot, SELECTION_FILENAME), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`persona pack store's ${SELECTION_FILENAME} is corrupted (invalid JSON)`);
  }
  if (parsed?.schema !== 1 || !("defaultPack" in parsed)) {
    throw new Error(`persona pack store's ${SELECTION_FILENAME} has an unrecognized shape`);
  }
  if (parsed.defaultPack !== null) parseQualifiedPackName(parsed.defaultPack);
  return { schema: 1, defaultPack: parsed.defaultPack };
}

// Changing the default is a separate, explicit action from binding any
// particular session's team (design draft §3: "Changing the global default
// is a separate explicit action" / "Change default | Affect future new
// sessions only"). Validates the target is actually installed so the default
// can never point at a pack that was never there; does not itself snapshot
// or bind anything. Shares the store's own mutation lock (global-pack-
// store.js) with every pack install/update/removal, so a default write can
// never interleave with a concurrent pack mutation that would make it stale
// the instant it lands.
export async function writeGlobalDefaultPack(storeRoot, qualifiedNameOrNull) {
  return withStoreMutationLock(storeRoot, () => writeGlobalDefaultPackWithinStoreLock(storeRoot, qualifiedNameOrNull));
}

// For callers that already hold the store's mutation lock (pack-lifecycle.js
// clearing a matching default atomically with a pack removal, inside that
// removal's own afterRemove hook): calling writeGlobalDefaultPack itself
// there would deadlock, since the lock is not reentrant.
export async function writeGlobalDefaultPackWithinStoreLock(storeRoot, qualifiedNameOrNull) {
  if (qualifiedNameOrNull !== null) {
    const { kind, name } = parseQualifiedPackName(qualifiedNameOrNull);
    if (!await pathExists(path.join(storeRoot, kind, name))) {
      throw new Error(`persona pack '${qualifiedNameOrNull}' is not installed; install it before setting it as the default`);
    }
  }
  await mkdir(storeRoot, { recursive: true, mode: 0o700 });
  const filePath = path.join(storeRoot, SELECTION_FILENAME);
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const payload = `${JSON.stringify({ schema: 1, defaultPack: qualifiedNameOrNull }, null, 2)}\n`;
  try {
    await activeFsHooks.writeFile(temporary, payload, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
  return { schema: 1, defaultPack: qualifiedNameOrNull };
}

// Pure scan over a session's branch entries (ctx.sessionManager.getBranch())
// for this session's remembered team, independent of the global default
// above (design draft §3: "Resume / reload | Preserve recorded team
// identity"). Two custom entry types, not one: `binding` reflects only a
// *completed* switch (or an explicit none/migration-required marker);
// `unresolvedPending` is a switch that was requested -- pending intent
// persisted, reload already triggered -- but not yet confirmed applied by a
// fresh instance. Keeping them separate means an interrupted switch (crash,
// or an unrelated extension's reload failure) can never silently promote
// itself to the current identity: a caller must explicitly attempt to
// resolve `unresolvedPending` and append a new binding entry once it
// actually succeeds.
export function inspectTeamEntries(entries) {
  let binding;
  let pending;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom") continue;
    if (!binding && entry.customType === TEAM_BINDING_ENTRY_TYPE) {
      binding = { index, data: entry.data };
    }
    if (!pending && entry.customType === TEAM_PENDING_ENTRY_TYPE) {
      pending = { index, data: entry.data };
    }
    if (binding && pending) break;
  }
  // A pending entry marked `cancelled` records that the reload it announced
  // never happened (the old runtime is still alive), so it settles itself
  // instead of being replayed by some later, unrelated reload.
  return {
    binding: binding?.data,
    unresolvedPending: pending && !pending.data?.cancelled && (!binding || pending.index > binding.index) ? pending.data : undefined,
  };
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

function createPackSession({ qualifiedName, manifest, revision, root, ownerMetaPath, project }) {
  let disposed = false;
  let activeChildren = 0;

  function retain() {
    if (disposed) {
      throw new Error(`persona pack session '${qualifiedName}' is already disposed`);
    }
    activeChildren += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeChildren = Math.max(0, activeChildren - 1);
    };
  }

  // The shape resolveAgentLaunchRequest/resolveConsultLaunchRequest/
  // resolveRoundtableLaunchRequest accept as options: a pre-resolved
  // project (skips workspace discovery), this snapshot's own root (resolves
  // packDocs), and the bare pack name roundtable's bound-team path expects.
  function team() {
    return { project, packRoot: root, packName: manifest.name };
  }

  async function dispose() {
    if (disposed) return { disposed: true, alreadyDisposed: true };
    if (activeChildren > 0) {
      throw new Error(
        `persona pack session '${qualifiedName}' cannot be disposed while ${activeChildren} native child run(s) are still reading its retained snapshot`,
      );
    }
    // Only mark this session disposed once removal has actually succeeded:
    // if rm throws (a locked file, a transient permission error), disposed
    // stays false so a caller can retry dispose() instead of the session
    // silently reporting itself gone while its snapshot is still on disk.
    await activeFsHooks.rm(root, { recursive: true, force: true });
    await activeFsHooks.rm(ownerMetaPath, { force: true });
    disposed = true;
    return { disposed: true, alreadyDisposed: false };
  }

  return {
    qualifiedName,
    manifest,
    revision,
    root,
    project,
    team,
    retain,
    dispose,
    get isDisposed() {
      return disposed;
    },
    get activeChildCount() {
      return activeChildren;
    },
  };
}

async function collectSnapshotFiles(source) {
  const files = new Map(source.files);
  // readPortablePersonaPack folds pack.yaml into its integrity hash but
  // strips it from the returned file map; read it back so the snapshot is a
  // self-contained pack, matching what the store itself retains on disk.
  files.set("pack.yaml", await readFile(path.join(source.root, "pack.yaml")));
  return files;
}

function assertWithinSnapshotBounds(qualifiedName, fileCount, totalBytes) {
  if (fileCount > MAX_SNAPSHOT_FILES) {
    throw new Error(
      `persona pack '${qualifiedName}' has ${fileCount} files, exceeding the ${MAX_SNAPSHOT_FILES}-file private snapshot limit`,
    );
  }
  if (totalBytes > MAX_SNAPSHOT_BYTES) {
    throw new Error(
      `persona pack '${qualifiedName}' is ${formatBytes(totalBytes)}, exceeding the ${formatBytes(MAX_SNAPSHOT_BYTES)} private snapshot limit`,
    );
  }
}

async function writeSnapshot(root, files) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const [relativePath, content] of files) {
    assertSnapshotRelativePath(relativePath);
    const destination = path.join(root, relativePath);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await activeFsHooks.writeFile(destination, content, { mode: 0o600 });
  }
}

// Records which runtime process owns a snapshot and when it was created, so
// a future crash-recovery sweeper (not implemented here — Task 5/6 territory)
// has the evidence it needs to tell a genuinely orphaned snapshot (owner
// process verified dead) apart from a live one, instead of guessing from
// age alone. Written as a sibling of the snapshot directory, not inside it,
// so the snapshot itself stays exactly the self-contained pack layout
// collectSnapshotFiles produced.
async function writeOwnerMetadata(ownerMetaPath, { qualifiedName, revision }) {
  await activeFsHooks.writeFile(ownerMetaPath, `${JSON.stringify({
    pid: process.pid,
    createdAt: new Date().toISOString(),
    qualifiedName,
    revision,
  }, null, 2)}\n`, { mode: 0o600 });
}

function assertSnapshotRelativePath(relativePath) {
  if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
    throw new Error(`persona pack snapshot path escapes its private root: ${relativePath}`);
  }
}

function parseQualifiedPackName(qualifiedName) {
  const parts = String(qualifiedName).split("/");
  const [kind, name] = parts;
  if (parts.length !== 2 || !KINDS.includes(kind) || !isSafeAgentName(name)) {
    throw new Error(`qualified persona pack identity must be 'official/<name>' or 'custom/<name>' (received '${qualifiedName}')`);
  }
  return { kind, name };
}

function formatBytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
