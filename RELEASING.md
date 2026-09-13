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

Use a disposable project with the packed `npm:pi-personas` artifact. Test
legacy with `npm:pi-subagents` loaded, then native with
`.pi/persona.json` set to `{ "backend": "native" }` and no `pi-subagents`.
Also verify default selection with no explicit backend: with `pi-subagents`
installed and no `.pi/persona.json`, `/persona doctor` reports `legacy`;
after uninstalling `pi-subagents`, it reports `native`:

1. Run `/persona onboard`, `/persona quick-start`, `/persona doctor`, and `/persona-list` in disposable workspaces.
2. Activate a persona with `/persona use generalist` and verify follow-up turns
   retain and clear active state correctly.
3. Run a focused `persona_consult` on each backend and verify the returned
   answer, provenance, cancellation, and nested usage accounting.
4. Run `/persona-roundtable <query>` and verify the primary generalist selects
   the visible roster, exactly one `persona_roundtable` call starts, the live box
   advances through Round 1, Round 2, and synthesis, and one final verdict is
   returned without raw run IDs, paths, or subagent-control messages.
   Expand the call and verify query, context, roster reasons, phase explanations,
   stable per-persona state, next-step guidance, and the final process summary.
   On legacy, verify the current `pi-subagents` release uses a foreground
   `workflowScript`, the 0.34.0-0.40.x compatibility path retains its chain
   payload, and no receipt-triggered assistant turn appears after synthesis.
   On native, verify child extensions
   are absent, declared skills and built-in tools work, a failed specialist
   stops synthesis, and no automatic legacy request is emitted.
5. Run assisted draft authoring and verify plan, confirmation-gated apply, and
   status through `persona_init`. Confirm an unchanged draft is rejected for
   unresolved template placeholders before plan or apply.
6. Install the packed artifact rather than the checkout and run one native
   child. This verifies that `child-entry.js` imports the host Pi 0.85.1 SDK
   entry passed by the extension instead of relying on checkout-local modules.
7. Run both `fresh` and `fork`; confirm fork includes only the active branch and
   excludes the in-flight `persona_consult` or `persona_roundtable` tool call.

## Publish

After the automated and manual gates pass:

```sh
npm version <patch|minor|major>
npm publish --access public
git push --follow-tags
```

Publishing and pushing are intentional maintainer actions; the test and release
scripts do not mutate npm or GitHub state.
