import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export class MspError extends Error {
  constructor(message: string, public readonly code: number, public readonly kind: string) { super(message); }
}

export function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

export function validateInitialize(value: unknown): void {
  const result = objectValue(value, "initialize result");
  const server = objectValue(result.serverInfo, "initialize serverInfo");
  const schema = objectValue(result.schema, "initialize schema");
  if (server.name !== "muse" || typeof server.version !== "string" || !server.version.trim()) throw new Error("Incompatible Muse host identity.");
  if (schema.version !== 1) throw new Error(`Unsupported Muse MSP schema version ${String(schema.version)} (expected 1).`);
  if (typeof schema.fingerprint !== "string" || !/^sha256:.+/.test(schema.fingerprint)) throw new Error("Muse host schema fingerprint is missing or invalid.");
}

/** One owned, read-only official MSP connection. Never resumes or writes a session. */
export class StdioMspHost {
  readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;
  private exited: Promise<void>;

  constructor(engine: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(engine, args, { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.resume();
    this.exited = new Promise(resolve => {
      this.child.once("exit", () => this.fail(new Error("Muse history host exited.")));
      this.child.once("error", error => this.fail(error));
      this.child.once("close", () => resolve());
    });
    this.child.stdin.on("error", error => this.fail(error));
    const reader = createInterface({ input: this.child.stdout });
    reader.on("line", line => {
      let frame: Record<string, unknown>;
      try { frame = objectValue(JSON.parse(line), "Muse MSP frame"); }
      catch (error) { this.fail(error as Error); this.child.kill(); return; }
      if (typeof frame.method === "string") {
        if (frame.id !== undefined && frame.id !== null && !this.closed) {
          this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "Read-only history companion does not handle host requests." } })}\n`);
        }
        return;
      }
      if (typeof frame.id !== "number") return;
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      this.pending.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.error !== undefined) {
        try {
          const error = objectValue(frame.error, "MSP error");
          const data = error.data && typeof error.data === "object" ? error.data as Record<string, unknown> : {};
          pending.reject(new MspError(String(error.message ?? "MSP request failed"), Number(error.code), String(data.kind ?? "unknown")));
        } catch (error) { pending.reject(error as Error); }
      } else if ("result" in frame) pending.resolve(frame.result);
      else pending.reject(new Error("Muse MSP reply has neither result nor error."));
    });
    reader.once("close", () => this.fail(new Error("Muse history host closed stdout.")));
  }

  private fail(error: Error): void {
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }

  get isClosed(): boolean { return this.closed; }

  request(method: "initialize" | "session/list" | "session/read" | "view/page", params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Muse history host is closed."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Muse MSP ${method} timed out.`));
      }, 120_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async initialize(): Promise<void> {
    validateInitialize(await this.request("initialize", { clientInfo: { name: "muse_history_sidebar", version: "0.1.0" } }));
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
  }

  async stop(): Promise<void> {
    this.fail(new Error("Muse history host stopped."));
    if (this.child.exitCode !== null || this.child.signalCode !== null) { await this.exited; return; }
    this.child.stdin.end();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 1_500); })]);
    if (timer) clearTimeout(timer);
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill();
      await this.exited;
    }
  }
}
