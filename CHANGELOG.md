# Changelog

## 0.2.1

- **Archive moves the session folder** into `~/.local/share/muse/archive/` (same yyyy/mm/dd path, with a small `<id>.archive.json`); Muse no longer lists it. **Unarchive** moves it back. Only main sessions can be archived; sub-agent records move with them. The old hide-only archive flags are dropped on upgrade.
- **Archived view**: Unarchive, Delete (to the Windows Recycle Bin), **Open Archive Folder** and **Empty Archive** (moves every archived session to the Recycle Bin after a confirmation). The archive filter in History was removed.
- Delete is labelled **Delete (Move to Windows Recycle Bin)**; the extension keeps no other copy, and Windows asks before permanently deleting anything it cannot recycle.

## 0.2.0

- **Static sidebar, refresh on demand.** History is read only when you press **Refresh** (or run an action that needs the engine, such as Move to Recycle Bin). There is no file watcher, timer, focus or visibility refresh, and no automatic refresh after a terminal closes. The view header shows when it was last refreshed.
- **No resident processes.** Each read starts the Muse engine host and stops it — and removes its temporary folder — as soon as the read finishes. Previously one engine host stayed alive for the whole VS Code session (~170 MB working set) and every refresh additionally ran `--version` twice.
- **Instant startup from the last refresh.** The result of the last refresh is saved as a small JSON snapshot in the extension's storage; a new VS Code window shows it immediately without starting any process. Only a first-ever start (no snapshot yet) reads once when the sidebar is first shown.
- **Faster reads.** The metadata scan of the sessions folder no longer spawns PowerShell; a full refresh of ~400 sessions dropped from ~3.3 s to ~1 s. Reparse points (junctions, symlinks, other tags) are still never followed.
- **Rename (F2).** Give any session a display name from the context menu or with F2. The name is stored by this extension (Muse 1.4.14 does not support renaming over its session protocol on Windows), is shown in both views, previews and new terminal titles, and is searchable alongside the original Muse title, which stays visible in the tooltip. **Restore Original Title** or an empty name clears it.
- **Archived view.** A dedicated **Archived** view under History lists every archived session (with its own search); click to open or switch to its terminal, or right-click to preview, rename, unarchive or recycle — no filter switching needed.
- Item context menus work in both views; item-only commands are hidden from the Command Palette.
- **Lighter previews.** Opening a preview or pressing "Load more" starts the engine for that read only. The Markdown renderer loads on the first preview, "Load more" renders only new or revised entries, and hidden preview tabs no longer keep their page alive in memory.
- The engine executable is validated (`--version`) once per file version instead of on every read.

## 0.1.3

- Added an original folder-and-history app icon, a theme-aware activity bar icon, and a matching documentation logo.

## 0.1.2

- Translated all extension-owned UI to English: activity bar and view titles, commands, menus, settings, tree descriptions and tooltips, preview pages (including `lang="en"`), notifications, warnings, error messages, and generated placeholders such as unindexed and sub-session titles.
- Marketplace packaging now uses the English `MARKETPLACE.md` as the store README (`--readme-path`); the bilingual source `README.md` is excluded from the VSIX.
- README rewritten as full equivalent English and Chinese guides, including archive vs. Recycle Bin recovery differences and migration from the earlier local publisher ID.

## 0.1.1

- Initial public source release of the locally validated Windows extension.
- Workspace grouping, previews, archive management and recoverable removal.
