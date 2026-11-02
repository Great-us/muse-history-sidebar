import * as vscode from 'vscode';
import { stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { buildCatalogForest, type CatalogRow } from '../shared/sessionCatalog';
import { terminalProcessIdentity, type ProcessIdentity } from './terminalProcess';

const MARKER = 'MUSE_HISTORY_TERMINAL_OWNER';
const SESSION = 'MUSE_HISTORY_TERMINAL_SESSION';

export interface TerminalTestOptions { env: NodeJS.ProcessEnv; extraArgs: string[] }
interface TerminalReceipt extends ProcessIdentity { sessionId: string; pid: number; engine: string; cwd: string; argv: string[] }

/** Own only terminals bearing our persisted, private creation marker. Never adopt by name. */
export class SessionTerminals implements vscode.Disposable {
  private readonly terminals = new Map<string, vscode.Terminal>();
  private readonly opening = new Map<string, Promise<vscode.Terminal>>();
  private readonly receipts: Map<string, TerminalReceipt>;
  private readonly reconnectFailures = new Map<string, string>();
  private readonly verifiedReceipts = new Set<string>();
  private readonly ownedClosed = new vscode.EventEmitter<string>();
  readonly onDidCloseOwnedTerminal = this.ownedClosed.event;
  private readonly closed: vscode.Disposable;
  constructor(private readonly owner: string, private readonly engine: () => Promise<string>, private readonly state: vscode.Memento, private readonly test?: TerminalTestOptions) {
    this.receipts = new Map(state.get<TerminalReceipt[]>('terminalReceipts.v1', []).map(receipt => [receipt.sessionId, receipt]));
    this.closed = vscode.window.onDidCloseTerminal(terminal => {
      for (const [id, owned] of this.terminals) if (owned === terminal) {
        this.terminals.delete(id);
        this.receipts.delete(id);
        this.verifiedReceipts.delete(id);
        void this.state.update('terminalReceipts.v1', [...this.receipts.values()]);
        this.ownedClosed.fire(id);
      }
    });
  }
  static async owner(state: vscode.Memento): Promise<string> {
    const saved = state.get<string>('terminalOwner');
    if (saved) return saved;
    const owner = randomUUID();
    await state.update('terminalOwner', owner);
    return owner;
  }
  inUseIds(): ReadonlySet<string> {
    for (const [id, terminal] of this.terminals) if (terminal.exitStatus !== undefined) this.terminals.delete(id);
    return new Set([...this.terminals.keys(), ...this.opening.keys()]);
  }
  async withOwnedWorkspaces(rows: readonly CatalogRow[]): Promise<CatalogRow[]> {
    const workspaces = new Map<string, string>();
    const forest = buildCatalogForest(rows);
    for (const root of forest.trees) {
      const row = root.row;
      if (row.kind !== 'root' || row.parent_session_id || row.workspace.trim()) continue;
      const terminal = this.terminals.get(row.session_id);
      const receipt = this.receipts.get(row.session_id);
      // These receipts were created only from an official, existing cwd plus exact native launch proof.
      if (!terminal || terminal.exitStatus !== undefined || !receipt || await terminal.processId !== receipt.pid) continue;
      if (!this.verifiedReceipts.has(row.session_id)) {
        try {
          const identity = await terminalProcessIdentity(receipt.pid);
          if (identity.executablePath !== receipt.executablePath || identity.commandLine !== receipt.commandLine || identity.creationDate !== receipt.creationDate) continue;
          this.verifiedReceipts.add(row.session_id);
        } catch { continue; } // Ownership is unknown; keep the directory explicitly unknown.
      }
      workspaces.set(row.session_id, receipt.cwd);
      for (const child of root.descendants) if (!child.workspace.trim()) workspaces.set(child.session_id, receipt.cwd);
    }
    return rows.map(row => workspaces.has(row.session_id) ? { ...row, workspace: workspaces.get(row.session_id)!, workspace_source: 'own-terminal' } : row);
  }
  async reconnect(rows: readonly CatalogRow[]): Promise<void> {
    if (this.terminals.size && rows.every(row => this.terminals.has(row.session_id))) return;
    const engine = await this.engine();
    for (const row of rows) {
      const known = this.terminals.get(row.session_id);
      if (known && known.exitStatus === undefined) continue;
      this.reconnectFailures.delete(row.session_id);
      const args = [...(this.test?.extraArgs ?? []), 'resume', row.session_id];
      const terminal = vscode.window.terminals.find(candidate => {
        const options = candidate.creationOptions as vscode.TerminalOptions;
        return candidate.exitStatus === undefined && options.env?.[MARKER] === this.owner &&
          options.env?.[SESSION] === row.session_id && options.shellPath === engine &&
          options.cwd === row.workspace && Array.isArray(options.shellArgs) &&
          options.shellArgs.length === args.length && options.shellArgs.every((arg, index) => arg === args[index]);
      });
      if (terminal) this.terminals.set(row.session_id, terminal);
      else {
        const receipt = this.receipts.get(row.session_id);
        if (!receipt || receipt.engine !== engine || (row.workspace && receipt.cwd !== row.workspace) || receipt.argv.length !== args.length || receipt.argv.some((arg, index) => arg !== args[index])) continue;
        // VS Code 1.144 loses env/argv/cwd in creationOptions on actual reload.
        // Our own launch receipt plus exact native process identity closes that API gap.
        const candidate = (await Promise.all(vscode.window.terminals.map(async item => ({ terminal: item, pid: await item.processId })))).find(item => item.pid === receipt.pid)?.terminal;
        if (!candidate || candidate.exitStatus !== undefined) continue;
        try {
          const identity = await terminalProcessIdentity(receipt.pid);
          if (identity.executablePath === receipt.executablePath && identity.commandLine === receipt.commandLine && identity.creationDate === receipt.creationDate) {
            this.terminals.set(row.session_id, candidate);
            this.verifiedReceipts.add(row.session_id);
          }
        } catch (error) { this.reconnectFailures.set(row.session_id, error instanceof Error ? error.message : String(error)); }
      }
    }
  }
  async open(row: CatalogRow): Promise<vscode.Terminal> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.session_id)) throw new Error('历史记录的会话 ID 不是有效 UUID。');
    if (row.kind !== 'root' || row.parent_session_id) throw new Error('内部子记录仅支持预览。请使用“打开父主会话终端”。');
    if (vscode.env.remoteName) throw new Error('这是本机 Muse 历史；请在本机 VS Code 窗口打开会话终端。');
    if (!vscode.workspace.isTrusted) throw new Error('打开 Muse 终端需要受信任工作区。请先在 VS Code 中管理工作区信任。');
    const existing = this.terminals.get(row.session_id);
    if (existing && existing.exitStatus === undefined) { existing.show(); return existing; }
    await this.reconnect([row]);
    const restored = this.terminals.get(row.session_id);
    if (restored && restored.exitStatus === undefined) { restored.show(); return restored; }
    const unresolved = this.reconnectFailures.get(row.session_id);
    if (unresolved) throw new Error(`无法确认重载后已有 Muse 终端的归属，已保留该终端。请直接使用原终端，或关闭它后重试。${unresolved}`);
    const pending = this.opening.get(row.session_id);
    if (pending) { const terminal = await pending; terminal.show(); return terminal; }
    const create = this.create(row);
    this.opening.set(row.session_id, create);
    try { return await create; } finally { this.opening.delete(row.session_id); }
  }
  private async create(row: CatalogRow): Promise<vscode.Terminal> {
    if (row.workspace_source === 'own-terminal') throw new Error('此目录来自本扩展终端启动记录，只能切回已验证的存活终端。请刷新历史后再打开新终端。');
    if (!row.workspace || !(await stat(row.workspace).catch(() => undefined))?.isDirectory()) {
      throw new Error(`原工作目录不存在，无法安全打开终端：${row.workspace || '（记录未提供目录）'}`);
    }
    const shellPath = await this.engine();
    const terminal = vscode.window.createTerminal({
      name: `Muse ${row.session_id.slice(-12)} · ${row.title.slice(0, 40)}`,
      shellPath,
      shellArgs: [...(this.test?.extraArgs ?? []), 'resume', row.session_id],
      cwd: row.workspace,
      env: { ...this.test?.env, [MARKER]: this.owner, [SESSION]: row.session_id },
      iconPath: new vscode.ThemeIcon('history'),
      isTransient: false,
    });
    this.terminals.set(row.session_id, terminal);
    terminal.show();
    try {
      const pid = await terminal.processId;
      if (pid !== undefined && terminal.exitStatus === undefined) {
        const identity = await terminalProcessIdentity(pid);
        if (resolve(identity.executablePath).toLowerCase() !== resolve(shellPath).toLowerCase()) throw new Error('终端进程与所选 Muse 引擎不匹配。');
        if (terminal.exitStatus === undefined && vscode.window.terminals.includes(terminal)) {
          this.receipts.set(row.session_id, { sessionId: row.session_id, pid, engine: shellPath, cwd: row.workspace, argv: [...(this.test?.extraArgs ?? []), 'resume', row.session_id], ...identity });
          this.verifiedReceipts.add(row.session_id);
          await this.state.update('terminalReceipts.v1', [...this.receipts.values()]);
        }
      }
    } catch (error) { void vscode.window.showWarningMessage(`Muse 终端已打开，但无法保存重载后的切换凭据：${error instanceof Error ? error.message : String(error)}`); }
    vscode.window.setStatusBarMessage('Muse 终端已打开，等待 Muse。若会话被其他窗口占用，请按 CLI 提示操作。', 6000);
    return terminal;
  }
  dispose(): void {
    this.closed.dispose();
    this.ownedClosed.dispose();
    // VS Code owns live terminal persistence. Deactivation must not interrupt work.
    this.terminals.clear();
  }
}
