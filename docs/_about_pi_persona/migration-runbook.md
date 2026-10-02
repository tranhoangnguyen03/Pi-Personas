# Migrating An Older Persona Project

Available from pi-personas 0.4.0. This runbook covers converting an **older
Pi Persona project** — a workspace whose own top-level generalist lives
directly under `.pi/agents/`, predating global persona packs — into a global
custom pack. Sessions in such a workspace start with no team and refuse to
run personas until it is migrated or another team is picked.

## In chat (default)

Open Pi in the workspace and ask, for example:

```text
This project has an old persona setup. What would converting it involve?
```

Pi inspects the setup, explains what would be copied and that the originals
stay untouched, previews your choices, and applies only after you approve the
exact plan. Rollback works the same way ("Roll back that migration"). Using
the new pack in this session, or making it the default, is a separate request
and approval.

If chat stalls, `/persona migrate status` tells you where the migration stands
and what to run next; the exact commands are below.

## Before you start: what this is not

**Migration is not a package/version downgrade, and rollback is not either.**
These are two unrelated operations that happen to share the word "roll
back" in everyday speech:

| | What it changes | What it never touches |
| --- | --- | --- |
| `/persona migrate rollback <name>` | This session's own team selection, and whether this workspace is recorded as migrated | The migrated pack in the global store; this workspace's original `.pi/agents/*.md` files; any installed npm package version |
| Downgrading `pi-personas` (e.g. `npm install pi-personas@<older>`) | Which version of this tool's code runs | Nothing about your persona data; an older version may not even have `/persona migrate` at all |

If you need to undo a bad **software update** (a broken release of
`pi-personas` itself), that is an ordinary package downgrade
(`npm install pi-personas@<previous-version>` in whatever project installed
it, or reverting your lockfile) — not a `/persona migrate` command. Do not
run `/persona migrate rollback` expecting it to reinstall an older version of
this tool; it cannot do that, and does not try to.

Releases before 0.4.0 have no `/persona migrate`. Downgrading to 0.3.x after
migrating makes that workspace use its original `.pi/agents` team again, and
editing `.pi/agents` there marks the migration `changed-source` after you
upgrade again; see the CHANGELOG's downgrade notes.

## The full lifecycle, exact commands (advanced)

These slash commands run the same operations as chat. They are copy/paste
exact; do not improvise flag names or ordering. Installing, forking, or
editing an already-global pack (`/persona pack ...`) is covered in the README.

Run these from inside the legacy workspace (the directory containing the
`.pi/agents/` you want to convert).

### 1. Inspect (read-only)

```
/persona migrate inspect
```

Reports whether this workspace is recognized as a legacy project, its
candidate lead(s), personas, declared `docs:` paths, and any decisions you
must make before migrating (an unsupported multi-lead shape, an unknown
declared tool). Writes nothing. Safe to run repeatedly, including before you
have decided to migrate at all.

### 2. Preview (stages a draft in the global store; workspace untouched)

```
/persona migrate preview <name> [--lead <persona>] [--approve <persona1,persona2,...>] [--baseline]
```

- `<name>` is the destination custom pack's name (`custom/<name>`).
- `--lead <persona>` is only required if `inspect` reported more than one
  candidate generalist.
- `--approve <persona1,persona2,...>` names every specialist to include.
  Nothing not named here leaves the workspace — there is no automatic
  content classifier. Re-read each specialist's description/body first if
  it might contain private project facts.
- `--baseline` includes `_baseline.md`'s `docs:`/`skills:` if present.

Preview reports a file diff (`added`/`changed`/`removed`) against the
destination and any semantic notices (e.g. a persona's `docs:` entry that
stays workspace-relative and will not resolve until the migrated pack later
runs in a workspace with that same relative path). Run it again any time the
source changes or you change your mind about `--approve`/`--lead`/
`--baseline` — each run replaces the staged draft.

### 3. Apply (the only step that mutates the global store)

```
/persona migrate apply <name>
```

Copy-only: writes a private backup and receipt under
`.pi/persona-migration/` in the workspace, then creates or updates
`custom/<name>` in the global store, then records a completion marker. It
never modifies, deletes, or renames anything under this workspace's own
`.pi/agents/`. If you previewed in the same session, apply refuses instead
of silently proceeding when either the legacy source or an already-existing
`custom/<name>` changed since that preview.

Nothing is selected or defaulted automatically. Follow up with one of:

```
/persona team <name>
/persona team default <name>
```

### 4. Status (read-only, any time)

```
/persona migrate status
```

Reports one of: `not-legacy`, `migration-required`, `changed-source`,
`destination-missing`, or `migrated`, plus a leftover-attempt note if a
previous apply's receipt does not match the current marker (e.g. the store
mutation succeeded but writing the completion marker itself failed) — that
note tells you the exact safe next command, which is almost always to run
`apply` again.

### 5. Cancel a staged draft you don't want

```
/persona migrate cancel <name>
```

Discards the draft staged by `preview`. Never touches the workspace or an
already-applied `custom/<name>`.

### 6. Rollback (this session's team selection only)

```
/persona migrate rollback <name>
```

`<name>` must match the destination this workspace actually migrated to
(shown by `status`); naming the wrong one is refused rather than guessed.
Rollback puts this session's team back to what it was right before that
`apply` (usually "needs migration") and marks the workspace as needing
migration again. It never deletes `custom/<name>` from the global store and
never touches this workspace's own `.pi/agents/` files. If the last `apply`
did not complete, there is nothing to roll back and `rollback` says so.

## Recovery scenarios

**A previous `apply` failed partway through.** Run `/persona migrate
status`. If it reports a leftover `failed` or `pending` receipt, the
previous good backup (if any) was left untouched; just run `preview` then
`apply` again — this is always safe to retry.

**The destination pack disappeared from the store** (`destination-missing`).
A private backup of the original legacy source remains under
`.pi/persona-migration/backup/` in the workspace. Run `preview` then `apply`
again to recreate the destination; this does not touch the workspace's own
files either way.

**You migrated, then decided the migrated pack itself needs different
content** (not just a different team selection). That is an ordinary custom
pack edit (`/persona pack ...`), not a migration rollback — rollback only
ever changes team selection and the marker, never the pack's own content.
