import { readCredentials, writeCredentials, type CredBlob } from "./keychain.ts";
import { log } from "./log.ts";

// Community-documented Claude Code OAuth client id; public.
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const REFRESH_URL = "https://console.anthropic.com/v1/oauth/token";
const REFRESH_SKEW_MS = 60_000;

let refreshInFlight: Promise<string> | null = null;

export async function getAccessToken(): Promise<string> {
  const cred = readCredentials();
  if (cred.claudeAiOauth.expiresAt - Date.now() > REFRESH_SKEW_MS) {
    return cred.claudeAiOauth.accessToken;
  }
  return refresh();
}

export function forceRefresh(): Promise<string> {
  return refresh();
}

function refresh(): Promise<string> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const cred = readCredentials();
      log("info", "oauth.refresh.start", { expiresInMs: cred.claudeAiOauth.expiresAt - Date.now() });
      const res = await fetch(REFRESH_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: cred.claudeAiOauth.refreshToken,
          client_id: CLIENT_ID,
        }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        log("error", "oauth.refresh.failed", { status: res.status, body: txt.slice(0, 300) });
        throw new Error(`oauth refresh failed: ${res.status} ${txt.slice(0, 200)}`);
      }
      const body = await res.json() as {
        access_token: string;
        refresh_token?: string;
        expires_in: number;
      };
      const next: CredBlob = {
        claudeAiOauth: {
          ...cred.claudeAiOauth,
          accessToken: body.access_token,
          refreshToken: body.refresh_token ?? cred.claudeAiOauth.refreshToken,
          expiresAt: Date.now() + body.expires_in * 1000,
        },
      };
      writeCredentials(next);
      log("info", "oauth.refresh.ok", { expiresInMs: body.expires_in * 1000 });
      return body.access_token;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}
