import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CircuitSnapshot } from "./circuit.ts";

const DIR = join(homedir(), ".forky");
const FILE = join(DIR, "status.json");

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

let mem: Status = {
  startedAt: new Date().toISOString(),
  pid: process.pid,
  port: 0,
  requests: 0,
  aiStackFailures: 0,
  fallbacksToOauth: 0,
  circuit: { state: "closed", failureCount: 0, openedAt: null, nextProbeAt: null },
  lastUpdated: new Date().toISOString(),
};

export function setPort(port: number): void { mem.port = port; persist(); }
export function incRequests(): void { mem.requests++; mem.lastUpdated = new Date().toISOString(); persist(); }
export function incAiStackFailure(): void { mem.aiStackFailures++; persist(); }
export function incFallback(): void { mem.fallbacksToOauth++; persist(); }
export function updateCircuit(snap: CircuitSnapshot): void { mem.circuit = snap; persist(); }
export function read(): Status { return { ...mem }; }

function persist(): void {
  try { writeFileSync(FILE, JSON.stringify(mem, null, 2)); } catch {}
}
