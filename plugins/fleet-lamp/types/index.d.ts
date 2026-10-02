/** A captain-facing question or failure, newest last in `Latch.reds`. */
export type RedSignal = {
  task: string
  /** The record's `[key=...]` decision key; a keyed red closes on its `resolved` record. */
  key: string | null
  state: string
  reason: string
  ts: number
}

/** A ready PR, newest last in `Latch.greens`. */
export type GreenSignal = {
  task: string
  pr: string | null
  ts: number
}

/** Everything the band shows: red outranks green, and both clear on the captain's next prompt. */
export type Latch = { reds: RedSignal[]; greens: GreenSignal[] }

declare module 'claude-code' {
  interface PluginState {
    'fleet-lamp': {
      latch: Latch
      /** Byte offset into the home's state/fleet-ledger.jsonl read so far, by home; absent until the first look. */
      offsets: Readonly<Record<string, number>>
      /** The firstmate home whose ledger is followed right now; the band is off while it is null. */
      followed: string | null
    }
  }
}
