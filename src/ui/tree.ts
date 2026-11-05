import * as vscode from 'vscode';
import { buildCatalogForest, buildCatalogGroups, type CatalogForest, type CatalogGroup, type CatalogTree, type CatalogRow, type CatalogArchiveFilter } from '../shared/sessionCatalog';

export type HistoryNode = { type: 'folder'; group: CatalogGroup } | { type: 'session'; tree: CatalogTree };

export class HistoryTree implements vscode.TreeDataProvider<HistoryNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<HistoryNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  forest: CatalogForest = buildCatalogForest([]);
  query = '';
  filter: CatalogArchiveFilter;
  groups: CatalogGroup[] = [];
  /** `fixedFilter` pins a dedicated view (the Archived view) to one archive filter. */
  constructor(private readonly archiveIds: () => readonly string[], readonly fixedFilter?: CatalogArchiveFilter) {
    this.filter = fixedFilter ?? 'active';
  }
  update(rows?: CatalogRow[]): void {
    if (rows) this.forest = buildCatalogForest(rows);
    if (this.fixedFilter) this.filter = this.fixedFilter;
    this.groups = buildCatalogGroups(this.forest, this.archiveIds(), this.filter, this.query);
    this.changed.fire(undefined);
  }
  /** Number of session rows currently shown (roots and nested children). */
  get shownCount(): number {
    return this.groups.reduce((total, group) => total + group.trees.reduce((sum, tree) => sum + 1 + tree.descendants.length, 0), 0);
  }
  /** Ids stay stable per view across refreshes so expansion and selection survive live updates. */
  private itemId(id: string): string { return this.fixedFilter ? `${this.fixedFilter}:${id}` : id; }
  getTreeItem(node: HistoryNode): vscode.TreeItem {
    if (node.type === 'folder') {
      const item = new vscode.TreeItem(node.group.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = this.itemId(`folder:${node.group.key}`);
      item.description = `${node.group.trees.length}`;
      item.tooltip = (node.group.path ?? 'No working directory recorded') + (node.group.trees.some(tree => tree.row.workspace_source === 'own-terminal') ? '\nDirectory from a terminal launch record of this extension' : '');
      item.iconPath = new vscode.ThemeIcon('folder');
      return item;
    }
    const { row, children, archived, contextOnly } = node.tree;
    const child = row.kind !== 'root' || Boolean(row.parent_session_id);
    const renamed = row.original_title !== undefined;
    if (row.archived_at) {
      // A session moved to the archive folder: Muse cannot see it, so it cannot be opened or previewed until unarchived.
      const archivedItem = new vscode.TreeItem(row.title || row.session_id, vscode.TreeItemCollapsibleState.None);
      archivedItem.id = this.itemId(row.session_id);
      archivedItem.description = [row.session_id.slice(-12), `Archived ${new Date(row.archived_at).toLocaleDateString()}`, row.archived_sub_records ? `${row.archived_sub_records} sub-record(s)` : ''].filter(Boolean).join(' · ');
      archivedItem.tooltip = `${row.title}${renamed ? `\nMuse title: ${row.original_title || '(none)'}` : ''}\n${row.workspace || 'Directory unknown'}\n${row.session_id}\nIn the archive folder: ${row.log_path.replace(/[\\/]session\.jsonl$/, '')}\nRight-click to Unarchive (move back to Muse) or Delete (move to the Windows Recycle Bin).`;
      archivedItem.contextValue = `archivedEntry${renamed ? '-renamed' : ''}`;
      archivedItem.iconPath = new vscode.ThemeIcon('archive');
      return archivedItem;
    }
    const item = new vscode.TreeItem(row.title || row.session_id, children.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = this.itemId(row.session_id);
    item.description = [row.session_id.slice(-12), child ? 'Child · Preview' : '', archived && !this.fixedFilter ? 'Archived' : '', contextOnly ? 'Contains archived children' : '', row.running ? 'Running' : '', row.workspace_source === 'own-terminal' ? 'Directory from launch record' : ''].filter(Boolean).join(' · ');
    item.tooltip = `${row.title}${renamed ? `\nMuse title: ${row.original_title || '(none)'}` : ''}\n${row.workspace || 'Directory unknown'}\n${row.session_id}${row.workspace_source === 'own-terminal' ? '\nDirectory from a terminal launch record of this extension' : ''}${child ? '\nInternal child records cannot be resumed on their own; open the parent main session terminal from the menu.' : row.workspace_source === 'own-terminal' ? '\nClick to switch back to the verified original terminal; this directory must not start another session.' : '\nClick to open or focus this session terminal.'}`;
    item.contextValue = `session-${child ? 'child' : 'root'}${renamed ? '-renamed' : ''}`;
    item.iconPath = new vscode.ThemeIcon(child ? 'references' : archived ? 'archive' : 'comment-discussion');
    item.command = { command: child ? 'museHistory.preview' : 'museHistory.open', title: child ? 'Read-only Preview' : 'Open Session Terminal', arguments: [node] };
    return item;
  }
  getChildren(node?: HistoryNode): HistoryNode[] {
    if (!node) return this.groups.map(group => ({ type: 'folder', group }));
    return (node.type === 'folder' ? node.group.trees : node.tree.children).map(tree => ({ type: 'session', tree }));
  }
  row(value: HistoryNode | string): CatalogRow {
    const row = typeof value === 'string' ? this.forest.treeById.get(value)?.row : value?.type === 'session' ? value.tree.row : undefined;
    if (!row) throw new Error('Select a session from the Muse history list.');
    return row;
  }
  parentRoot(row: CatalogRow): CatalogRow {
    let current = row;
    while (current.parent_session_id) {
      const parent = this.forest.treeById.get(current.parent_session_id)?.row;
      if (!parent) throw new Error('The parent main session of this internal record was not found.');
      current = parent;
    }
    if (current.kind !== 'root') throw new Error('This internal record has no parent main session to resume.');
    return current;
  }
  dispose(): void { this.changed.dispose(); }
}
