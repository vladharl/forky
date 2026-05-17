import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CircuitSnapshot } from "./circuit.ts";

const DIR = join(homedir(), ".forky");
const FILE = join(DIR, "status.json");
// Persisted status that's older than this is ignored on startup — counters
// stay accurate over short restart cycles but a long downtime resets the view.
const STATUS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

mkdirSync(DIR, { recursive: true });

export type Status = {
  startedAt: string;
  pid: number;
  port: number;
  requests: number;
  aiStackFailures: number;
  fallbacksToOauth: number;
  circuit: CircuitSnapshot;
  lastUpdated: string;
};

/**
 * Load persisted status from disk if recent. Returns null if missing, malformed,
 * or older than STATUS_MAX_AGE_MS.
 */
function loadPersisted(): Status | null {
  if (!existsSync(FILE)) return null;
  try {
    const raw = JSON.parse(readFileSync(FILE, "utf8"));
    if (typeof raw?.lastUpdated !== "string") return null;
    const age = Date.now() - new Date(raw.lastUpdated).getTime();
    if (!Number.isFinite(age) || age > STATUS_MAX_AGE_MS) return null;
    return raw as Status;
  } catch { return null; }
}

const persisted = loadPersisted();

let mem: Status = {
  startedAt: new Date().toISOString(),
  pid: process.pid,
  port: 0,
  requests: persisted?.requests ?? 0,
  aiStackFailures: persisted?.aiStackFailures ?? 0,
  fallbacksToOauth: persisted?.fallbacksToOauth ?? 0,
  circuit: persisted?.circuit ?? { state: "closed", failureCount: 0, openedAt: null, nextProbeAt: null },
  lastUpdated: new Date().toISOString(),
};

export function getPersistedSnapshot(): Status | null { return persisted; }
export function setPort(port: number): void { mem.port = port; persist(); }
export function incRequests(): void { mem.requests++; mem.lastUpdated = new Date().toISOString(); persist(); }
export function incAiStackFailure(): void { mem.aiStackFailures++; persist(); }
export function incFallback(): void { mem.fallbacksToOauth++; persist(); }
export function updateCircuit(snap: CircuitSnapshot): void { mem.circuit = snap; persist(); }
export function read(): Status { return { ...mem }; }

function persist(): void {
  try { writeFileSync(FILE, JSON.stringify(mem, null, 2)); } catch {}
}
