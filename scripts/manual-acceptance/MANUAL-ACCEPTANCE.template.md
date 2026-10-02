# Pi Persona — Manual Acceptance Kit

Isolated, disposable kit for manually trying the candidate Pi Persona
extension before it ships. Nothing here touches your real `~/.pi/agent` or
your real npm cache/config, and no model provider is configured unless you
add one for an authorized real-model pass. This kit was built
by `scripts/manual-acceptance/build-kit.mjs` from a real `npm pack` tarball
of the checkout below, installed offline into a disposable project outside
any git repo.

- **Kit path:** `{{KIT_ROOT}}`
- **Built:** `{{BUILT_AT}}`
- **Source commit:** `{{COMMIT}}` (worktree clean: `{{WORKTREE_CLEAN}}`)
- **pi-personas:** `{{PERSONA_VERSION}}` (tarball sha256 `{{PERSONA_SHA}}`)
- **Installed @earendil-works/pi-coding-agent:** `{{PI_CODING_AGENT_VERSION}}` (this kit's own `project/node_modules/.bin/pi`; this is the tested baseline, and is what the launcher runs — NOT your global `pi` (`{{GLOBAL_PI_VERSION}}`, if installed), which is a different, newer version.)
- Full hashes/versions of every tarball used: `MANIFEST.json` in this directory.

## Launch

```sh
{{KIT_ROOT}}/bin/launch.sh workspace
```

- `workspace` — a normal, empty disposable project (no pre-existing personas).
- `legacy` — a synthetic pre-pack-model project (`.pi/agents/coordinator.md` + `.pi/agents/writer.md`) for the `/persona migrate` walkthrough, kept separate from `workspace` on purpose.
- Any other path — used as-is for `cd` before launching pi.

Two terminals can run this concurrently. Both share the same
`PI_CODING_AGENT_DIR` (`{{KIT_ROOT}}/agent-dir` — same isolated settings,
same installed fixture packs, same session store), so `--session`,
`--session-id`, `--resume`/`-r`, `--continue`/`-c`, and `--fork` all forward
safely between the two terminals regardless of which workspace each one
uses:

```sh
{{KIT_ROOT}}/bin/launch.sh workspace -- --resume
{{KIT_ROOT}}/bin/launch.sh legacy    -- --continue
{{KIT_ROOT}}/bin/launch.sh workspace -- --session-id my-test-session
```

Sessions persist under `{{KIT_ROOT}}/agent-dir/sessions` (inside the kit,
nothing written to your real Pi session store).

The launcher passes `--no-skills --no-prompt-templates --no-themes
--no-context-files` so nothing from your real machine's skills, prompt
templates, themes, or AGENTS.md/CLAUDE.md discovery leaks in, and
`--extension {{EXTENSION_PATH}}` to load exactly the candidate build (the
installed tarball's own extension file, not this checkout's).

## No credentials configured — read this first

**Do not add API keys, OAuth credentials, or run `/login` in this kit
unless you have been separately authorized to do a real-model pass.** No
provider is configured, so on launch you will see:

```
Warning: No models available. Use /login to log into a provider via OAuth or
API key.
```

This is expected and correct for this pass. The deterministic commands
below — pack install/fork/preview/apply/cancel/delete, team switching,
migration — complete without a model. Some commands do **not**: after
`/persona pack create <name>` and `/persona pack edit <name>` stage their
draft, the extension queues an **assisted model turn** ("Help me
create/edit the persona pack …") so a persona can author the draft with
you. Without credentials that turn reports that no model is available; the
draft itself is still staged on disk and the rest of the lifecycle
(hand-edit or `stage-draft-change.mjs`, then preview/apply/cancel) still
works. Chat-first management, `persona_consult`, `/persona-roundtable`,
and the create/edit assisted turn need a working model. They are covered by
the separate real-model pass below, only after it has been authorized.

The launcher passes `--offline` by default. In pi this only disables
*startup* network operations (such as the self-update check); it does
**not** prohibit model calls — a configured provider would still be called
for a model turn. What keeps this pass model-free is that no credentials
are configured, not the flag. For a later, explicitly authorized
real-model pass, re-run with `PI_PERSONA_KIT_OFFLINE=0
{{KIT_ROOT}}/bin/launch.sh ...` (optional) and add credentials only then.

## What's pre-installed

Two custom fixture packs, schema 2, installed directly into the isolated
global store (`{{KIT_ROOT}}/agent-dir/persona/custom/`) — **no default team
is set**, so a fresh session starts unbound and team selection is always a
deliberate step you take yourself:

| Pack | Lead (`[G]`) | Specialist |
| --- | --- | --- |
| `custom/marketing` | `market-lead` | `market-analyst` |
| `custom/philosophy` | `philo-lead` | `philo-scout` |

The bundled official catalog (`philosopher-7`, `[G] symposium` + 7
specialists) is available but **not installed** — install it yourself
below to exercise the official-pack path.

Confirm the above yourself first:

```
/persona pack list
```

Expected: `custom/marketing` and `custom/philosophy` under Installed,
`philosopher-7` under Available to install (bundled catalog), `Default:
none configured`.

## UI-only walkthrough (no credentials, exact commands)

Run these inside the launched session. Every command below is copied
verbatim from this checkout's README/runbook and was exercised for real —
either through a live PTY (noted) or through the real RPC mode of this same
installed artifact (see Verification below for exactly which).

### Deliberate team selection

```
/persona status
/persona team custom/marketing
/persona status
/persona-list
/persona team custom/philosophy
/persona-list
/persona team none
/persona team default custom/marketing
/persona team default
```

`/persona team <name>` binds only this session (`/persona status` before
and after shows `Persona team: none` → `Persona team: custom/marketing`,
`Active persona: [G] market-lead`); `/persona team default <name>` sets the
default for *new* sessions (this one is unaffected until you rebind it) —
`/persona team default` with no name reports the current default.
`/persona team none` unbinds. Installing/forking/creating/editing a pack
never activates it — team selection is always this separate step.

### Official catalog: install / update / uninstall

```
/persona pack install philosopher-7
/persona pack status philosopher-7
/persona pack uninstall philosopher-7
```

`uninstall` (like `update`/`delete`/`apply`) computes its plan, then opens a
real interactive Y/N confirm dialog (`ctx.ui.confirm`) describing the exact
consequence before doing anything — it does not apply on the first command
and does not require retyping the command to confirm; answer the dialog
itself.

### Fork / edit / preview / apply (custom pack lifecycle)

```
/persona pack fork marketing my-fork
/persona pack edit my-fork
```

`edit` stages the draft and then queues an assisted model turn (see "No
credentials configured" above); without credentials, expect that turn to
report no model available — that is not a lifecycle failure. At this point
a draft exists on disk under
`{{KIT_ROOT}}/agent-dir/persona/drafts/my-fork/`. You can hand-edit
`pack.yaml`/`agents/*.md`/`references/**` there directly, or use the
deterministic helper (so you don't need to know that raw path yourself):

```sh
node {{KIT_ROOT}}/bin/stage-draft-change.mjs my-fork
```

Run this from a **second terminal** (or a shell pane) while the Pi session
stays open — it only touches the on-disk draft directory, not anything
live in the running session. Then back in Pi:

```
/persona pack preview my-fork
/persona pack apply my-fork
```

`apply` shows the pending diff, then opens the same Y/N confirm dialog as
`uninstall`/`update`/`delete` above — answer it to actually replace
`custom/my-fork` (or `/persona pack cancel my-fork` beforehand to discard
the draft instead of applying it). Clean up afterward if you want:

```
/persona pack delete my-fork
```

### Create from scratch

```
/persona pack create sales
```

Same draft/preview/apply/cancel lifecycle as edit, starting from an empty
draft instead of a fork — including the queued assisted model turn after
the draft is staged (expected to report no model available in this pass).

### Legacy migration (launch with `legacy`, not `workspace`)

```
{{KIT_ROOT}}/bin/launch.sh legacy
```

```
/persona migrate inspect
/persona migrate preview legacy-team --approve writer
/persona migrate apply legacy-team
/persona migrate status
/persona team custom/legacy-team
/persona migrate rollback legacy-team
/persona migrate status
```

`inspect` and `status` are read-only, safe to run repeatedly.
`apply` never modifies the legacy workspace's own `.pi/agents/*.md`
files — confirm this yourself with `cat legacy-workspace/.pi/agents/*.md`
from a separate shell before and after `apply`. `rollback` only changes
this session's team selection and the workspace's completion marker; it
never deletes `custom/legacy-team` from the store or touches the original
files.

### Doctor / status

```
/persona doctor
/persona status
/persona clear
```

## Chat-first pass (real model, only when authorized)

Chat is the default way to manage personas, so release acceptance includes
one pass in plain chat without slash commands. Run it only after a provider,
credentials scope, and spending limit have been agreed. Add only that
provider's models/auth to this kit's agent dir, launch with
`PI_PERSONA_KIT_OFFLINE=0`, then ask, for example:

```text
What persona teams can I use, and which one does this session use?
Make a copy of marketing I can edit and add a pricing specialist.
Switch this session to my copy.
From now on, start new sessions with philosophy.
```

In `legacy`:

```text
This project has an old persona setup. What would converting it involve?
Roll back that migration.
```

Check that every change is shown as a plain plan and waits for your reply,
that nothing outside the stated scope (this session versus new sessions)
changes, that a team switch replaces the `/` commands after the reply, that
the active persona can consult a specialist, and that migration leaves
`legacy-workspace/.pi/agents/*.md` unchanged and selects nothing.

## Verification already performed (read before re-verifying yourself)

- **`{{KIT_ROOT}}/bin/launch.sh workspace` was actually launched under a
  real PTY** (Python `pty`, not RPC mode): the TUI rendered, the extension
  panel showed `pi-persona.ts` loaded, the workspace path and "no models
  available" warning appeared correctly, and typing `/persona pack list`
  and pressing Enter rendered the real command output showing exactly
  `custom/marketing`, `custom/philosophy`, `philosopher-7` available, and
  `Default: none configured` — matching this doc's own "What's pre-installed"
  section above. This confirms the candidate extension actually loads and
  responds in a real interactive terminal, not just over RPC.
- **Every other command sequence in this doc** (team switching in both
  directions, install/uninstall philosopher-7, fork → edit → the
  `stage-draft-change.mjs` helper → preview → apply, and the full legacy
  migrate inspect/preview/apply/status/rollback cycle) was exercised for
  real against this exact same installed artifact (`{{PI_BIN_PATH}}` +
  `{{EXTENSION_PATH}}`, same `PI_CODING_AGENT_DIR` isolation) through pi's
  `--mode rpc`, using scratch copies of the store/workspace so the kit
  itself was left untouched (still no default team, `philosopher-7` still
  not installed) for you to do this yourself fresh. **RPC mode is not the
  TUI** — it proves the underlying command/store wiring behaves exactly as
  documented, not that the terminal rendering is correct beyond the one PTY
  pass above. Re-run `node scripts/manual-acceptance/verify-kit.mjs` from
  the source checkout at any time to repeat the RPC pass against this kit.
- **Not performed by the build:** any real model call (chat-first
  management, `persona_consult`, `/persona-roundtable`, the assisted turn
  `/persona pack create|edit` queues, or a persona actually answering a
  question) — no credentials are configured, by design; see the chat-first
  pass above. The RPC pass
  checks the create/edit draft plumbing, not a model response. A human has not sat at the keyboard and typed every command in
  this document by hand; the PTY pass above covers one representative
  command, the RPC pass covers the rest of the wiring. Treat this document
  as "verified plumbing, unverified human ergonomics" and do your own
  pass through the commands above to check the interactive experience
  itself (rendering, timing, confirm-dialog UX, error messages as actually
  displayed).

## Cleanup

Removes exactly this kit's directory tree, nothing else:

```sh
{{KIT_ROOT}}/bin/cleanup.sh
```

## Rebuilding

From the source checkout, re-running the build script wipes and rebuilds
this exact kit fresh (new tarball, fresh fixture packs, default still
none):

```sh
cd {{REPO_ROOT}}
node scripts/manual-acceptance/build-kit.mjs
node scripts/manual-acceptance/verify-kit.mjs
```
