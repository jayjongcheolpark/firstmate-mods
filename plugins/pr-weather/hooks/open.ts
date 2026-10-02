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
