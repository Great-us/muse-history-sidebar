import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, writeFile, rm, symlink, copyFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { CatalogService, recycleScope, requireSessionId, verifyRecycled } from "../src/backend/catalogService";
import { museDataRoot, resolveEngine, validateEngine } from "../src/backend/engine";
import { buildInventoryRows, completeRootMetadata, listAll, readCursor, scanDisk } from "../src/backend/inventory";
import { MspError, StdioMspHost, validateInitialize } from "../src/backend/mspHost";
import type { CatalogRow } from "../src/shared/sessionCatalog";

async function fixture(): Promise<string> {
  await mkdir(path.join(process.cwd(), "work", "backend-tests"), { recursive: true });
  return mkdtemp(path.join(process.cwd(), "work", "backend-tests", "test-"));
}

function row(id: string, parent?: string): CatalogRow {
  return { session_id: id, parent_session_id: parent, workspace: "", title: id, kind: parent ? "subagent" : "root", log_path: path.resolve("work", "synthetic-sessions", id, "session.jsonl"), indexed: !parent, workspace_exists: false, running: false, log_bytes: 0 };
}

test("home resolution honors only absolute XDG and never an ambient synthetic fallback", () => {
  const home = path.resolve("work", "isolated-home");
  assert.equal(museDataRoot({ HOME: home, XDG_DATA_HOME: "relative" }), path.join(home, ".local", "share", "muse"));
  assert.equal(museDataRoot({ HOME: home, XDG_DATA_HOME: path.join(home, "xdg") }), path.join(home, "xdg", "muse"));
  assert.throws(() => museDataRoot({}), /HOME/);
  assert.throws(() => requireSessionId("../session"), /Invalid/);
  assert.throws(() => readCursor(12, "cursor"), /opaque string/);
});

test("schema identity, version and fingerprint fail explicitly", () => {
  const valid = { serverInfo: { name: "muse", version: "1.4" }, schema: { version: 1, fingerprint: "sha256:abc" } };
  validateInitialize(valid);
  assert.throws(() => validateInitialize({ ...valid, schema: { ...valid.schema, version: 2 } }), /Unsupported/);
  assert.throws(() => validateInitialize({ ...valid, serverInfo: { name: "other", version: "1" } }), /identity/);
  assert.throws(() => validateInitialize({ ...valid, schema: { version: 1 } }), /fingerprint/);
});

test("listing pages every root, forwards opaque cursor and rejects repeated cursors", async () => {
  const calls: Record<string, unknown>[] = [];
  const host = { request: async (_method: string, params: Record<string, unknown>) => {
    calls.push(params);
    return params.cursor ? { sessions: [{ sessionId: "B" }], nextCursor: null } : { sessions: [{ sessionId: "A" }], nextCursor: " opaque cursor " };
  } } as unknown as StdioMspHost;
  assert.deepEqual((await listAll(host)).map(item => item.sessionId), ["A", "B"]);
  assert.equal(calls[1].cursor, " opaque cursor ");
  const repeat = { request: async () => ({ sessions: [], nextCursor: "repeat" }) } as unknown as StdioMspHost;
  await assert.rejects(listAll(repeat), /repeated cursor/);
  await assert.rejects(listAll({ request: async () => ({}) } as unknown as StdioMspHost), /sessions array/);
});

test("metadata walk finds all grandchildren without following a real junction", async () => {
  const base = await fixture();
  try {
    const sessions = path.join(base, "sessions");
    const outside = path.join(base, "outside");
    const root = path.join(sessions, randomUUID());
    const child = path.join(root, "subagent", randomUUID());
    const grandchild = path.join(child, "subagent", randomUUID());
    for (const directory of [root, child, grandchild, outside]) {
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "session.jsonl"), "NOT A PRIVATE HISTORY PARSER: metadata only.\n");
    }
    await symlink(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    const scanned = await scanDisk(sessions, process.env);
    assert.deepEqual(scanned.warnings, []);
    assert.equal(scanned.sessions.length, 3);
    assert.equal(scanned.sessions[0].parent_directory, null);
    assert.equal(scanned.sessions[2].parent_directory, child);
    const inventory = await buildInventoryRows([{ sessionId: path.basename(root), workspaceRoot: base, path: path.join(root, "session.jsonl"), title: "Synthetic root", kind: "root" }], scanned.sessions);
    assert.equal(inventory.length, 3);
    assert.equal(inventory[2].parent_session_id, path.basename(child));
    assert.match(inventory[2].title, new RegExp(`^\\[${path.basename(grandchild).slice(-12)}\\]`));
    assert.equal(inventory[2].workspace, base);
    assert.ok(inventory[2].created_at && inventory[2].updated_at);
  } finally { await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});

test("leased root metadata restores folder across cold refresh with zero child reads", async () => {
  const base = await fixture();
  try {
    const rootId = randomUUID();
    const rootDir = path.join(base, "sessions", rootId);
    const metadata = { created_at: new Date(0).toISOString(), updated_at: new Date(1).toISOString(), log_bytes: 1 };
    const disk = [{ ...metadata, directory: rootDir, parent_directory: null }, ...Array.from({ length: 150 }, () => ({ ...metadata, directory: path.join(rootDir, "subagent", randomUUID()), parent_directory: rootDir }))];
    const root = { sessionId: rootId, path: path.join(rootDir, "session.jsonl"), workspaceRoot: base, title: "Known synthetic folder", kind: "root" };
    const calls: string[] = [];
    const host = { request: async (_method: string, params: Record<string, unknown>) => { calls.push(String(params.sessionId)); return { session: root }; } } as unknown as StdioMspHost;
    const before = await completeRootMetadata(host, [root], disk);
    assert.equal(calls.length, 0);
    assert.equal((await buildInventoryRows(before.roots, disk, new Set([rootId])))[0].workspace, base);
    for (let refresh = 0; refresh < 2; refresh++) {
      const during = await completeRootMetadata(host, [], disk);
      const inventory = await buildInventoryRows(during.roots, disk, new Set());
      assert.equal(inventory[0].workspace, base);
      assert.equal(inventory[0].title, root.title);
      assert.equal(inventory[0].indexed, false);
      assert.ok(inventory.slice(1).every(row => row.workspace === base));
    }
    assert.deepEqual(calls, [rootId, rootId]);
    const after = await completeRootMetadata(host, [root], disk);
    assert.equal((await buildInventoryRows(after.roots, disk, new Set([rootId])))[0].indexed, true);
    assert.equal(calls.length, 2);
    const refused = await completeRootMetadata({ request: async () => { throw new MspError("corrupt synthetic root", -32020, "invalidSession"); } } as unknown as StdioMspHost, [], [disk[0]]);
    assert.match(refused.warnings[0], /corrupt synthetic root/);
    await assert.rejects(completeRootMetadata({ request: async () => { throw new Error("transport failed"); } } as unknown as StdioMspHost, [], [disk[0]]), /transport failed/);
    await assert.rejects(completeRootMetadata({ request: async () => ({ session: { ...root, sessionId: randomUUID() } }) } as unknown as StdioMspHost, [], [disk[0]]), /mismatched/);
    await assert.rejects(completeRootMetadata({ request: async () => ({ session: { ...root, path: path.join(base, "outside", rootId, "session.jsonl") } }) } as unknown as StdioMspHost, [], [disk[0]]), /mismatched/);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("recycle refuses owned terminal descendants and ancestors before moving", () => {
  const rows = [row("root"), row("child", "root"), row("grandchild", "child"), row("other")];
  rows[1].log_path = path.join(path.dirname(rows[0].log_path), "subagent", "child", "session.jsonl");
  rows[2].log_path = path.join(path.dirname(rows[1].log_path), "subagent", "grandchild", "session.jsonl");
  assert.equal(recycleScope(rows, "root", new Set()).length, 3);
  assert.throws(() => recycleScope(rows, "root", new Set(["grandchild"])), /in use/);
  assert.throws(() => recycleScope(rows, "grandchild", new Set(["root"])), /parent is open/);
  assert.equal(recycleScope(rows, "other", new Set(["root"])).length, 1);
});

test("cold recycle verification requires list absence AND exact code/kind for selected ID", async () => {
  const makeHost = (listed: string[], error?: Error, readable = false) => ({ request: async (method: string) => {
    if (method === "session/list") return { sessions: listed.map(sessionId => ({ sessionId })) };
    if (readable) return { session: {} };
    throw error ?? new MspError("missing", -32020, "sessionNotFound");
  } }) as unknown as StdioMspHost;
  await verifyRecycled(makeHost([]), "root");
  await assert.rejects(verifyRecycled(makeHost(["root"]), "root"), /still listed/);
  await assert.rejects(verifyRecycled(makeHost([], new MspError("missing", -32020, "wrongKind")), "root"), /missing/);
  await assert.rejects(verifyRecycled(makeHost([], new Error("timeout")), "root"), /timeout/);
  await assert.rejects(verifyRecycled(makeHost([], undefined, true), "root"), /still readable/);
});

test("151-row physical recycle scope excludes outside logical links and needs only one read RPC", async () => {
  const root = row("root");
  const children = Array.from({ length: 150 }, (_, index) => ({
    ...row(`child-${index}`, "root"),
    log_path: path.join(path.dirname(root.log_path), "subagent", `child-${index}`, "session.jsonl"),
  }));
  const outside = row("outside", "root");
  const scope = recycleScope([root, ...children, outside], "root", new Set(["outside"]));
  assert.equal(scope.length, 151);
  assert.ok(!scope.some(row => row.session_id === outside.session_id));
  const reads: string[] = [];
  const host = { request: async (method: string, params: Record<string, unknown>) => {
    if (method === "session/list") return { sessions: [{ sessionId: "outside" }] };
    reads.push(String(params.sessionId));
    throw new MspError("missing", -32020, "sessionNotFound");
  } } as unknown as StdioMspHost;
  await verifyRecycled(host, scope[0].session_id);
  assert.deepEqual(reads, ["root"]);
});

test("engine path returns while a long history read is pending", { skip: !process.env.MUSE_TEST_ENGINE }, async () => {
  const base = await fixture();
  const service = new CatalogService({ storagePath: base, nativeHelperPath: "unused.exe", enginePath: process.env.MUSE_TEST_ENGINE, env: { ...process.env, HOME: base, USERPROFILE: base, XDG_DATA_HOME: path.join(base, "data"), XDG_CONFIG_HOME: path.join(base, "config"), APPDATA: path.join(base, "roaming"), LOCALAPPDATA: path.join(base, "local") } });
  let rejectRead: (error: Error) => void = () => undefined;
  let startedRead: () => void = () => undefined;
  const started = new Promise<void>(resolve => { startedRead = resolve; });
  const host = {
    isClosed: false,
    request: () => { startedRead(); return new Promise((_resolve, reject) => { rejectRead = reject; }); },
    stop: async () => { rejectRead(new Error("stopped")); },
  } as unknown as StdioMspHost;
  (service as unknown as { host: StdioMspHost }).host = host;
  const pending = service.readHistory(randomUUID());
  const rejected = assert.rejects(pending, /stopped/);
  await started;
  let timer: NodeJS.Timeout | undefined;
  try {
    const engine = await Promise.race([
      service.getEnginePath(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Engine path waited behind history read")), 2_000); }),
    ]);
    assert.equal(engine, process.env.MUSE_TEST_ENGINE);
  } finally {
    if (timer) clearTimeout(timer);
    await service.dispose();
    await rejected;
    await rm(base, { recursive: true, force: true });
  }
  await assert.rejects(service.getEnginePath(), /disposed/);
});

test("stopping the owned stdio host rejects a pending long read and terminates it", async () => {
  const base = await fixture();
  try {
    const script = path.join(base, "host.cjs");
    await writeFile(script, `const r=require('node:readline').createInterface({input:process.stdin});r.on('line',line=>{const f=JSON.parse(line);if(f.method==='initialize')process.stdout.write(JSON.stringify({id:f.id,result:{serverInfo:{name:'muse',version:'test'},schema:{version:1,fingerprint:'sha256:test'}}})+'\\n');});setInterval(()=>{},1000);`);
    const host = new StdioMspHost(process.execPath, [script], base, process.env);
    await host.initialize();
    const pending = host.request("session/read", { sessionId: randomUUID(), excludeItems: true });
    const rejected = assert.rejects(pending, /stopped/);
    const started = Date.now();
    await host.stop();
    await rejected;
    assert.ok(Date.now() - started < 5_000);
    assert.ok(host.child.exitCode !== null || host.child.signalCode !== null);
  } finally { await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});

test("actual engine discovery and read-only synthetic MSP integration", { skip: !process.env.MUSE_TEST_ENGINE }, async () => {
  const engine = process.env.MUSE_TEST_ENGINE!;
  const base = await fixture();
  try {
    const portable = path.join(base, "home", "MuseCode");
    await mkdir(portable, { recursive: true });
    const linked = path.join(portable, "muse-bin-test.exe");
    await copyFile(engine, linked);
    await writeFile(path.join(portable, ".muse-version"), "test\n");
    const env = { ...process.env, HOME: path.join(base, "home"), USERPROFILE: path.join(base, "home"), XDG_DATA_HOME: path.join(base, "data"), XDG_CONFIG_HOME: path.join(base, "config"), APPDATA: path.join(base, "roaming"), LOCALAPPDATA: path.join(base, "local"), PATH: "" };
    assert.equal(await resolveEngine(undefined, env), linked);
    await writeFile(path.join(portable, "muse-bin-newer.exe"), "not an engine");
    await writeFile(path.join(portable, "muse.cmd"), "DO NOT EXECUTE LAUNCHERS");
    assert.equal(await resolveEngine(undefined, { ...env, PATH: portable }), linked);
    assert.equal(await resolveEngine(engine, { ...env, PATH: portable }), engine);
    await assert.rejects(validateEngine(path.join(portable, "muse.cmd"), env), /native Muse engine/);
    const defaultInstall = path.join(env.LOCALAPPDATA, "Programs", "muse");
    await mkdir(defaultInstall, { recursive: true });
    await copyFile(engine, path.join(defaultInstall, path.basename(linked)));
    await writeFile(path.join(defaultInstall, ".muse-version"), "test\n");
    assert.equal(await resolveEngine(undefined, { ...env, USERPROFILE: path.join(base, "no-portable") }), path.join(defaultInstall, path.basename(linked)));
    const service = new CatalogService({ storagePath: path.join(base, "storage"), nativeHelperPath: path.join(base, "not-used.exe"), env, extraServeArgs: ["--provider", "echo"] });
    try {
      const empty = await service.refresh();
      assert.deepEqual(empty.sessions, []);
      await assert.rejects(service.readHistory(randomUUID()), error => error instanceof MspError && error.code === -32020 && error.kind === "sessionNotFound");
      const refreshed = await service.refresh();
      assert.deepEqual(refreshed.sessions, []);
      const corruptId = randomUUID();
      const corruptDir = path.join(service.getDataRoot(), "sessions", "2026", "10", "30", corruptId);
      await mkdir(corruptDir, { recursive: true });
      await writeFile(path.join(corruptDir, "session.jsonl"), "This is deliberately an unknown synthetic format.\n");
      assert.ok((await service.refresh()).sessions.some(row => row.session_id === corruptId && !row.indexed));
      await assert.rejects(service.readHistory(corruptId), /unreadable|unknown|corrupt|not found|No session/i);
    } finally { await service.dispose(); }

    const harnessUrl = pathToFileURL(path.join(process.cwd(), "test", "backend-fixture.mjs")).href;
    const harness = await import(harnessUrl);
    const seedEnv = harness.isolatedEnv(path.join(base, "seed"));
    const workspace = path.join(base, "seed-workspace");
    await mkdir(workspace, { recursive: true });
    const seed = await harness.createSyntheticSession({ binary: engine, workspace, env: seedEnv });
    const seeded = new CatalogService({ enginePath: engine, storagePath: path.join(base, "seed-storage"), nativeHelperPath: path.join(base, "not-used.exe"), env: seedEnv, extraServeArgs: ["--provider", "echo"] });
    try {
      const inventory = await seeded.refresh();
      assert.ok(inventory.sessions.some(row => row.session_id === seed.sessionId));
      const children = inventory.sessions.filter(row => row.parent_session_id === seed.sessionId);
      assert.ok(children.length > 0);
      assert.ok(children.every(row => !row.indexed));
      const history = await seeded.readHistory(seed.sessionId);
      assert.ok(history.events && history.events.length > 0);
      const child = await seeded.readHistory(children[0].session_id);
      assert.ok(child.events && child.events.length > 0);
    } finally { await seeded.dispose(); }
  } finally { await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});

test("actual recoverable recycle uses native helper then strict cold absence verification", { skip: !process.env.MUSE_TEST_ENGINE || process.env.MUSE_TEST_RECYCLE !== "1" }, async () => {
  const base = await fixture();
  const engine = process.env.MUSE_TEST_ENGINE!;
  try {
    const env = { ...process.env, HOME: path.join(base, "home"), USERPROFILE: path.join(base, "home"), XDG_DATA_HOME: path.join(base, "data"), XDG_CONFIG_HOME: path.join(base, "config"), APPDATA: path.join(base, "roaming"), LOCALAPPDATA: path.join(base, "local") };
    // The test-only harness creates a durable synthetic root using the local echo provider.
    const harnessUrl = pathToFileURL(path.join(process.cwd(), "test", "backend-fixture.mjs")).href;
    const harness = await import(harnessUrl);
    const writer = harness.createHost({ workspace: base, env, binary: engine });
    let sessionId: string;
    await writer.connect();
    try {
      sessionId = (await writer.request("session/start", { commandId: harness.uuidv7(), workspaceRoot: base })).session.sessionId;
      const turn = await harness.turn(writer, sessionId, "Synthetic recyclable backend verification only. Echo locally.");
      assert.equal(turn.terminal, "completed");
    }
    finally { await writer.stop(); }
    const service = new CatalogService({ storagePath: path.join(base, "storage"), nativeHelperPath: path.resolve("bin", "muse-history-recycle.exe"), enginePath: engine, env, extraServeArgs: ["--provider", "echo"] });
    try {
      const before = await service.refresh();
      assert.ok(before.sessions.some(row => row.session_id === sessionId));
      await assert.rejects(service.recycle(sessionId, new Set([sessionId])), /open in a companion terminal/);
      assert.ok((await service.refresh()).sessions.some(row => row.session_id === sessionId));
      const result = await service.recycle(sessionId);
      assert.equal(result.status, "recycled", result.message);
      assert.deepEqual(new Set(result.recycled_session_ids), new Set(before.sessions.map(row => row.session_id)));
      assert.ok(!(await service.refresh()).sessions.some(row => row.session_id === sessionId));
      await assert.rejects(service.readHistory(sessionId), error => error instanceof MspError && error.code === -32020 && error.kind === "sessionNotFound");
    } finally { await service.dispose(); }
  } finally { await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});
