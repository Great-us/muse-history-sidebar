import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { CatalogRow, CatalogHistoryPage } from '../shared/sessionCatalog';
import { mergeCatalogEntries } from '../shared/sessionCatalog';
import { historyItemsToLogEntries, historyEventsToLogEntries } from '../shared/history';
import type { LogEntry } from '../shared/types';
import { escapeHtml, renderEntries } from './render';

export class HistoryPreview {
  readonly panel: vscode.WebviewPanel;
  entries: LogEntry[] = [];
  cursor: string | null = null;
  private loading = false;
  private warning = '';
  private error = '';
  private disposed = false;
  private readonly nonce = randomBytes(18).toString('base64');
  constructor(private readonly row: CatalogRow, private readonly extensionUri: vscode.Uri, private readonly read: (id: string, cursor?: string) => Promise<CatalogHistoryPage>) {
    this.panel = vscode.window.createWebviewPanel('museHistory.preview', `预览 · ${row.title || row.session_id}`, vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')], retainContextWhenHidden: true });
    this.panel.webview.onDidReceiveMessage(message => {
      if (message?.type === 'more' && (this.cursor || this.error) && !this.loading) void this.load(this.cursor ?? undefined);
    });
    this.panel.onDidDispose(() => { this.disposed = true; });
    this.render();
  }
  async load(cursor?: string): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.error = '';
    this.render();
    try {
      const page = await this.read(this.row.session_id, cursor);
      const incoming = page.items?.length ? historyItemsToLogEntries(page.items) : historyEventsToLogEntries(page.events ?? []);
      this.entries = mergeCatalogEntries(this.entries, incoming);
      this.cursor = page.next_cursor ?? null;
      this.warning = page.warning ?? this.warning;
    } catch (error) { this.error = String(error instanceof Error ? error.message : error); }
    finally { this.loading = false; this.render(); }
  }
  html(): string {
    const webview = this.panel.webview;
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'preview.css'));
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'preview.js'));
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${this.nonce}'; img-src 'none'; font-src 'none';"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${css}"></head><body><h1>${escapeHtml(this.row.title || this.row.session_id)}</h1><p class="muted">只读预览 · ${escapeHtml(this.row.workspace)}<br>${escapeHtml(this.row.session_id)}</p>${this.warning ? `<p class="notice">${escapeHtml(this.warning)}</p>` : ''}${renderEntries(this.entries)}${this.error ? `<p role="alert">${escapeHtml(this.error)}</p>` : ''}<footer><p>已加载 ${this.entries.length} 条记录${this.cursor ? '，还有更多' : this.loading ? '' : ' · 已到末尾'}</p>${this.loading ? '<p>正在读取…</p>' : this.cursor || this.error ? '<button id="more">加载更多 / 重试</button>' : ''}</footer><script nonce="${this.nonce}" src="${script}"></script></body></html>`;
  }
  private render(): void { if (!this.disposed) this.panel.webview.html = this.html(); }
}
