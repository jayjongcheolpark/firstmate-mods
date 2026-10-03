// How a pressed PR reaches a browser: the machine's own opener, else the clipboard.

// Where the session runs, as the press handler reads it once.
export type Host = {
  // `uname -s`: Darwin, Linux, ...; empty when it could not be read.
  system: string
  // Reached over SSH: the opener would open a browser on the far machine.
  isRemote: boolean
  // A Linux desktop session (X11 or Wayland) an opener can show a browser on.
  hasDisplay: boolean
}

// Only a github.com pull request is opened or copied; anything else is refused.
export function isPrUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  // Spelled exactly as rebuilt from its path: no user, port, query or fragment.
  return /^\/[^/]+\/[^/]+\/pull\/\d+$/.test(parsed.pathname) && url === `https://github.com${parsed.pathname}`
}

// The command that opens `url` in this machine's browser, or null where none can:
// a remote session, or a Linux without a desktop (a server reached through a multiplexer).
export function openerFor(host: Host, url: string): string[] | null {
  if (host.isRemote) return null
  if (host.system === 'Darwin') return ['open', url]
  if (host.system === 'Linux' && host.hasDisplay) return ['xdg-open', url]
  return null
}

// How the opener went: it ran and exited, or it could not run (missing, timed out).
export type RunResult = { kind: 'exited'; exitCode: number; stderr: string } | { kind: 'threw'; error: string }

// How a press went: the press reached the plugin, the opener's run, or no opener to run.
export type OpenResult = RunResult | { kind: 'pressed' } | { kind: 'no-opener' } | { kind: 'refused' }

// A debug log line of one press, to find with `grep 'pr-weather press'`. Each press logs
// `pressed` as it arrives, then how the open went:
// pr-weather press #7 https://github.com/o/r/pull/7 opener=none pressed
// pr-weather press #7 https://github.com/o/r/pull/7 opener=["open","https://github.com/o/r/pull/7"] exit=0 stderr=""
export function pressLogLine(pr: { number: number; url: string }, opener: readonly string[] | null, result: OpenResult): string {
  const outcome =
    result.kind === 'exited'
      ? `exit=${result.exitCode} stderr=${JSON.stringify(result.stderr.trim())}`
      : result.kind === 'threw'
        ? `error=${JSON.stringify(result.error)}`
        : result.kind === 'pressed'
          ? 'pressed'
          : result.kind === 'refused'
            ? 'refused=not-a-github-pr-url'
            : 'copy=no-local-browser'
  return `pr-weather press #${pr.number} ${pr.url} opener=${opener ? JSON.stringify(opener) : 'none'} ${outcome}`
}

// Why the opener did not open the PR, in a few words for a toast: "open exited 1", "open failed: spawn open ENOENT".
export function openFailure(opener: readonly string[], result: RunResult): string {
  const name = opener[0] ?? 'opener'
  if (result.kind === 'exited') return `${name} exited ${result.exitCode}`
  return `${name} failed: ${result.error.length > 40 ? `${result.error.slice(0, 39)}…` : result.error}`
}
