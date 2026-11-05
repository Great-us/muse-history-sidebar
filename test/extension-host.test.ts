import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { watch } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SessionTerminals } from '../src/ui/terminals';
import { HistoryTree } from '../src/ui/tree';
import { HistoryPreview } from '../src/ui/preview';
import type { CatalogRow } from '../src/shared/sessionCatalog';

function event<T>(subscribe: vscode.Event<T>, predicate: (value: T) => boolean): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { disposable.dispose(); reject(new Error('VS Code event timed out')); }, 40000);
    const disposable = subscribe(value => { if (predicate(value)) { clearTimeout(timer); disposable.dispose(); resolve(value); } });
  });
}

async function resumedAfter(path: string, before: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { watcher.close(); reject(new Error(`No CLI session.resumed event: ${path}`)); }, 40000);
    const inspect = async () => {
      const lines = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      const resumes = lines.filter(line => line.payload_type === 'session.resumed');
      if (resumes.length > before) { clearTimeout(timer); watcher.close(); resolve(resumes.at(-1)); }
    };
    const watcher = watch(path, () => { void inspect().catch(error => { clearTimeout(timer); watcher.close(); reject(error); }); });
    void inspect();
  });
}

async function echoWritten(path: string, marker: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { watcher.close(); reject(new Error(`Synthetic echo turn not written: ${marker}`)); }, 40000);
    const inspect = async () => {
      if ((await readFile(path, 'utf8')).includes(`echo: ${marker}`)) { clearTimeout(timer); watcher.close(); resolve(); }
    };
    const watcher = watch(path, () => { void inspect().catch(reject); });
    void inspect();
  });
}

async function verifyOwnedWorkspaceDisplay(api: any, roots: CatalogRow[], box: string, evidence: Record<string, unknown>): Promise<CatalogRow[]> {
  const extension = vscode.extensions.getExtension('AlexWonton.muse-history-sidebar')!;
  const fixtureUrl = pathToFileURL(join(extension.extensionPath, 'test/backend-fixture.mjs')).href;
  const fixture = await import(fixtureUrl);
  const config = JSON.parse(await readFile(process.env.MUSE_HISTORY_TEST_CONFIG!, 'utf8'));
  const observer = join(box, 'list-observer');
  await mkdir(observer, { recursive: true });
  const host = fixture.createHost({ binary: config.enginePath, workspace: observer, env: { ...process.env, ...config.env }, extraArgs: ['--trust-workspace', '--disable-sandbox'] });
  let official: any[];
  try { await host.connect(); official = (await host.request('session/list', { limit: 200 })).sessions; }
  finally { await host.stop(); }
  evidence.officialListDuringNativeCli = roots.map(root => {
    const listed = official.find(row => row.sessionId === root.session_id);
    return { sessionId: root.session_id, listed: Boolean(listed), workspaceRoot: listed?.workspaceRoot ?? null };
  });
  await writeFile(join(box, `${process.env.MUSE_HISTORY_TEST_PHASE}-official-list-during-cli.json`), JSON.stringify(evidence.officialListDuringNativeCli, null, 2));
  const refreshed = await api.refresh();
  for (const root of roots) assert.equal(api.tree.row(root.session_id).workspace, root.workspace, 'refresh keeps the historical folder of the owned live CLI');
  evidence.refreshedFolderSources = roots.map(root => ({ sessionId: root.session_id, officialWorkspace: refreshed.sessions.find((row: CatalogRow) => row.session_id === root.session_id)?.workspace, displayedWorkspace: api.tree.row(root.session_id).workspace, source: api.tree.row(root.session_id).workspace_source ?? 'official' }));
  const blank = refreshed.sessions.map((row: CatalogRow) => ({ ...row, workspace: '', workspace_source: undefined }));
  const display = await api.terminals.withOwnedWorkspaces(blank);
  const grouped = new HistoryTree(() => []);
  grouped.filter = 'all';
  grouped.update(display);
  for (const root of roots) {
    const node = grouped.forest.treeById.get(root.session_id)!;
    assert.equal(node.row.workspace, root.workspace);
    assert.equal(node.row.workspace_source, 'own-terminal');
    assert.match(String(grouped.getTreeItem({ type: 'session', tree: node }).tooltip), /Directory from a terminal launch record of this extension/);
    for (const child of node.descendants) { assert.equal(child.workspace, root.workspace); assert.equal(child.workspace_source, 'own-terminal'); }
    assert.ok(grouped.groups.some(group => group.path?.replace(/\\/g, '/') === root.workspace.replace(/\\/g, '/')));
  }
  const officialPreferred = await api.terminals.withOwnedWorkspaces([{ ...roots[0], workspace: observer, workspace_source: undefined }]);
  assert.equal(officialPreferred[0].workspace, observer);
  assert.equal(officialPreferred[0].workspace_source, undefined);
  const lostState = { keys: () => [], get: (key: string, fallback?: any) => key === 'terminalReceipts.v1' ? [] : api.globalState.get(key, fallback), update: async () => {} } as vscode.Memento;
  const lost = new SessionTerminals(api.globalState.get('terminalOwner'), () => Promise.resolve(config.enginePath), lostState, { env: config.env, extraArgs: config.extraArgs });
  await lost.reconnect(blank);
  assert.ok((await lost.withOwnedWorkspaces(blank)).every(row => !row.workspace && !row.workspace_source), 'lost receipt must not infer a folder');
  lost.dispose();
  evidence.ownedTerminalFolderDisplay = { roots: roots.map(root => ({ sessionId: root.session_id, workspace: root.workspace })), inheritedDescendantCount: display.filter((row: CatalogRow) => row.parent_session_id && row.workspace_source === 'own-terminal').length, descendantsInherited: true, officialNonemptyPreferred: true, missingReceiptNoInference: true };
  grouped.dispose();
  return display;
}

/**
 * Static sidebar: a session created by ANOTHER process does not appear (and
 * nothing re-reads) until Refresh is pressed; after the refresh no engine
 * process remains.
 */
async function verifyStaticRefresh(api: any, box: string, evidence: Record<string, unknown>): Promise<void> {
  const extension = vscode.extensions.getExtension('AlexWonton.muse-history-sidebar')!;
  // Keep the URL in a variable: TypeScript 7 does not rewrite identifiers inside an import() argument.
  const fixtureUrl = pathToFileURL(join(extension.extensionPath, 'test/backend-fixture.mjs')).href;
  const fixture = await import(fixtureUrl);
  const config = JSON.parse(await readFile(process.env.MUSE_HISTORY_TEST_CONFIG!, 'utf8'));
  const workspace = join(box, 'workspace-static');
  await mkdir(workspace, { recursive: true });
  if (!api.view.visible) {
    const shown = event(api.view.onDidChangeVisibility, (value: vscode.TreeViewVisibilityChangeEvent) => value.visible);
    await vscode.commands.executeCommand('workbench.view.extension.museHistory');
    await shown;
  }
  await api.refresh();
  await api.catalog.idle();
  assert.equal(api.catalog.hostRunning, false, 'no engine process after a refresh');
  const startsBefore = api.catalog.hostStarts;
  const id = await fixture.createSyntheticSession({ binary: config.enginePath, workspace, env: { ...process.env, ...config.env }, extraArgs: ['--trust-workspace', '--disable-sandbox'], text: 'STATIC_REFRESH_PROMPT' }).then((session: any) => session.sessionId);
  await new Promise(resolve => setTimeout(resolve, 8000));
  assert.equal(api.tree.forest.treeById.has(id), false, 'nothing re-reads on its own');
  assert.equal(api.catalog.hostStarts, startsBefore, 'no engine process was started while idle');
  await vscode.commands.executeCommand('museHistory.refresh');
  assert.ok(api.tree.forest.treeById.has(id), 'Refresh brings in the new session');
  assert.match(api.tree.row(id).title, /STATIC_REFRESH_PROMPT/);
  await api.catalog.idle();
  assert.equal(api.catalog.hostRunning, false, 'and leaves no engine process behind');
  evidence.staticRefresh = { sessionId: id, idleEngineStarts: 0, appearedOnlyAfterRefresh: true, engineGoneAfterRefresh: true };
}

export async function run(): Promise<void> {
  const box = process.env.MUSE_HISTORY_TEST_BOX!;
  const phase = process.env.MUSE_HISTORY_TEST_PHASE!;
  const extension = vscode.extensions.getExtension('AlexWonton.muse-history-sidebar')!;
  const api = await extension.activate();
  const inventory = await api.ready;
  const seeds = JSON.parse(await readFile(join(box, 'seed.json'), 'utf8'));
  const a = api.tree.row(seeds[0].sessionId) as CatalogRow;
  const b = api.tree.row(seeds[1].sessionId) as CatalogRow;
  const evidence: Record<string, unknown> = { phase, version: vscode.version, a: a?.session_id, b: b?.session_id };
  assert.ok(a && b, 'isolated engine roots visible');
  assert.equal(a.workspace, seeds[0].workspaceRoot, 'root A keeps its original folder while native CLI owns the lease');
  assert.equal(b.workspace, seeds[1].workspaceRoot, 'root B keeps its original folder');
  assert.equal(inventory.data_root.startsWith(join(box, 'muse')), true);
  if (phase === 'reload') {
    const checkpoint = join(box, 'reload-checkpoint.json');
    if (!existsSync(checkpoint)) {
      const resumed = resumedAfter(a.log_path, (await readFile(a.log_path, 'utf8')).split('\n').filter(line => line.includes('"payload_type":"session.resumed"')).length);
      const terminal = await vscode.commands.executeCommand<vscode.Terminal>('museHistory.open', a.session_id);
      assert.ok(terminal);
      await resumed;
      const pid = await terminal.processId;
      await writeFile(checkpoint, JSON.stringify({ pid, sessionId: a.session_id }));
      void vscode.commands.executeCommand('workbench.action.reloadWindow');
      await new Promise(() => {});
      return;
    }
    const previous = JSON.parse(await readFile(checkpoint, 'utf8'));
    await writeFile(join(box, 'reload-restored-terminals.json'), JSON.stringify(await Promise.all(vscode.window.terminals.map(async terminal => ({ name: terminal.name, creationOptions: terminal.creationOptions, processId: await terminal.processId, exitStatus: terminal.exitStatus }))), null, 2));
    const restored = (await Promise.all(vscode.window.terminals.map(async terminal => ({ terminal, pid: await terminal.processId })))).find(item => item.pid === previous.pid)?.terminal;
    assert.ok(restored, 'native CLI process survives window reload');
    const before = vscode.window.terminals.length;
    const config = JSON.parse(await readFile(process.env.MUSE_HISTORY_TEST_CONFIG!, 'utf8'));
    const stored = api.globalState.get('terminalReceipts.v1', []);
    for (const field of ['creationDate', 'commandLine', 'executablePath']) {
      const wrongState = { keys: () => [], get: (key: string, fallback?: any) => key === 'terminalReceipts.v1' ? stored.map((receipt: any) => receipt.sessionId === a.session_id ? { ...receipt, [field]: `wrong-${receipt[field]}` } : receipt) : api.globalState.get(key, fallback), update: async () => {} } as vscode.Memento;
      const rejected = new SessionTerminals(api.globalState.get('terminalOwner'), () => Promise.resolve(inventory.engine_path), wrongState, { env: config.env, extraArgs: config.extraArgs });
      await rejected.reconnect([a]);
      assert.equal(rejected.inUseIds().has(a.session_id), false, `mismatched ${field} must not adopt restored terminal`);
      assert.equal((await rejected.withOwnedWorkspaces([{ ...a, workspace: '', workspace_source: undefined }]))[0].workspace_source, undefined, `mismatched ${field} must not infer a folder`);
      rejected.dispose();
    }
    const identityModule = require('../src/ui/terminalProcess');
    const readIdentity = identityModule.terminalProcessIdentity;
    const unknown = new SessionTerminals(api.globalState.get('terminalOwner'), () => Promise.resolve(inventory.engine_path), api.globalState, { env: config.env, extraArgs: config.extraArgs });
    try {
      identityModule.terminalProcessIdentity = async () => { throw new Error('Synthetic CIM unavailable'); };
      await assert.rejects(unknown.open(a), /Could not confirm ownership of an existing Muse terminal/);
      assert.equal((await unknown.withOwnedWorkspaces([{ ...a, workspace: '', workspace_source: undefined }]))[0].workspace_source, undefined);
      assert.equal(vscode.window.terminals.length, before, 'unknown native identity must not create a duplicate');
    } finally { identityModule.terminalProcessIdentity = readIdentity; unknown.dispose(); }
    const selected = await api.terminals.open(a);
    assert.equal(selected, restored, 'real window reload must preserve and rebind the exact owned terminal');
    assert.equal(await selected!.processId, previous.pid, 'native CLI process survives actual window reload');
    assert.equal(vscode.window.terminals.length, before, 'reselect after reload creates no duplicate');
    await verifyOwnedWorkspaceDisplay(api, [a], box, evidence);
    evidence.actualWindowReload = { nativePidBefore: previous.pid, nativePidAfter: await selected!.processId, noDuplicate: true, birthExeCommandMismatchRefused: true, unknownIdentityBlocksDuplicate: true, creationOptions: selected!.creationOptions };
    const closed = event(vscode.window.onDidCloseTerminal, terminal => terminal === selected);
    selected!.dispose();
    await closed;
    await writeFile(join(box, `${phase}-evidence.json`), JSON.stringify(evidence, null, 2));
    console.log('Muse history actual window reload smoke passed');
    return;
  }
  if (phase === 'persistence') {
    assert.ok(api.archives().includes(a.session_id), 'archive globalState persists across real host restarts');
    const archivedGroup = api.tree.groups.find((group: any) => group.trees.some((tree: any) => tree.row.session_id === a.session_id));
    assert.equal(archivedGroup, undefined, 'active view excludes archived root after restart');
    assert.ok(api.archivedTree.groups.some((group: any) => group.trees.some((tree: any) => tree.row.session_id === a.session_id)), 'Archived view lists the archived root after restart');
    evidence.archivePersistence = true;
    assert.equal(api.names()[b.session_id], 'Renamed B persists', 'display name persists across real host restarts');
    assert.equal(api.tree.row(b.session_id).title, 'Renamed B persists');
    await api.rename(b.session_id, '');
    assert.equal(api.tree.row(b.session_id).original_title, undefined);
    evidence.renamePersistence = true;
    await api.setArchived(a.session_id, false);
    await writeFile(join(box, `${phase}-evidence.json`), JSON.stringify(evidence, null, 2));
    console.log('Muse history persistence smoke passed');
    return;
  }
  const sentinel = vscode.window.createTerminal({ name: 'Muse unrelated sentinel', shellPath: 'C:/Windows/System32/cmd.exe', shellArgs: ['/d','/k','echo UNRELATED_SENTINEL'], env: { UNRELATED_SENTINEL: '1' } });
  await sentinel.processId;
  const count = async (path: string) => (await readFile(path, 'utf8')).split('\n').filter(line => line.includes('"payload_type":"session.resumed"')).length;
  const aResumes = await count(a.log_path);
  const aResumed = resumedAfter(a.log_path, aResumes);
  const ta = await vscode.commands.executeCommand<vscode.Terminal>('museHistory.open', a.session_id);
  assert.ok(ta);
  await ta.processId;
  evidence.aResumeEvent = await aResumed;
  assert.equal(vscode.window.activeTerminal, ta);
  const options = ta.creationOptions as vscode.TerminalOptions;
  assert.equal(options.cwd, a.workspace);
  assert.equal(options.shellPath, inventory.engine_path);
  assert.deepEqual((options.shellArgs as string[]).slice(-2), ['resume', a.session_id]);
  const bResumed = resumedAfter(b.log_path, await count(b.log_path));
  const tb = await vscode.commands.executeCommand<vscode.Terminal>('museHistory.open', b.session_id);
  assert.ok(tb && tb !== ta);
  evidence.bResumeEvent = await bResumed;
  // Only these isolated, extension-owned echo terminals receive synthetic user input.
  await new Promise(resolve => setTimeout(resolve, 6000));
  const markerA = `EXTENSION_HOST_CONTINUE_A_${Date.now()}`;
  const markerB = `EXTENSION_HOST_CONTINUE_B_${Date.now()}`;
  const wroteA = echoWritten(a.log_path, markerA), wroteB = echoWritten(b.log_path, markerB);
  ta.sendText(markerA, false);
  tb.sendText(markerB, false);
  await new Promise(resolve => setTimeout(resolve, 800));
  ta.sendText('\r', false);
  tb.sendText('\r', false);
  await Promise.all([wroteA, wroteB]);
  assert.equal((await readFile(a.log_path, 'utf8')).includes(markerB), false);
  assert.equal((await readFile(b.log_path, 'utf8')).includes(markerA), false);
  evidence.echoContinuation = { markerA, markerB, correctSessionLogs: true };
  const inferred = await verifyOwnedWorkspaceDisplay(api, [a, b], box, evidence);
  const focusedA = event(vscode.window.onDidChangeActiveTerminal, terminal => terminal === ta);
  const taAgain = await vscode.commands.executeCommand<vscode.Terminal>('museHistory.open', a.session_id);
  await focusedA;
  assert.equal(taAgain, ta);
  assert.equal(vscode.window.terminals.filter(terminal => (terminal.creationOptions as vscode.TerminalOptions).env?.MUSE_HISTORY_TERMINAL_SESSION === a.session_id).length, 1);
  assert.ok(vscode.window.terminals.includes(sentinel));
  evidence.switchAndReuse = true;
  // Real creationOptions retain the owned marker. Rebinding recreates only the registry, preserving live processes.
  const marker = options.env!.MUSE_HISTORY_TERMINAL_OWNER!;
  const privateConfig = JSON.parse(await readFile(process.env.MUSE_HISTORY_TEST_CONFIG!, 'utf8'));
  const rebound = new SessionTerminals(marker, () => Promise.resolve(inventory.engine_path), api.globalState, { env: privateConfig.env, extraArgs: privateConfig.extraArgs });
  assert.equal(await rebound.open(a), ta);
  rebound.dispose();
  assert.ok(vscode.window.terminals.includes(ta));
  evidence.registryRebind = true;
  const aClosed = event(vscode.window.onDidCloseTerminal, terminal => terminal === ta);
  if (!api.view.visible) {
    const shown = event(api.view.onDidChangeVisibility, (value: vscode.TreeViewVisibilityChangeEvent) => value.visible);
    await vscode.commands.executeCommand('workbench.view.extension.museHistory');
    await shown;
    await api.refresh();
  }
  ta.dispose();
  await aClosed;
  const terminalCountAfterClose = vscode.window.terminals.length;
  await assert.rejects(api.terminals.open(inferred.find(row => row.session_id === a.session_id)), /terminal launch record of this extension/);
  assert.equal(vscode.window.terminals.length, terminalCountAfterClose, 'a stale inferred row cannot create a new terminal');
  await vscode.commands.executeCommand('museHistory.refresh');
  assert.equal(api.tree.row(a.session_id).workspace_source, undefined, 'after close, a manual refresh uses official metadata again');
  evidence.ownedTerminalCloseThenManualRefreshUsesOfficialMetadata = true;
  const reopenedEvent = resumedAfter(a.log_path, await count(a.log_path));
  const reopened = await vscode.commands.executeCommand<vscode.Terminal>('museHistory.open', a.session_id);
  assert.ok(reopened && reopened !== ta);
  evidence.aReopenedEvent = await reopenedEvent;
  evidence.closeReopen = true;
  await assert.rejects(api.terminals.open({ ...a, session_id: '--help' }), /UUID/);
  await assert.rejects(api.terminals.open({ ...a, workspace: join(box, 'missing-workspace'), session_id: '11111111-1111-4111-8111-111111111111' }), /original working directory no longer exists/);
  const child = inventory.sessions.find((row: CatalogRow) => row.parent_session_id === a.session_id);
  if (child) {
    const preview = await vscode.commands.executeCommand<HistoryPreview>('museHistory.preview', child.session_id);
    assert.ok(preview && preview.entries.length);
    assert.match(preview.html(), /Read-only preview/);
    assert.equal(api.tree.parentRoot(child).session_id, a.session_id);
    await assert.rejects(api.terminals.open(child), /Internal child record/);
    evidence.childPreviewAndExplicitParent = true;
  }
  const paged = new HistoryPreview(a, extension.extensionUri, async (_id, cursor) => ({ items: Array.from({ length: 1205 }, (_, i) => ({ itemId: `${cursor ?? 'first'}-${i}`, kind: 'agentMessage', text: `Paged message ${cursor ?? 'first'} ${i}`, recordedAt: new Date(i + (cursor ? 1205 : 0)).toISOString() })), next_cursor: cursor ? null : 'second' }));
  await paged.load();
  assert.equal(paged.cursor, 'second');
  await paged.load(paged.cursor!);
  assert.equal(paged.entries.length, 2410);
  assert.equal(paged.cursor, null);
  assert.match(paged.html(), /second 1204/);
  evidence.previewPagination = { loaded: paged.entries.length, exhausted: true };
  paged.panel.dispose();
  await api.setArchived(a.session_id, true);
  if (child) { await api.setArchived(child.session_id, true); await api.setArchived(a.session_id, false); assert.ok(api.archives().includes(child.session_id)); await api.setArchived(a.session_id, true); }
  const originalRecycle = api.catalog.recycle;
  await api.setArchived(b.session_id, true);
  // Archived view: archived sessions are listed there directly and open like any other row.
  const archivedNode = api.archivedTree.getChildren().flatMap((folder: any) => api.archivedTree.getChildren(folder)).find((node: any) => node.tree.row.session_id === b.session_id);
  assert.ok(archivedNode, 'Archived view lists archived root B');
  assert.equal(api.tree.groups.some((group: any) => group.trees.some((tree: any) => tree.row.session_id === b.session_id)), false, 'History (unarchived) hides B');
  const archivedItem = api.archivedTree.getTreeItem(archivedNode);
  assert.equal(archivedItem.command.command, 'museHistory.open');
  assert.equal(await vscode.commands.executeCommand<vscode.Terminal>(archivedItem.command.command, ...archivedItem.command.arguments), tb, 'clicking B in Archived switches to its live terminal');
  assert.match(String(archivedItem.contextValue), /selfArchived/);
  evidence.archivedViewDirectAccess = true;
  // Rename: local display name, searchable by both names, restorable, independent of the engine title.
  const engineTitleB = api.tree.row(b.session_id).title;
  assert.equal(await api.rename(b.session_id, '  Renamed   B persists '), 'Renamed B persists');
  assert.equal(api.tree.row(b.session_id).title, 'Renamed B persists');
  assert.equal(api.tree.row(b.session_id).original_title, engineTitleB);
  assert.equal(api.archivedTree.row(b.session_id).title, 'Renamed B persists', 'Archived view shows the display name');
  api.archivedTree.query = 'renamed b';
  api.archivedTree.update();
  assert.equal(api.archivedTree.groups.length, 1, 'search finds the display name');
  api.archivedTree.query = engineTitleB;
  api.archivedTree.update();
  assert.equal(api.archivedTree.groups.length, 1, 'search still finds the engine title');
  api.archivedTree.query = '';
  api.archivedTree.update();
  assert.match(String(api.archivedTree.getTreeItem({ type: 'session', tree: api.archivedTree.forest.treeById.get(b.session_id) }).tooltip), /Muse title:/);
  await api.rename(a.session_id, 'Temporary A');
  await api.rename(a.session_id, '');
  assert.equal(api.tree.row(a.session_id).original_title, undefined, 'empty name restores the engine title');
  evidence.rename = { engineTitleB, displayName: api.tree.row(b.session_id).title };
  const originalArchives = [...api.archives()];
  api.catalog.recycle = async () => ({ status: 'partial', message: 'Synthetic cold verification partial', recycled_session_ids: [b.session_id] });
  // Close owned synthetic terminals before mutation fixture; sentinel is deliberately untouched.
  for (const terminal of [reopened, tb]) { const closed = event(vscode.window.onDidCloseTerminal, value => value === terminal); terminal.dispose(); await closed; }
  await api.recycle(b.session_id, true);
  assert.deepEqual(api.archives(), originalArchives, 'partial outcome must not purge archive ids');
  api.catalog.recycle = originalRecycle;
  assert.ok(vscode.window.terminals.includes(sentinel));
  evidence.partialKeepsArchives = true;
  await verifyStaticRefresh(api, box, evidence);
  sentinel.dispose();
  for (const preview of api.previews.values()) preview.panel.dispose();
  await writeFile(join(box, `${phase}-evidence.json`), JSON.stringify(evidence, null, 2));
  console.log('Muse history primary extension-host smoke passed');
}
