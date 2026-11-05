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
  const archiveKey = 'archiveIds.v1';
  const namesKey = 'displayNames.v1';
  const archives = () => context.globalState.get<string[]>(archiveKey, []);
  const names = () => context.globalState.get<Record<string, string>>(namesKey, {});
  const tree = new HistoryTree(archives);
  const archivedTree = new HistoryTree(archives, 'archived');
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
    view.description = [tree.filter === 'active' ? 'Unarchived' : tree.filter === 'archived' ? 'Archived' : 'All', tree.query, refreshing ? 'Refreshing…' : when].filter(Boolean).join(' · ');
    view.message = lastError ? `${lastError}${inventory ? '\n(Showing the last successful read.)' : ''}`
      : !inventory ? (refreshing ? 'Reading local Muse history…' : 'Press Refresh to read local Muse history.') : tree.groups.length ? (inventory.warnings.length ? inventory.warnings.join('\n') : undefined) : 'No matching history. Search, change the archive filter, or refresh.';
    archivedView.description = [inventory ? `${archives().filter(id => tree.forest.treeById.has(id)).length} archived` : '', archivedTree.query].filter(Boolean).join(' · ');
    archivedView.message = !inventory ? (refreshing ? 'Reading local Muse history…' : 'Press Refresh to read local Muse history.') : archivedTree.groups.length ? undefined
      : archivedTree.query ? 'No archived session matches this search.' : 'No archived sessions. Right-click a session in History and choose Archive.';
  };
  /** Re-renders both views from the last read plus current local names/archives. No engine access. */
  const render = () => {
    const rows = applyDisplayNames(baseRows, names());
    tree.update(rows);
    archivedTree.update(rows);
    updateDescription();
  };
  const saveSnapshot = async (result: CatalogInventory, at: number) => {
    const temporary = `${snapshotFile}.tmp`;
    await writeFile(temporary, JSON.stringify({ at, inventory: result }));
    await renameFile(temporary, snapshotFile);
  };
  /** Shows the last refresh without starting any process; false when there is none. */
  const loadSnapshot = async (): Promise<boolean> => {
    try {
      const saved = JSON.parse(await readFile(snapshotFile, 'utf8')) as { at?: unknown; inventory?: CatalogInventory };
      if (typeof saved.at !== 'number' || !saved.inventory || !Array.isArray(saved.inventory.sessions)) return false;
      inventory = saved.inventory;
      refreshedAt = saved.at;
      baseRows = saved.inventory.sessions;
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
    if (value !== undefined) return tree.row(value);
    const selected = lastSelectedView.selection[0] ?? view.selection[0] ?? archivedView.selection[0];
    if (!selected || selected.type !== 'session') throw new Error('Select a session in the Muse history list first.');
    return tree.row(selected.tree.row.session_id);
  };
  const setArchived = async (value: HistoryNode | string, archived: boolean) => {
    const row = target(value);
    const ids = new Set(archives());
    if (archived) ids.add(row.session_id); else ids.delete(row.session_id);
    await context.globalState.update(archiveKey, [...ids]);
    render();
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
  register('filter', async () => {
    const choice = await vscode.window.showQuickPick([{ label: 'Unarchived', value: 'active' as const }, { label: 'Archived (required parents included)', value: 'archived' as const }, { label: 'All', value: 'all' as const }], { title: 'Muse History · Archive Filter' });
    if (choice) { tree.filter = choice.value; render(); }
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
  register('archive', (value: HistoryNode | string) => setArchived(value, true));
  register('unarchive', (value: HistoryNode | string) => setArchived(value, false));
  register('rename', (value?: HistoryNode | string, requested?: string) => rename(value, typeof requested === 'string' ? requested : undefined));
  register('resetName', (value?: HistoryNode | string) => rename(value, ''));
  const recycle = async (value: HistoryNode | string, confirmed = false) => {
    const row = target(value);
    const descendants = tree.forest.treeById.get(row.session_id)?.descendants ?? [];
    const scope = [row, ...descendants];
    const inUse = terminals.inUseIds();
    if (scope.some(item => inUse.has(item.session_id))) throw new Error('A Muse terminal for this session or one of its child records is still open. Close that terminal first.');
    if (!confirmed) {
      const choice = await vscode.window.showWarningMessage(`Move "${row.title || row.session_id}" and its ${descendants.length} child record(s) to the Windows Recycle Bin?`, { modal: true, detail: `Scope: ${row.session_id}\n${scope.map(item => item.title || item.session_id).join('\n')}\nRecoverable from the system Recycle Bin. Nothing is permanently deleted.` }, 'Move to Recycle Bin');
      if (choice !== 'Move to Recycle Bin') return undefined;
    }
    const result = await catalog.recycle(row.session_id, inUse);
    if (result.status === 'recycled') {
      const purged = new Set(result.recycled_session_ids);
      await context.globalState.update(archiveKey, archives().filter(id => !purged.has(id)));
      await context.globalState.update(namesKey, Object.fromEntries(Object.entries(names()).filter(([id]) => !purged.has(id))));
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
  return test ? { ready, tree, archivedTree, view, archivedView, terminals, catalog, refresh, archives, names, setArchived, rename, recycle, previews, globalState: context.globalState, storagePath: join(context.globalStorageUri.fsPath, '..') } : { ready };
}

export async function deactivate(): Promise<void> { await service?.dispose(); service = undefined; }
