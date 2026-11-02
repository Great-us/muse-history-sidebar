import * as vscode from 'vscode';
import { buildCatalogForest, buildCatalogGroups, type CatalogForest, type CatalogGroup, type CatalogTree, type CatalogRow, type CatalogArchiveFilter } from '../shared/sessionCatalog';

export type HistoryNode = { type: 'folder'; group: CatalogGroup } | { type: 'session'; tree: CatalogTree };

export class HistoryTree implements vscode.TreeDataProvider<HistoryNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<HistoryNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  forest: CatalogForest = buildCatalogForest([]);
  query = '';
  filter: CatalogArchiveFilter = 'active';
  groups: CatalogGroup[] = [];
  constructor(private readonly archiveIds: () => readonly string[]) {}
  update(rows?: CatalogRow[]): void {
    if (rows) this.forest = buildCatalogForest(rows);
    this.groups = buildCatalogGroups(this.forest, this.archiveIds(), this.filter, this.query);
    this.changed.fire(undefined);
  }
  getTreeItem(node: HistoryNode): vscode.TreeItem {
    if (node.type === 'folder') {
      const item = new vscode.TreeItem(node.group.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `folder:${node.group.key}`;
      item.description = `${node.group.trees.length}`;
      item.tooltip = (node.group.path ?? '记录未提供工作目录') + (node.group.trees.some(tree => tree.row.workspace_source === 'own-terminal') ? '\n目录来自本扩展终端启动记录' : '');
      item.iconPath = new vscode.ThemeIcon('folder');
      return item;
    }
    const { row, children, archived, contextOnly } = node.tree;
    const child = row.kind !== 'root' || Boolean(row.parent_session_id);
    const item = new vscode.TreeItem(row.title || row.session_id, children.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = row.session_id;
    item.description = [row.session_id.slice(-12), child ? '子记录 · 预览' : '', archived ? '已归档' : '', contextOnly ? '包含归档子记录' : '', row.running ? '运行中' : '', row.workspace_source === 'own-terminal' ? '目录来自启动记录' : ''].filter(Boolean).join(' · ');
    item.tooltip = `${row.title}\n${row.workspace || '目录未知'}\n${row.session_id}${row.workspace_source === 'own-terminal' ? '\n目录来自本扩展终端启动记录' : ''}${child ? '\n内部子记录不能单独恢复；可从菜单打开父主会话终端。' : row.workspace_source === 'own-terminal' ? '\n点击切回已验证的原终端；此目录不能用来另开会话。' : '\n点击打开或聚焦本会话终端。'}`;
    item.contextValue = `session-${child ? 'child' : 'root'}${this.archiveIds().includes(row.session_id) ? '-selfArchived' : ''}`;
    item.iconPath = new vscode.ThemeIcon(child ? 'references' : archived ? 'archive' : 'comment-discussion');
    item.command = { command: child ? 'museHistory.preview' : 'museHistory.open', title: child ? '只读预览' : '打开会话终端', arguments: [node] };
    return item;
  }
  getChildren(node?: HistoryNode): HistoryNode[] {
    if (!node) return this.groups.map(group => ({ type: 'folder', group }));
    return (node.type === 'folder' ? node.group.trees : node.tree.children).map(tree => ({ type: 'session', tree }));
  }
  row(value: HistoryNode | string): CatalogRow {
    const row = typeof value === 'string' ? this.forest.treeById.get(value)?.row : value?.type === 'session' ? value.tree.row : undefined;
    if (!row) throw new Error('请从 Muse 历史记录中选择会话。');
    return row;
  }
  parentRoot(row: CatalogRow): CatalogRow {
    let current = row;
    while (current.parent_session_id) {
      const parent = this.forest.treeById.get(current.parent_session_id)?.row;
      if (!parent) throw new Error('找不到此内部记录的父主会话。');
      current = parent;
    }
    if (current.kind !== 'root') throw new Error('此内部记录没有可恢复的父主会话。');
    return current;
  }
  dispose(): void { this.changed.dispose(); }
}
