# firstmate-mods

Claude Code mods for [firstmate](https://github.com/kunchenguid/firstmate) fleets, published as a Claude Code plugin marketplace.

| Mod | What it does |
| --- | --- |
| [fleet-lamp](#fleet-lamp) | A lamp above the prompt: red when the fleet needs you, green when a PR is ready. |

## Install

```sh
claude plugin marketplace add jayjongcheolpark/firstmate-mods
claude plugin install fleet-lamp@firstmate-mods
```

To try a local checkout without installing it, start a session with the plugin folder loaded:

```sh
claude --plugin-dir /path/to/firstmate-mods/plugins/fleet-lamp
```

## fleet-lamp

A band above the prompt that tells you when the fleet needs a human. You don't need a lamp.

```
● fix-login needs-decision: pick: keep the legacy session cookie (A) or move to JWT (B)?  +1 more
────────────────────────────────────────────────────────────────────────────────────────────────
❯
```

```
● PR ready https://github.com/acme/webapp/pull/7  fix-login
────────────────────────────────────────────────────────────────────────────────────────────────
❯
```

When nothing needs you, the band shows nothing.

### What it shows

- **Red** (strongest): a task is waiting on you. The band shows the task, its state and the first line of its reason. The newest open red comes first, and `+N more` counts the others.
- **Green**: a PR is ready for review. The band shows the PR URL and its task.
- **Nothing**: the fleet doesn't need you.

### The rules

The band reads only `task.status` and `task.pr_ready` records from firstmate's fleet activity ledger, `state/fleet-ledger.jsonl` (see `docs/fleet-ledger.md` in the firstmate repository).

- **Red**: a `task.status` record whose state is `needs-decision`, `blocked` or `failed`. Two kinds of record are left out:
  - worker validation findings that firstmate decides itself (text contains `ask-user findings=`);
  - a held decision recorded again with the captain's own answer (`Captain 2026-09-30 verbatim ...`).
- A **keyed** red (a record with a `[key=...]` decision key) turns off by itself when a later `resolved` record carries the same task and key.
- A **keyless** red stays until your next prompt.
- **Green** (latched): a `task.pr_ready` record, or a `done` record that reports a ready PR (`PR https://...`, `child X done: PR https://...`, `PR ready: https://...`). A `done` record that says the PR already `landed` or `merged` does not count. Green stays until your next prompt.
- **Your next prompt clears the band**, red and green alike. Only a prompt you send counts, typed at the terminal or sent through Remote Control. Task notifications, messages from other sessions and scheduled prompts leave the band as it is.

These are the same rules as the lamp script that inspired this mod.

### Turning on the ledger

The ledger is opt-in. In your firstmate home, create the flag:

```sh
touch config/fleet-ledger
```

Delete the flag to turn the ledger off. While the ledger is off, the band shows nothing. The first time a session finds the ledger off, the mod adds one dim line to the transcript that tells you how to turn it on.

### How it finds your fleet

The mod looks for the firstmate home at or above the session's working directory: the nearest directory whose `AGENTS.md` names firstmate and that has a `state/` folder. Start your firstmate session in its home, as usual, and the mod finds it.

To follow a home from somewhere else, set the plugin's `home` option in `/config`, or from a shell:

```sh
echo '{"home": "~/firstmate"}' | claude plugin configure fleet-lamp@firstmate-mods --values-stdin
```

The mod reads two paths in that home: the `config/fleet-ledger` flag and `state/fleet-ledger.jsonl`. It reads no other state file, makes no network calls and controls no hardware.

### How it reads the ledger

- The mod checks the ledger every 2 seconds and reads only the lines added since the last check, from a saved byte offset. A partial last line waits for the next check.
- On the first look in a session, the mod starts at the end of the ledger, so old history does not turn the band red.
- The offset and the signals are kept in the session's state, so a reload of the mod does not read old lines again.
- If the ledger is truncated, reading starts again from the top.
- The ledger never rotates, and `$.fs.read` reads whole files of at most 4 MiB. So the mod reads the new bytes with `tail -c +<offset>`.

### Developing

```sh
claude plugin validate .                    # the marketplace
claude plugin validate plugins/fleet-lamp   # the plugin and its hooks module
claude plugin test plugins/fleet-lamp       # the rule and band tests
npx -p typescript tsc -p plugins/fleet-lamp  # type-check, once a session has loaded the mod
```

A session that loads the mod from a folder you own (`--plugin-dir`) writes the API types to `plugins/fleet-lamp/.claude-plugin/types/`, which `tsconfig.json` extends.

The rules are pure functions in `plugins/fleet-lamp/hooks/rules.ts`. The hooks module that reads the ledger and draws the band is `plugins/fleet-lamp/hooks/register.tsx`.
