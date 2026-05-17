import { spawnSync } from "node:child_process";

const SERVICE = "Claude Code-credentials";

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
  const r = spawnSync("security", ["find-generic-password", "-s", SERVICE, "-w"], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`keychain read failed (status ${r.status}): ${r.stderr?.trim() || r.stdout?.trim() || "no output"}`);
  }
  const raw = r.stdout.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`keychain content is not JSON: ${(e as Error).message}`);
  }
  if (!isCredBlob(parsed)) {
    throw new Error("keychain content has unexpected shape (missing claudeAiOauth.{accessToken,refreshToken,expiresAt})");
  }
  return parsed;
}

export function writeCredentials(cred: CredBlob): void {
  const account = process.env.USER ?? "";
  const r = spawnSync(
    "security",
    ["add-generic-password", "-U", "-s", SERVICE, "-a", account, "-w", JSON.stringify(cred)],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    throw new Error(`keychain write failed: ${r.stderr?.trim() || "no error message"}`);
  }
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
