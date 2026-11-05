import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import type { CatalogRow } from "../shared/sessionCatalog";
import { displayPath } from "../shared/paths";
import { MspError, objectValue, type StdioMspHost } from "./mspHost";

export interface DiskSession {
  directory: string;
  parent_directory: string | null;
  created_at: string;
  updated_at: string;
  log_bytes: number;
}

/** Opaque cursors are forwarded unchanged; malformed envelopes fail explicitly. */
export function readCursor(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 16_384) throw new Error(`${label} must be an opaque string of at most 16384 characters.`);
  return value;
}

export async function listAll(host: StdioMspHost): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const result = objectValue(await host.request("session/list", { limit: 200, ...(cursor === undefined ? {} : { cursor }) }), "session/list result");
    if (!Array.isArray(result.sessions)) throw new Error("session/list returned no sessions array.");
    rows.push(...result.sessions.map(row => objectValue(row, "session/list row")));
    cursor = readCursor(result.nextCursor, "session/list nextCursor");
    if (cursor !== undefined) {
      if (seen.has(cursor)) throw new Error("session/list returned a repeated cursor.");
      seen.add(cursor);
    }
  } while (cursor !== undefined);
  return rows;
}

/**
 * Metadata-only walk of the sessions root. Directory entries come from one
 * readdir per directory; on Windows libuv types EVERY reparse point (junction,
 * symlink, cloud placeholder or unknown tag) as a link entry, never as a
 * directory or file, so reparse points are never followed or counted. The root
 * itself is classified through its parent's directory listing for the same
 * reason. Unreadable directories become warnings and the walk continues.
 * Parents are always emitted before their descendants.
 */
export async function scanDisk(root: string, _env?: NodeJS.ProcessEnv): Promise<{ sessions: DiskSession[]; warnings: string[] }> {
  const sessions: DiskSession[] = [];
  const warnings: string[] = [];
  const absolute = path.resolve(root);
  let rootEntry: Dirent | undefined;
  try {
    const parent = path.dirname(absolute);
    const name = path.basename(absolute).toLowerCase();
    rootEntry = (await readdir(parent, { withFileTypes: true })).find(entry => entry.name.toLowerCase() === name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!rootEntry || !rootEntry.isDirectory()) {
    warnings.push(rootEntry ? `Sessions root is not a plain directory (reparse points are never followed): ${absolute}` : `No sessions directory at ${absolute}`);
    return { sessions, warnings };
  }
  const walk = async (directory: string, parent: string | null): Promise<void> => {
    let entries: Dirent[];
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { warnings.push(`Cannot scan directory ${directory} : ${(error as Error).message}`); return; }
    const log = entries.find(entry => entry.isFile() && entry.name.toLowerCase() === "session.jsonl");
    if (log) {
      try {
        const metadata = await lstat(path.join(directory, log.name));
        if (metadata.isFile()) {
          sessions.push({ directory, parent_directory: parent, created_at: metadata.birthtime.toISOString(), updated_at: metadata.mtime.toISOString(), log_bytes: metadata.size });
          parent = directory;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.push(`Cannot read session log metadata in ${directory} : ${(error as Error).message}`);
      }
    }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) if (entry.isDirectory()) await walk(path.join(directory, entry.name), parent);
  };
  await walk(absolute, null);
  return { sessions, warnings };
}

const directoryKey = (directory: string): string => path.resolve(displayPath(directory)).replace(/\\/g, "/").toLowerCase();

/** A writer lease hides a root from cold session/list; metadata read still works. */
export async function completeRootMetadata(host: StdioMspHost, official: Record<string, unknown>[], disk: DiskSession[]): Promise<{ roots: Record<string, unknown>[]; warnings: string[] }> {
  const roots = [...official];
  const listedIds = new Set(official.map(row => row.sessionId));
  const warnings: string[] = [];
  for (const metadata of disk) {
    if (metadata.parent_directory !== null) continue;
    const sessionId = path.basename(metadata.directory);
    if (listedIds.has(sessionId)) continue;
    let read: unknown;
    try { read = await host.request("session/read", { sessionId, excludeItems: true }); }
    catch (error) {
      if (!(error instanceof MspError)) throw error;
      warnings.push(`Unlisted root ${sessionId} metadata is unavailable: ${error.message}`);
      continue;
    }
    const session = objectValue(objectValue(read, "unlisted root session/read result").session, "unlisted root session");
    if (session.sessionId !== sessionId || typeof session.path !== "string" || !path.isAbsolute(session.path) || path.basename(session.path).toLowerCase() !== "session.jsonl" || directoryKey(path.dirname(session.path)) !== directoryKey(metadata.directory)) {
      throw new Error(`session/read returned mismatched identity or path for unlisted root ${sessionId}.`);
    }
    roots.push(session);
  }
  return { roots, warnings };
}

/** Official metadata owns root identity; disk metadata adds every internal child. */
export async function buildInventoryRows(official: Record<string, unknown>[], disk: DiskSession[], listedIds?: ReadonlySet<string>): Promise<CatalogRow[]> {
  const rows: CatalogRow[] = [];
  const byDirectory = new Map<string, CatalogRow>();
  const diskByDirectory = new Map(disk.map(row => [directoryKey(row.directory), row]));
  for (const raw of official) {
    if (typeof raw.sessionId !== "string" || !raw.sessionId || typeof raw.path !== "string" || !path.isAbsolute(raw.path) ||
      (raw.workspaceRoot !== null && raw.workspaceRoot !== undefined && typeof raw.workspaceRoot !== "string")) throw new Error("Invalid session/list identity or path metadata.");
    const directory = path.dirname(raw.path);
    const metadata = diskByDirectory.get(directoryKey(directory));
    const workspace = typeof raw.workspaceRoot === "string" ? raw.workspaceRoot : "";
    let workspaceExists = false;
    if (workspace) {
      try { workspaceExists = (await lstat(workspace)).isDirectory(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const row: CatalogRow = {
      session_id: raw.sessionId, workspace,
      title: typeof raw.title === "string" ? raw.title : typeof raw.firstUserPrompt === "string" ? raw.firstUserPrompt : "",
      kind: typeof raw.kind === "string" ? raw.kind : "root", parent_session_id: null,
      created_at: typeof raw.createdAt === "string" ? raw.createdAt : metadata?.created_at,
      updated_at: typeof raw.updatedAt === "string" ? raw.updatedAt : metadata?.updated_at,
      log_path: raw.path, indexed: listedIds?.has(raw.sessionId) ?? true, workspace_exists: workspaceExists, running: raw.status === "running",
      log_bytes: metadata?.log_bytes ?? (typeof raw.logBytes === "number" ? raw.logBytes : 0),
    };
    rows.push(row);
    byDirectory.set(directoryKey(directory), row);
  }
  // Scanner emits parents before descendants, so inheritance works at every depth.
  for (const metadata of disk) {
    const key = directoryKey(metadata.directory);
    if (byDirectory.has(key)) continue;
    const id = path.basename(metadata.directory);
    const parent = metadata.parent_directory ? byDirectory.get(directoryKey(metadata.parent_directory)) : undefined;
    const row: CatalogRow = {
      session_id: id, workspace: parent?.workspace ?? "",
      title: parent ? `[${id.slice(-12)}] Sub-session ${id}` : `[${id.slice(-12)}] Unindexed session ${id}`,
      kind: parent ? "subagent" : "root", parent_session_id: parent?.session_id ?? null,
      created_at: metadata.created_at, updated_at: metadata.updated_at,
      log_path: path.join(metadata.directory, "session.jsonl"), indexed: false,
      workspace_exists: parent?.workspace_exists ?? false, running: false, log_bytes: metadata.log_bytes,
    };
    rows.push(row);
    byDirectory.set(key, row);
  }
  return rows;
}
