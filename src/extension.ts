import * as vscode from 'vscode';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { CatalogService } from './backend/catalogService';
import { HistoryTree, type HistoryNode } from './ui/tree';
import { SessionTerminals } from './ui/terminals';
import { HistoryPreview } from './ui/preview';
import type { CatalogInventory } from './shared/sessionCatalog';

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
  const archives = () => context.globalState.get<string[]>(archiveKey, []);
  const tree = new HistoryTree(archives);
  const view = vscode.window.createTreeView('museHistory.sessions', { treeDataProvider: tree, showCollapseAll: true });
  const terminals = new SessionTerminals(await SessionTerminals.owner(context.globalState), () => catalog.getEnginePath(), context.globalState, test ? { env: test.env, extraArgs: test.extraArgs } : undefined);
  const previews = new Map<string, HistoryPreview>();
  let inventory: CatalogInventory | undefined;
  let refreshing: Promise<CatalogInventory> | undefined;
  const updateDescription = () => {
    view.description = `${tree.filter === 'active' ? '未归档' : tree.filter === 'archived' ? '已归档' : '全部'}${tree.query ? ` · ${tree.query}` : ''}`;
    view.message = !inventory ? '正在读取本机 Muse 历史…' : tree.groups.length ? (inventory.warnings.length ? inventory.warnings.join('\n') : undefined) : '没有匹配的历史记录。可搜索、切换归档筛选或刷新。';
  };
  const refresh = (): Promise<CatalogInventory> => {
    if (refreshing) return refreshing;
    refreshing = catalog.refresh().then(async result => { inventory = result; await terminals.reconnect(result.sessions); tree.update(await terminals.withOwnedWorkspaces(result.sessions)); updateDescription(); return result; }).catch(error => {
      view.message = `读取失败：${error instanceof Error ? error.message : String(error)}。请检查引擎路径后刷新。`;
      throw error;
    }).finally(() => { refreshing = undefined; });
    return refreshing;
  };
  const report = (error: unknown) => { void vscode.window.showErrorMessage(`Muse 历史：${error instanceof Error ? error.message : String(error)}`); };
  const register = (name: string, handler: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(`museHistory.${name}`, async (...args) => { try { return await handler(...args); } catch (error) { report(error); return undefined; } }));
  const setArchived = async (value: HistoryNode | string, archived: boolean) => {
    const row = tree.row(value);
    const ids = new Set(archives());
    if (archived) ids.add(row.session_id); else ids.delete(row.session_id);
    await context.globalState.update(archiveKey, [...ids]);
    tree.update();
    updateDescription();
  };
  register('refresh', refresh);
  register('search', async () => {
    const query = await vscode.window.showInputBox({ title: '搜索 Muse 历史', prompt: '输入标题或文件夹路径；清空显示全部。匹配子记录时保留父级。', value: tree.query });
    if (query !== undefined) { tree.query = query.trim(); tree.update(); updateDescription(); }
  });
  register('filter', async () => {
    const choice = await vscode.window.showQuickPick([{ label: '未归档', value: 'active' as const }, { label: '已归档（包含必要父级）', value: 'archived' as const }, { label: '全部', value: 'all' as const }], { title: 'Muse 历史 · 归档筛选' });
    if (choice) { tree.filter = choice.value; tree.update(); updateDescription(); }
  });
  register('chooseEngine', async () => {
    const choice = await vscode.window.showOpenDialog({ title: '选择本机 Muse 原生引擎', canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { 'Windows 原生引擎': ['exe'] } });
    if (choice?.[0]) {
      await catalog.setEnginePath(choice[0].fsPath);
      await vscode.workspace.getConfiguration('museHistory').update('enginePath', choice[0].fsPath, vscode.ConfigurationTarget.Global);
      await refresh();
    }
  });
  register('open', (value: HistoryNode | string) => terminals.open(tree.row(value)));
  register('openParent', (value: HistoryNode | string) => terminals.open(tree.parentRoot(tree.row(value))));
  register('preview', async (value: HistoryNode | string) => {
    const row = tree.row(value);
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
  const recycle = async (value: HistoryNode | string, confirmed = false) => {
    const row = tree.row(value);
    const descendants = tree.forest.treeById.get(row.session_id)?.descendants ?? [];
    const scope = [row, ...descendants];
    const inUse = terminals.inUseIds();
    if (scope.some(item => inUse.has(item.session_id))) throw new Error('此会话或其子记录的 Muse 终端仍打开。请先关闭对应终端。');
    if (!confirmed) {
      const choice = await vscode.window.showWarningMessage(`将“${row.title || row.session_id}”及其 ${descendants.length} 条子记录移到 Windows 回收站？`, { modal: true, detail: `范围：${row.session_id}\n${scope.map(item => item.title || item.session_id).join('\n')}\n可在系统回收站恢复。不会永久删除。` }, '移到回收站');
      if (choice !== '移到回收站') return undefined;
    }
    const result = await catalog.recycle(row.session_id, inUse);
    if (result.status === 'recycled') {
      const purged = new Set(result.recycled_session_ids);
      await context.globalState.update(archiveKey, archives().filter(id => !purged.has(id)));
      await refresh();
      void vscode.window.showInformationMessage(result.message);
    } else { void vscode.window.showWarningMessage(result.message); }
    return result;
  };
  register('recycle', (value: HistoryNode | string) => recycle(value));
  context.subscriptions.push(tree, view, terminals,
    terminals.onDidCloseOwnedTerminal(() => { if (view.visible) void refresh().catch(report); }),
    view.onDidChangeVisibility(event => { if (event.visible) void refresh().catch(report); }),
    vscode.window.onDidChangeWindowState(state => { if (state.focused && view.visible) void refresh().catch(report); }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('museHistory.enginePath') && !test) {
        const path = vscode.workspace.getConfiguration('museHistory').get<string>('enginePath');
        if (path) void catalog.setEnginePath(path).then(refresh).catch(report);
      }
    }));
  updateDescription();
  const ready = refresh();
  void ready.catch(report);
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
  return test ? { ready, tree, view, terminals, catalog, refresh, archives, setArchived, recycle, previews, globalState: context.globalState, storagePath: join(context.globalStorageUri.fsPath, '..') } : { ready };
}

export async function deactivate(): Promise<void> { await service?.dispose(); service = undefined; }
