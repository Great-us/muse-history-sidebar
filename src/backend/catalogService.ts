import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { CatalogHistoryPage, CatalogInventory, CatalogRecycleResult, CatalogRow } from "../shared/sessionCatalog";
import { museDataRoot, resolveEngine, validateEngine } from "./engine";
import { buildInventoryRows, completeRootMetadata, listAll, readCursor, scanDisk } from "./inventory";
import { MspError, objectValue, StdioMspHost } from "./mspHost";

export interface CatalogOptions {
  storagePath: string;
  nativeHelperPath: string;
  enginePath?: string;
  env?: NodeJS.ProcessEnv;
  /** Only isolated test harnesses supply additional serve arguments. */
  extraServeArgs?: string[];
}

export function requireSessionId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error("Invalid Muse session ID.");
  return value;
}

export function recycleScope(rows: readonly CatalogRow[], sessionId: string, inUseIds: ReadonlySet<string>): CatalogRow[] {
  const byId = new Map(rows.map(row => [row.session_id, row]));
  const selected = byId.get(sessionId);
  if (!selected) throw new Error("Session is absent from the current inventory. Refresh the sidebar.");
  let ancestor: CatalogRow | undefined = selected;
  while (ancestor) {
    if (inUseIds.has(ancestor.session_id)) throw new Error("This session or its parent is open in a companion terminal. Close that terminal before recycling.");
    ancestor = ancestor.parent_session_id ? byId.get(ancestor.parent_session_id) : undefined;
  }
  const targetDirectory = path.dirname(selected.log_path);
  const scope = [selected, ...rows.filter(row => {
    if (row === selected) return false;
    const relative = path.relative(targetDirectory, path.dirname(row.log_path));
    return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  })];
  if (scope.some(row => inUseIds.has(row.session_id) || row.running)) throw new Error("This session or a descendant is in use. Close it before recycling.");
  return scope;
}

export async function verifyRecycled(host: StdioMspHost, sessionId: string): Promise<void> {
  const listed = await listAll(host);
  if (listed.some(candidate => candidate.sessionId === sessionId)) throw new Error(`Session ${sessionId} is still listed after recycling.`);
  try {
    await host.request("session/read", { sessionId, excludeItems: true });
  } catch (error) {
    if (error instanceof MspError && error.code === -32020 && error.kind === "sessionNotFound") return;
    throw error;
  }
  throw new Error(`Session ${sessionId} is still readable after recycling.`);
}

/** Owns one neutral host. Operations serialize; disposal cancels immediately. */
export class CatalogService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly dataRoot: string;
  private enginePath: string | undefined;
  private host: StdioMspHost | undefined;
  private neutralDirectory: string | undefined;
  private stopping: Promise<void> | undefined;
  private serial: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(private readonly options: CatalogOptions) {
    this.env = { ...(options.env ?? process.env), MUSE_NO_AUTO_UPDATE: "1" };
    this.dataRoot = museDataRoot(this.env);
    this.enginePath = options.enginePath;
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.serial.then(() => {
      if (this.disposed) throw new Error("Muse catalog has been disposed.");
      return operation();
    });
    this.serial = task.catch(() => undefined);
    return task;
  }

  getDataRoot(): string { return this.dataRoot; }

  async getEnginePath(): Promise<string> {
    if (this.disposed) throw new Error("Muse catalog has been disposed.");
    const selected = this.enginePath;
    const engine = await resolveEngine(selected, this.env);
    if (this.disposed) throw new Error("Muse catalog has been disposed.");
    if (this.enginePath !== selected) return this.getEnginePath();
    this.enginePath = engine;
    return engine;
  }

  setEnginePath(file: string): Promise<void> {
    return this.run(async () => {
      const validated = await validateEngine(file, this.env);
      await this.stopHost();
      this.enginePath = validated;
    });
  }

  private async stopHost(): Promise<void> {
    if (this.stopping) return this.stopping;
    const host = this.host;
    const neutral = this.neutralDirectory;
    this.host = undefined;
    this.neutralDirectory = undefined;
    this.stopping = (async () => {
      if (host) await host.stop();
      // This is only the unique mkdtemp folder created by this instance, never history.
      if (neutral) await rm(neutral, { recursive: true, force: true });
    })();
    try { await this.stopping; }
    finally { this.stopping = undefined; }
  }

  private async ensureHost(cold = false): Promise<StdioMspHost> {
    if (cold || this.host?.isClosed) await this.stopHost();
    if (this.host) return this.host;
    const engine = await resolveEngine(this.enginePath, this.env);
    if (this.disposed) throw new Error("Muse catalog has been disposed.");
    this.enginePath = engine;
    await mkdir(this.options.storagePath, { recursive: true });
    const neutral = await mkdtemp(path.join(this.options.storagePath, "catalog-host-"));
    if (this.disposed) { await rm(neutral, { recursive: true }); throw new Error("Muse catalog has been disposed."); }
    const host = new StdioMspHost(engine, ["serve", "--sandbox-network", "restricted", "--trust-workspace", ...(this.options.extraServeArgs ?? [])], neutral, this.env);
    this.host = host;
    this.neutralDirectory = neutral;
    try { await host.initialize(); }
    catch (error) { await this.stopHost(); throw error; }
    return host;
  }

  private async inventory(cold: boolean): Promise<CatalogInventory> {
    const host = await this.ensureHost(cold);
    const official = await listAll(host);
    const scanned = await scanDisk(path.join(this.dataRoot, "sessions"), this.env);
    const completed = await completeRootMetadata(host, official, scanned.sessions);
    const sessions = await buildInventoryRows(completed.roots, scanned.sessions, new Set(official.map(row => String(row.sessionId))));
    const warnings = [...scanned.warnings, ...completed.warnings];
    const unindexedRoots = sessions.filter(row => !row.indexed && !row.parent_session_id).length;
    if (unindexedRoots) warnings.push(`${unindexedRoots} unindexed session folder(s) are shown for browsing; unreadable formats will fail explicitly on preview.`);
    return { sessions, engine_path: this.enginePath!, data_root: this.dataRoot, warnings };
  }

  refresh(): Promise<CatalogInventory> { return this.run(() => this.inventory(true)); }

  readHistory(sessionId: string, cursor?: string): Promise<CatalogHistoryPage> {
    requireSessionId(sessionId);
    const checkedCursor = readCursor(cursor, "view/page cursor");
    return this.run(async () => {
      const host = await this.ensureHost();
      if (checkedCursor === undefined) {
        const read = objectValue(await host.request("session/read", { sessionId, excludeItems: true }), "session/read result");
        const session = objectValue(read.session, "session/read session");
        if (session.sessionId !== sessionId) throw new Error("Muse session/read returned a different session identity.");
      }
      const result = objectValue(await host.request("view/page", {
        sessionId, direction: "forward", limit: 500,
        ...(checkedCursor === undefined ? {} : { cursor: checkedCursor }),
      }), "view/page result");
      if (!Array.isArray(result.events)) throw new Error("view/page returned no events array.");
      const next = readCursor(result.nextCursor, "view/page nextCursor");
      if (next !== undefined && next === checkedCursor) throw new Error("view/page returned a repeated cursor.");
      if (checkedCursor === undefined && result.events.length === 0) {
        const listed = await listAll(host);
        if (!listed.some(row => row.sessionId === sessionId)) throw new Error(`Session ${sessionId} has no engine-readable transcript (unknown or unreadable history format).`);
      }
      return { events: result.events, next_cursor: next ?? null, warning: null };
    });
  }

  recycle(sessionId: string, inUseIds: ReadonlySet<string> = new Set()): Promise<CatalogRecycleResult> {
    requireSessionId(sessionId);
    return this.run(async () => {
      const inventory = await this.inventory(true);
      const scope = recycleScope(inventory.sessions, sessionId, inUseIds);
      const target = scope[0];
      await this.stopHost();
      const helper = await new Promise<{ stdout: string; error: Error | null }>(resolve => {
        execFile(this.options.nativeHelperPath, ["--root", path.join(this.dataRoot, "sessions"), "--session", sessionId, "--directory", path.dirname(target.log_path)],
          { env: this.env, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => resolve({ error, stdout }));
      });
      if (helper.error && !helper.stdout.trim()) throw helper.error;
      const result = objectValue(JSON.parse(helper.stdout), "native recycle result");
      if (helper.error || result.status !== "recycled" || result.sourceGone !== true || result.hasRecycleItem !== true || typeof result.deleteHresult !== "number" || result.deleteHresult < 0) {
        const message = typeof result.message === "string" ? result.message : helper.error?.message ?? "Native helper did not confirm a recoverable recycle operation.";
        if (result.sourceGone === true) return { status: "partial", message, recycled_session_ids: [] };
        throw new Error(message);
      }
      try {
        const host = await this.ensureHost(true);
        // The native receipt confirms the physical directory and everything
        // beneath it moved together. Only its selected identity needs MSP proof.
        await verifyRecycled(host, sessionId);
      } catch (error) {
        return { status: "partial", message: `Moved by the native helper, but cold verification failed: ${(error as Error).message}. Local archive state was retained.`, recycled_session_ids: [] };
      }
      return { status: "recycled", message: "Moved to the Windows Recycle Bin and verified absent from a fresh Muse host.", recycled_session_ids: scope.map(row => row.session_id) };
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stopHost();
  }
}
