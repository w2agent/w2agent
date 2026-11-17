import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";

export const CORE_DIR = resolve(__dirname, "../..");

const tracked = new Set<ChildProcess>();

export function killTracked(): void {
  for (const p of tracked) {
    if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
  }
  tracked.clear();
}

process.on("exit", killTracked);

export function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => res(port));
    });
  });
}

// Run node directly (no tsx wrapper process) so killing the child kills the server.
export function spawnServer(
  cwd: string,
  port: number,
): { proc: ChildProcess; output: () => string } {
  const proc = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
    cwd,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  tracked.add(proc);
  let out = "";
  proc.stdout?.on("data", (d: Buffer) => {
    out += d.toString();
  });
  proc.stderr?.on("data", (d: Buffer) => {
    out += d.toString();
  });
  return { proc, output: () => out };
}

export async function waitForRunning(
  proc: ChildProcess,
  output: () => string,
  timeoutMs = 20000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (output().includes("running at")) return;
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(`server exited early (${proc.exitCode}):\n${output()}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  proc.kill("SIGKILL");
  throw new Error(`server did not start:\n${output()}`);
}
