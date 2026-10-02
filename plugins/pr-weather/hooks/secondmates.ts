// The second mate homes a firstmate home has registered in data/secondmates.md.
// Pure, so the tests hold it without a file system. fleet-lamp and pr-weather each carry an
// identical copy: plugins cannot import each other.
export type SecondMate = { id: string; home: string }

// A local entry is `- <id> - <charter> (home: <path>; scope: ...)`; a remote one puts
// `host: ...; root: ...;` before its home, which lives on another machine.
const ENTRY = /^- ([A-Za-z0-9._-]+) - .+ \((host:[^;)]*;\s*root:[^;)]*;\s*)?home:\s*([^;)]*);.*\)\s*$/

const trimSlash = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, '') : path)

/** The local second mates in secondmates.md text, in file order; remote and malformed entries are left out. */
export function parseSecondMates(text: string): SecondMate[] {
  const found: SecondMate[] = []
  for (const line of text.split('\n')) {
    const match = ENTRY.exec(line.trim())
    const home = trimSlash((match?.[3] ?? '').trim())
    if (!match?.[1] || match[2] !== undefined || !home.startsWith('/')) continue
    if (found.some(mate => mate.home === home)) continue
    found.push({ id: match[1], home })
  }
  return found
}

