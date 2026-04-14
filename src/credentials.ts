import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { type ClaudeCredentials, type ClaudeAccount } from "./keychain.ts"
import { resetExcludedBetas } from "./betas.ts"
import { log } from "./logger.ts"

export type { ClaudeCredentials } from "./keychain.ts"
export type { ClaudeAccount } from "./keychain.ts"

const CREDENTIAL_CACHE_TTL_MS = 30_000

function isOAuthUrl(): boolean {
  const raw = process.env.ANTHROPIC_OAUTH?.trim()
  return !!raw && /^https?:\/\//.test(raw)
}

const accountCacheMap = new Map<
  string,
  { creds: ClaudeCredentials; cachedAt: number }
>()
let activeAccountSource: string | null = null
let allAccounts: ClaudeAccount[] = []

export function initAccounts(accounts: ClaudeAccount[]): void {
  allAccounts = accounts
}

export function getAccounts(): ClaudeAccount[] {
  return allAccounts
}

export function setActiveAccountSource(source: string): void {
  const previous = activeAccountSource
  activeAccountSource = source
  accountCacheMap.delete(source)
  resetExcludedBetas()
  if (previous && previous !== source) {
    log("account_switch", { newSource: source, previousSource: previous })
  }
}

function getActiveAccount(): ClaudeAccount | null {
  if (allAccounts.length === 0) return null
  if (activeAccountSource) {
    const found = allAccounts.find((a) => a.source === activeAccountSource)
    if (found) return found
  }
  return allAccounts[0]
}

function getAuthJsonPaths(): string[] {
  const xdgPath = join(homedir(), ".local", "share", "opencode", "auth.json")
  if (process.platform === "win32") {
    const appData =
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
    const localAppDataPath = join(appData, "opencode", "auth.json")
    return [xdgPath, localAppDataPath]
  }
  return [xdgPath]
}

function syncToPath(authPath: string, creds: ClaudeCredentials): void {
  let auth: Record<string, unknown> = {}
  if (existsSync(authPath)) {
    const raw = readFileSync(authPath, "utf-8").trim()
    if (raw) {
      try {
        auth = JSON.parse(raw)
      } catch {
        // Malformed file, start fresh
      }
    }
  }
  auth.anthropic = {
    type: "oauth",
    access: creds.accessToken,
    refresh: creds.refreshToken,
    expires: creds.expiresAt,
  }
  const dir = dirname(authPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  writeFileSync(authPath, JSON.stringify(auth, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  })
  if (process.platform !== "win32") {
    chmodSync(authPath, 0o600)
  }
}

export function syncAuthJson(creds: ClaudeCredentials): void {
  for (const authPath of getAuthJsonPaths()) {
    try {
      syncToPath(authPath, creds)
      log("sync_auth_json", { path: authPath, success: true })
    } catch (err) {
      log("sync_auth_json", {
        path: authPath,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }
}

async function fetchEnvCredentialsFromUrl(
  url: string,
): Promise<ClaudeCredentials | null> {
  try {
    const parsed = new URL(url)
    const userinfo = parsed.username
      ? `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`
      : ""
    parsed.username = ""
    parsed.password = ""

    const headers: Record<string, string> = {}
    if (userinfo) {
      headers.authorization = `Basic ${btoa(userinfo)}`
    }

    const res = await fetch(parsed.href, { headers })
    if (!res.ok) {
      log("env_credentials_url_fetch", {
        success: false,
        error: `HTTP ${res.status}`,
      })
      return null
    }
    const data = (await res.json()) as { token?: string; expires_at?: number }
    if (typeof data.token !== "string") {
      log("env_credentials_url_fetch", {
        success: false,
        error: "response missing 'token' field",
      })
      return null
    }
    log("env_credentials_url_fetch", { success: true })
    return {
      accessToken: data.token,
      refreshToken: "",
      expiresAt:
        typeof data.expires_at === "number"
          ? data.expires_at
          : Date.now() + 3600_000,
    }
  } catch (err) {
    log("env_credentials_url_fetch", {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

export async function refreshIfNeeded(
  account?: ClaudeAccount,
): Promise<ClaudeCredentials | null> {
  const target = account ?? getActiveAccount()
  if (!target) return null

  // When ANTHROPIC_OAUTH is a URL, always fetch fresh (ignore expiry/cache)
  const raw = process.env.ANTHROPIC_OAUTH?.trim()
  if (raw && /^https?:\/\//.test(raw)) {
    const fetched = await fetchEnvCredentialsFromUrl(raw)
    if (fetched) {
      target.credentials = fetched
      return fetched
    }
  }

  const creds = target.credentials
  if (creds.expiresAt > Date.now() + 60_000) return creds

  log("refresh_needed", {
    source: target.source,
    expiresAt: creds.expiresAt,
    expiresIn: creds.expiresAt - Date.now(),
  })

  if (raw) {
    const fresh: ClaudeCredentials = {
      accessToken: raw,
      refreshToken: "",
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
    }
    target.credentials = fresh
    return fresh
  }

  log("refresh_exhausted", { source: target.source })
  return null
}

export function getCredentialsForSync(): ClaudeCredentials | null {
  const account = getActiveAccount()
  if (!account) return null

  const creds = account.credentials
  if (creds.expiresAt > Date.now() + 60_000) {
    return creds
  }

  return null
}

export async function getCachedCredentials(): Promise<ClaudeCredentials | null> {
  const account = getActiveAccount()
  if (!account) return null

  const now = Date.now()
  const urlMode = isOAuthUrl()

  if (!urlMode) {
    const cached = accountCacheMap.get(account.source)
    if (
      cached &&
      now - cached.cachedAt < CREDENTIAL_CACHE_TTL_MS &&
      cached.creds.expiresAt > now + 60_000
    ) {
      log("cache_hit", {
        source: account.source,
        ttlRemaining: CREDENTIAL_CACHE_TTL_MS - (now - cached.cachedAt),
      })
      return cached.creds
    }
  }

  log("cache_miss", {
    source: account.source,
    reason: urlMode ? "url_mode_force_fetch" : "stale or expiring",
  })

  const fresh = await refreshIfNeeded(account)
  if (!fresh) {
    log("credentials_unavailable", { source: account.source })
    accountCacheMap.delete(account.source)
    return null
  }

  accountCacheMap.set(account.source, { creds: fresh, cachedAt: now })
  return fresh
}
