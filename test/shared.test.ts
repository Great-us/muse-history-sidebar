import assert from "node:assert/strict";
import { test } from "node:test";
import { applyDisplayNames, buildCatalogForest, buildCatalogGroups, isCatalogRowArchived, MAX_DISPLAY_NAME, mergeCatalogEntries, normalizeDisplayName, type CatalogRow } from "../src/shared/sessionCatalog";
import { historyEventsToLogEntries, historyItemsToLogEntries } from "../src/shared/history";

function row(id: string, parent?: string): CatalogRow {
  return { session_id: id, parent_session_id: parent, workspace: "C:\\synthetic", title: id, kind: parent ? "subagent" : "root", log_path: "", indexed: !parent, workspace_exists: true, running: false, log_bytes: 0 };
}

test("archive inheritance preserves independently archived grandchildren and search reaches them", () => {
  const rows = [row("root"), row("child", "root"), row("grandchild needle", "child")];
  const forest = buildCatalogForest(rows);
  assert.equal(forest.trees[0].descendants.length, 2);
  assert.equal(buildCatalogGroups(forest, [], "all", "needle").length, 1);
  const archived = ["root", "grandchild needle"];
  const byId = new Map(rows.map(row => [row.session_id, row]));
  assert.ok(isCatalogRowArchived(rows[1], byId, new Set(archived)));
  const restoredParent = buildCatalogGroups(forest, ["grandchild needle"], "archived", "");
  assert.ok(restoredParent[0].trees[0].contextOnly);
  assert.ok(restoredParent[0].trees[0].children[0].contextOnly);
  assert.ok(restoredParent[0].trees[0].children[0].children[0].archived);
  assert.equal(buildCatalogGroups(forest, archived, "active", "").length, 0);
});

test("local display names replace titles, keep the engine title searchable, and normalize input", () => {
  const rows = [row("root"), row("child", "root"), row("other")];
  const named = applyDisplayNames(rows, { root: "  My   renamed\nroot  ", child: "   ", missing: "ghost" });
  assert.equal(named[0].title, "My renamed root");
  assert.equal(named[0].original_title, "root");
  assert.equal(named[1].title, "child", "blank name keeps the engine title");
  assert.equal(named[1].original_title, undefined);
  assert.equal(named.length, 3, "names of absent sessions never create rows");
  assert.equal(rows[0].title, "root", "input rows are not mutated");
  const forest = buildCatalogForest(named);
  assert.equal(buildCatalogGroups(forest, [], "active", "renamed").length, 1, "search finds the display name");
  assert.equal(buildCatalogGroups(forest, [], "active", "root").length, 1, "search still finds the engine title");
  assert.equal(normalizeDisplayName("x".repeat(500)).length, MAX_DISPLAY_NAME);
  assert.equal(normalizeDisplayName("\u0000tab\tname\u007f"), "tab name");
});

test("archived view keeps archived descendants placed under context-only parents", () => {
  const rows = [row("root"), row("child", "root"), row("other")];
  const groups = buildCatalogGroups(buildCatalogForest(rows), ["child", "other"], "archived", "");
  const trees = groups.flatMap(group => group.trees);
  assert.deepEqual(trees.map(tree => tree.row.session_id).sort(), ["other", "root"]);
  const root = trees.find(tree => tree.row.session_id === "root")!;
  assert.ok(root.contextOnly && !root.archived);
  assert.ok(root.children[0].archived && !root.children[0].contextOnly);
});

test("preview merges beyond 2000 entries and folds later revisions", () => {
  const items = Array.from({ length: 2501 }, (_, index) => ({ itemId: String(index), kind: "agentMessage", text: `line ${index}` }));
  const entries = historyItemsToLogEntries(items, 0);
  assert.equal(mergeCatalogEntries([], entries).length, 2501);
  const revised = historyEventsToLogEntries([
    { method: "item/started", params: { item: { itemId: "x", kind: "toolCall", revision: 1, visibleOutput: "old" } } },
    { method: "item/completed", params: { item: { itemId: "x", kind: "toolCall", revision: 2, visibleOutput: "new", status: "failed" } } },
    { method: "item/updated", params: { item: { itemId: "x", kind: "toolCall", revision: 1, visibleOutput: "stale" } } },
  ], 0);
  assert.equal(revised.length, 1);
  assert.equal(revised[0].text, "new");
  assert.equal(revised[0].failed, true);
  assert.equal(mergeCatalogEntries([...entries, { ...revised[0], text: "old" }], revised).find(entry => entry.itemId === "x")?.text, "new");
});
