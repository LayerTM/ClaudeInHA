---
name: ha-backup
description: Create Home Assistant backups via the Supervisor before risky or large changes (destructive config edits, integration removals, core updates), or whenever the user asks to back up. Also covers where backups live and how to restore.
---

# ha-backup

Create a Home Assistant backup through the Supervisor before anything risky, and know how it gets restored.

## When to create a backup

Make a **named** backup BEFORE:
- Destructive or large config edits (rewriting `configuration.yaml`, bulk automation changes).
- Removing an integration or add-on.
- A Home Assistant Core / add-on update.
- Any change you are not sure you can cleanly undo.
- The user explicitly asks to back up.

When in doubt, back up. It is cheap; a broken instance is not.

## Create a backup

Always give it a descriptive, unambiguous name so it is easy to find later:

```bash
ha backups new --name "pre-automation-refactor-2026-07-02"
```

List existing backups (confirm yours was created, note its slug):

```bash
ha backups
```

Inspect one:

```bash
ha backups info <slug>
```

Full vs partial:
- `ha backups new` (as above) creates a **full** backup — all add-ons + HA config/folders. Use this by default before risky changes; it is the safest and needs no decisions.
- **Partial** backups (subset of add-ons/folders) are best created from the HA UI (Settings → System → Backups), where you can tick exactly what to include. Prefer a full backup from the CLI unless the user specifically wants a partial one.

## Where backups live

- Stored in **`/backup`** as `.tar` archives.
- From this add-on, treat `/backup` as **read-only** — do not write, move, or delete files there by hand. Manage backups only through `ha backups ...` or the HA UI.

## Restoring

Restore is **not** driven from here. Do it from Home Assistant:
- **HA UI:** Settings → System → Backups → pick the backup → Restore (choose full or partial). This is the recommended path.
- Or `ha backups restore <slug>` via Supervisor — this reboots/reconfigures Core, so only run it when the user has explicitly confirmed they want to roll back.

Tell the user the backup name/slug you created so they can find it in the UI if a restore is needed.

## Recommended flow around a risky change

```bash
# 1. Back up first
ha backups new --name "pre-<what-you-are-about-to-do>"

# 2. Make the change (edit the correct !included file, 2-space YAML)

# 3. Validate before applying
ha core check

# 4. Prefer reload over restart
ha core reload   # or: ha core restart, only if reload can't apply it
```

If validation fails or behavior breaks, point the user to the named backup for a UI restore.
