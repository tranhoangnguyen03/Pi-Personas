import {
  getAgentDir,
  getMarkdownTheme,
  getPackageDir,
  keyHint,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";

import {
  applyPersonaMigration,
  assertPersonaRuntimeReady,
  cancelCustomPersonaPackDraft,
  cancelPersonaChildren,
  createConsultProgressTracker,
  createRoundtableProgressTracker,
  createDocsIndex,
  createPersonaInitDraft,
  applyPersonaInitFromManifest,
  detectMigrationState,
  discoverPersonaProject,
  formatPersonaDisplayName,
  formatConsultBridgeResult,
  formatDoctorReport,
  formatGlobalPersonaPackReport,
  formatMigrationInspectionReport,
  formatMigrationPreviewReport,
  formatMigrationStatusReport,
  formatPersonaInitDraftAuthoringPrompt,
  formatPersonaInitManifestReport,
  formatPersonaList,
  formatRoundtableBridgeResult,
  inspectLegacyMigration,
  inspectTeamEntries,
  isDirectPersonaCommandName,
  listGlobalPersonaPacks,
  loadPackSession,
  parsePersonaOnboardArgs,
  planPersonaInitFromManifest,
  previewCustomPersonaPackDraft,
  previewPersonaMigration,
  readGlobalDefaultPack,
  readMigrationRecord,
  recordMigrationRollback,
  resolveAgentLaunchRequest,
  resolveConsultLaunchRequest,
  resolveInstalledQualifiedPersonaPackName,
  resolveRoundtableLaunchRequest,
  resolveRoundtableSelectionRequest,
  resolveNativeChildTools,
  runNativeRoundtable,
  runPersonaChild,
  runDoctor,
  runGlobalPersonaPackAction,
  sendPersonaOutput,
  snapshotForkBranch,
  statusPersonaInitFromManifest,
  TEAM_BINDING_ENTRY_TYPE,
  TEAM_PENDING_ENTRY_TYPE,
  writeGlobalDefaultPack,
} from "../src/persona/index.js";

const ACTIVE_PERSONA_STATE_TYPE = "pi-persona-active";
// Internal /persona subcommand that carries a chat-approved change from the
// persona_pack tool into a command context (which can reload). Not listed in
// usage; it only acts on a single-use nonce this runtime issued.
const CHAT_HANDOFF_SUBCOMMAND = "chat-handoff";

type ChatHandoff = {
  nonce: string;
  sessionId: string;
  anchorEntryId?: string;
} & (
  | { kind: "team"; target: string | null; revision?: string }
  | { kind: "rollback"; name: string; attemptId: string | null }
);
const CONSULT_IDLE_TIMEOUT_MS = 180_000;
const CONSULT_HEARTBEAT_MS = 10_000;
const IS_PI_SUBAGENT_CHILD = process.env.PI_SUBAGENT_CHILD === "1";

export default function registerPiPersona(pi: ExtensionAPI): void {
  if (IS_PI_SUBAGENT_CHILD) return;

  let activePersonaName: string | undefined;
  let boundPackSession: Awaited<ReturnType<typeof loadPackSession>> | undefined;
  // Why boundPackSession is undefined, for truthful /persona status and for
  // gating every persona execution path (direct activation, /persona use,
  // persona_consult, persona_roundtable): "legacy" (no team-binding entry was
  // ever recorded -- a workspace that predates or never touched this
  // feature) is the only state where the pre-existing ctx.cwd fallback stays
  // exactly as before. "none" (the user explicitly ran /persona team none),
  // "missing-bound" (a recorded binding that this runtime could not load),
  // and "migration-required" (see resolveMigrationGate) all
  // deliberately refuse persona execution instead of silently falling back
  // to an unrelated ctx.cwd roster -- see assertPersonaExecutionAllowed. Pi
  // management (persona_init/persona_pack) and team recovery (/persona team)
  // remain usable in every state; only running a persona is gated.
  let teamScopeState: "legacy" | "bound" | "none" | "migration-required" | "missing-bound" = "legacy";
  let pendingRoundtable: {
    cwd: string;
    query: string;
    moderator: string;
    pack?: string;
  } | undefined;
  let availableSkills: Array<{ name: string; filePath: string }> = [];
  const registeredPersonaCommands = new Set<string>();
  // Best-effort freshness hint for /persona migrate apply: set by the most
  // recent /persona migrate preview in this runtime, consulted (not
  // required) so apply can refuse a legacy source, the staged draft, or a
  // destination pack that changed since that preview instead of silently applying stale
  // content or overwriting someone else's edit. Deliberately in-memory only
  // -- losing it across a reload just means apply skips that extra check and
  // relies on its own always-on inspectLegacyMigration/marker/receipt-owner
  // comparisons (re-run again, regardless, inside the store's own mutation
  // lock right before applying -- see pack-migration.js's applyPersonaMigration).
  let lastMigrationPreview: { name: string; sourceDigest: string; activeIntegrity: string | null; draftIntegrity: string } | undefined;
  // Set by session_shutdown: lets commitTeamSwitch tell a real reload (this
  // runtime was torn down) from one the host declined.
  let runtimeShutDown = false;
  // Chat-approved session changes (persona_pack team/default/migrate). A
  // planId is honored only if this runtime issued it in this session and the
  // user has sent a message since, so a plan can never be confirmed in the
  // same turn that showed it. This is a structural guard only: the runtime
  // cannot tell whether that message approves; the model interprets it.
  const issuedChatPlans = new Map<string, { sessionId: string; userMessages: number }>();
  // At most one approved reload-requiring change waits for the current
  // response to end; a second approval meanwhile (e.g. a sibling tool call in
  // the same batch) is refused rather than racing it. The nonce is never
  // shown to the model, so only this runtime can dispatch it.
  let pendingChatHandoff: ChatHandoff | undefined;

  const sessionIdOf = (ctx: any): string => ctx.sessionManager?.getSessionId?.() ?? "";
  const branchOf = (ctx: any): any[] => ctx.sessionManager?.getBranch?.() ?? [];
  const countUserMessages = (ctx: any) => branchOf(ctx).filter((entry) => entry?.type === "message" && entry.message?.role === "user").length;

  const recordIssuedPlan = (ctx: any, planId: string) => {
    issuedChatPlans.set(planId, { sessionId: sessionIdOf(ctx), userMessages: countUserMessages(ctx) });
  };

  const issueChatPlan = (ctx: any, parts: Record<string, unknown>) => {
    const planId = chatPlanId(sessionIdOf(ctx), parts);
    recordIssuedPlan(ctx, planId);
    return planId;
  };

  // Shown-and-answered check for a plan whose freshness the caller verifies
  // itself (the pack lifecycle's own planId).
  const assertPackPlanApproved = (ctx: any, planId: unknown) => {
    if (typeof planId !== "string" || !planId) return; // the lifecycle rejects a missing planId with its own message
    const issued = issuedChatPlans.get(planId);
    if (!issued || issued.sessionId !== sessionIdOf(ctx)) {
      throw new Error("This plan was not shown in this session (or Pi reloaded since). Show the plan to the user again.");
    }
    if (countUserMessages(ctx) <= issued.userMessages) {
      throw new Error("The user has not replied since this plan was shown. Show them the plan and wait for their explicit approval.");
    }
  };

  const assertNoWaitingHandoff = () => {
    if (pendingChatHandoff) {
      throw new Error("Another approved change is already waiting to run when this response ends, so this one was not applied. Tell the user, and ask again after that change has finished.");
    }
  };

  const consumeApprovedChatPlan = (ctx: any, planId: unknown, parts: Record<string, unknown>) => {
    if (typeof planId !== "string" || !planId) {
      throw new Error("The approval could not be matched to a displayed plan. Show the plan to the user first.");
    }
    const issued = issuedChatPlans.get(planId);
    if (!issued || issued.sessionId !== sessionIdOf(ctx)) {
      throw new Error("This plan was not shown in this session (or Pi reloaded since). Show the plan to the user again.");
    }
    if (chatPlanId(sessionIdOf(ctx), parts) !== planId) {
      issuedChatPlans.delete(planId);
      throw new Error("Something changed since this plan was shown, so nothing was changed. Show the updated plan to the user again.");
    }
    if (countUserMessages(ctx) <= issued.userMessages) {
      throw new Error("The user has not replied since this plan was shown. Show them the plan and wait for their explicit approval.");
    }
    issuedChatPlans.delete(planId);
  };

  // Hands an approved reload-requiring change to the existing /persona
  // command path. Tools cannot reload; commands can, and Pi dispatches a
  // registered command before its streaming check, so the handler starts now
  // and waits for idle itself. The tool must not await it: the handler waits
  // for this very turn to finish.
  const dispatchChatHandoff = (
    ctx: any,
    handoff: { kind: "team"; target: string | null; revision?: string } | { kind: "rollback"; name: string; attemptId: string | null },
  ) => {
    const nonce = randomUUID();
    const branch = branchOf(ctx);
    pendingChatHandoff = {
      ...handoff,
      nonce,
      sessionId: sessionIdOf(ctx),
      anchorEntryId: branch.at(-1)?.id,
    } as ChatHandoff;
    pi.sendUserMessage(`/persona ${CHAT_HANDOFF_SUBCOMMAND} ${nonce}`, { expandPromptTemplates: true });
  };

  const runChatHandoff = async (ctx: any, nonce: string) => {
    if (!pendingChatHandoff || pendingChatHandoff.nonce !== nonce) {
      sendPersonaOutput(pi, ctx, "That approval is no longer current, so nothing was changed.", "warning");
      return;
    }
    await ctx.waitForIdle();
    if (runtimeShutDown) return;
    const handoff = pendingChatHandoff;
    if (!handoff || handoff.nonce !== nonce) return;
    pendingChatHandoff = undefined;
    const sameBranch = handoff.anchorEntryId === undefined || branchOf(ctx).some((entry) => entry?.id === handoff.anchorEntryId);
    if (handoff.sessionId !== sessionIdOf(ctx) || !sameBranch) {
      sendPersonaOutput(pi, ctx, "The conversation moved to a different session or branch after this was approved, so nothing was changed. Ask again if you still want it.", "warning");
      return;
    }
    try {
      if (handoff.kind === "team") {
        await switchPersonaTeam(ctx, handoff.target ?? "none", undefined, { expectedRevision: handoff.revision });
      } else {
        await rollbackMigration(ctx, handoff.name, { expectedAttemptId: handoff.attemptId });
      }
    } catch (error) {
      sendPersonaOutput(pi, ctx, error instanceof Error ? error.message : String(error), "error");
    }
  };

  const updateActivePersonaStatus = (ctx: any) => {
    ctx.ui?.setStatus?.(
      "pi-persona-active",
      activePersonaName ? `persona /${activePersonaName}` : undefined,
    );
  };

  const restoreActivePersona = (ctx: any, options: { resetIfMissing?: boolean } = {}) => {
    const entries = ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? [];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry?.type !== "custom" || entry.customType !== ACTIVE_PERSONA_STATE_TYPE) continue;
      const agentName = entry.data?.agentName;
      activePersonaName = typeof agentName === "string" && agentName ? agentName : undefined;
      return;
    }
    if (options.resetIfMissing) activePersonaName = undefined;
  };

  const setActivePersona = (ctx: any, agentName: string | undefined) => {
    activePersonaName = agentName;
    pi.appendEntry(ACTIVE_PERSONA_STATE_TYPE, { agentName: agentName ?? null });
    updateActivePersonaStatus(ctx);
  };

  const personaStoreRoot = () => join(getAgentDir(), "persona");

  // Bound-team roster/system-prompt/consult/roundtable resolution replaces
  // ctx.cwd project discovery for this session once a global team is bound
  // (design draft §3/§6: selection owns routing, not implicit ctx.cwd
  // fallback). Unbound sessions keep the pre-existing ctx.cwd behavior
  // untouched -- this only ever narrows, never widens, what ctx.cwd-scoped
  // project-local pack tools (persona_init/persona_pack) themselves do.
  const boundTeamOptions = () => (boundPackSession ? boundPackSession.team() : {});

  // doctor.js's options.team shape (see runDoctor's docstring): reports this
  // session's current global-team scope so doctor can skip the
  // project-foundation/library demand while a team is bound, and surface
  // per-state recovery guidance (missing-bound/migration-required/none)
  // otherwise.
  const currentTeamOption = () => (
    boundPackSession
      ? { state: "bound" as const, qualifiedName: boundPackSession.qualifiedName }
      : { state: teamScopeState }
  );

  const currentSessionPackOption = () => (
    boundPackSession ? { qualifiedName: boundPackSession.qualifiedName } : undefined
  );

  // Centralized scope guard for every persona execution path (direct
  // activation via registerPersonaCommand, /persona use, persona_consult,
  // persona_roundtable/persona-roundtable). "legacy" is the only unbound
  // state exempt: a workspace that predates or never touched this feature
  // keeps its pre-existing ctx.cwd fallback untouched. "none",
  // "missing-bound", and "migration-required" all refuse instead of silently
  // resolving an unrelated ctx.cwd roster. The migration-required message
  // below is intentionally the coarse, always-true fallback ("run inspect,
  // then preview/apply, or pick an installed team"); the more specific
  // per-state detail (changed-source vs destination-missing) is surfaced
  // live by resolveMigrationGate's session-start notice and by
  // /persona migrate status, not recomputed on every gated call here.
  const assertPersonaExecutionAllowed = () => {
    if (boundPackSession || teamScopeState === "legacy") return;
    if (teamScopeState === "none") {
      throw new Error("No persona team is bound. Run /persona team to choose one.");
    }
    if (teamScopeState === "missing-bound") {
      throw new Error("This session's persona team could not be loaded. Run /persona team to choose a valid pack.");
    }
    throw new Error("This workspace's persona setup predates global persona packs. Run /persona migrate inspect to review it, then /persona migrate preview <name> and /persona migrate apply <name> to convert it into a global custom pack, or run /persona team to choose an already-installed persona team.");
  };

  // Registers direct persona commands (registerPersonaCommand dedupes by
  // name) from whichever roster is authoritative for this session: the bound
  // team's retained snapshot, or -- when nothing is bound -- the unrelated
  // ctx.cwd project-local roster exactly as before. Kept distinct from
  // registerProjectCommands(cwd) below, which persona_init/persona_pack keep
  // calling directly: those tools mutate ctx.cwd's own .pi/agents regardless
  // of any global binding, and must keep reporting on that project, not a
  // bound snapshot. registerProjectCommands is itself bound-aware (see its
  // definition below): it always discovers and returns ctx.cwd's project for
  // that reporting, but only ever registers its agents as live dispatchable
  // commands when no global team is bound, so persona_init/persona_pack can
  // never pollute a bound team's command map no matter how directly they
  // call it.
  const refreshPersonaCommands = async (ctx: any) => {
    if (boundPackSession) {
      for (const agent of boundPackSession.project.agents) registerPersonaCommand(agent.name);
      return boundPackSession.project;
    }
    return registerProjectCommands(ctx.cwd);
  };

  // Recognized-legacy guard for Task 5's new-session default, now backed by
  // Task 6's marker-aware detectMigrationState (src/persona/pack-migration.js)
  // instead of a bare recognition boolean: a workspace whose ctx.cwd already
  // has its own pre-pack-redesign generalist (agents.js's
  // hasLegacyPersonaProject) must not have a global default silently applied on top
  // of it -- unless this exact source content was already reviewed and
  // migrated (state "migrated"), in which case the gate lifts and the
  // ordinary default flow resumes. "changed-source" and "destination-missing"
  // still block, each with their own actionable message, rather than
  // silently trusting a stale marker or re-importing an edited project.
  // Returns { blocked: false } (not a thrown error) for both "not-legacy" and
  // "migrated" so the caller's own default-application flow decides what
  // happens next, exactly like the pre-Task-6 boolean did.
  const resolveMigrationGate = async (ctx: any): Promise<{ blocked: boolean; migrated: boolean; message?: string }> => {
    let state;
    try {
      state = await detectMigrationState(ctx.cwd, personaStoreRoot());
    } catch (error) {
      // A failure here (a corrupted marker/receipt, a symlink-escape check
      // tripping) is not evidence this workspace is fine: it means this
      // runtime could not determine whether it is a recognized-but-unfixed
      // legacy project. Defaulting to "not blocked" would silently apply
      // the global default (or run persona commands) on top of exactly the
      // kind of project this gate exists to catch. Fail closed instead,
      // with the diagnostic surfaced so it is actionable.
      return {
        blocked: true,
        migrated: false,
        message: `This workspace's persona migration state could not be determined: ${error instanceof Error ? error.message : String(error)}. This workspace's own persona commands are blocked until you run /persona migrate status to investigate, or /persona team to choose an installed team.`,
      };
    }
    switch (state.state) {
      case "not-legacy":
        return { blocked: false, migrated: false };
      case "migrated":
        // Distinct from "not-legacy": this workspace's ctx.cwd still has its
        // original pre-migration .pi/agents content sitting on disk
        // (migration never touches it -- see /persona migrate apply's own
        // comment), so callers with no default configured must not silently
        // fall back to serving that stale content as if this were an
        // ordinary never-touched-packs project.
        return { blocked: false, migrated: true };
      case "changed-source":
        return {
          blocked: true,
          migrated: false,
          message: `This workspace's persona setup was previously migrated to '${state.marker.destination}', but its original files changed afterward, so no global default team was applied. The earlier migration was left in place; run /persona migrate inspect and then preview/apply again to review the change. This workspace's own persona commands are blocked until you choose an installed team with /persona team.`,
        };
      case "destination-missing":
        return {
          blocked: true,
          migrated: false,
          message: `This workspace was previously migrated to '${state.marker.destination}', but that persona pack is no longer installed, so no global default team was applied. Run /persona migrate status for recovery options. This workspace's own persona commands are blocked until you choose an installed team with /persona team.`,
        };
      default:
        return {
          blocked: true,
          migrated: false,
          message: "This workspace has an existing persona setup that predates global persona packs. No global default team was applied, and this workspace's own persona commands are blocked until you choose an installed team. Run /persona migrate inspect to review it, then /persona migrate preview <name> and /persona migrate apply <name> to convert it into a global custom pack, or run /persona team to pick an already-installed team.",
        };
    }
  };

  const activateBoundTeamLead = (ctx: any, session: Awaited<ReturnType<typeof loadPackSession>>) => {
    const lead = session.project.agents.find((agent: any) => agent.role === "generalist");
    setActivePersona(ctx, lead?.name);
    return lead;
  };

  // Step 4 of Task 5: wait for idle, validate and snapshot the target BEFORE
  // touching any session state, persist pending intent, then reload as the
  // terminal action. Nothing after ctx.reload() in this handler is reliable
  // (the extension instance is torn down/rebuilt), so completion is recorded
  // by the fresh instance's session_start handler (completePendingSwitch
  // below), never here.
  // `pendingBindingStatus` is an optional refinement of what a `null`
  // (none) target ultimately resolves to once the fresh instance commits
  // it: plain "none" (the default), or "migration-required" for rollback
  // restoring a workspace to the state it was actually in before migration
  // (see /persona migrate rollback below) -- never silently collapsed to
  // "none", which is a distinct, explicit user choice with its own meaning.
  const switchPersonaTeam = async (
    ctx: any,
    targetInput: string,
    pendingBindingStatus?: "migration-required",
    options: { expectedRevision?: string; declinedMessage?: string } = {},
  ) => {
    await ctx.waitForIdle();
    const prepared = await resolveTeamTarget(targetInput);
    if (options.expectedRevision !== undefined && prepared.revision !== options.expectedRevision) {
      throw new Error(`persona pack '${prepared.target}' changed since the switch was approved; nothing was changed. Ask to switch again to review its current version.`);
    }
    await commitTeamSwitch(ctx, prepared, pendingBindingStatus, options.declinedMessage);
  };

  // Validates a /persona team target without touching session state: the
  // installed qualified name plus the revision a fresh snapshot would bind.
  const resolveTeamTarget = async (targetInput: string): Promise<{ target: string | null; revision?: string }> => {
    const trimmed = targetInput.trim();
    if (trimmed === "none") return { target: null };
    const storeRoot = personaStoreRoot();
    const target = await resolveInstalledQualifiedPersonaPackName(storeRoot, trimmed);
    const validated = await loadPackSession(storeRoot, target);
    const revision = validated.revision;
    await validated.dispose();
    return { target, revision };
  };

  // Terminal half of a switch. Idleness is rechecked synchronously right
  // before the pending entry and reload, with no await in between, because
  // interactive Pi's reload silently declines while a response is streaming.
  // The previous bound snapshot is not disposed here: reload's own
  // session_shutdown disposes it, so a switch that never reloads leaves the
  // live session intact instead of half torn down.
  const commitTeamSwitch = async (
    ctx: any,
    { target, revision }: { target: string | null; revision?: string },
    pendingBindingStatus?: "migration-required",
    declinedMessage = "Pi did not reload, so the persona team was not switched and nothing changed. Try again once Pi is idle.",
  ) => {
    if (!ctx.isIdle()) {
      throw new Error("Pi is still busy with a response, so the persona team was not switched and nothing changed. Try again once it finishes.");
    }
    pi.appendEntry(TEAM_PENDING_ENTRY_TYPE, {
      target,
      revision,
      ...(pendingBindingStatus ? { bindingStatus: pendingBindingStatus } : {}),
    });
    // This is the last output this handler may send: ctx.reload() below
    // tears down and rebuilds the extension instance, so nothing after it
    // in this function is reliable (see completePendingSwitch, which is the
    // only place a *confirmed* outcome -- success or failure -- may be
    // reported, using its own fresh ctx).
    sendPersonaOutput(
      pi,
      ctx,
      target
        ? `Switching persona team to '${target}' (reload requested; outcome not yet known)…`
        : pendingBindingStatus === "migration-required"
          ? "Rolling back persona team selection to migration-required (reload requested; outcome not yet known)…"
          : "Switching persona team to none (reload requested; outcome not yet known)…",
      "info",
    );
    await ctx.reload();
    // A real reload shut this runtime down (session_shutdown below). Still
    // running means the host declined to reload, so settle the pending entry
    // now rather than let a later, unrelated reload apply it.
    if (!runtimeShutDown) {
      pi.appendEntry(TEAM_PENDING_ENTRY_TYPE, { target, cancelled: true });
      sendPersonaOutput(pi, ctx, declinedMessage, "warning");
    }
  };

  // Fresh-instance side of a switch: the pending entry survives ctx.reload()
  // (only extensions are torn down/rebuilt, not the session), so this reads
  // it back and either commits a new binding entry (success) or leaves the
  // previous committed binding as the truth (failure) -- never both, and
  // never a false "switched" claim either way.
  const completePendingSwitch = async (
    ctx: any,
    storeRoot: string,
    pending: { target: string | null; revision?: string; bindingStatus?: "migration-required" },
    previousBinding: { status: string; qualifiedName?: string } | undefined,
  ) => {
    if (pending.target === null) {
      boundPackSession = undefined;
      const status = pending.bindingStatus === "migration-required" ? "migration-required" : "none";
      teamScopeState = status;
      pi.appendEntry(TEAM_BINDING_ENTRY_TYPE, { status });
      setActivePersona(ctx, undefined);
      sendPersonaOutput(
        pi,
        ctx,
        status === "migration-required"
          ? "Persona team rolled back: this workspace's persona setup requires migration again. Ask in chat for its migration status or to choose an installed team (or use /persona migrate status and /persona team)."
          : "Persona team switched: none. Active persona cleared.",
        "info",
      );
      return;
    }
    try {
      const session = await loadPackSession(storeRoot, pending.target);
      boundPackSession = session;
      teamScopeState = "bound";
      pi.appendEntry(TEAM_BINDING_ENTRY_TYPE, { status: "pack", qualifiedName: pending.target, revision: session.revision });
      const lead = activateBoundTeamLead(ctx, session);
      sendPersonaOutput(
        pi,
        ctx,
        `Persona team switched to '${pending.target}'. Active lead: ${lead ? formatActivePersonaLabel(lead.name, lead.role) : "none"}.`,
        "info",
      );
    } catch (error) {
      // A failed switch must settle durably: append a binding entry that
      // mirrors whatever was previously recorded (never "none", so a
      // previously-bound pack's identity is preserved for recovery even when
      // this runtime cannot load it right now), or an explicit "failed"
      // marker when nothing was previously recorded. Without this, the just-
      // appended TEAM_PENDING_ENTRY_TYPE entry remains the latest team entry
      // forever, so inspectTeamEntries keeps reporting it as unresolved and
      // every later reload/resume retries this same failed switch again.
      const recoveryEntry = previousBinding ?? { status: "failed" as const };
      if (recoveryEntry.status === "pack" && recoveryEntry.qualifiedName) {
        try {
          boundPackSession = await loadPackSession(storeRoot, recoveryEntry.qualifiedName);
          teamScopeState = "bound";
        } catch {
          boundPackSession = undefined;
          teamScopeState = "missing-bound";
        }
      } else {
        boundPackSession = undefined;
        teamScopeState = recoveryEntry.status === "none"
          ? "none"
          : recoveryEntry.status === "migration-required"
            ? "migration-required"
            : "missing-bound";
      }
      pi.appendEntry(TEAM_BINDING_ENTRY_TYPE, recoveryEntry);
      if (boundPackSession) activateBoundTeamLead(ctx, boundPackSession);
      else setActivePersona(ctx, undefined);
      sendPersonaOutput(
        pi,
        ctx,
        `Persona team switch to '${pending.target}' failed and was not applied: ${error instanceof Error ? error.message : String(error)}. The previous team, if any, remains active. Run /persona team to choose a valid pack.`,
        "error",
      );
    }
  };

  // Resume/reload/fork with an already-committed binding and nothing
  // pending: rehydrate this runtime's own private snapshot for that
  // identity. A pack that is now missing/invalid never falls back to
  // silently unbinding or substituting the default -- it surfaces recovery
  // guidance and this runtime simply has no bound team until the user acts.
  const rehydrateBinding = async (
    ctx: any,
    storeRoot: string,
    binding: { status: string; qualifiedName?: string },
  ) => {
    if (binding.status !== "pack" || !binding.qualifiedName) {
      boundPackSession = undefined;
      teamScopeState = binding.status === "none" || binding.status === "migration-required" ? binding.status : "none";
      return;
    }
    try {
      boundPackSession = await loadPackSession(storeRoot, binding.qualifiedName);
      teamScopeState = "bound";
    } catch (error) {
      boundPackSession = undefined;
      teamScopeState = "missing-bound";
      // The restored active persona belonged to the team that just failed to
      // load; keeping it would leave a stale name in the status bar and in
      // the stored session state while every persona path is gated anyway.
      if (activePersonaName) setActivePersona(ctx, undefined);
      sendPersonaOutput(
        pi,
        ctx,
        `This session's persona team '${binding.qualifiedName}' could not be loaded: ${error instanceof Error ? error.message : String(error)}. No persona is active. Run /persona team to choose a valid pack.`,
        "error",
      );
    }
  };

  // Genuinely new sessions only (event.reason === "new"): applies the
  // global default, unless this workspace has a recognized legacy project
  // that either has never been migrated, or was migrated but has since
  // drifted or lost its destination (see resolveMigrationGate) -- in which
  // case the default is deliberately withheld rather than silently
  // overriding it.
  const applyDefaultForNewSession = async (ctx: any, storeRoot: string) => {
    const migrationGate = await resolveMigrationGate(ctx);
    if (migrationGate.blocked) {
      teamScopeState = "migration-required";
      pi.appendEntry(TEAM_BINDING_ENTRY_TYPE, { status: "migration-required" });
      sendPersonaOutput(pi, ctx, migrationGate.message!, "warning");
      return;
    }
    let defaultRecord;
    try {
      defaultRecord = await readGlobalDefaultPack(storeRoot);
    } catch (error) {
      sendPersonaOutput(pi, ctx, `Persona default pack record is invalid: ${error instanceof Error ? error.message : String(error)}`, "error");
      return;
    }
    if (!defaultRecord?.defaultPack) {
      // A workspace that was already migrated (its ctx.cwd content converted
      // into a global custom pack) must never silently fall back to serving
      // that stale, superseded ctx.cwd content just because no default is
      // configured yet -- that is exactly the old pre-redesign behavior this
      // gate exists to retire. Only a workspace that never touched global
      // persona packs at all keeps the "legacy" ctx.cwd fallback.
      if (migrationGate.migrated) {
        teamScopeState = "none";
        pi.appendEntry(TEAM_BINDING_ENTRY_TYPE, { status: "none" });
      } else {
        teamScopeState = "legacy";
      }
      return;
    }
    try {
      const session = await loadPackSession(storeRoot, defaultRecord.defaultPack);
      boundPackSession = session;
      teamScopeState = "bound";
      pi.appendEntry(TEAM_BINDING_ENTRY_TYPE, { status: "pack", qualifiedName: defaultRecord.defaultPack, revision: session.revision });
      activateBoundTeamLead(ctx, session);
    } catch (error) {
      teamScopeState = "missing-bound";
      if (activePersonaName) setActivePersona(ctx, undefined);
      sendPersonaOutput(
        pi,
        ctx,
        `Default persona team '${defaultRecord.defaultPack}' could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  };

  // Shared /persona migrate operations: the command and persona_pack's
  // migrate action run the same code and differ only in how they phrase the
  // next step (slash command vs. plain request).
  const inspectMigration = async (ctx: any, options: { chat?: boolean } = {}): Promise<{ text: string; level: "info" | "warning" }> => {
    // inspectLegacyMigration is a raw, marker-unaware structural check (by
    // design -- detectMigrationState itself is built on top of it): it
    // reports "recognized" for any workspace whose ctx.cwd still has legacy
    // generalist content, even one already fully migrated, since migration
    // never touches that content. Route through detectMigrationState first
    // so a genuinely already-migrated workspace gets that fact, not a "you
    // have a legacy setup to migrate" framing that no longer applies.
    const state = await detectMigrationState(ctx.cwd, personaStoreRoot());
    if (state.state === "migrated") {
      return {
        text: `This workspace was already migrated to '${state.marker.destination}' and its original files have not changed since.${options.chat ? "" : ` Run /persona migrate status for details, or /persona team ${state.marker.destination} to select it.`}`,
        level: "info",
      };
    }
    const inspection = await inspectLegacyMigration(ctx.cwd);
    return { text: formatMigrationInspectionReport(inspection, options), level: inspection.recognized && inspection.supported ? "info" : "warning" };
  };

  const migrationStatus = async (ctx: any, options: { chat?: boolean } = {}): Promise<{ text: string; level: "info" | "warning" }> => {
    const state = await detectMigrationState(ctx.cwd, personaStoreRoot());
    return {
      text: formatMigrationStatusReport(state, options),
      level: state.state === "migrated" || state.state === "not-legacy" ? "info" : "warning",
    };
  };

  const previewMigration = async (
    ctx: any,
    selection: { name: string; leadName?: string; approvedPersonas?: string[]; includeBaseline?: boolean },
    options: { chat?: boolean } = {},
  ) => {
    const preview: any = await previewPersonaMigration(ctx.cwd, personaStoreRoot(), {
      destinationName: selection.name,
      leadName: selection.leadName,
      approvedPersonas: selection.approvedPersonas ?? [],
      includeBaseline: selection.includeBaseline === true,
    });
    lastMigrationPreview = {
      name: selection.name,
      sourceDigest: preview.sourceDigest,
      activeIntegrity: preview.activeIntegrity,
      draftIntegrity: preview.draftIntegrity,
    };
    return { preview, report: formatMigrationPreviewReport(preview, options) };
  };

  const cancelMigration = async (name: string) => {
    await cancelCustomPersonaPackDraft(personaStoreRoot(), name);
    return `Migration draft '${name}' discarded. The workspace's original persona files were never touched.`;
  };

  const applyMigration = async (
    ctx: any,
    name: string,
    expected: { expectedSourceDigest?: string; expectedActiveIntegrity?: string | null; expectedDraftIntegrity?: string },
  ) => {
    const previousBinding = boundPackSession
      ? { status: "pack" as const, qualifiedName: boundPackSession.qualifiedName }
      : { status: teamScopeState };
    const result = await applyPersonaMigration(ctx.cwd, personaStoreRoot(), name, { ...expected, previousBinding });
    // The workspace is now "migrated": its original ctx.cwd roster is
    // superseded, so an unbound session must stop reporting (and gating as)
    // migration-required. It lands on plain "none" -- exactly what a fresh
    // session over this workspace gets -- and never binds, activates, or
    // defaults the new pack by itself. A session already bound to some team
    // keeps that team untouched.
    if (!boundPackSession && teamScopeState !== "none") {
      teamScopeState = "none";
      pi.appendEntry(TEAM_BINDING_ENTRY_TYPE, { status: "none" });
      if (activePersonaName) setActivePersona(ctx, undefined);
    }
    return result;
  };

  // Validates this workspace's migration receipt for a rollback to
  // custom/<name>. Returns either a message to show (nothing to roll back) or
  // the completed receipt to roll back.
  const checkMigrationRollback = async (ctx: any, name: string): Promise<
    { receipt: any; message?: undefined } | { receipt?: undefined; message: { text: string; level: "info" | "warning" } }
  > => {
    const record = await readMigrationRecord(ctx.cwd);
    if (!record?.receipt) {
      return {
        message: {
          text: "No migration receipt found for this workspace; there is nothing to roll back. Migration apply never modifies this workspace's own persona files, so no filesystem rollback is needed either way.",
          level: "info",
        },
      };
    }
    // Explicit intent, the same pattern apply/cancel already use: naming the
    // destination confirms the maintainer means to roll back *this* receipt,
    // not whatever happens to be on disk.
    const expectedDestination = `custom/${name}`;
    if (record.receipt.destination !== expectedDestination) {
      throw new Error(`this workspace's migration receipt is for '${record.receipt.destination}', not '${expectedDestination}'; run /persona migrate rollback ${record.receipt.destination?.split("/")[1] ?? record.receipt.destination} to confirm, or /persona migrate status to review it first`);
    }
    // Only a receipt that actually completed represents a real change to
    // this session's team binding; a "pending" (never finished) or "failed"
    // (refused before the store mutation, or rolled back by it) attempt never
    // touched anything to roll back from. "rolled-back" is accepted so
    // repeating a rollback stays idempotent (it restores the same prior
    // binding again).
    if (record.receipt.status !== "completed" && record.receipt.status !== "rolled-back") {
      return {
        message: {
          text: `The last migration attempt to '${record.receipt.destination}' did not complete (status: ${record.receipt.status ?? "unknown"}${record.receipt.status === "failed" && record.receipt.error ? `: ${record.receipt.error}` : ""}); there is nothing completed to roll back. Run /persona migrate status for details.`,
          level: "warning",
        },
      };
    }
    return { receipt: record.receipt };
  };

  // Rollback's real contract: record the rollback in the receipt and
  // invalidate the completion marker (so this workspace is
  // "migration-required" again, not silently still "migrated", and status
  // reports a deliberate rollback rather than a failed marker write), restore
  // this session's exact prior binding -- including "migration-required"
  // itself, never collapsed to "none" -- and never delete the migrated pack
  // or touch the workspace's original files. switchPersonaTeam is the
  // terminal action (it reloads); the confirmation is sent by the fresh
  // instance's completePendingSwitch, not here. `expectedAttemptId` binds a
  // chat-approved rollback to the receipt that was shown.
  const rollbackMigration = async (ctx: any, name: string, options: { expectedAttemptId?: string | null } = {}) => {
    const checked = await checkMigrationRollback(ctx, name);
    if (checked.message) {
      sendPersonaOutput(pi, ctx, checked.message.text, checked.message.level);
      return;
    }
    if (options.expectedAttemptId !== undefined && (checked.receipt.attemptId ?? null) !== options.expectedAttemptId) {
      throw new Error("This workspace's migration receipt changed since the rollback was approved, so nothing was changed. Ask to roll back again to review it.");
    }
    await ctx.waitForIdle();
    if (!ctx.isIdle()) {
      throw new Error("Pi is still busy with a response, so the migration was not rolled back and nothing changed. Try again once it finishes.");
    }
    const previous = checked.receipt.previousBinding;
    await recordMigrationRollback(ctx.cwd);
    // From here the workspace itself is already rolled back on disk; only
    // restoring this session's team can still fail. Say exactly that, and
    // point at the safe retry (rollback is idempotent), never "nothing
    // changed".
    const partial = (reason: string) => `The migration to '${checked.receipt.destination}' was rolled back on disk: this workspace is marked as needing migration again, and '${checked.receipt.destination}', its backup and the workspace's original files are kept. This session's persona team was not restored, because ${reason}. Run /persona migrate rollback ${name} again once Pi is idle to restore it; repeating the rollback is safe.`;
    const declinedMessage = partial("Pi did not reload");
    try {
      if (previous?.status === "pack" && previous.qualifiedName) {
        await switchPersonaTeam(ctx, previous.qualifiedName, undefined, { declinedMessage });
      } else if (previous?.status === "migration-required") {
        await switchPersonaTeam(ctx, "none", "migration-required", { declinedMessage });
      } else {
        await switchPersonaTeam(ctx, "none", undefined, { declinedMessage });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(partial(/still busy/.test(message) ? "Pi was busy with a response" : `switching it failed: ${message}`));
    }
  };

  // persona_pack action "default": the global default for new sessions.
  // Never touches this session.
  const runDefaultToolAction = async (params: any, ctx: any) => {
    const storeRoot = personaStoreRoot();
    const currentDefault = (await readGlobalDefaultPack(storeRoot))?.defaultPack ?? null;
    if (!String(params.target ?? "").trim()) {
      return textResult(`Default team for new sessions: ${currentDefault ?? "none configured"}`, { mode: "status", defaultPack: currentDefault });
    }
    const requested = String(params.target).trim();
    const target = requested === "none" ? null : await resolveInstalledQualifiedPersonaPackName(storeRoot, requested);
    if (target === currentDefault) {
      return textResult(`The default team for new sessions is already ${target ? `'${target}'` : "none"}. Nothing to change.`, { mode: "status", defaultPack: currentDefault });
    }
    const parts = { operation: "default", from: currentDefault, to: target };
    if (params.confirmed !== true) {
      const planId = issueChatPlan(ctx, parts);
      const summary = target
        ? `Make '${target}' the default team for new sessions${currentDefault ? ` (replacing '${currentDefault}')` : ""}? This session and other open sessions keep their current teams.`
        : `Clear the default team${currentDefault ? ` ('${currentDefault}')` : ""}? New sessions will start with no team. This session and other open sessions keep their current teams.`;
      return confirmRequiredResult(summary, { action: "default", target: params.target, confirmed: true, planId }, { mode: "confirm-required", operation: "default", target, planId });
    }
    consumeApprovedChatPlan(ctx, params.planId, parts);
    await writeGlobalDefaultPack(storeRoot, target);
    return textResult(
      target
        ? `Default team set to '${target}'. Only new sessions start with it; this session is unchanged.`
        : "Default team cleared. New sessions will start with no team; this session is unchanged.",
      { mode: "apply", operation: "default", defaultPack: target },
    );
  };

  // persona_pack action "migrate": the /persona migrate operations. apply and
  // rollback use the same plan-then-approve contract as team/default, bound
  // to the exact legacy source, draft, destination and receipt shown.
  const runMigrateToolAction = async (params: any, ctx: any) => {
    const storeRoot = personaStoreRoot();
    const operation = params.operation;
    if (operation === "inspect") {
      const { text } = await inspectMigration(ctx, { chat: true });
      return textResult(text, { mode: "status", operation });
    }
    if (operation === "status") {
      const { text } = await migrationStatus(ctx, { chat: true });
      return textResult(text, { mode: "status", operation });
    }
    if (!["preview", "cancel", "apply", "rollback"].includes(operation)) {
      throw new Error("persona_pack migrate needs operation: inspect, status, preview, cancel, apply, or rollback");
    }
    const name = requireToolTarget(params.target, `migrate ${operation}`);
    if (operation === "preview") {
      const { report } = await previewMigration(ctx, {
        name,
        leadName: params.leadName,
        approvedPersonas: params.approvedPersonas,
        includeBaseline: params.includeBaseline,
      }, { chat: true });
      return textResult(
        `${report}\n\nNothing is installed yet.`,
        { mode: "preview", operation, name },
        `To copy this into the global store, call persona_pack with {"action":"migrate","operation":"apply","target":${JSON.stringify(name)}} to get the exact plan for the user to approve; to discard it, use operation "cancel".`,
      );
    }
    if (operation === "cancel") {
      return textResult(await cancelMigration(name), { mode: "apply", operation, name });
    }
    if (operation === "apply") {
      const inspection = await inspectLegacyMigration(ctx.cwd);
      if (!inspection.recognized) throw new Error(`no recognized Pi Persona setup to migrate in ${ctx.cwd}: ${inspection.reason}`);
      let draft: any;
      try {
        draft = await previewCustomPersonaPackDraft(storeRoot, name);
      } catch {
        throw new Error(`There is no migration preview for '${name}' yet. Run the migrate preview operation first and show it to the user.`);
      }
      const parts = {
        operation: "migrate-apply",
        cwd: ctx.cwd,
        name,
        sourceDigest: inspection.sourceDigest,
        draftIntegrity: draft.draftIntegrity,
        activeIntegrity: draft.activeIntegrity,
      };
      if (params.confirmed !== true) {
        const planId = issueChatPlan(ctx, parts);
        const summary = `Copy this workspace's persona setup into the global custom pack 'custom/${name}' (${draft.personas.map((persona: any) => persona.name).join(", ")})?${draft.isNew ? "" : " It replaces that pack's current content."} The workspace's original persona files are not changed, and nothing is selected or made the default automatically.`;
        return confirmRequiredResult(summary, { action: "migrate", operation, target: name, confirmed: true, planId }, { mode: "confirm-required", operation, name, planId });
      }
      consumeApprovedChatPlan(ctx, params.planId, parts);
      const result = await applyMigration(ctx, name, {
        expectedSourceDigest: inspection.sourceDigest,
        expectedActiveIntegrity: draft.activeIntegrity,
        expectedDraftIntegrity: draft.draftIntegrity,
      });
      return textResult(
        [...migrationAppliedLines(result), "It is not selected for this session or made the default."].join("\n"),
        { mode: "apply", operation, qualifiedName: result.qualifiedName },
        offerToUsePack(result.qualifiedName),
      );
    }
    if (operation === "rollback") {
      const checked = await checkMigrationRollback(ctx, name);
      if (checked.message) return textResult(checked.message.text, { mode: "status", operation });
      const receipt = checked.receipt;
      const parts = {
        operation: "migrate-rollback",
        cwd: ctx.cwd,
        destination: receipt.destination,
        attemptId: receipt.attemptId ?? null,
        status: receipt.status,
        previousBinding: receipt.previousBinding ?? null,
      };
      if (params.confirmed !== true) {
        const planId = issueChatPlan(ctx, parts);
        const previous = receipt.previousBinding;
        const restored = previous?.status === "pack" && previous.qualifiedName
          ? `its team before migration, '${previous.qualifiedName}'`
          : previous?.status === "migration-required" ? "needing migration, as before" : "no team";
        const summary = `Roll back the migration to '${receipt.destination}'? This workspace will be marked as needing migration again and this session returns to ${restored}. '${receipt.destination}', its backup and the workspace's original files all stay as they are. Pi reloads its extensions to apply this, right after the response in which it is approved.`;
        return confirmRequiredResult(summary, { action: "migrate", operation, target: name, confirmed: true, planId }, { mode: "confirm-required", operation, name, planId });
      }
      assertNoWaitingHandoff();
      consumeApprovedChatPlan(ctx, params.planId, parts);
      dispatchChatHandoff(ctx, { kind: "rollback", name, attemptId: receipt.attemptId ?? null });
      return {
        ...textResult(`Approved. Pi will roll back the migration to '${receipt.destination}' as soon as this response ends, then post the confirmed outcome.`, { mode: "scheduled", operation, name }, NOT_DONE_YET),
        terminate: true,
      };
    }
    throw new Error(`persona_pack migrate operation '${operation}' is not supported`);
  };

  // persona_pack action "team": this session's team, through the same
  // switch/reload path as /persona team. Without a target it only reports.
  const runTeamToolAction = async (params: any, ctx: any) => {
    const storeRoot = personaStoreRoot();
    const current = boundPackSession
      ? { qualifiedName: boundPackSession.qualifiedName, revision: boundPackSession.revision }
      : { state: teamScopeState };
    if (!params.target) {
      const { official, custom } = await listGlobalPersonaPacks(storeRoot);
      const defaultRecord = await readGlobalDefaultPack(storeRoot);
      return textResult([
        formatTeamStatusLine(boundPackSession, teamScopeState, { chat: true }),
        `Default team for new sessions: ${defaultRecord?.defaultPack ?? "none configured"}`,
        `Installed teams: ${[...official, ...custom].map((pack: any) => pack.qualifiedName).join(", ") || "none"}`,
      ].join("\n"), { mode: "status", current });
    }
    const { target, revision } = await resolveTeamTarget(String(params.target));
    const parts = { operation: "team", target, revision: revision ?? null, current };
    const currentName = boundPackSession?.qualifiedName;
    const refresh = target !== null && target === currentName;
    if (refresh && revision === boundPackSession?.revision) {
      return textResult(`This session already uses the latest saved version of '${target}'. Nothing to refresh.`, { mode: "status", current });
    }
    if (target === null && !boundPackSession && teamScopeState === "none") {
      return textResult("This session already has no persona team. Nothing to change.", { mode: "status", current });
    }
    if (params.confirmed !== true) {
      const planId = issueChatPlan(ctx, parts);
      const lead = target ? await leadNameOf(storeRoot, target) : undefined;
      const summary = refresh
        ? `Refresh this session's team '${target}' to its latest saved version? This session has been using the copy it loaded earlier.`
        : target
          ? `Switch this session's persona team ${currentName ? `from '${currentName}' ` : ""}to '${target}'? Its persona commands replace the current ones${lead ? ` and /${lead} becomes the active lead` : ""}. Other sessions and the default for new sessions stay as they are.`
          : `Clear this session's persona team${currentName ? ` ('${currentName}')` : ""}? No persona will be active and its persona commands are removed. Other sessions and the default stay as they are.`;
      return confirmRequiredResult(
        `${summary}\nPi reloads its extensions to apply this, right after the response in which it is approved.`,
        { action: "team", target: params.target, confirmed: true, planId },
        { mode: "confirm-required", operation: "team", target, planId },
      );
    }
    assertNoWaitingHandoff();
    consumeApprovedChatPlan(ctx, params.planId, parts);
    dispatchChatHandoff(ctx, { kind: "team", target, revision });
    return {
      ...textResult(
        `Approved. Pi will ${refresh ? `refresh '${target}'` : target ? `switch this session to '${target}'` : "clear this session's persona team"} as soon as this response ends, then post the confirmed outcome.`,
        { mode: "scheduled", operation: "team", target },
        NOT_DONE_YET,
      ),
      terminate: true,
    };
  };

  pi.registerTool({
    name: "persona_consult",
    label: "pi-persona",
    description: "Ask another persona available in this session for a focused consult, run in a native child session, and return the result.",
    promptSnippet: "Use persona_consult only when the active Pi Persona needs another known persona's expertise. Independent sibling consultations may run in parallel; every consultant remains a leaf. Provide a narrow requester-written summary and synthesize the returned consultant answer.",
    parameters: Type.Object({
      requester: Type.String({ description: "Active Pi Persona requester agent name" }),
      consultant: Type.String({ description: "Known Pi Persona consultant agent name" }),
      question: Type.String({ description: "Specific question for the consultant" }),
      summary: Type.String({ description: "Requester-authored concise context summary" }),
      constraints: Type.Optional(Type.String({ description: "Constraints the consultant must follow" })),
      expectedOutput: Type.Optional(Type.String({ description: "Requested answer shape" })),
      context: Type.Optional(Type.String({
        enum: ["fresh", "fork"],
        description: "fresh by default; fork inherits the current conversation branch",
      })),
    }),
    renderCall(args, theme, context) {
      const consultant = args.consultant || "consultant";
      const question = args.question || "(query pending)";
      const contextLine = formatConsultContextLine(args.context);
      let text = theme.fg("toolTitle", theme.bold(`Consulting ${consultant}`));
      text += `\n${theme.fg("muted", `Query: ${context.expanded ? question : truncatePanelText(question, 100)}`)}`;
      text += `\n${theme.fg("dim", contextLine)}`;

      if (context.expanded) {
        text += `\n\n${theme.fg("muted", `Requester: ${args.requester || "(unknown)"}`)}`;
        if (args.summary) text += `\n\n${theme.fg("muted", "Summary:")}\n${theme.fg("dim", args.summary)}`;
        if (args.constraints) text += `\n\n${theme.fg("muted", "Constraints:")}\n${theme.fg("dim", args.constraints)}`;
        if (args.expectedOutput) text += `\n\n${theme.fg("muted", "Expected output:")}\n${theme.fg("dim", args.expectedOutput)}`;
      } else {
        text += `\n${theme.fg("dim", keyHint("app.tools.expand", "to expand"))}`;
      }
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, context = {} as any) {
      const output = firstToolResultText(result);
      if (isPartial) {
        return new Text(theme.fg("toolOutput", stripConsultProgressHeading(output)), 0, 0);
      }

      const failed = context.isError;
      const status = failed
        ? theme.fg("error", "✗ Consultation failed")
        : theme.fg("success", "✓ Consultation complete");
      if (!expanded) {
        return new Text(status, 0, 0);
      }

      const container = new Container();
      container.addChild(new Text(status, 0, 0));
      if (output) {
        container.addChild(new Spacer(1));
        container.addChild(new Markdown(output, 0, 0, getMarkdownTheme()));
      }
      return container;
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      let progress: ReturnType<typeof createConsultProgressReporter> | undefined;
      let releaseSnapshot: (() => void) | undefined;
      try {
        assertNotAborted(signal, "consultation");
        assertPersonaExecutionAllowed();
        restoreActivePersona(ctx);
        if (!activePersonaName) {
          throw new Error("persona_consult requires an active persona; run /persona use <name> first");
        }
        if (params.requester !== activePersonaName) {
          throw new Error(`persona_consult requester must match active persona '${activePersonaName}'`);
        }
        releaseSnapshot = boundPackSession?.retain();
        const consult = await resolveConsultLaunchRequest(ctx.cwd, params, boundTeamOptions());
        await assertPersonaRuntimeReady(ctx.cwd);
        progress = createConsultProgressReporter(onUpdate, consult.consultant.name);

        const request = await createNativeRequest(consult.scope, consult.task, consult.context, toolCallId, ctx, availableSkills, undefined, signal);
        const result = await runPersonaChild(request, {
          signal,
          onUpdate(update: unknown) { progress?.update(update); },
        });
        return {
          content: [{ type: "text", text: formatConsultBridgeResult(consult, result.text) }],
          details: { backend: "native", requester: consult.requester.name, consultant: consult.consultant.name, context: consult.context, model: result.model },
          usage: result.usage,
        };
      } finally {
        progress?.stop();
        releaseSnapshot?.();
      }
    },
  });

  pi.registerTool({
    name: "persona_roundtable",
    label: "pi-persona",
    description: "Run one pack-local round-table over specialists selected by that pack's [G] moderator.",
    promptSnippet: "Use persona_roundtable exactly once after /persona-roundtable asks the selected pack moderator to choose a roster. Preserve the user's query and give one concrete reason per specialist. After the tool completes, present its moderator synthesis faithfully and in full; never summarize, shorten, paraphrase, or replace it with a second verdict.",
    parameters: Type.Object({
      query: Type.String({ description: "The user's round-table query, unchanged" }),
      selections: Type.Array(Type.Object({
        name: Type.String({ description: "Selected specialist persona name" }),
        reason: Type.String({ description: "Concrete reason this specialist is useful" }),
      }, { additionalProperties: false }), {
        minItems: 1,
        maxItems: 5,
        description: "One to five specialists selected from this team's roster",
      }),
      context: Type.Optional(Type.String({
        enum: ["fresh", "fork"],
        description: "fresh by default; fork only when full conversation context is deliberately required",
      })),
    }),
    renderCall(args, theme, context) {
      const selections = Array.isArray(args.selections) ? args.selections : [];
      let text = theme.fg("toolTitle", theme.bold(`Round-table · ${selections.length || "…"} specialists`));
      text += `\n${theme.fg("muted", `Query: ${context.expanded ? args.query || "(query pending)" : truncatePanelText(args.query || "(query pending)", 100)}`)}`;
      text += `\n${theme.fg("dim", formatRoundtableContextLine(args.context))}`;
      if (context.expanded) {
        text += `\n${theme.fg("muted", "Moderator: active pack [G] persona")}`;
        text += `\n\n${theme.fg("muted", "Selected panel:")}`;
        for (const selection of selections) {
          text += `\n${theme.fg("toolTitle", selection.name || "(unknown)")} ${theme.fg("dim", `— ${selection.reason || "reason pending"}`)}`;
        }
        text += `\n\n${theme.fg("muted", "Process:")}`;
        text += `\n${theme.fg("dim", "1. Independent positions")}`;
        text += `\n${theme.fg("dim", "2. Peer reveal and revision")}`;
        text += `\n${theme.fg("dim", "3. Moderator synthesis")}`;
      } else {
        const names = selections.map((selection: any) => selection.name).filter(Boolean).join(", ");
        if (names) text += `\n${theme.fg("dim", `Panel: ${names}`)}`;
        text += `\n${theme.fg("dim", keyHint("app.tools.expand", "to inspect selection"))}`;
      }
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, context = {} as any) {
      const output = firstToolResultText(result);
      if (isPartial) {
        return new Text(theme.fg("toolOutput", stripRoundtableProgressHeading(output)), 0, 0);
      }

      const failed = context.isError;
      const status = failed
        ? theme.fg("error", "✗ Round-table failed")
        : theme.fg("success", "✓ Round-table complete");
      const process = formatRoundtableProcessLine((result.details as { process?: any } | undefined)?.process);
      if (!expanded) {
        return new Text(`${status}${process ? `\n${theme.fg("dim", process)}` : ""}`, 0, 0);
      }

      const container = new Container();
      container.addChild(new Text(`${status}${process ? `\n${theme.fg("dim", process)}` : ""}`, 0, 0));
      if (output) {
        container.addChild(new Spacer(1));
        container.addChild(new Markdown(output, 0, 0, getMarkdownTheme()));
      }
      return container;
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      let progress: ReturnType<typeof createRoundtableProgressReporter> | undefined;
      let releaseSnapshot: (() => void) | undefined;
      try {
        assertNotAborted(signal, "round-table");
        assertPersonaExecutionAllowed();
        restoreActivePersona(ctx);
        if (!pendingRoundtable || pendingRoundtable.cwd !== ctx.cwd) {
          throw new Error("persona_roundtable requires a pending /persona-roundtable request");
        }
        if (params.query.trim() !== pendingRoundtable.query) {
          throw new Error("persona_roundtable query must match the pending /persona-roundtable request unchanged");
        }
        releaseSnapshot = boundPackSession?.retain();
        const roundtable = await resolveRoundtableLaunchRequest(ctx.cwd, {
          ...params,
          pack: pendingRoundtable.pack,
          activePersona: pendingRoundtable.moderator,
        }, boundTeamOptions());
        if (activePersonaName !== roundtable.generalist.name || pendingRoundtable.moderator !== roundtable.generalist.name) {
          throw new Error(`persona_roundtable requires active pack moderator '${roundtable.generalist.name}'`);
        }
        await assertPersonaRuntimeReady(ctx.cwd);
        pendingRoundtable = undefined;
        progress = createRoundtableProgressReporter(onUpdate, roundtable);

        const branch = roundtable.context === "fork" ? snapshotForkBranch(ctx.sessionManager, toolCallId) : [];
        for (const scope of roundtable.scopes.values()) {
          assertNotAborted(signal, "round-table");
          await createNativeRequest(scope, "preflight", roundtable.context, toolCallId, ctx, availableSkills, branch, signal);
        }
        const native = await runNativeRoundtable(roundtable, async ({ scope, task, index, signal: childSignal, onUpdate: childUpdate }: any) => {
          const request = await createNativeRequest(scope, task, roundtable.context, toolCallId, ctx, availableSkills, branch, childSignal);
          return runPersonaChild(request, { index, signal: childSignal, idleTimeoutMs: false, onUpdate: childUpdate });
        }, { signal, onUpdate: (update: unknown) => progress?.update(update) });
        const process = createNativeRoundtableProcessDetails(roundtable, native, progress.summary());
        return {
          content: [{ type: "text", text: formatRoundtableBridgeResult(roundtable, native.text) }],
          details: {
            backend: "native",
            moderator: roundtable.generalist.name,
            roster: roundtable.roster.map((agent: any) => agent.name),
            context: roundtable.context,
            process,
          },
          usage: combineUsage(native.steps.map((step: any) => step.usage)),
        };
      } finally {
        progress?.stop();
        releaseSnapshot?.();
      }
    },
  });

  const activatePersona = async (agentName: string, args: string, ctx: any) => {
    try {
      assertPersonaExecutionAllowed();
      const launch = await resolveAgentLaunchRequest(ctx.cwd, agentName, {
        task: normalizeCommandText(args),
        ...boundTeamOptions(),
      });
      setActivePersona(ctx, launch.agentName);
      if (!launch.userMessage) {
        ctx.ui.notify(`Active persona: ${formatActivePersonaLabel(launch.agentName, launch.role)}`, "info");
        return;
      }
      pi.sendUserMessage(
        launch.userMessage,
        ctx.isIdle() ? undefined : { deliverAs: "followUp" },
      );
    } catch (error) {
      sendPersonaOutput(pi, ctx, formatPersonaCommandError(agentName, error), "error");
    }
  };

  const registerPersonaCommand = (agentName: string) => {
    if (!isDirectPersonaCommandName(agentName)) return;
    if (registeredPersonaCommands.has(agentName)) return;

    pi.registerCommand(agentName, {
      description: `Activate Pi Persona agent: ${agentName}`,
      handler: async (args, ctx) => {
        await activatePersona(agentName, args, ctx);
      },
    });
    registeredPersonaCommands.add(agentName);
  };

  const registerProjectCommands = async (cwd: string) => {
    const project = await discoverPersonaProject(cwd);
    // persona_init/persona_pack call this directly to report on ctx.cwd's own
    // project regardless of any bound global team, so the guard belongs
    // here, centrally: once a team is bound, ctx.cwd's own project agents
    // must never become live dispatchable commands alongside (or in place
    // of) the bound team's roster, no matter which caller reached this path.
    if (!boundPackSession) {
      for (const agent of project.agents) {
        registerPersonaCommand(agent.name);
      }
    }
    return project;
  };

  pi.registerTool({
    name: "persona_init",
    label: "Persona Init",
    description: "Plan, apply, or inspect a Pi Persona setup manifest during assisted authoring.",
    promptSnippet: "Use persona_init with action plan before apply. During V1 onboarding, keep agents empty and change only the baseline plus shared-library files; persona packs own all team design. The draft path is already chosen, so never ask the user about YAML filenames or manual configuration editing. Ask for explicit user approval, then call action apply with confirmed: true. Apply includes persona doctor verification; use status afterward.",
    parameters: Type.Object({
      action: Type.String({
        enum: ["plan", "apply", "status"],
        description: "Manifest action to perform",
      }),
      source: Type.String({ description: "Workspace-relative manifest YAML path" }),
      confirmed: Type.Optional(Type.Boolean({
        description: "Required for apply; set true only after explicit user approval",
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        let result;
        let doctor;
        if (params.action === "plan") {
          result = await planPersonaInitFromManifest(ctx.cwd, params.source);
        } else if (params.action === "status") {
          result = await statusPersonaInitFromManifest(ctx.cwd, params.source);
        } else {
          if (params.confirmed !== true) {
            throw new Error("Please approve the displayed foundation plan before applying it.");
          }
          result = await applyPersonaInitFromManifest(ctx.cwd, params.source);
          await registerProjectCommands(ctx.cwd);
          const index = await createDocsIndex(ctx.cwd, { all: true });
          const status = await statusPersonaInitFromManifest(ctx.cwd, params.source);
          doctor = await runDoctor(ctx.cwd, { team: currentTeamOption() });
          const project = await discoverPersonaProject(ctx.cwd);
          return {
            content: [{
              type: "text",
              text: [
                formatPersonaInitManifestReport(result, { doctorIncluded: true, needsAttention: doctor.status === "error" }),
                formatDoctorReport(doctor),
                formatPersonaList(project),
                doctor.status === "error"
                  ? "Onboarding needs attention; fix the doctor errors above, then run /persona onboard again."
                  : "Project foundation complete. Persona packs are managed globally; run /persona pack list to browse and install one.",
              ].join("\n\n"),
            }],
            details: { ...result, index, status, doctor },
          };
        }
        return {
          content: [{
            type: "text",
            text: formatPersonaInitManifestReport(result),
          }],
          details: result,
        };
      } catch (error) {
        throw error instanceof Error ? error : new Error(String(error));
      }
    },
  });

  pi.registerTool({
    name: "persona_pack",
    label: "Persona Pack",
    description: "Manage global official/custom persona packs: browse the catalog, install/update/uninstall official packs, create/fork/edit/delete custom packs through validated drafts, switch this session's team (team), set the default team for new sessions (default), and convert an older workspace persona setup (migrate).",
    promptSnippet: "Persona packs are global, not project files -- no project foundation is required first. install/update/uninstall act on official packs; create/fork/edit/delete act on custom packs. create and edit stage an inactive draft on disk at the returned draftPath: read and edit its pack.yaml/agents/*.md/references/** files directly with ordinary file tools, then call preview to see the diff and apply to replace the active pack. update, uninstall, delete, and apply first return a confirm-required result describing the exact consequence without changing anything, plus a planId; call the same action again with confirmed: true and that exact planId (plus clearDefaultConfirmed: true when told the target is the current global default, or discardLocalEdits: true when told the official pack has local edits) to actually apply it. Never pass confirmed: true on the first call for these four actions, and never fabricate a planId -- it must come from that same call's own confirm-required result, or the apply is rejected; if anything about the pack changed since you previewed it, planId will no longer match and you must preview again. Installing, forking, creating, or editing a pack never activates it or changes any session's team; that is always a separate, explicitly approved team or default action. team, default, and migrate apply/rollback follow the same plan-then-approve contract, and their planId only works after the user has replied to the plan.",
    promptGuidelines: [
      "Use persona_pack when the user asks in plain language to find, try, copy, change, switch, or set up persona teams; they do not need to know /persona commands. Answer from persona_pack list/status results rather than guessing what is installed.",
      "With persona_pack, customize an official pack by forking it into a custom pack, then edit the fork: edit stages a draft you change with ordinary file tools, preview shows the user the diff, and apply needs their explicit approval of the exact plan. Bring the user's goal and expertise into the persona content itself; do not water it down.",
      "persona_pack changes to packs never change which team a session uses. After an apply, if this session uses that pack, tell the user it keeps its earlier copy and offer a refresh (action team with the same pack); separately offer to make a pack the default for new sessions (action default). Never switch or set a default on your own.",
      "For persona_pack team and default, when the user's request clearly names the scope (\"this session\", \"from now on\", \"for new sessions\") go straight to that plan; when it is ambiguous whether they mean this session or the default for new sessions, ask which one first.",
      "For persona_pack team/default/migrate apply/rollback: show the user the plan summary in plain words and stop; only after they explicitly approve that exact plan, call again with the given retry. A scheduled team switch or rollback happens after your response ends and Pi posts the outcome, so do not claim it is done.",
      "When you point the user to a persona they can use, say they can simply ask for it in chat; its /command is an optional shortcut.",
      "For an older workspace persona setup, use persona_pack migrate: inspect (or status), explain what would be copied and that the originals stay untouched, preview with the user's choices, then apply after approval. Migration never selects the new pack or makes it the default.",
    ],
    parameters: Type.Object({
      action: Type.String({
        enum: ["list", "status", "install", "update", "uninstall", "fork", "create", "edit", "preview", "apply", "cancel", "delete", "team", "default", "migrate"],
        description: "Persona pack lifecycle action; team = this session's team (select, refresh, none); default = the team new sessions start with; migrate = convert this workspace's older persona setup",
      }),
      operation: Type.Optional(Type.String({
        enum: ["inspect", "status", "preview", "cancel", "apply", "rollback"],
        description: "Required for migrate",
      })),
      leadName: Type.Optional(Type.String({ description: "migrate preview: the lead persona, when the workspace has more than one candidate" })),
      approvedPersonas: Type.Optional(Type.Array(Type.String(), { description: "migrate preview: personas to copy besides the lead" })),
      includeBaseline: Type.Optional(Type.Boolean({ description: "migrate preview: also copy the workspace baseline" })),
      target: Type.Optional(Type.String({
        description: "Bundled catalog name for install; installed/draft pack name (bare, or qualified official/<name> or custom/<name>) for every other action; for team/default an installed pack name or none (omit to see the current state); for migrate the destination custom pack name",
      })),
      source: Type.Optional(Type.String({
        description: "Source pack name for fork (bare or qualified)",
      })),
      confirmed: Type.Optional(Type.Boolean({
        description: "Required to carry out update/uninstall/delete/apply, a team or default change, or migrate apply/rollback; set true only on the retry given by that action's confirm-required result, after the user has replied approving it",
      })),
      planId: Type.Optional(Type.String({
        description: "Required alongside confirmed: true; must be the exact planId from that same action's own confirm-required result (update/uninstall/delete/apply, team, default, or migrate apply/rollback), not typed or guessed",
      })),
      discardLocalEdits: Type.Optional(Type.Boolean({
        description: "Required for update when the installed official pack has local edits not present in the recorded install",
      })),
      clearDefaultConfirmed: Type.Optional(Type.Boolean({
        description: "Required for uninstall/delete when the target is the current global default pack",
      })),
    }, { additionalProperties: false }),
    renderResult(result, { expanded }, theme, context = {} as any) {
      const shownText = (result.details as { display?: unknown } | undefined)?.display;
      const display = typeof shownText === "string" ? shownText : firstToolResultText(result);
      const lines = display.split("\n");
      const shown = expanded || lines.length <= PACK_PANEL_LINES ? display : lines.slice(0, PACK_PANEL_LINES).join("\n");
      let text = theme.fg(context.isError ? "error" : "toolOutput", shown);
      if (shown !== display) text += `\n${theme.fg("dim", keyHint("app.tools.expand", `for ${lines.length - PACK_PANEL_LINES} more lines`))}`;
      return new Text(text, 0, 0);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        if (params.action === "team") return await runTeamToolAction(params, ctx);
        if (params.action === "default") return await runDefaultToolAction(params, ctx);
        if (params.action === "migrate") return await runMigrateToolAction(params, ctx);
        // The lifecycle's own planId already proves freshness; the tool
        // additionally requires that this runtime showed that plan and the
        // user replied since, like team/default/migrate.
        if (params.confirmed === true) assertPackPlanApproved(ctx, params.planId);
        const result = await runGlobalPersonaPackAction(personaStoreRoot(), {
          ...params,
          currentSession: currentSessionPackOption(),
        });
        if (result.mode === "confirm-required" && result.planId) recordIssuedPlan(ctx, result.planId);
        else if (params.confirmed === true && typeof params.planId === "string") issuedChatPlans.delete(params.planId);
        const report = formatGlobalPersonaPackReport(result, { chat: true });
        const changedPack = result.mode === "apply" && (result.operation === "apply" || result.operation === "update");
        const agentNote = result.mode === "confirm-required"
          ? formatPackToolRetry(params, result)
          : result.mode === "draft"
            ? `Edit the draft files under ${result.draftPath} with your file tools, then call persona_pack preview and show the user what changed; apply needs their explicit approval.`
            : changedPack && result.qualifiedName === boundPackSession?.qualifiedName
              ? `This session still uses the copy of '${result.qualifiedName}' it loaded earlier. Offer to refresh it (persona_pack action team, target ${result.qualifiedName}); separately, you may offer to make it the default for new sessions (action default). Each needs its own approval.`
              : changedPack
                ? offerToUsePack(result.qualifiedName)
                : undefined;
        return textResult(result.mode === "confirm-required" ? `${report}\n\nNothing has changed yet.` : report, result, agentNote);
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          isError: true,
          details: { error: true },
        };
      }
    },
  });

  pi.on("session_start", async (event, ctx) => {
    try {
      // Pi 0.85.1 RPC new_session/switch_session/fork/clone bind extensions
      // twice on the same runtime, so session_start can fire again on this
      // instance. Release the snapshot an earlier session_start loaded
      // before binding another, or it is never disposed and stays on disk.
      const previousSession = boundPackSession;
      boundPackSession = undefined;
      if (previousSession && previousSession.activeChildCount === 0) {
        await previousSession.dispose().catch((error: unknown) => {
          console.error(`Pi Persona failed to dispose replaced pack session '${previousSession.qualifiedName}': ${error instanceof Error ? error.message : String(error)}`);
        });
      }
      restoreActivePersona(ctx, { resetIfMissing: true });
      const storeRoot = personaStoreRoot();
      const entries = ctx.sessionManager?.getBranch?.() ?? [];
      const { binding, unresolvedPending } = inspectTeamEntries(entries);
      if (unresolvedPending !== undefined) {
        await completePendingSwitch(ctx, storeRoot, unresolvedPending, binding);
      } else if (binding) {
        await rehydrateBinding(ctx, storeRoot, binding);
      } else if (event?.reason === "new" || (event?.reason === "startup" && !hasRecordedConversation(entries))) {
        // "startup" covers every ordinary CLI process boot -- Pi's own
        // sessionStartEvent defaults to reason "startup" whenever no
        // explicit event is supplied (dist/core/agent-session.js), which is
        // true both for a genuinely first-ever session AND for `--session
        // <file>` resuming an old session that predates this feature (no
        // team entries ever recorded either way, so there is nothing to
        // distinguish them by inspectTeamEntries alone). Telling those two
        // apart requires looking at the entries themselves: a historical
        // saved session that predates this feature still has real "message"
        // entries from its actual prior conversation, while a genuinely new
        // process boot does not. Only the latter is eligible for the
        // default; a `--session <file>` resume of old content is treated
        // like any other reload of an already-existing (if unbound) session.
        // "new" additionally covers ctx.newSession() called from a live
        // session. "resume"/"fork" are deliberately excluded even with no
        // entries: those only fire from a live switchSession()/fork() call,
        // where design draft §3's "Resume / reload | Preserve recorded team
        // identity" means preserving whatever this session already had --
        // nothing, in that case -- not retroactively adopting the default.
        await applyDefaultForNewSession(ctx, storeRoot);
      } else if (event?.reason === "startup" && hasRecordedConversation(entries)) {
        // The historical case the comment above names explicitly: a saved
        // session with real prior conversation that predates team-binding
        // entirely (no team entries ever recorded). Design draft §3's
        // "preserve recorded team identity" is about *resume/fork of a
        // session this feature already knows about*, not about giving a
        // recognized-but-unmigrated legacy project a permanent pass just by
        // always being reopened via `--session <file>` instead of started
        // fresh -- so this one historical-resume path, alone, still checks
        // the same migration gate a genuinely new session would.
        const migrationGate = await resolveMigrationGate(ctx);
        boundPackSession = undefined;
        if (migrationGate.blocked) {
          teamScopeState = "migration-required";
          pi.appendEntry(TEAM_BINDING_ENTRY_TYPE, { status: "migration-required" });
          sendPersonaOutput(pi, ctx, migrationGate.message!, "warning");
        } else if (migrationGate.migrated) {
          // Same reasoning as applyDefaultForNewSession's no-default branch:
          // an already-migrated workspace's ctx.cwd content is superseded,
          // not a valid fallback roster, even for this resumed-old-session path.
          teamScopeState = "none";
          pi.appendEntry(TEAM_BINDING_ENTRY_TYPE, { status: "none" });
        } else {
          teamScopeState = "legacy";
        }
      } else {
        boundPackSession = undefined;
        teamScopeState = "legacy";
      }
      if (activePersonaName && !boundPackSession && teamScopeState !== "legacy") setActivePersona(ctx, undefined);
      updateActivePersonaStatus(ctx);
      await refreshPersonaCommands(ctx);
    } catch (error) {
      console.error("Failed to register Pi Persona commands:", error);
    }
  });

  pi.on("session_shutdown", async () => {
    runtimeShutDown = true;
    pendingChatHandoff = undefined;
    cancelPersonaChildren();
    const session = boundPackSession;
    if (!session) return;
    // cancelPersonaChildren() only signals cancellation; it does not itself
    // wait for the in-flight native child(ren) to actually settle and
    // release their retain() on this snapshot. dispose() correctly refuses
    // to run while activeChildCount > 0 (never force-delete an active
    // reference, as a prior reviewer suggested), so give cancellation a
    // bounded window to actually take effect before attempting disposal.
    await waitForPersonaSessionIdle(session);
    try {
      await session.dispose();
    } catch (error) {
      // Best-effort with one retry, but never a silent swallow: a failed
      // cleanup here leaks a private pack snapshot on disk, which is worth
      // surfacing even though there is no UI left to report it to at
      // shutdown.
      await new Promise((resolve) => setTimeout(resolve, 250));
      try {
        await session.dispose();
      } catch (retryError) {
        console.error(
          `Pi Persona failed to dispose bound pack session '${session.qualifiedName}' on shutdown: ${retryError instanceof Error ? retryError.message : String(retryError)}`,
        );
      }
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    availableSkills = (event.systemPromptOptions?.skills ?? [])
      .filter((skill: any) => typeof skill?.name === "string" && typeof skill?.filePath === "string")
      .map((skill: any) => ({ name: skill.name, filePath: skill.filePath }));
    restoreActivePersona(ctx);
    if (!activePersonaName) {
      updateActivePersonaStatus(ctx);
      return undefined;
    }
    updateActivePersonaStatus(ctx);
    try {
      // A restored persona name (e.g. written by an older pi-personas, or
      // by this session while it was still unbound) must not pull a ctx.cwd
      // roster into a none/migration-required/missing-bound session.
      assertPersonaExecutionAllowed();
      const launch = await resolveAgentLaunchRequest(ctx.cwd, activePersonaName, boundTeamOptions());
      return {
        systemPrompt: `${event.systemPrompt}\n\n${launch.systemPrompt}`,
      };
    } catch (error) {
      const failedPersonaName = activePersonaName;
      const message = error instanceof Error ? error.message : String(error);
      setActivePersona(ctx, undefined);
      return {
        systemPrompt: `${event.systemPrompt}\n\n## Pi Persona\n\nPreviously active persona /${failedPersonaName} is not available in this session: ${message}. Answer normally and tell the user to run /persona-list or choose another persona.`,
      };
    }
  });

  pi.registerCommand("persona", {
    description: "Pi Persona setup, activation, and global persona-pack commands.",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const [subcommand = ""] = trimmed.split(/\s+/, 1);

      if (subcommand === "pack") {
        const parsed = parseGlobalPersonaPackArgs(trimmed.slice("pack".length));
        if (!parsed) {
          sendPersonaOutput(pi, ctx, personaPackUsage(), "error");
          return;
        }
        const storeRoot = personaStoreRoot();
        try {
          const baseParams = { ...parsed, currentSession: currentSessionPackOption() };
          if (GLOBAL_PACK_DESTRUCTIVE_ACTIONS.has(parsed.action)) {
            const plan = await runGlobalPersonaPackAction(storeRoot, baseParams);
            if (plan.mode !== "confirm-required") {
              sendPersonaOutput(pi, ctx, formatGlobalPersonaPackReport(plan), "info");
              return;
            }
            // A plan that will fail update's discardLocalEdits requirement
            // is doomed before the user even sees a confirm prompt: showing
            // one anyway means they say yes, wait, and then learn they had
            // to re-run the whole command with --discard-edits from the
            // start. Catch that here instead of spending a confirmation
            // round-trip on a plan that cannot succeed.
            if (parsed.action === "update" && plan.edited && !baseParams.discardLocalEdits) {
              sendPersonaOutput(pi, ctx, `${plan.summary} To replace them anyway, run /persona pack update ${parsed.target} --discard-edits.`, "error");
              return;
            }
            const approved = await ctx.ui.confirm("Confirm persona pack action", plan.summary);
            if (!approved) {
              sendPersonaOutput(pi, ctx, "Cancelled.", "info");
              return;
            }
            const applied = await runGlobalPersonaPackAction(storeRoot, {
              ...baseParams,
              confirmed: true,
              planId: plan.planId,
              clearDefaultConfirmed: true,
            });
            sendPersonaOutput(pi, ctx, formatGlobalPersonaPackReport(applied), "info");
            return;
          }
          const result = await runGlobalPersonaPackAction(storeRoot, baseParams);
          sendPersonaOutput(pi, ctx, formatGlobalPersonaPackReport(result), "info");
          if ((parsed.action === "create" || parsed.action === "edit") && result.mode === "draft") {
            pi.sendUserMessage(
              `Help me ${parsed.action === "create" ? "create" : "edit"} the persona pack '${parsed.target}'. Its draft files are on disk at ${result.draftPath}; read and edit them directly (pack.yaml, agents/*.md, references/**), then tell me when it is ready so I can preview and apply it.`,
              ctx.isIdle() ? undefined : { deliverAs: "followUp" },
            );
          }
        } catch (error) {
          sendPersonaOutput(pi, ctx, error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }

      if (subcommand === CHAT_HANDOFF_SUBCOMMAND) {
        await runChatHandoff(ctx, trimmed.slice(CHAT_HANDOFF_SUBCOMMAND.length).trim());
        return;
      }

      if (subcommand === "team") {
        const rest = trimmed.slice("team".length).trim();
        const storeRoot = personaStoreRoot();
        try {
          if (rest === "default" || rest.startsWith("default ")) {
            const value = normalizeCommandText(rest.slice("default".length));
            if (!value) {
              const current = await readGlobalDefaultPack(storeRoot);
              sendPersonaOutput(
                pi,
                ctx,
                current?.defaultPack ? `Persona default team: ${current.defaultPack}` : "Persona default team: none configured",
                "info",
              );
              return;
            }
            const target = value === "none" ? null : await resolveInstalledQualifiedPersonaPackName(storeRoot, value);
            await writeGlobalDefaultPack(storeRoot, target);
            sendPersonaOutput(
              pi,
              ctx,
              target
                ? `Persona default team set to '${target}'. This affects genuinely new sessions only; it does not change this session.`
                : "Persona default team cleared. New sessions will start with no team; this does not change this session.",
              "info",
            );
            return;
          }
          if (!rest) {
            const { official, custom } = await listGlobalPersonaPacks(storeRoot);
            const installed = [...official, ...custom].map((pack: any) => pack.qualifiedName);
            if (installed.length === 0) {
              sendPersonaOutput(pi, ctx, "No persona packs are installed. Run /persona pack install <name-or-path> first.", "info");
              return;
            }
            const labels = [...installed, "(none)"];
            const selected = await ctx.ui.select("Which persona team should this session use?", labels);
            if (!selected) return;
            await switchPersonaTeam(ctx, selected === "(none)" ? "none" : selected);
            return;
          }
          await switchPersonaTeam(ctx, normalizeCommandText(rest));
        } catch (error) {
          sendPersonaOutput(pi, ctx, error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }

      if (subcommand === "migrate") {
        const parsed = parsePersonaMigrateArgs(trimmed.slice("migrate".length));
        if (!parsed) {
          sendPersonaOutput(pi, ctx, personaMigrateUsage(), "error");
          return;
        }
        try {
          if (parsed.operation === "inspect") {
            const { text, level } = await inspectMigration(ctx);
            sendPersonaOutput(pi, ctx, text, level);
            return;
          }
          if (parsed.operation === "status") {
            const { text, level } = await migrationStatus(ctx);
            sendPersonaOutput(pi, ctx, text, level);
            return;
          }
          if (parsed.operation === "preview") {
            const { report } = await previewMigration(ctx, parsed);
            sendPersonaOutput(
              pi,
              ctx,
              [
                report,
                "",
                `Run /persona migrate apply ${parsed.name} to copy this into the global persona pack store (the workspace's original persona files are never changed), or /persona migrate cancel ${parsed.name} to discard this draft.`,
              ].join("\n"),
              "info",
            );
            return;
          }
          if (parsed.operation === "cancel") {
            sendPersonaOutput(pi, ctx, await cancelMigration(parsed.name), "info");
            return;
          }
          if (parsed.operation === "apply") {
            const hint = lastMigrationPreview?.name === parsed.name ? lastMigrationPreview : undefined;
            const result = await applyMigration(ctx, parsed.name, {
              expectedSourceDigest: hint?.sourceDigest,
              expectedActiveIntegrity: hint?.activeIntegrity,
              expectedDraftIntegrity: hint?.draftIntegrity,
            });
            sendPersonaOutput(
              pi,
              ctx,
              [
                ...migrationAppliedLines(result),
                `Run /persona team ${result.qualifiedName} to select it for this session, or /persona team default ${result.qualifiedName} to make it the default for new sessions. Neither happens automatically.`,
              ].join("\n"),
              "info",
            );
            return;
          }
          if (parsed.operation === "rollback") {
            await rollbackMigration(ctx, parsed.name);
            return;
          }
        } catch (error) {
          sendPersonaOutput(pi, ctx, error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }

      if (subcommand === "use") {
        const parsed = parsePersonaUseArgs(trimmed.slice("use".length));
        if (!parsed) {
          sendPersonaOutput(pi, ctx, "Usage: /persona use <name> [query]", "error");
          return;
        }
        await activatePersona(parsed.agentName, parsed.task, ctx);
        return;
      }

      if (subcommand === "status") {
        restoreActivePersona(ctx);
        const project = boundPackSession ? boundPackSession.project : await discoverPersonaProject(ctx.cwd);
        const activeAgent = project.agents.find((agent: any) => agent.name === activePersonaName);
        sendPersonaOutput(
          pi,
          ctx,
          [
            formatTeamStatusLine(boundPackSession, teamScopeState),
            activePersonaName
              ? `Active persona: ${formatActivePersonaLabel(activePersonaName, activeAgent?.role)}`
              : "Active persona: none",
          ].join("\n"),
          "info",
        );
        updateActivePersonaStatus(ctx);
        return;
      }

      if (subcommand === "clear") {
        setActivePersona(ctx, undefined);
        sendPersonaOutput(pi, ctx, "Active persona: none", "info");
        return;
      }

      if (subcommand === "doctor") {
        const result = await runDoctor(ctx.cwd, { storeRoot: personaStoreRoot(), team: currentTeamOption() });
        const report = formatDoctorReport(result);
        const level = result.status === "error" ? "error" : result.status === "warning" ? "warning" : "info";
        sendPersonaOutput(pi, ctx, report, level);
        return;
      }

      if (subcommand === "onboard" || (subcommand === "init" && trimmed === "init")) {
        try {
          const parsed = parsePersonaOnboardArgs(subcommand === "onboard" ? trimmed.slice("onboard".length) : "");
          const project = await discoverPersonaProject(ctx.cwd);
          if (project.baseline) {
            let status;
            try {
              status = await statusPersonaInitFromManifest(ctx.cwd, parsed.out);
            } catch (error) {
              if ((error as any)?.code !== "ENOENT") throw error;
            }
            const doctor = await runDoctor(ctx.cwd, { team: currentTeamOption() });
            sendPersonaOutput(pi, ctx, [
              status?.items.every((item: any) => item.state === "done") && doctor.status !== "error"
                ? "Pi Persona onboarding is complete."
                : "Pi Persona is already set up in this workspace.",
              "",
              formatDoctorReport(doctor),
              "",
              formatPersonaList(project),
            ].join("\n"), doctor.status === "error" ? "error" : "info");
            return;
          }
          const result = await createPersonaInitDraft(ctx.cwd, parsed.out, { resume: true });
          sendPersonaOutput(pi, ctx, formatPersonaInitManifestReport(result), "info");
          pi.sendUserMessage(
            formatPersonaInitDraftAuthoringPrompt(result),
            ctx.isIdle() ? undefined : { deliverAs: "followUp" },
          );
        } catch (error) {
          sendPersonaOutput(pi, ctx, error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }

      sendPersonaOutput(pi, ctx, personaUsage(), "info");
    },
  });

  pi.registerCommand("persona-list", {
    description: "List available Pi Persona agents",
    handler: async (_args, ctx) => {
      try {
        const project = await refreshPersonaCommands(ctx);
        sendPersonaOutput(pi, ctx, formatPersonaList(project), "info");
      } catch (error) {
        sendPersonaOutput(pi, ctx, error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("persona-roundtable", {
    description: "Run a Pi Persona round-table over selected specialists",
    handler: async (args, ctx) => {
      const query = normalizeCommandText(args);
      if (!query) {
        ctx.ui.notify('Usage: /persona-roundtable "query"', "error");
        return;
      }
      try {
        await refreshPersonaCommands(ctx);
        restoreActivePersona(ctx);
        // Centralized scope guard (see assertPersonaExecutionAllowed): only
        // "legacy" keeps this workspace's own ctx.cwd round-table roster
        // usable. "none", "missing-bound", and "migration-required" all
        // refuse rather than silently falling back to an unrelated roster.
        assertPersonaExecutionAllowed();
        let selectionRequest;
        try {
          selectionRequest = await resolveRoundtableSelectionRequest(ctx.cwd, {
            query,
            activePersona: activePersonaName,
          }, boundTeamOptions());
        } catch (error) {
          // A bound team is exactly one pack (resolveBoundTeam), so there is
          // never a multi-pack choice to disambiguate here.
          if (boundPackSession) throw error;
          const choices = (error as any)?.code === "ROUNDTABLE_PACK_REQUIRED"
            ? (error as any).packs
            : undefined;
          if (!Array.isArray(choices) || choices.length === 0) throw error;
          const labels = choices.map((choice: any) => (
            `${choice.name} — [G] ${choice.moderator ?? "missing moderator"}`
          ));
          const selected = await ctx.ui.select("Which team should host this roundtable?", labels);
          if (!selected) return;
          const pack = choices[labels.indexOf(selected)]?.name;
          selectionRequest = await resolveRoundtableSelectionRequest(ctx.cwd, { query, pack });
        }
        await assertPersonaRuntimeReady(ctx.cwd);
        pendingRoundtable = {
          cwd: ctx.cwd,
          query: selectionRequest.query,
          moderator: selectionRequest.generalist.name,
          pack: selectionRequest.pack,
        };
        await activatePersona(selectionRequest.generalist.name, selectionRequest.userMessage, ctx);
      } catch (error) {
        sendPersonaOutput(pi, ctx, error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}

const SHUTDOWN_CHILD_SETTLE_TIMEOUT_MS = 5_000;
const SHUTDOWN_CHILD_SETTLE_POLL_MS = 25;

// Polls activeChildCount rather than requiring child-runner.js to expose an
// awaitable "settled" signal: cancelPersonaChildren() already rejects each
// in-flight runPersonaChild() promise, and the caller's own finally block
// releases this session's retain() as a reaction to that rejection, so
// activeChildCount reaching 0 is the accurate signal that dispose() will no
// longer refuse. Bounded, not indefinite: a child that never settles must
// not hang process shutdown forever, and dispose() below still refuses (and
// is logged, not swallowed) rather than force-deleting an active reference.
async function waitForPersonaSessionIdle(session: { activeChildCount: number }): Promise<void> {
  const deadline = Date.now() + SHUTDOWN_CHILD_SETTLE_TIMEOUT_MS;
  while (session.activeChildCount > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, SHUTDOWN_CHILD_SETTLE_POLL_MS));
  }
}

// A historical saved session (loaded via `--session <file>`, reason
// "startup") has real conversation entries even though it never recorded a
// team-binding entry (it predates this feature). A genuinely new process
// boot has none. Only entry.type === "message" counts: custom entries (ours
// or another extension's) do not represent an actual prior conversation.
function hasRecordedConversation(entries: any[]): boolean {
  return entries.some((entry) => entry?.type === "message");
}

function normalizeCommandText(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

// Truthful /persona status: "no bound team" is not one single state. Explicit
// none, a not-yet-migrated legacy project, and a recorded-but-unloadable
// binding all leave boundPackSession undefined, but they are not the same
// thing and must not be reported identically as a bare "Persona team: none"
// (which reads as "never configured", hiding that recovery may be needed).
function formatTeamStatusLine(
  boundPackSession: { qualifiedName: string } | undefined,
  teamScopeState: "legacy" | "bound" | "none" | "migration-required" | "missing-bound",
  options: { chat?: boolean } = {},
): string {
  if (boundPackSession) return `Persona team: ${boundPackSession.qualifiedName}`;
  const chat = options.chat === true;
  switch (teamScopeState) {
    case "none":
      return chat
        ? "Persona team: none (no team is selected for this session)"
        : "Persona team: none (no team is selected for this session; run /persona team to choose one)";
    case "migration-required":
      return chat
        ? "Persona team: none (this workspace's persona setup predates global persona packs; its own personas are unavailable until an installed team is chosen or the setup is migrated)"
        : "Persona team: none (this workspace's persona setup predates global persona packs; its own persona commands are blocked until you run /persona team to choose an installed team; run /persona migrate status for migration details)";
    case "missing-bound":
      return chat
        ? "Persona team: none (the bound pack could not be loaded; a valid installed team needs to be chosen)"
        : "Persona team: none (the bound pack could not be loaded; run /persona team to choose a valid pack)";
    default:
      return "Persona team: none";
  }
}

// Tool-only retry instruction for a confirm-required persona_pack result:
// the plan's own summary stays plain user-facing text (it is also what the
// /persona pack confirm dialog shows), so the exact structured parameters
// for the approved retry are spelled out here, separately.
function formatPackToolRetry(params: { action: string; target?: string; source?: string }, result: { confirmParams?: Record<string, unknown> }): string {
  const retry = {
    action: params.action,
    ...(params.target !== undefined ? { target: params.target } : {}),
    ...(params.source !== undefined ? { source: params.source } : {}),
    ...(result.confirmParams ?? {}),
  };
  return `Only after the user explicitly approves this exact plan, call persona_pack again with ${JSON.stringify(retry)}.`;
}

function chatPlanId(sessionId: string, parts: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify({ sessionId, ...parts })).digest("hex");
}

function migrationAppliedLines(result: { qualifiedName: string; receiptPath: string }): string[] {
  return [
    `Migration applied: ${result.qualifiedName} now exists in the global persona pack store. The workspace's original persona files were not changed.`,
    `A private backup and receipt were written under ${result.receiptPath.replace(/receipt\.json$/, "")} for review and rollback.`,
  ];
}

function requireToolTarget(target: unknown, action: string): string {
  if (typeof target !== "string" || !target.trim()) throw new Error(`persona_pack ${action} needs a target name`);
  return target.trim();
}

// persona_pack results: `display` is what the person sees in the tool panel
// (details.display, rendered by renderResult); `agentNote` is guidance only
// the model needs (retry parameters, "not done yet", what to offer next),
// so it is appended to the model-facing content but never displayed.
function textResult(display: string, details: Record<string, unknown>, agentNote?: string) {
  return {
    content: [{ type: "text" as const, text: agentNote ? `${display}\n\n${agentNote}` : display }],
    details: { ...details, display },
  };
}

function confirmRequiredResult(summary: string, retry: Record<string, unknown>, details: Record<string, unknown>) {
  return textResult(
    `${summary}\n\nNothing has changed yet.`,
    { ...details, summary },
    `Only after the user explicitly approves this exact plan, call persona_pack again with ${JSON.stringify(retry)}.`,
  );
}

const PACK_PANEL_LINES = 6;
const NOT_DONE_YET = "It has not happened yet, so do not tell the user it is done.";

function offerToUsePack(qualifiedName: string): string {
  return `It is not selected for any session or made the default. Offer to use '${qualifiedName}' in this session (persona_pack action team) or to make it the default for new sessions (action default); these are separate choices, each with its own approval.`;
}

async function leadNameOf(storeRoot: string, qualifiedName: string): Promise<string | undefined> {
  const { official, custom } = await listGlobalPersonaPacks(storeRoot);
  const pack = [...official, ...custom].find((candidate: any) => candidate.qualifiedName === qualifiedName);
  return pack?.personas?.find((persona: any) => persona.role === "generalist")?.name;
}

function formatActivePersonaLabel(name: string, role?: string): string {
  return role === "generalist" ? `[G] ${name} (/${name})` : `/${name}`;
}

function formatPersonaCommandError(agentName: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === `Unknown agent: ${agentName}`) {
    return `/${agentName} is not available in this session. Run /persona-list.`;
  }
  return message;
}

function personaUsage(): string {
  return [
    "Usage: /persona onboard [--out <file>]",
    "Usage: /persona use <name> [query]",
    "Usage: /persona status",
    "Usage: /persona clear",
    "Usage: /persona doctor",
    personaTeamUsage(),
    personaPackUsage(),
    personaMigrateUsage(),
  ].join("\n");
}

function personaTeamUsage(): string {
  return [
    "Usage: /persona team",
    "Usage: /persona team <name-or-none>",
    "Usage: /persona team default [<name-or-none>]",
  ].join("\n");
}

function personaMigrateUsage(): string {
  return [
    "Usage: /persona migrate inspect",
    "Usage: /persona migrate preview <name> [--lead <persona>] [--approve <persona1,persona2,...>] [--baseline]",
    "Usage: /persona migrate apply <name>",
    "Usage: /persona migrate cancel <name>",
    "Usage: /persona migrate status",
    "Usage: /persona migrate rollback <name>",
  ].join("\n");
}

type PersonaMigrateArgs =
  | { operation: "inspect" | "status" }
  | { operation: "cancel" | "apply" | "rollback"; name: string }
  | {
    operation: "preview";
    name: string;
    leadName?: string;
    approvedPersonas: string[];
    includeBaseline: boolean;
  };

function parsePersonaMigrateArgs(value: string): PersonaMigrateArgs | null {
  const tokens = value.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const [operation, ...rest] = tokens;

  if (operation === "inspect" || operation === "status") {
    return rest.length === 0 ? { operation } : null;
  }
  if (operation === "cancel" || operation === "apply" || operation === "rollback") {
    return rest.length === 1 ? { operation, name: rest[0] } : null;
  }
  if (operation === "preview") {
    if (rest.length === 0) return null;
    const [name, ...flags] = rest;
    let leadName: string | undefined;
    let approvedPersonas: string[] = [];
    let includeBaseline = false;
    for (let index = 0; index < flags.length; index += 1) {
      const flag = flags[index];
      if (flag === "--baseline") {
        includeBaseline = true;
        continue;
      }
      if (flag === "--lead") {
        leadName = flags[index + 1];
        index += 1;
        continue;
      }
      if (flag === "--approve") {
        approvedPersonas = (flags[index + 1] ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
        index += 1;
        continue;
      }
      return null;
    }
    return { operation, name, leadName, approvedPersonas, includeBaseline };
  }
  return null;
}

type GlobalPersonaPackAction =
  | "list"
  | "status"
  | "install"
  | "update"
  | "uninstall"
  | "fork"
  | "create"
  | "edit"
  | "preview"
  | "apply"
  | "cancel"
  | "delete";

const GLOBAL_PACK_ACTIONS = new Set<GlobalPersonaPackAction>([
  "list", "status", "install", "update", "uninstall",
  "fork", "create", "edit", "preview", "apply", "cancel", "delete",
]);

// update/uninstall/delete/apply are the only actions with a real consequence
// beyond an inactive draft or a brand-new identity (see pack-lifecycle.js's
// runGlobalPersonaPackAction docstring); the command handler always fetches
// their `confirm-required` plan first and shows it through ctx.ui.confirm
// before applying, matching design draft §2/§4's "explicitly confirms
// clearing a matching global default" for uninstall/delete.
const GLOBAL_PACK_DESTRUCTIVE_ACTIONS = new Set<GlobalPersonaPackAction>([
  "update", "uninstall", "delete", "apply",
]);

function parseGlobalPersonaPackArgs(value: string): {
  action: GlobalPersonaPackAction;
  target?: string;
  source?: string;
  discardLocalEdits?: boolean;
} | null {
  const tokens = value.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const [action, ...rest] = tokens;
  if (!GLOBAL_PACK_ACTIONS.has(action as GlobalPersonaPackAction)) return null;
  const typedAction = action as GlobalPersonaPackAction;
  if (typedAction === "list") return rest.length === 0 ? { action: typedAction } : null;
  if (typedAction === "status") return { action: typedAction, target: rest.join(" ") || undefined };
  if (typedAction === "fork") {
    return rest.length === 2 ? { action: typedAction, source: rest[0], target: rest[1] } : null;
  }
  if (typedAction === "update") {
    const discardIndex = rest.indexOf("--discard-edits");
    const discardLocalEdits = discardIndex >= 0;
    const remaining = rest.filter((_token, index) => index !== discardIndex);
    return remaining.length === 1 ? { action: typedAction, target: remaining[0], discardLocalEdits } : null;
  }
  return rest.length === 1 ? { action: typedAction, target: rest[0] } : null;
}

function personaPackUsage(): string {
  return [
    "Usage: /persona pack list",
    "Usage: /persona pack status [name]",
    "Usage: /persona pack install <bundled-catalog-name>",
    "Usage: /persona pack update <name> [--discard-edits]",
    "Usage: /persona pack uninstall <name>",
    "Usage: /persona pack fork <source> <new-name>",
    "Usage: /persona pack create <new-name>",
    "Usage: /persona pack edit <name>",
    "Usage: /persona pack preview <name>",
    "Usage: /persona pack apply <name>",
    "Usage: /persona pack cancel <name>",
    "Usage: /persona pack delete <name>",
  ].join("\n");
}

function parsePersonaUseArgs(value: string): { agentName: string; task: string } | null {
  const match = value.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return {
    agentName: match[1],
    task: match[2] ?? "",
  };
}

function formatConsultContextLine(context: unknown): string {
  return context === "fork"
    ? "Context: fork · current conversation branch inherited"
    : "Context: fresh · conversation history not included";
}

function formatRoundtableContextLine(context: unknown): string {
  return context === "fork"
    ? "Context: fork · current conversation branch inherited"
    : "Context: fresh · specialists receive only resolved persona context";
}

function truncatePanelText(value: unknown, maxLength: number): string {
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function firstToolResultText(result: any): string {
  const part = result?.content?.find((entry: any) => entry?.type === "text");
  return typeof part?.text === "string" ? part.text.trim() : "";
}

function stripConsultProgressHeading(value: string): string {
  return value.replace(/^\[pi-persona\] Consulting [^\n]+\n+/, "").trim();
}

function stripRoundtableProgressHeading(value: string): string {
  return value.replace(/^\[pi-persona\] Round-table\n+/, "").trim();
}

function createNativeRoundtableProcessDetails(roundtable: any, result: any, summary: any) {
  return {
    specialists: roundtable.roster.length,
    rounds: 2,
    expectedSteps: roundtable.roster.length * 2 + 1,
    completedSteps: result.steps.length,
    failedSteps: 0,
    ...summary,
  };
}

async function createNativeRequest(
  scope: any,
  task: string,
  context: string,
  toolCallId: string,
  ctx: any,
  loadedSkills: Array<{ name: string; filePath: string }>,
  frozenBranch?: any[],
  signal?: AbortSignal,
) {
  assertNotAborted(signal, "child launch");
  let requestedTools;
  try {
    requestedTools = resolveNativeChildTools(scope.tools);
  } catch (error) {
    throw new Error(`${scope.agent.name}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const skillPaths = scope.skills.map((name: string) => {
    const matches = loadedSkills.filter((skill) => skill.name === name);
    if (matches.length !== 1) {
      throw new Error(`Native backend requires exactly one loaded Pi skill named '${name}' for ${scope.agent.name}; found ${matches.length}.`);
    }
    return matches[0].filePath;
  });
  const { model, thinkingLevel } = resolveNativeModel(scope.agent.model, ctx);
  const dynamicProviders = ctx.modelRegistry.getRegisteredProviderIds?.() ?? [];
  if (dynamicProviders.includes(model.provider)) {
    throw new Error(`Native backend cannot use extension-registered provider '${model.provider}' because child extensions are disabled.`);
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);
  assertNotAborted(signal, "child launch");

  return {
    cwd: ctx.cwd,
    agentDir: getAgentDir(),
    sdkEntry: pathToFileURL(join(getPackageDir(), "dist/index.js")).href,
    authStorageEntry: pathToFileURL(join(getPackageDir(), "dist/core/auth-storage.js")).href,
    projectTrusted: ctx.isProjectTrusted(),
    personaName: scope.agent.name,
    systemPrompt: `${scope.prompt}\n\n## Native Child Boundary\n\nThis is a one-shot leaf session. Use only the tools declared for this persona and return the requested answer directly. Do not attempt delegation.`,
    task,
    model: { provider: model.provider, id: model.id },
    thinkingLevel,
    auth,
    skillNames: scope.skills,
    skillPaths,
    tools: requestedTools,
    context,
    branch: context === "fork" ? frozenBranch ?? snapshotForkBranch(ctx.sessionManager, toolCallId) : [],
  };
}

function assertNotAborted(signal: AbortSignal | undefined, operation: string) {
  if (signal?.aborted) throw new Error(`Native Pi Persona ${operation} was cancelled.`);
}

function resolveNativeModel(value: unknown, ctx: any) {
  if (typeof value !== "string" || !value.trim()) {
    if (!ctx.model) throw new Error("Native backend requires an active Pi model.");
    return { model: ctx.model, thinkingLevel: ctx.thinkingLevel };
  }
  const thinkingMatch = value.trim().match(/:(off|minimal|low|medium|high|xhigh|max)$/);
  const spec = thinkingMatch ? value.trim().slice(0, -thinkingMatch[0].length) : value.trim();
  const separator = spec.indexOf("/");
  const provider = separator < 0 ? undefined : spec.slice(0, separator);
  const id = separator < 0 ? spec : spec.slice(separator + 1);
  const matches = ctx.modelRegistry.getAll().filter((model: any) => model.id === id && (!provider || model.provider === provider));
  if (matches.length !== 1) throw new Error(`Native backend could not resolve persona model '${value}' uniquely; found ${matches.length}.`);
  return { model: matches[0], thinkingLevel: thinkingMatch?.[1] ?? ctx.thinkingLevel };
}

function combineUsage(usages: any[]) {
  const total: any = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  for (const usage of usages) {
    if (!usage) continue;
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) total[key] += Number(usage[key]) || 0;
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"]) total.cost[key] += Number(usage.cost?.[key]) || 0;
  }
  return total;
}

function formatRoundtableProcessLine(process: any): string {
  if (!process) return "";
  const parts = [
    `${process.specialists} specialists`,
    `${process.rounds} rounds`,
    `${process.completedSteps}/${process.expectedSteps} steps complete`,
    `${formatPanelDuration(process.elapsedMs)} elapsed`,
  ];
  if (process.toolCount > 0) parts.push(`${process.toolCount} tools`);
  if (process.turns > 0) parts.push(`${process.turns} turns`);
  if (process.categories?.files > 0) parts.push(`${process.categories.files} files`);
  if (process.sources > 0) parts.push(`${process.sources} external sources`);
  if (process.recoverableErrors > 0) parts.push(`${process.recoverableErrors} recoverable errors`);
  if (process.failedSteps > 0) parts.push(`${process.failedSteps} failed steps`);
  return parts.join(" · ");
}

function formatPanelDuration(value: unknown): string {
  const seconds = Math.max(0, Math.floor((Number(value) || 0) / 1_000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}:${String(seconds % 60).padStart(2, "0")}` : `${seconds}s`;
}

function createConsultProgressReporter(onUpdate: any, agent: string) {
  const tracker = createConsultProgressTracker(agent, { idleTimeoutMs: CONSULT_IDLE_TIMEOUT_MS });
  let latestUpdate: unknown;
  let lastPublishedAt = 0;

  const publish = (force = false) => {
    if (!onUpdate) return;
    const now = Date.now();
    if (!force && now - lastPublishedAt < 1_000) return;
    lastPublishedAt = now;
    onUpdate({
      content: [{ type: "text", text: tracker.format(now) }],
      details: latestUpdate,
    });
  };

  const heartbeat = setInterval(() => publish(true), CONSULT_HEARTBEAT_MS);
  (heartbeat as any).unref?.();
  publish(true);

  return {
    update(update: unknown) {
      latestUpdate = update;
      tracker.update(update);
      publish();
    },
    stop() {
      clearInterval(heartbeat);
    },
  };
}

function createRoundtableProgressReporter(onUpdate: any, roundtable: any) {
  const tracker = createRoundtableProgressTracker(roundtable.roster.map((agent: any) => agent.name), {
    idleTimeoutMs: false,
    moderator: formatPersonaDisplayName(roundtable.generalist),
  });
  let latestUpdate: unknown;
  let lastPublishedAt = 0;

  const publish = (force = false) => {
    if (!onUpdate) return;
    const now = Date.now();
    if (!force && now - lastPublishedAt < 1_000) return;
    lastPublishedAt = now;
    onUpdate({
      content: [{ type: "text", text: tracker.format(now) }],
      details: latestUpdate,
    });
  };

  const heartbeat = setInterval(() => publish(true), CONSULT_HEARTBEAT_MS);
  (heartbeat as any).unref?.();
  publish(true);

  return {
    update(update: unknown) {
      const firstUpdate = latestUpdate === undefined;
      latestUpdate = update;
      tracker.update(update);
      publish(firstUpdate);
    },
    summary() {
      return tracker.snapshot();
    },
    stop() {
      clearInterval(heartbeat);
    },
  };
}
