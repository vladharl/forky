import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, chmodSync, mkdirSync, existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";

const SERVICE = "Claude Code-credentials";
const LINUX_CRED_PATH = process.env.FORKY_CREDENTIALS_FILE ?? join(homedir(), ".claude", ".credentials.json");

export type CredBlob = {
  claudeAiOauth: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes?: string[];
    subscriptionType?: string;
  };
};

export function readCredentials(): CredBlob {
  const raw = platform() === "darwin" ? readFromKeychain() : readFromFile();
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (e) { throw new Error(`credentials are not JSON: ${(e as Error).message}`); }
  if (!isCredBlob(parsed)) {
    throw new Error("credentials have unexpected shape (missing claudeAiOauth.{accessToken,refreshToken,expiresAt})");
  }
  return parsed;
}

export function writeCredentials(cred: CredBlob): void {
  if (platform() === "darwin") writeToKeychain(cred);
  else writeToFile(cred);
}

function readFromKeychain(): string {
  const r = spawnSync("security", ["find-generic-password", "-s", SERVICE, "-w"], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`keychain read failed (status ${r.status}): ${r.stderr?.trim() || r.stdout?.trim() || "no output"}`);
  }
  return r.stdout.trim();
}

function writeToKeychain(cred: CredBlob): void {
  const account = process.env.USER ?? "";
  const r = spawnSync(
    "security",
    ["add-generic-password", "-U", "-s", SERVICE, "-a", account, "-w", JSON.stringify(cred)],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`keychain write failed: ${r.stderr?.trim() || "no error message"}`);
}

function readFromFile(): string {
  if (!existsSync(LINUX_CRED_PATH)) {
    throw new Error(`credentials file not found at ${LINUX_CRED_PATH} (set FORKY_CREDENTIALS_FILE or log into Claude Code first)`);
  }
  return readFileSync(LINUX_CRED_PATH, "utf8");
}

function writeToFile(cred: CredBlob): void {
  mkdirSync(dirname(LINUX_CRED_PATH), { recursive: true });
  writeFileSync(LINUX_CRED_PATH, JSON.stringify(cred, null, 2));
  // Permissions 0o600 — owner-only, matches what Claude Code writes.
  try { chmodSync(LINUX_CRED_PATH, 0o600); } catch { /* best effort */ }
}

function isCredBlob(x: unknown): x is CredBlob {
  if (typeof x !== "object" || x === null) return false;
  const c = (x as { claudeAiOauth?: unknown }).claudeAiOauth;
  if (typeof c !== "object" || c === null) return false;
  const oc = c as Record<string, unknown>;
  return typeof oc.accessToken === "string"
    && typeof oc.refreshToken === "string"
    && typeof oc.expiresAt === "number";
}
