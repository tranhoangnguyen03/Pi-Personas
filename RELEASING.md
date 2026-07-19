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

The test command includes syntax checks, focused unit and workflow tests, and a
real offline Pi RPC smoke test that loads the packaged extension and executes
`/persona-list`.

## Manual Runtime Smoke

Use a disposable project with `npm:pi-personas` and `npm:pi-subagents` loaded:

1. Run `/persona onboard`, `/persona quick-start`, `/persona doctor`, and `/persona-list` in disposable workspaces.
2. Activate a persona with `/persona use generalist` and verify follow-up turns
   retain and clear active state correctly.
3. Run a focused `persona_consult` and verify the returned answer and provenance.
4. Run `/persona-roundtable <query>` and verify the primary generalist selects
   the visible roster, exactly one `persona_roundtable` call starts, the live box
   advances through Round 1, Round 2, and synthesis, and one final verdict is
   returned without raw run IDs, paths, or subagent-control messages.
   Expand the call and verify query, context, roster reasons, phase explanations,
   stable per-persona state, next-step guidance, and the final process summary.
   Verify `pi-subagents` is at least 0.34.0 and that no `subagent-result` message
   or receipt-triggered assistant turn appears after the moderator synthesis.
5. Run assisted draft authoring and verify plan, confirmation-gated apply, and
   status through `persona_init`. Confirm an unchanged draft is rejected for
   unresolved template placeholders before plan or apply.

## Publish

After the automated and manual gates pass:

```sh
npm version <patch|minor|major>
npm publish --access public
git push --follow-tags
```

Publishing and pushing are intentional maintainer actions; the test and release
scripts do not mutate npm or GitHub state.
