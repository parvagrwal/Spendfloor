// Starts the local operator (loopback only) and the Vite UI together.
// The browser talks only to Vite on relative /api paths; Vite proxies to
// the operator. No key material ever enters a browser bundle.

import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL("..", import.meta.url)), ".");
const children: ChildProcess[] = [];

function start(name: string, args: string[]): void {
  const child = spawn(process.execPath, args, { cwd: root, stdio: "inherit" });
  child.on("exit", (code) => {
    if (code && code !== 0) {
      console.error(`${name} exited with code ${code}; stopping the other process.`);
      stop();
      process.exitCode = code;
    }
  });
  children.push(child);
}

function stop(): void {
  for (const child of children) if (!child.killed) child.kill("SIGTERM");
}

process.on("SIGINT", () => { stop(); process.exit(0); });
process.on("SIGTERM", () => { stop(); process.exit(0); });

start("operator", ["--import", "tsx", join(root, "operator", "server.ts")]);
start("ui", [join(root, "node_modules", "vite", "bin", "vite.js"), "--config", join(root, "frontend", "vite.config.ts")]);
