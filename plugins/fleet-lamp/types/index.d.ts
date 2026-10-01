/** A captain-facing question or failure, newest last in `Latch.reds`. */
export type RedSignal = {
  /** The firstmate home whose ledger carried it. */
  home: string
  task: string
  /** The record's `[key=...]` decision key; a keyed red closes on its `resolved` record. */
  key: string | null
  state: string
  reason: string
  ts: number
}

/** A ready PR, newest last in `Latch.greens`. */
export type GreenSignal = {
  home: string
  task: string
  pr: string | null
  ts: number
}

/** Everything the band shows: red outranks green, and both clear on the captain's next prompt. */
export type Latch = { reds: RedSignal[]; greens: GreenSignal[] }

/** A home whose ledger is on and followed: the session's own home, or one of its second mates. */
export type Followed = { home: string; label: string }

declare module 'claude-code' {
  interface PluginState {
    'fleet-lamp': {
      latch: Latch
      /** Byte offset into each home's state/fleet-ledger.jsonl read so far, by home; absent until the first look. */
      offsets: Readonly<Record<string, number>>
      /** The homes followed right now, the session's own first; the band is off while it is empty. */
      followed: Followed[]
    }
  }
}
