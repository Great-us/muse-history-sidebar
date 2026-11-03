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
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.session_id)) throw new Error('The history session ID is not a valid UUID.');
    if (row.kind !== 'root' || row.parent_session_id) throw new Error('Internal child records support preview only. Use "Open Parent Main Session Terminal".');
    if (vscode.env.remoteName) throw new Error('This is local Muse history; open session terminals in a local VS Code window.');
    if (!vscode.workspace.isTrusted) throw new Error('Opening a Muse terminal requires a trusted workspace. Manage workspace trust in VS Code first.');
    const existing = this.terminals.get(row.session_id);
    if (existing && existing.exitStatus === undefined) { existing.show(); return existing; }
    await this.reconnect([row]);
    const restored = this.terminals.get(row.session_id);
    if (restored && restored.exitStatus === undefined) { restored.show(); return restored; }
    const unresolved = this.reconnectFailures.get(row.session_id);
    if (unresolved) throw new Error(`Could not confirm ownership of an existing Muse terminal after reload; that terminal was kept. Use the original terminal directly, or close it and retry. ${unresolved}`);
    const pending = this.opening.get(row.session_id);
    if (pending) { const terminal = await pending; terminal.show(); return terminal; }
    const create = this.create(row);
    this.opening.set(row.session_id, create);
    try { return await create; } finally { this.opening.delete(row.session_id); }
  }
  private async create(row: CatalogRow): Promise<vscode.Terminal> {
    if (row.workspace_source === 'own-terminal') throw new Error('This directory comes from a terminal launch record of this extension and can only switch back to the verified live terminal. Refresh the history before opening a new terminal.');
    if (!row.workspace || !(await stat(row.workspace).catch(() => undefined))?.isDirectory()) {
      throw new Error(`The original working directory no longer exists; a terminal cannot be opened safely: ${row.workspace || '(no directory recorded)'}`);
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
        if (resolve(identity.executablePath).toLowerCase() !== resolve(shellPath).toLowerCase()) throw new Error('The terminal process does not match the selected Muse engine.');
        if (terminal.exitStatus === undefined && vscode.window.terminals.includes(terminal)) {
          this.receipts.set(row.session_id, { sessionId: row.session_id, pid, engine: shellPath, cwd: row.workspace, argv: [...(this.test?.extraArgs ?? []), 'resume', row.session_id], ...identity });
          this.verifiedReceipts.add(row.session_id);
          await this.state.update('terminalReceipts.v1', [...this.receipts.values()]);
        }
      }
    } catch (error) { void vscode.window.showWarningMessage(`The Muse terminal opened, but its post-reload switching credential could not be saved: ${error instanceof Error ? error.message : String(error)}`); }
    vscode.window.setStatusBarMessage('Muse terminal opened, waiting for Muse. If another window holds the session, follow the CLI prompt.', 6000);
    return terminal;
  }
  dispose(): void {
    this.closed.dispose();
    this.ownedClosed.dispose();
    // VS Code owns live terminal persistence. Deactivation must not interrupt work.
    this.terminals.clear();
  }
}
