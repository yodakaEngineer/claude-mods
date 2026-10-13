# claude-mods

Mods (function-hook plugins) for Claude Code.

| Mod | What it does |
| --- | --- |
| `pr-status-pane` | A pane that follows the PRs this session pushes or creates: CI checks, review state, URL. Polls `gh` every 60s while you are at the keyboard, pauses when idle, stops once merged. |
| `progress-band` | A band above the prompt (or a pane) with the elapsed time and a Haiku-written summary of the session: plan, done, now, next, progress %, things to confirm. Updated from the diff of the conversation only, so it stays cheap. Also lists every URL seen in the conversation. |

## Install

In a Claude Code terminal session:

```
/plugin install pr-status-pane --marketplace yodakaEngineer/claude-mods
/plugin install progress-band --marketplace yodakaEngineer/claude-mods
```

Answer `y` to add the marketplace, then pick a scope (user is the usual one).

## pr-status-pane

- `/pr-status` refreshes now. `/pr-status scan` picks up PR urls from the conversation so far. `/pr-status add <url>` and `/pr-status rm <url|#n>` edit the list by hand; each PR in the pane also has a `✕`.
- Requires `gh` to be installed and logged in.

## progress-band

- `/progress` refreshes the summary. `/progress links` prints every URL of the conversation.
- `/config` → progress-band → `View`: `band` (default) or `pane`.
- Uses the `haiku` model alias through the session's own client; nothing is sent anywhere else.

## Development

```
claude plugin validate <mod>
claude plugin test <mod>
```

Or run a session with a mod loaded from this folder: `claude --plugin-dir ./pr-status-pane`.
