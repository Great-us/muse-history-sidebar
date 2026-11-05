import test from 'node:test';
import assert from 'node:assert/strict';
import { renderEntries } from '../src/ui/render';
import { mergeCatalogEntries } from '../src/shared/sessionCatalog';
import type { LogEntry } from '../src/shared/types';

test('preview renders markdown, thinking and tools while keeping transcript content inert', () => {
  const html = renderEntries([
    { id: '1', ts: 0, role: 'user', text: '**bold** <script>alert(1)</script> [click](command:evil) ![alt](https://example.com/a.png)' },
    { id: '2', ts: 1, role: 'thinking', text: 'Reasoning' },
    { id: '3', ts: 2, role: 'tool', text: '```sh\nrm -rf /\n```' },
  ]);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script|href=|<img|src=/);
  assert.match(html, /<details class="entry thinking"/);
  assert.match(html, /<details class="entry tool"/);
});

test('preview renders each merged entry once: loading more pages re-renders only new or revised entries', () => {
  const cache = new WeakMap<LogEntry, string>();
  const first = Array.from({ length: 300 }, (_, i) => ({ id: String(i), ts: i, role: 'assistant' as const, text: `page-one-${i}` }));
  const html1 = renderEntries(first, cache);
  // Same entry objects: served from the cache even if their text were (hypothetically) mutated.
  first[0].text = 'MUTATED AFTER RENDER';
  const second = mergeCatalogEntries(first, [{ id: '300', ts: 300, role: 'assistant', text: 'page-two' }, { id: '5', ts: 5, role: 'assistant', text: 'revised-5' }]);
  const html2 = renderEntries(second, cache);
  assert.match(html2, /page-one-0/, 'unchanged entry reused its cached HTML');
  assert.doesNotMatch(html2, /MUTATED/);
  assert.match(html2, /revised-5/, 'a revised entry (new object) is rendered again');
  assert.match(html2, /page-two/);
  assert.equal((html2.match(/<section /g) ?? []).length, 301);
  assert.ok(html1.length > 0);
});

test('preview does not truncate a loaded transcript beyond 2000 entries', () => {
  const html = renderEntries(Array.from({ length: 2401 }, (_, i) => ({ id: String(i), ts: i, role: 'assistant' as const, text: `message-${i}` })));
  assert.equal((html.match(/<section /g) ?? []).length, 2401);
  assert.match(html, /message-2400/);
});
