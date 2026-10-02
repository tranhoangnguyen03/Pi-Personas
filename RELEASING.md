# Releasing Pi Persona

## Automated Gates

Run from a clean checkout with the supported Node version:

```sh
npm ci
npm test
npm audit --omit=dev
npm pack --dry-run
git diff --check
```

The test command includes syntax and Pi 0.85.1 type checks, focused unit and
workflow tests, and a real offline Pi RPC smoke test that loads the packaged
extension and executes `/persona-list`.

## Manual Runtime Smoke

Use a disposable project with the packed `npm:pi-personas` artifact and a
disposable `PI_CODING_AGENT_DIR`. Pi Persona runs natively only; `pi-subagents`
is irrelevant to it. Confirm an installed `pi-subagents` package never alters
Pi Persona's own consults or round-tables, and that an explicit
`PI_PERSONA_BACKEND=legacy` (or a `.pi/persona.json` `{ "backend": "legacy" }`)
fails fast with an actionable error naming the setting, instead of silently
falling back:

1. Install `philosopher-7` with `/persona pack install philosopher-7` and bind
   a session to it with `/persona team philosopher-7`. Confirm installing
   never activates the pack by itself, `/persona-list` shows `[G] symposium`
   plus seven specialists, and `/persona status` reports the bound team.
2. Optionally run `/persona onboard` and confirm the separate, optional
   project foundation (shared context library) previews its 2–5 minute
   stages, creates no persona and no project coordinator, and has nothing to
   do with pack installation or team binding.
3. Ask `[G] symposium` for two independent specialist perspectives.
   Verify sibling `persona_consult` calls may run in parallel, both answers and
   provenance return, and no “one subagent call” rejection appears.
4. Run `/persona-roundtable <query>` and verify the bound pack's `[G]` lead
   chooses a visible pack-local roster, exactly one `persona_roundtable` call
   starts, the live box advances through Round 1, Round 2, and synthesis, and
   one substantive verdict returns without raw run IDs, paths, or
   subagent-control messages.
   Confirm every selected specialist's assigned contribution reaches both
   rounds, Round 2 restates a self-contained final position, and the final
   answer includes Answer, Perspective contributions, Real disagreements,
   Conditions and tradeoffs, Recommended decision, and What could change the
   answer without a shorter second paraphrase.
   Expand the call and verify query, context, roster reasons, phase explanations,
   stable per-persona state, next-step guidance, and the final process summary.
   Verify child extensions are absent, declared skills and built-in tools
   work, a failed specialist stops synthesis, and no `pi-subagents` request is
   ever emitted.
5. Fork `philosopher-7` into a custom pack, `/persona pack edit` it, and
   confirm `preview`/`apply` are confirmation-gated and show an accurate diff.
   Install or fork a second pack, bind a fresh session to it, and confirm
   `/persona-roundtable` runs directly on that session's pack, with no picker
   and no cross-pack option.
6. Install the packed artifact rather than the checkout, in a project with its
   own `node_modules` (no checkout-relative import), and run one native child.
   This verifies that `child-entry.js` imports the host Pi 0.85.1 SDK entry
   passed by the extension from the installed package, not a checkout-local
   module.
7. Run both `fresh` and `fork`; confirm fork includes only the active branch and
   excludes the in-flight `persona_consult` or `persona_roundtable` tool call.
8. With an authorized model, repeat the core journeys in plain chat without
   slash commands: discover teams, fork and edit a pack (preview, then
   approve), switch this session's team, set the default for new sessions,
   and migrate then roll back an older project setup. Confirm each change is
   shown as a plan, waits for a reply, and does nothing outside the stated
   scope.

## Persona Pack Acceptance

Follow the six product-acceptance milestones in
[`docs/_about_pi_persona/design.md`](docs/_about_pi_persona/design.md#manual-verification-milestones),
which cover global pack discovery, install/team/play, fork-or-create/edit/
apply, default-and-session-switching (both directions), missing/invalid
recovery, edit/remove of an actively-bound pack, and the release-artifact and
migration journeys. Milestone 6 starts earlier: install the actual packed Pi
Persona release, then run the release-candidate journeys. Consults and
round-tables run natively and need no `pi-subagents` install.

`scripts/task8-packed-acceptance/run-acceptance.mjs` automates the RPC-driven
parts of these milestones against the actual `npm pack` tarball installed
into a disposable project outside the checkout (own `node_modules`, no
checkout-relative import): pack lifecycle over RPC, default/session
switching in both directions, missing/invalid recovery, an actively-bound
pack's retained snapshot, migration original-preservation and rollback, and
the installed artifact's native child resolving the host Pi SDK from its own
node_modules. It does not replace the milestones' interactive/TUI and
provider-backed checks; the script ends by printing exactly what it did not
check.

## Publish

Releases are automated by `.github/workflows/release.yml`. When a PR merges to
`main`, CI runs `npm ci`, `npm test`, `npm audit --omit=dev`, and
`npm pack --dry-run`; on success the workflow tags `v<version>`, publishes to
npm with provenance, and creates a GitHub release whose notes come from the
matching `## <version>` CHANGELOG section (for example `## 0.4.0 - 2026-10-15`).
Every step is idempotent: merging without a version bump is a no-op, and a
re-run resumes at the first missing artifact.

To release a version:

1. Bump `package.json` to a version that is not yet published (check with
   `npm view pi-personas versions`) and run `npm install` to sync the
   lockfile. Merging new work without a bump publishes nothing.
2. Give the CHANGELOG section that exact version as its heading. Replace a
   `Unreleased` date with the release date before merging.
3. Merge the PR.

### One-time setup: npm trusted publishing

No `NPM_TOKEN` secret is stored. Publishing authenticates through GitHub
Actions OIDC. On npmjs.com, open the `pi-personas` package settings and add a
trusted publisher for this repository with workflow filename `release.yml`.
Verify the wiring any time with **Actions → release → Run workflow →
verify_only**; the `oidc-check` job must live in `release.yml` because npm
binds trusted publishers to the workflow filename.

Manual publishing from a checkout remains possible for emergencies
(`npm publish --access public && git push --follow-tags`) but bypasses the
automated gates.
