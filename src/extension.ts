import * as vscode from 'vscode';
import { readFile, mkdir, writeFile, rename as renameFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { CatalogService } from './backend/catalogService';
import { HistoryTree, type HistoryNode } from './ui/tree';
import { SessionTerminals } from './ui/terminals';
import { HistoryPreview } from './ui/preview';
import { applyDisplayNames, MAX_DISPLAY_NAME, normalizeDisplayName, type CatalogInventory, type CatalogRow } from './shared/sessionCatalog';

interface PrivateTestConfig { env: NodeJS.ProcessEnv; enginePath: string; extraArgs: string[] }
let service: CatalogService | undefined;

async function testConfiguration(context: vscode.ExtensionContext): Promise<PrivateTestConfig | undefined> {
  if (context.extensionMode === vscode.ExtensionMode.Production || !process.env.MUSE_HISTORY_TEST_CONFIG) return undefined;
  const value: unknown = JSON.parse(await readFile(process.env.MUSE_HISTORY_TEST_CONFIG, 'utf8'));
  if (!value || typeof value !== 'object') throw new Error('Invalid isolated test configuration');
  const config = value as Record<string, unknown>;
  const env = config.env as Record<string, unknown> | undefined;
  const keys = ['HOME', 'USERPROFILE', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'APPDATA', 'LOCALAPPDATA'];
  if (!env || !keys.every(key => typeof env[key] === 'string' && isAbsolute(env[key] as string)) ||
      typeof config.enginePath !== 'string' || !isAbsolute(config.enginePath) ||
      !Array.isArray(config.extraArgs) || !config.extraArgs.every(arg => typeof arg === 'string')) throw new Error('Test configuration requires all isolated home paths and native engine');
  return { env: { ...process.env, ...(env as NodeJS.ProcessEnv), MUSE_NO_AUTO_UPDATE: '1' }, enginePath: config.enginePath, extraArgs: config.extraArgs };
}

export async function activate(context: vscode.ExtensionContext) {
  const test = await testConfiguration(context);
  await mkdir(context.globalStorageUri.fsPath, { recursive: true });
  service = new CatalogService({ storagePath: context.globalStorageUri.fsPath, nativeHelperPath: context.asAbsolutePath('bin/muse-history-recycle.exe'), enginePath: test?.enginePath || vscode.workspace.getConfiguration('museHistory').get<string>('enginePath') || undefined, env: test?.env, extraServeArgs: test?.extraArgs });
  const catalog = service;
  const namesKey = 'displayNames.v1';
  const names = () => context.globalState.get<Record<string, string>>(namesKey, {});
  // 0.2.1: Archive moves the session folder into the archive folder. The old
  // hide-only flags are dropped once; those sessions simply show in History again.
  const legacyArchiveKey = 'archiveIds.v1';
  const legacyFlags = context.globalState.get<string[]>(legacyArchiveKey, []);
  if (legacyFlags.length) {
    await context.globalState.update(legacyArchiveKey, undefined);
    if (!test) void vscode.window.showInformationMessage(`Muse History: Archive now moves a session into the archive folder (${catalog.getArchiveRoot()}). ${legacyFlags.length} session(s) hidden by the old archive flag are shown in History again; archive them again to move them.`);
  }
  const noFlags = () => [] as string[];
  const tree = new HistoryTree(noFlags, 'all');
  const archivedTree = new HistoryTree(noFlags, 'all');
  /** Sessions currently in the archive folder (read from their metadata files, no engine). */
  let archivedRows: CatalogRow[] = [];
  const view = vscode.window.createTreeView('museHistory.sessions', { treeDataProvider: tree, showCollapseAll: true });
  const archivedView = vscode.window.createTreeView('museHistory.archived', { treeDataProvider: archivedTree, showCollapseAll: true });
  const terminals = new SessionTerminals(await SessionTerminals.owner(context.globalState), () => catalog.getEnginePath(), context.globalState, test ? { env: test.env, extraArgs: test.extraArgs } : undefined);
  const previews = new Map<string, HistoryPreview>();
  let inventory: CatalogInventory | undefined;
  /** Rows as last read (with owned-terminal workspaces), before local display names. */
  let baseRows: CatalogRow[] = [];
  let refreshing: Promise<CatalogInventory> | undefined;
  let refreshedAt: number | undefined;
  let lastSelectedView: vscode.TreeView<HistoryNode> = view;
  let lastError = '';
  const anyVisible = () => view.visible || archivedView.visible;
  /**
   * Static sidebar: history is read ONLY when the user presses Refresh (or
   * runs an action that needs the engine, such as Move to Recycle Bin). There
   * is no watcher, timer, focus or visibility refresh. Each read starts the
   * engine host and stops it as soon as the read finishes. The last result is
   * saved as a small JSON snapshot so the next VS Code start can show it
   * without starting any process.
   */
  const snapshotFile = join(context.globalStorageUri.fsPath, 'last-inventory.v1.json');
  const updateDescription = () => {
    const when = refreshedAt ? `Refreshed ${new Date(refreshedAt).toLocaleString()}` : '';
    view.description = [tree.query, refreshing ? 'Refreshing…' : when].filter(Boolean).join(' · ');
    view.message = lastError ? `${lastError}${inventory ? '\n(Showing the last successful read.)' : ''}`
      : !inventory ? (refreshing ? 'Reading local Muse history…' : 'Press Refresh to read local Muse history.') : tree.groups.length ? (inventory.warnings.length ? inventory.warnings.join('\n') : undefined) : 'No matching history. Search or refresh.';
    archivedView.description = [`${archivedRows.length} archived`, archivedTree.query].filter(Boolean).join(' · ');
    archivedView.message = archivedTree.groups.length ? undefined
      : archivedTree.query ? 'No archived session matches this search.' : `No archived sessions. Right-click a main session in History and choose Archive to move it to ${catalog.getArchiveRoot()}.`;
  };
  /** Re-renders both views from the last read plus current local names. No engine access. */
  const render = () => {
    tree.update(applyDisplayNames(baseRows, names()));
    archivedTree.update(applyDisplayNames(archivedRows, names()));
    updateDescription();
  };
  const reloadArchived = async () => { archivedRows = await catalog.listArchived(); };
  const saveSnapshot = async (result: CatalogInventory, at: number) => {
    const temporary = `${snapshotFile}.tmp`;
    await writeFile(temporary, JSON.stringify({ at, inventory: result, archived: archivedRows }));
    await renameFile(temporary, snapshotFile);
  };
  /** Shows the last refresh without starting any process; false when there is none. */
  const loadSnapshot = async (): Promise<boolean> => {
    try {
      const saved = JSON.parse(await readFile(snapshotFile, 'utf8')) as { at?: unknown; inventory?: CatalogInventory; archived?: CatalogRow[] };
      if (typeof saved.at !== 'number' || !saved.inventory || !Array.isArray(saved.inventory.sessions)) return false;
      inventory = saved.inventory;
      refreshedAt = saved.at;
      baseRows = saved.inventory.sessions;
      archivedRows = Array.isArray(saved.archived) ? saved.archived : [];
      render();
      return true;
    } catch { return false; }
  };
  const refresh = (): Promise<CatalogInventory> => {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      updateDescription();
      const result = await catalog.refresh();
      inventory = result;
      lastError = '';
      refreshedAt = Date.now();
      await terminals.reconnect(result.sessions);
      baseRows = await terminals.withOwnedWorkspaces(result.sessions);
      await reloadArchived();
      render();
      void saveSnapshot(result, refreshedAt).catch(() => undefined);
      return result;
    })().catch(error => {
      lastError = `Read failed: ${error instanceof Error ? error.message : String(error)}. Check the engine path, then refresh.`;
      throw error;
    }).finally(() => { refreshing = undefined; updateDescription(); });
    return refreshing;
  };
  const report = (error: unknown) => { void vscode.window.showErrorMessage(`Muse History: ${error instanceof Error ? error.message : String(error)}`); };
  const register = (name: string, handler: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(`museHistory.${name}`, async (...args) => { try { return await handler(...args); } catch (error) { report(error); return undefined; } }));
  /** Context-menu commands receive the node; keybindings receive nothing and use the focused view's selection. */
  const target = (value?: HistoryNode | string): CatalogRow => {
    if (value !== undefined && typeof value !== 'string') return tree.row(value);
    if (typeof value === 'string') return tree.forest.treeById.get(value)?.row ?? archivedTree.row(value);
    const selected = lastSelectedView.selection[0] ?? view.selection[0] ?? archivedView.selection[0];
    if (!selected || selected.type !== 'session') throw new Error('Select a session in the Muse history list first.');
    return selected.tree.row;
  };
  /** Archive: move the session folder (with its sub-agent records) into the archive folder. */
  const archive = async (value: HistoryNode | string) => {
    const row = target(value);
    if (row.archived_at) throw new Error('This session is already in the archive folder.');
    const result = await catalog.archive(row.session_id, terminals.inUseIds());
    await refresh();
    if (result.status === 'archived') void vscode.window.showInformationMessage(`Muse History: archived "${row.title || row.session_id}". ${result.message}`);
    else void vscode.window.showWarningMessage(`Muse History: ${result.message}`);
    return result;
  };
  /** Unarchive: move the folder back to Muse's sessions folder. */
  const unarchive = async (value: HistoryNode | string) => {
    const row = target(value);
    if (!row.archived_at) throw new Error('This session is not in the archive folder.');
    const result = await catalog.unarchive(row.session_id);
    await refresh();
    if (result.status === 'unarchived') void vscode.window.showInformationMessage(`Muse History: "${row.title || row.session_id}" is back in History.`);
    else void vscode.window.showWarningMessage(`Muse History: ${result.message}`);
    return result;
  };
  const setArchived = (value: HistoryNode | string, archived: boolean) => archived ? archive(value) : unarchive(value);
  const forgetNames = async (ids: Iterable<string>) => {
    const purged = new Set(ids);
    await context.globalState.update(namesKey, Object.fromEntries(Object.entries(names()).filter(([id]) => !purged.has(id))));
  };
  /** Empty Archive: every archived folder goes to the Windows Recycle Bin (recoverable there until it is emptied). */
  const emptyArchive = async (confirmed = false) => {
    await reloadArchived();
    render();
    if (!archivedRows.length) { void vscode.window.showInformationMessage('Muse History: the archive is already empty.'); return { recycled: 0, failed: [] as string[] }; }
    if (!confirmed) {
      const choice = await vscode.window.showWarningMessage(`Move all ${archivedRows.length} archived session(s) to the Windows Recycle Bin?`, { modal: true, detail: `${archivedRows.map(row => row.title || row.session_id).join('\n')}\n\nThey can still be restored from the Windows Recycle Bin until it is emptied.` }, 'Move All to Recycle Bin');
      if (choice !== 'Move All to Recycle Bin') return undefined;
    }
    const failed: string[] = [];
    const recycled: string[] = [];
    for (const row of [...archivedRows]) {
      try {
        const result = await catalog.recycleArchived(row.session_id);
        if (result.status === 'recycled') recycled.push(row.session_id); else failed.push(`${row.title || row.session_id}: ${result.message}`);
      } catch (error) { failed.push(`${row.title || row.session_id}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    await forgetNames(recycled);
    await reloadArchived();
    render();
    if (inventory && refreshedAt) void saveSnapshot(inventory, refreshedAt).catch(() => undefined);
    if (failed.length) void vscode.window.showWarningMessage(`Muse History: moved ${recycled.length} to the Recycle Bin; ${failed.length} failed.`, { modal: false, detail: failed.join('\n') });
    else void vscode.window.showInformationMessage(`Muse History: moved ${recycled.length} archived session(s) to the Windows Recycle Bin.`);
    return { recycled: recycled.length, failed };
  };
  const rename = async (value?: HistoryNode | string, requested?: string) => {
    const row = target(value);
    const original = row.original_title ?? row.title;
    let input = requested;
    if (input === undefined) {
      const current = row.title || '';
      input = await vscode.window.showInputBox({
        title: 'Rename Muse Session',
        prompt: `Display name in this sidebar (stored by the extension; Muse itself keeps its own title). Leave empty to restore: ${original || row.session_id}`,
        value: current,
        valueSelection: [0, current.length],
        validateInput: text => text.length > MAX_DISPLAY_NAME ? `At most ${MAX_DISPLAY_NAME} characters.` : undefined,
      });
      if (input === undefined) return undefined;
    }
    const name = normalizeDisplayName(input);
    const next = { ...names() };
    if (!name || name === original) delete next[row.session_id]; else next[row.session_id] = name;
    await context.globalState.update(namesKey, next);
    render();
    return next[row.session_id] ?? original;
  };
  register('refresh', refresh);
  register('search', async () => {
    const query = await vscode.window.showInputBox({ title: 'Search Muse History', prompt: 'Match titles, renamed titles or folder paths; empty shows all. Parents are kept when a child matches.', value: tree.query });
    if (query !== undefined) { tree.query = query.trim(); render(); }
  });
  register('searchArchived', async () => {
    const query = await vscode.window.showInputBox({ title: 'Search Archived Muse Sessions', prompt: 'Match titles, renamed titles or folder paths; empty shows all archived sessions.', value: archivedTree.query });
    if (query !== undefined) { archivedTree.query = query.trim(); render(); }
  });
  register('emptyArchive', () => emptyArchive());
  register('openArchiveFolder', async () => {
    await mkdir(catalog.getArchiveRoot(), { recursive: true });
    await vscode.env.openExternal(vscode.Uri.file(catalog.getArchiveRoot()));
  });
  register('chooseEngine', async () => {
    const choice = await vscode.window.showOpenDialog({ title: 'Choose the local native Muse engine', canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { 'Windows native engine': ['exe'] } });
    if (choice?.[0]) {
      await catalog.setEnginePath(choice[0].fsPath);
      await vscode.workspace.getConfiguration('museHistory').update('enginePath', choice[0].fsPath, vscode.ConfigurationTarget.Global);
      await refresh();
    }
  });
  register('open', (value: HistoryNode | string) => terminals.open(target(value)));
  register('openParent', (value: HistoryNode | string) => terminals.open(tree.parentRoot(target(value))));
  register('preview', async (value: HistoryNode | string) => {
    const row = target(value);
    const existing = previews.get(row.session_id);
    if (existing) { existing.panel.reveal(); return existing; }
    const preview = new HistoryPreview(row, context.extensionUri, (id, cursor) => catalog.readHistory(id, cursor));
    previews.set(row.session_id, preview);
    preview.panel.onDidDispose(() => previews.delete(row.session_id));
    await preview.load();
    return preview;
  });
  register('archive', (value: HistoryNode | string) => archive(value));
  register('unarchive', (value: HistoryNode | string) => unarchive(value));
  register('rename', (value?: HistoryNode | string, requested?: string) => rename(value, typeof requested === 'string' ? requested : undefined));
  register('resetName', (value?: HistoryNode | string) => rename(value, ''));
  const recycle = async (value: HistoryNode | string, confirmed = false) => {
    const row = target(value);
    if (row.archived_at) {
      if (!confirmed) {
        const choice = await vscode.window.showWarningMessage(`Move the archived session "${row.title || row.session_id}" to the Windows Recycle Bin?`, { modal: true, detail: `${row.archived_sub_records ? `Includes ${row.archived_sub_records} sub-agent record(s).\n` : ''}It can be restored from the Windows Recycle Bin until the Recycle Bin is emptied.` }, 'Move to Recycle Bin');
        if (choice !== 'Move to Recycle Bin') return undefined;
      }
      const result = await catalog.recycleArchived(row.session_id);
      if (result.status === 'recycled') await forgetNames(result.recycled_session_ids);
      await reloadArchived();
      render();
      if (inventory && refreshedAt) void saveSnapshot(inventory, refreshedAt).catch(() => undefined);
      if (result.status === 'recycled') void vscode.window.showInformationMessage(result.message); else void vscode.window.showWarningMessage(result.message);
      return result;
    }
    const descendants = tree.forest.treeById.get(row.session_id)?.descendants ?? [];
    const scope = [row, ...descendants];
    const inUse = terminals.inUseIds();
    if (scope.some(item => inUse.has(item.session_id))) throw new Error('A Muse terminal for this session or one of its child records is still open. Close that terminal first.');
    if (!confirmed) {
      const choice = await vscode.window.showWarningMessage(`Move "${row.title || row.session_id}" and its ${descendants.length} child record(s) to the Windows Recycle Bin?`, { modal: true, detail: `Scope: ${row.session_id}\n${scope.map(item => item.title || item.session_id).join('\n')}\nIt can be restored from the Windows Recycle Bin until the Recycle Bin is emptied.` }, 'Move to Recycle Bin');
      if (choice !== 'Move to Recycle Bin') return undefined;
    }
    const result = await catalog.recycle(row.session_id, inUse);
    if (result.status === 'recycled') {
      await forgetNames(result.recycled_session_ids);
      await refresh();
      void vscode.window.showInformationMessage(result.message);
    } else { void vscode.window.showWarningMessage(result.message); }
    return result;
  };
  register('recycle', (value: HistoryNode | string) => recycle(value));
  context.subscriptions.push(tree, archivedTree, view, archivedView, terminals,
    view.onDidChangeSelection(() => { lastSelectedView = view; }),
    archivedView.onDidChangeSelection(() => { lastSelectedView = archivedView; }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('museHistory.enginePath') && !test) {
        const path = vscode.workspace.getConfiguration('museHistory').get<string>('enginePath');
        if (path) void catalog.setEnginePath(path).then(refresh).catch(report);
      }
    }));
  updateDescription();
  // Activation starts nothing: the last refresh is shown from its snapshot.
  // Only a first-ever start (no snapshot) reads once, when a view is shown.
  let ready: Promise<CatalogInventory | undefined>;
  if (test) { ready = refresh(); void ready.catch(report); }
  else {
    ready = loadSnapshot().then(async found => {
      if (found) return inventory;
      if (anyVisible()) return refresh();
      await new Promise<void>(resolve => {
        const subscriptions = [view, archivedView].map(item => item.onDidChangeVisibility(event => { if (event.visible) { subscriptions.forEach(sub => sub.dispose()); resolve(); } }));
        context.subscriptions.push(...subscriptions);
      });
      return refresh();
    });
    void ready.catch(report);
  }
  if (test && context.extensionMode === vscode.ExtensionMode.Development && process.env.MUSE_HISTORY_TEST_BOOTSTRAP === '1') {
    // The ordinary --extensionTestsPath host deliberately uses in-memory globalState.
    // An isolated development host is necessary to verify real disk persistence and reload.
    setImmediate(async () => {
      let result: { passed: boolean; error?: string };
      try { await require(join(context.extensionPath, 'out/test/extension-host.test.js')).run(); result = { passed: true }; }
      catch (error) { result = { passed: false, error: error instanceof Error ? error.stack : String(error) }; console.error(error); }
      await writeFile(join(process.env.MUSE_HISTORY_TEST_BOX!, `${process.env.MUSE_HISTORY_TEST_PHASE}-result.json`), JSON.stringify(result, null, 2));
      await vscode.commands.executeCommand('workbench.action.quit');
    });
  }
  // Only the isolated development/test host receives direct validation hooks.
  return test ? { ready, tree, archivedTree, view, archivedView, terminals, catalog, refresh, archives: () => archivedRows.map(row => row.session_id), archivedRows: () => archivedRows, names, setArchived, archive, unarchive, emptyArchive, rename, recycle, previews, globalState: context.globalState, storagePath: join(context.globalStorageUri.fsPath, '..') } : { ready };
}

export async function deactivate(): Promise<void> { await service?.dispose(); service = undefined; }
