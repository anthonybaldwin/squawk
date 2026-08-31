# Commands

Every command below works identically on Discord and Slack. Each can be individually enabled/disabled via [feature flags](Configuration.md#feature-flags).

## Command Form

| | Discord | Slack |
|---|---------|-------|
| Registration | Pushed over the Discord API at startup | Declared in the [app manifest](Slack-Setup.md) |
| Syntax | `/status target:atlassian` | `/squawk status atlassian` |
| Options | Typed options with autocomplete | Positional, or `key=value`; quote values with spaces |
| Discovery | Autocomplete | `/squawk help` |
| Permissions | **Manage Server** on administrative commands | `SLACK_ADMIN_USER_IDS` |

Slack slash command names are unique per workspace and cannot be registered over an API, so all six commands are subcommands of a single command — `/squawk` by default, renameable with `SLACK_COMMAND_NAME`. Wherever this page writes `/status`, the Slack equivalent is `/squawk status`.

Responses are ephemeral (visible only to the invoker) on both platforms.

## `/status [target]`

Show the current page status and active incidents.

- **Permission:** None (channel access check applies)
- **Response:** Ephemeral embed with overall status indicator, color-coded by severity, and a list of active incidents
- **Target resolution:** If `target` is omitted, resolves to all monitors matching the current channel, or the only configured monitor. Errors if ambiguous. When multiple monitors match, returns one embed per monitor.

## `/testpost [target]`

Post the current status snapshot into the configured channel as a visible message. Does **not** mark anything as sent in state.

- **Permission:** Manage Server
- **Response:** Ephemeral confirmation + visible status embed in the monitor's channel
- **Use case:** Verify embed rendering without affecting incident tracking

## `/replay [target]`

Replay active incident timelines into their threads.

- **Permission:** Manage Server
- **Response:** Ephemeral summary of replayed/skipped incidents
- **Behavior:**
  1. Fetches all active incidents from the API
  2. For each incident, checks for an existing thread
  3. Deduplicates against both tracked state and actual thread content (Discord scans the posted embeds' `ID` field; Slack reads the update ID from message metadata)
  4. Posts only missing updates, preserving chronological order
  5. Skips incidents that already have complete live threads
- **Use case:** Recover after state loss, manual cleanup, or to backfill a newly added monitor

## `/cleanup [target]`

Find and ghost dangling incident threads that are no longer in the status page API.

- **Permission:** Manage Server
- **Response:** Ephemeral summary of ghosted incidents
- **Target resolution:** If `target` is omitted, cleans all monitors. Otherwise cleans only the specified monitor.
- **Behavior:**
  1. Fetches current incidents from the status page API for each target monitor
  2. Identifies tracked incidents that are unresolved in state but absent from the API
  3. Ghosts them (grey embed + strikethrough text + unpin, and archives the thread on Discord)
  4. Syncs `openIncidentIds` from the API
- **Use case:** Remove dangling threads that persisted after incidents aged out of the API between polls

## `/clean [target] [limit]`

Delete recent bot-authored messages in the current channel.

- **Permission:** Manage Server
- **Channel:** Must be used in a configured monitor channel.
- **Target resolution:** If `target` is omitted, cleans all monitors in the channel. When a target is specified, only that monitor's threads and parent messages are removed.
- **Options:**
  - `limit` (integer, 1-100, default 100): How many recent messages to inspect
- **Behavior:**
  1. Deletes all incident threads and their bot-authored messages
  2. Deletes bot-authored channel messages — Discord bulk-deletes and skips anything older than 14 days; Slack deletes one at a time with no age limit
  3. Removes per-incident state entries; preserves monitor-level `postedUpdateIds` for resolved incidents (preventing re-post flooding) but strips them for active incidents (so they re-create threads on the next poll)
- **Use case:** Reset a channel after testing or reconfiguration

## `/monitor add <url> [channel] [label] [id] [icon_url]`

Add a new status page monitor at runtime. Statuspage.io, incident.io, and Instatus URLs are supported — the provider is auto-detected from the URL.

On Slack: `/squawk monitor add https://status.atlassian.com channel=#ops label="Atlassian"`.

- **Permission:** Manage Server
- **Options:**
  - `url` (required): Public status page URL (e.g. `https://status.atlassian.com` or `https://status.openai.com`)
  - `channel` (optional): Target channel; defaults to the current channel. On Slack, accepts `#name`, `<#C123>`, or a raw channel ID.
  - `label` (optional): Display name for the monitor
  - `id` (optional): Unique monitor ID; auto-derived from the page name if omitted
  - `icon_url` (optional): Custom icon URL for embeds; overrides auto-detected favicon
- **Validation:**
  - Probes each supported provider (incident.io first, then Statuspage.io, then Instatus) and picks the first match. The detected provider is saved on the monitor entry so future polls skip detection.
  - Checks that the bot can post in the target channel (Discord permission flags; Slack channel membership, joining public channels automatically)
  - Rejects duplicate IDs or duplicate URLs (same status page can only be tracked once per server; different status pages in the same channel are allowed)
- **Side effects:**
  - Persists to `data/monitors.json`
  - Re-registers commands for updated autocomplete (Discord only — Slack commands are manifest-declared)
  - Triggers an immediate first poll
  - Caches the page favicon (or `icon_url` override) for embed icons

## `/monitor remove <id>`

Remove a runtime-added monitor.

- **Permission:** Manage Server
- **Behavior:**
  - Environment-configured monitors are protected and cannot be removed
  - Existing threads are preserved; use `/clean` to remove them
  - Re-registers commands for updated autocomplete (Discord only)

## `/monitor list`

List all configured monitors with metadata.

- **Permission:** Manage Server
- **Response:** Ephemeral embed listing each monitor with:
  - Source (`env` or `runtime`)
  - URL and channel
  - Who added it and when (runtime monitors only)

## Autocomplete

Discord only — Slack slash commands have no autocomplete, so use `/squawk help` to list the available subcommands and options.

- `/status`, `/testpost`, `/replay`, `/cleanup`, `/clean`: Autocompletes `target` from all configured monitors (ID and label)
- `/monitor remove`: Autocompletes `id` from runtime monitors only (env monitors are protected)

## `/squawk help` (Slack only)

Lists the enabled subcommands and their options. Also shown for an unrecognized subcommand.
