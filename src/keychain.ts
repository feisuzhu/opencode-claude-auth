import { log } from "./logger.ts"

export interface ClaudeCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: number
  subscriptionType?: string
}

export interface ClaudeAccount {
  label: string
  source: string
  credentials: ClaudeCredentials
}

function readEnvCredentials(): ClaudeCredentials | null {
  const raw = process.env.ANTHROPIC_OAUTH?.trim()
  if (!raw) return null

  if (/^https?:\/\//.test(raw)) {
    // Return placeholder — actual fetch happens asynchronously via getCachedCredentials
    log("env_credentials_url_detected", { url: raw })
    return {
      accessToken: "",
      refreshToken: "",
      expiresAt: 0,
    }
  }

  log("env_credentials_parse", { success: true })
  return {
    accessToken: raw,
    refreshToken: "",
    expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
  }
}

export function buildAccountLabels(credsList: ClaudeCredentials[]): string[] {
  const baseLabels = credsList.map((c) => {
    if (c.subscriptionType) {
      const tier =
        c.subscriptionType.charAt(0).toUpperCase() + c.subscriptionType.slice(1)
      return `Claude ${tier}`
    }
    return "Claude"
  })

  const counts = new Map<string, number>()
  for (const l of baseLabels) counts.set(l, (counts.get(l) ?? 0) + 1)

  const seen = new Map<string, number>()
  return baseLabels.map((base) => {
    if ((counts.get(base) ?? 0) <= 1) return base
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return `${base} ${n}`
  })
}

export function readAllClaudeAccounts(): ClaudeAccount[] {
  const envCreds = readEnvCredentials()
  if (!envCreds) return []
  const [label] = buildAccountLabels([envCreds])
  return [{ label, source: "env", credentials: envCreds }]
}
