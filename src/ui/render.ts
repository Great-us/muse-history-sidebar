import type MarkdownIt from 'markdown-it';
import type { LogEntry } from '../shared/types';

export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

/** The Markdown renderer is loaded on the first preview, never at activation, so a sidebar-only session never pays for it. */
type Markdown = ReturnType<typeof MarkdownIt>;
let markdownInstance: Markdown | undefined;
function markdown(): Markdown {
  if (markdownInstance) return markdownInstance;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Factory = require('markdown-it') as typeof MarkdownIt;
  const instance = new Factory({ html: false, linkify: false, typographer: false });
  // Transcript links and images stay inert: reading history never fetches a remote URL or runs a command URI.
  instance.renderer.rules.link_open = (tokens, index) => `<span class="record-link"><span class="muted">[${escapeHtml(String(tokens[index].attrGet('href') ?? ''))}] </span>`;
  instance.renderer.rules.link_close = () => '</span>';
  instance.renderer.rules.image = (tokens, index) => `<span>[Image: ${escapeHtml(tokens[index].content)} · ${escapeHtml(String(tokens[index].attrGet('src') ?? ''))}]</span>`;
  markdownInstance = instance;
  return instance;
}
const labels: Record<string, string> = { user: 'User', assistant: 'Muse', thinking: 'Thinking', tool: 'Tool', system: 'System', subagent: 'Sub-agent' };

function renderEntry(entry: LogEntry): string {
  const body = markdown().render(entry.text);
  const header = `<header>${labels[entry.role] ?? escapeHtml(entry.role)} <time>${escapeHtml(new Date(entry.ts).toLocaleString())}</time></header>`;
  const attachments = (entry.richContent?.map(item => `<p class="muted">Attachment: ${escapeHtml(item.path)} (${escapeHtml(item.mediaType)})</p>`).join('') ?? '') +
    (entry.outputRef ? `<p class="muted">Separately stored output (not expanded): ${escapeHtml(entry.outputRef)}</p>` : '');
  return entry.role === 'thinking' || entry.role === 'tool'
    ? `<details class="entry ${entry.role}" open><summary>${labels[entry.role]}</summary>${header}${body}${attachments}</details>`
    : `<section class="entry ${entry.role}">${header}${body}${attachments}</section>`;
}

/**
 * `cache` (per preview) keeps each entry's HTML keyed by the entry object.
 * Merging a new page keeps unchanged entry objects, so "load more" renders
 * only the new or revised entries instead of the whole transcript again.
 */
export function renderEntries(entries: readonly LogEntry[], cache?: WeakMap<LogEntry, string>): string {
  return entries.map(entry => {
    const cached = cache?.get(entry);
    if (cached !== undefined) return cached;
    const html = renderEntry(entry);
    cache?.set(entry, html);
    return html;
  }).join('');
}
