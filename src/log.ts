import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_DIR = join(homedir(), ".forky", "log");
mkdirSync(LOG_DIR, { recursive: true });

export type LogLevel = "info" | "warn" | "error";

export function log(level: LogLevel, event: string, data: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...data }) + "\n";
  process.stderr.write(line);
  const file = join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  try {
    appendFileSync(file, line);
  } catch {
    // Logging must never throw.
  }
}
