import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CatalogHistoryPage, CatalogInventory, CatalogRecycleResult, CatalogRow } from "../shared/sessionCatalog";

export interface CatalogArchiveResult {
  status: "archived" | "unarchived" | "partial";
  message: string;
  session_ids: string[];
  location: string;
}

/** Metadata written next to each archived folder (`<id>.archive.json`); the session folder itself is never modified. */
export interface ArchivedSessionMeta {
  version: 1;
  session_id: string;
  title: string;
  workspace: string;
  created_at: string | null;
  updated_at: string | null;
  archived_at: string;
  /** Path relative to `sessions/` (and to the archive folder), e.g. `2026/11/05/<id>`. */
  relative: string;
  sub_records: number;
}

export const ARCHIVE_META_SUFFIX = ".archive.json";

async function pathExists(file: string): Promise<boolean> {
  try { await lstat(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** `directory` must sit strictly inside `root` and end with the session ID; returns the relative path. */
export function relativeSessionPath(root: string, directory: string, sessionId: string): string {
  const relative = path.relative(path.resolve(root), path.resolve(directory));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || path.basename(relative) !== sessionId) {
    throw new Error("The session folder is not inside the Muse sessions folder; it cannot be archived.");
  }
  return relative;
}

/** Reads `*.archive.json` files up to four levels deep (yyyy/mm/dd). Malformed files are skipped. */
export async function readArchiveMeta(archiveRoot: string): Promise<ArchivedSessionMeta[]> {
  const found: ArchivedSessionMeta[] = [];
  const walk = async (directory: string, depth: number): Promise<void> => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isFile() && entry.name.endsWith(ARCHIVE_META_SUFFIX)) {
        try {
          const meta = JSON.parse(await readFile(full, "utf8")) as ArchivedSessionMeta;
          const relative = path.relative(archiveRoot, full.slice(0, -ARCHIVE_META_SUFFIX.length));
          if (meta.version === 1 && typeof meta.session_id === "string" && path.normalize(meta.relative) === relative) found.push({ ...meta, relative });
        } catch { /* not ours or damaged: ignored */ }
      } else if (entry.isDirectory() && depth < 3 && /^\d{1,4}$/.test(entry.name)) await walk(full, depth + 1);
    }
  };
  await walk(archiveRoot, 0);
  return found;
}

/** Archived sessions as sidebar rows (folder must still exist). */
export async function listArchivedSessions(archiveRoot: string): Promise<CatalogRow[]> {
  const rows: CatalogRow[] = [];
  for (const meta of await readArchiveMeta(archiveRoot)) {
    const directory = path.join(archiveRoot, meta.relative);
    if (!(await pathExists(directory))) continue;
    rows.push({
      session_id: meta.session_id, workspace: meta.workspace ?? "", title: meta.title ?? "", kind: "root", parent_session_id: null,
      created_at: meta.created_at, updated_at: meta.updated_at, log_path: path.join(directory, "session.jsonl"),
      indexed: false, workspace_exists: false, running: false, log_bytes: 0,
      archived_at: meta.archived_at, archived_sub_records: meta.sub_records,
    });
  }
  return rows;
}
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
  /** Engine files already proven by `--version`, keyed by path + size + mtime. */
  private readonly validatedEngines = new Set<string>();
  /** Number of engine hosts started (diagnostics and tests). */
  hostStarts = 0;

  constructor(private readonly options: CatalogOptions) {
    this.env = { ...(options.env ?? process.env), MUSE_NO_AUTO_UPDATE: "1" };
    this.dataRoot = museDataRoot(this.env);
    this.enginePath = options.enginePath;
  }

  /**
   * Operations serialize. When the last queued operation finishes, the engine
   * host is stopped right away: between user-triggered reads no engine process
   * (and no temporary folder) exists. The stop is queued behind the result, so
   * callers get their answer without waiting for the process to exit.
   */
  private run<T>(operation: () => Promise<T>): Promise<T> {
    this.pendingOps++;
    const task = this.serial.then(() => {
      if (this.disposed) throw new Error("Muse catalog has been disposed.");
      return operation();
    });
    this.serial = task.catch(() => undefined).then(async () => {
      this.pendingOps--;
      if (this.pendingOps === 0) await this.stopHost().catch(() => undefined);
    });
    return task;
  }

  private pendingOps = 0;

  /** Resolves once every queued operation finished and the engine host is gone. */
  idle(): Promise<void> { return this.serial.then(() => undefined); }

  get hostRunning(): boolean { return Boolean(this.host && !this.host.isClosed); }

  /** `--version` runs once per engine file version, not on every read. */
  private readonly validate = async (file: string, env: NodeJS.ProcessEnv): Promise<string> => {
    const metadata = await stat(file);
    const key = `${path.resolve(file).toLowerCase()}|${metadata.size}|${metadata.mtimeMs}`;
    if (this.validatedEngines.has(key)) return file;
    await validateEngine(file, env);
    this.validatedEngines.add(key);
    return file;
  };

  getDataRoot(): string { return this.dataRoot; }

  async getEnginePath(): Promise<string> {
    if (this.disposed) throw new Error("Muse catalog has been disposed.");
    const selected = this.enginePath;
    const engine = await resolveEngine(selected, this.env, this.validate);
    if (this.disposed) throw new Error("Muse catalog has been disposed.");
    if (this.enginePath !== selected) return this.getEnginePath();
    this.enginePath = engine;
    return engine;
  }

  setEnginePath(file: string): Promise<void> {
    return this.run(async () => {
      const validated = await this.validate(file, this.env);
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
    const engine = await resolveEngine(this.enginePath, this.env, this.validate);
    if (this.disposed) throw new Error("Muse catalog has been disposed.");
    this.enginePath = engine;
    await mkdir(this.options.storagePath, { recursive: true });
    const neutral = await mkdtemp(path.join(this.options.storagePath, "catalog-host-"));
    if (this.disposed) { await rm(neutral, { recursive: true }); throw new Error("Muse catalog has been disposed."); }
    const host = new StdioMspHost(engine, ["serve", "--sandbox-network", "restricted", "--trust-workspace", ...(this.options.extraServeArgs ?? [])], neutral, this.env);
    this.host = host;
    this.neutralDirectory = neutral;
    this.hostStarts++;
    try { await host.initialize(); }
    catch (error) { await this.stopHost(); throw error; }
    return host;
  }

  private async inventory(cold: boolean): Promise<CatalogInventory> {
    const host = await this.ensureHost(cold);
    const official = await listAll(host);
    const scanned = await scanDisk(path.join(this.dataRoot, "sessions"), this.env);
    const completed = await completeRootMetadata(host, official, scanned.sessions);
    const listed = new Set(official.map(row => String(row.sessionId)));
    const sessions = await buildInventoryRows(completed.roots, scanned.sessions, listed);
    return this.assemble(sessions, scanned.warnings, completed.warnings);
  }

  private assemble(sessions: CatalogRow[], scanWarnings: string[], rootWarnings: string[]): CatalogInventory {
    const warnings = [...scanWarnings, ...rootWarnings];
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

  /** Runs the native helper; null on a confirmed move to the Windows Recycle Bin, else a partial result or a thrown error. */
  private async recycleDirectory(root: string, sessionId: string, directory: string): Promise<CatalogRecycleResult | null> {
    const helper = await new Promise<{ stdout: string; error: Error | null }>(resolve => {
      execFile(this.options.nativeHelperPath, ["--root", root, "--session", sessionId, "--directory", directory],
        { env: this.env, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => resolve({ error, stdout }));
    });
    if (helper.error && !helper.stdout.trim()) throw helper.error;
    const result = objectValue(JSON.parse(helper.stdout), "native recycle result");
    if (helper.error || result.status !== "recycled" || result.sourceGone !== true || result.hasRecycleItem !== true || typeof result.deleteHresult !== "number" || result.deleteHresult < 0) {
      const message = typeof result.message === "string" ? result.message : helper.error?.message ?? "Native helper did not confirm a recoverable recycle operation.";
      if (result.sourceGone === true) return { status: "partial", message, recycled_session_ids: [] };
      throw new Error(message);
    }
    return null;
  }

  /** Folder that holds archived sessions: `<muse data>/archive/<yyyy>/<mm>/<dd>/<id>`, mirroring `sessions/`. */
  getArchiveRoot(): string { return path.join(this.dataRoot, "archive"); }

  /** Archived sessions, read from their metadata files only (no engine process). */
  listArchived(): Promise<CatalogRow[]> { return listArchivedSessions(this.getArchiveRoot()); }

  /**
   * Archive = move the whole session folder (its sub-agent records included)
   * out of Muse's `sessions/` into the archive folder. Muse no longer lists or
   * resumes it; Unarchive moves it back. Only an idle, indexed main session
   * that no terminal of this extension holds can be archived.
   */
  archive(sessionId: string, inUseIds: ReadonlySet<string> = new Set()): Promise<CatalogArchiveResult> {
    requireSessionId(sessionId);
    return this.run(async () => {
      const inventory = await this.inventory(true);
      const scope = recycleScope(inventory.sessions, sessionId, inUseIds);
      const target = scope[0];
      if (target.parent_session_id || target.kind !== "root") throw new Error("Only main sessions can be archived; their sub-agent records move together with them.");
      if (!target.indexed) throw new Error("Muse does not list this session right now (it may be open in another Muse window). Close it there, refresh, then archive.");
      const sessionsRoot = path.join(this.dataRoot, "sessions");
      const source = path.dirname(target.log_path);
      const relative = relativeSessionPath(sessionsRoot, source, sessionId);
      const destination = path.join(this.getArchiveRoot(), relative);
      if (await pathExists(destination)) throw new Error(`The archive folder already contains ${relative}. Nothing was moved.`);
      await this.stopHost();
      await mkdir(path.dirname(destination), { recursive: true });
      await rename(source, destination);
      const meta: ArchivedSessionMeta = {
        version: 1, session_id: sessionId, title: target.title, workspace: target.workspace,
        created_at: target.created_at ?? null, updated_at: target.updated_at ?? null,
        archived_at: new Date().toISOString(), relative, sub_records: scope.length - 1,
      };
      await writeFile(`${destination}${ARCHIVE_META_SUFFIX}`, JSON.stringify(meta, null, 2));
      try { await verifyRecycled(await this.ensureHost(true), sessionId); }
      catch (error) {
        return { status: "partial", message: `Moved to the archive folder, but Muse still reports it: ${(error as Error).message}`, session_ids: scope.map(row => row.session_id), location: destination };
      }
      return { status: "archived", message: `Moved to the archive folder: ${destination}`, session_ids: scope.map(row => row.session_id), location: destination };
    });
  }

  /** Unarchive = move the folder back to its original place under `sessions/` and confirm Muse reads it again. */
  unarchive(sessionId: string): Promise<CatalogArchiveResult> {
    requireSessionId(sessionId);
    return this.run(async () => {
      const meta = (await readArchiveMeta(this.getArchiveRoot())).find(item => item.session_id === sessionId);
      if (!meta) throw new Error("This session is not in the archive folder any more. Refresh the sidebar.");
      const source = path.join(this.getArchiveRoot(), meta.relative);
      const destination = path.join(this.dataRoot, "sessions", meta.relative);
      if (!(await pathExists(source))) throw new Error(`The archived folder is missing: ${source}`);
      if (await pathExists(destination)) throw new Error(`Muse already has a session folder at ${destination}. Nothing was moved.`);
      await this.stopHost();
      await mkdir(path.dirname(destination), { recursive: true });
      await rename(source, destination);
      await rm(`${source}${ARCHIVE_META_SUFFIX}`, { force: true });
      try {
        const host = await this.ensureHost(true);
        await host.request("session/read", { sessionId, excludeItems: true });
      } catch (error) {
        return { status: "partial", message: `Moved back to ${destination}, but Muse could not read it yet: ${(error as Error).message}`, session_ids: [sessionId], location: destination };
      }
      return { status: "unarchived", message: `Moved back to Muse: ${destination}`, session_ids: [sessionId], location: destination };
    });
  }

  /** Deleting an archived session moves its folder from the archive to the Windows Recycle Bin. */
  recycleArchived(sessionId: string): Promise<CatalogRecycleResult> {
    requireSessionId(sessionId);
    return this.run(async () => {
      const meta = (await readArchiveMeta(this.getArchiveRoot())).find(item => item.session_id === sessionId);
      if (!meta) throw new Error("This session is not in the archive folder any more. Refresh the sidebar.");
      const directory = path.join(this.getArchiveRoot(), meta.relative);
      const partial = await this.recycleDirectory(this.getArchiveRoot(), sessionId, directory);
      if (partial) return partial;
      await rm(`${directory}${ARCHIVE_META_SUFFIX}`, { force: true });
      return { status: "recycled", message: "Moved from the archive to the Windows Recycle Bin.", recycled_session_ids: [sessionId] };
    });
  }

  recycle(sessionId: string, inUseIds: ReadonlySet<string> = new Set()): Promise<CatalogRecycleResult> {
    requireSessionId(sessionId);
    return this.run(async () => {
      const inventory = await this.inventory(true);
      const scope = recycleScope(inventory.sessions, sessionId, inUseIds);
      const target = scope[0];
      await this.stopHost();
      const partial = await this.recycleDirectory(path.join(this.dataRoot, "sessions"), sessionId, path.dirname(target.log_path));
      if (partial) return partial;
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
