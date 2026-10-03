// A PR's CI, read off gh's statusCheckRollup.
export type Ci = 'passed' | 'failed' | 'running' | 'none'

export type Pr = {
  number: number
  url: string
  isDraft: boolean
  ci: Ci
  // A workflow run on the head commit waits at conclusion action_required.
  isHeld: boolean
  // GitHub's mergeable is CONFLICTING; UNKNOWN (still computing) is not a conflict.
  isConflicting: boolean
}

// auto polls on the interval; manual refreshes only when asked.
export type Mode = 'auto' | 'manual'

// How the refreshing stands; times are $.clock.now() milliseconds.
export type Status = {
  mode: Mode
  isRefreshing: boolean
  // The last refresh failed; the PRs shown are from an earlier one.
  isStale: boolean
  updatedAt: number | null
  // Auto mode's stretched interval while the GitHub quota is low.
  backoffMs: number | null
  // A rate limit holds every refresh until then.
  limitedUntil: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'pr-weather': { prs: Pr[] | null; status: Status; now: number }
  }
}
