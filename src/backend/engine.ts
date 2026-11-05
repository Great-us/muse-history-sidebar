import { execFile } from "node:child_process";
import { open, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

export async function validateEngine(file: string, env: NodeJS.ProcessEnv): Promise<string> {
  if (!path.isAbsolute(file) || path.extname(file).toLowerCase() !== ".exe" || path.basename(file).toLowerCase() === "muse.exe") {
    throw new Error("Choose the absolute native Muse engine executable (muse-bin-<version>.exe), not its launcher.");
  }
  const handle = await open(file, "r");
  try {
    const signature = Buffer.alloc(2);
    await handle.read(signature, 0, 2, 0);
    if (signature.toString("ascii") !== "MZ") throw new Error("The selected Muse engine is not a native Windows executable.");
  } finally {
    await handle.close();
  }
  const version = await new Promise<string>((resolve, reject) => {
    execFile(file, ["--version"], { env: { ...env, MUSE_NO_AUTO_UPDATE: "1" }, windowsHide: true, timeout: 15_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
  if (!/^muse(?: code)?\s+\d+\.\d+/i.test(version)) throw new Error("The selected executable did not report a Muse engine version.");
  return file;
}

async function fileExists(file: string): Promise<boolean> {
  try { return (await stat(file)).isFile(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Installation metadata is public launcher metadata, never session-log parsing. */
async function installedEngine(directory: string): Promise<string | undefined> {
  let version: string | undefined;
  try { version = (await readFile(path.join(directory, ".muse-version"), "utf8")).trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (version && /^[A-Za-z0-9.+_-]+$/.test(version)) {
    const named = path.join(directory, `muse-bin-${version}.exe`);
    if (await fileExists(named)) return named;
  }
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const candidates = await Promise.all(names.filter(name => /^muse-bin-.+\.exe$/i.test(name)).map(async name => {
    const file = path.join(directory, name);
    const metadata = await stat(file);
    return { file, metadata };
  }));
  return candidates.filter(item => item.metadata.isFile()).sort((a, b) => b.metadata.mtimeMs - a.metadata.mtimeMs)[0]?.file;
}

export type EngineValidator = (file: string, env: NodeJS.ProcessEnv) => Promise<string>;

/** `validate` lets callers memoize the `--version` probe; discovery itself is metadata-only. */
export async function resolveEngine(override: string | undefined, env: NodeJS.ProcessEnv, validate: EngineValidator = validateEngine): Promise<string> {
  if (override) return validate(override, env);
  const searchPath = env.PATH ?? env.Path ?? "";
  for (const directory of searchPath.split(path.delimiter).filter(directory => path.isAbsolute(directory))) {
    const launchers = await Promise.all(["muse.cmd", "muse.ps1", "muse.exe"].map(name => fileExists(path.join(directory, name))));
    if (launchers.some(Boolean)) {
      const engine = await installedEngine(directory);
      if (engine) return validate(engine, env);
    }
  }
  const locations = [
    env.USERPROFILE ? path.join(env.USERPROFILE, "MuseCode") : undefined,
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Programs", "muse") : undefined,
  ];
  for (const directory of locations) {
    if (!directory) continue;
    const engine = await installedEngine(directory);
    if (engine) return validate(engine, env);
  }
  throw new Error("Muse engine not found. Install Muse CLI or choose its native muse-bin-<version>.exe in the sidebar.");
}

export function museDataRoot(env: NodeJS.ProcessEnv): string {
  if (env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME)) return path.join(env.XDG_DATA_HOME, "muse");
  const home = env.HOME || env.USERPROFILE;
  if (!home || !path.isAbsolute(home)) throw new Error("Cannot locate Muse history: HOME or USERPROFILE must be an absolute path.");
  return path.join(home, ".local", "share", "muse");
}
