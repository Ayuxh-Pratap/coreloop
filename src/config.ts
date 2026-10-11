/** Runtime settings. Everything is overridable by environment variable; defaults match scripts/serve-decider.ps1. */
export const config = {
  decider: {
    url: process.env.COLOOP_DECIDER_URL ?? "http://127.0.0.1:8001",
    timeoutMs: Number(process.env.COLOOP_DECIDER_TIMEOUT_MS ?? 3000),
  },
} as const;
