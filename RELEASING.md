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

From the Pi Persona repository root, use a disposable project and a real
configured model provider. Install the published child runtime first; Pi
Persona supports `pi-subagents` 0.34.0 or newer.

```sh
pi install npm:pi-subagents
REPO="$(pwd)"
PI_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
SUBAGENTS="$(npm root --prefix "$PI_AGENT_DIR/npm")/pi-subagents"
node -e 'console.log(require(process.argv[1]).version)' "$SUBAGENTS/package.json"
SMOKE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-persona-release.XXXXXX")"
cd "$SMOKE_DIR"
pi --no-extensions \
  --extension "$REPO/extensions/pi-persona.ts" \
  --extension "$SUBAGENTS/src/extension/index.ts" \
  --approve
```

The version command should print `0.34.0` at the time of this release. Add the
normal `--provider` and `--model` flags to the final command if Pi does not have
a usable default.

Inside Pi:

1. Run `/persona init`, then create two specialists:
   `/persona new reviewer --description "Reviews release risks."` and
   `/persona new strategist --description "Reviews rollout strategy."`.
   Run `/persona doctor` and `/persona-list`. Doctor must report the configured
   `pi-subagents` 0.34.0 runtime without errors.
2. Run `/persona use generalist`, send a normal follow-up, and check
   `/persona status`. Run `/persona clear` and confirm status is inactive.
3. Reactivate the generalist and ask it to call `persona_consult` exactly once,
   with `requester: generalist`, `consultant: reviewer`, and fresh context, to
   identify two release risks. Verify one consult starts, progress updates, the
   answer contains `## reviewer` and `Consulted:`, and no run IDs, artifact
   paths, intercom receipts, or raw subagent-control messages are shown.
4. Run `/persona-roundtable Decide whether this disposable project is ready to
   release; return one recommendation and one next action.` Verify the primary
   generalist selects from the visible roster, exactly one `persona_roundtable`
   call starts, and the live box advances through Round 1, Round 2, and
   Synthesis. Expand the call and verify the query, fresh context, roster
   reasons, phase explanations, per-persona state, next step, and process
   summary. The final output must contain one moderator verdict without raw run
   IDs, paths, intercom receipts, or a receipt-triggered second assistant turn.
5. Run assisted draft authoring and verify plan, confirmation-gated apply, and
   status through `persona_init`. Confirm an unchanged draft is rejected for
   unresolved template placeholders before plan or apply.

Exit Pi, then remove the disposable project with `rm -rf "$SMOKE_DIR"`.

## Publish

After the automated and manual gates pass:

```sh
npm version <patch|minor|major>
npm publish --access public
git push --follow-tags
```

Publishing and pushing are intentional maintainer actions; the test and release
scripts do not mutate npm or GitHub state.
