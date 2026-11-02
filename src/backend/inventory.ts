import { execFile } from "node:child_process";
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

// Node does not expose arbitrary Windows reparse attributes. One metadata-only
// OS walk checks the attribute on EVERY directory/file, including unknown tags.
// Input travels in an environment variable, never interpolated into shell code.
const windowsScan = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$rows = [System.Collections.Generic.List[object]]::new()
$warnings = [System.Collections.Generic.List[string]]::new()
function Walk([string]$directory, [AllowNull()][string]$parentSession) {
  try {
    $dir = Get-Item -LiteralPath $directory -Force
    if (($dir.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not $dir.PSIsContainer) { return }
    $entries = @(Get-ChildItem -LiteralPath $directory -Force)
    $log = $entries | Where-Object { $_.Name -ieq 'session.jsonl' -and -not $_.PSIsContainer -and ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0 } | Select-Object -First 1
    if ($null -ne $log) {
      $rows.Add([pscustomobject]@{ directory=$dir.FullName; parent_directory=$parentSession; created_at=$log.CreationTimeUtc.ToString('o'); updated_at=$log.LastWriteTimeUtc.ToString('o'); log_bytes=$log.Length })
      $parentSession = $dir.FullName
    }
    foreach ($entry in $entries) {
      if ($entry.PSIsContainer -and ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) { Walk $entry.FullName $parentSession }
    }
  } catch { $warnings.Add("Cannot scan directory $directory : $($_.Exception.Message)") }
}
if (Test-Path -LiteralPath $env:MUSE_HISTORY_SCAN_ROOT -PathType Container) { Walk $env:MUSE_HISTORY_SCAN_ROOT $null }
else { $warnings.Add("No sessions directory at $env:MUSE_HISTORY_SCAN_ROOT") }
[pscustomobject]@{ sessions=@($rows.ToArray()); warnings=@($warnings.ToArray()) } | ConvertTo-Json -Depth 5 -Compress
`;

export async function scanDisk(root: string, env: NodeJS.ProcessEnv): Promise<{ sessions: DiskSession[]; warnings: string[] }> {
  if (process.platform === "win32") {
    const systemRoot = env.SystemRoot ?? env.SYSTEMROOT;
    if (!systemRoot) throw new Error("SystemRoot is required for the Windows metadata scanner.");
    const output = await new Promise<string>((resolve, reject) => {
      execFile(path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(windowsScan, "utf16le").toString("base64")],
        { env: { ...env, MUSE_HISTORY_SCAN_ROOT: root }, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
        (error, stdout) => error ? reject(error) : resolve(stdout));
    });
    const result = objectValue(JSON.parse(output.replace(/^\uFEFF/, "")), "Windows metadata scan");
    if (!Array.isArray(result.sessions) || !Array.isArray(result.warnings)) throw new Error("Invalid Windows metadata scanner output.");
    const sessions = result.sessions.map(raw => {
      const row = objectValue(raw, "disk metadata row");
      if (typeof row.directory !== "string" || (row.parent_directory !== null && typeof row.parent_directory !== "string") ||
        typeof row.created_at !== "string" || typeof row.updated_at !== "string" || typeof row.log_bytes !== "number") throw new Error("Invalid disk metadata fields.");
      return { ...row, parent_directory: row.parent_directory === "" ? null : row.parent_directory } as unknown as DiskSession;
    });
    if (!result.warnings.every(warning => typeof warning === "string")) throw new Error("Invalid scanner warning.");
    return { sessions, warnings: result.warnings as string[] };
  }
  const sessions: DiskSession[] = [];
  const warnings: string[] = [];
  const walk = async (directory: string, parent: string | null): Promise<void> => {
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) return;
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.some(entry => entry.isFile() && entry.name === "session.jsonl")) {
      const log = await lstat(path.join(directory, "session.jsonl"));
      sessions.push({ directory, parent_directory: parent, created_at: log.birthtime.toISOString(), updated_at: log.mtime.toISOString(), log_bytes: log.size });
      parent = directory;
    }
    for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(path.join(directory, entry.name), parent);
  };
  try { await walk(root, null); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") warnings.push(`No sessions directory at ${root}`);
    else throw error;
  }
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
