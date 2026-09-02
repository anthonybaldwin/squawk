# State Management

The bot persists its state to JSON files in the `data/` directory. In Docker deployments, this directory is backed by a named volume (`squawk_data`).

> **State belongs to one chat platform.** Message, thread, and channel IDs are stored as opaque platform handles — Discord snowflakes on a Discord deployment, Slack `ts` values and channel IDs on a Slack one. Running both platforms means two instances with separate data volumes; pointing a Slack deployment at a Discord state file will not resolve any of the stored IDs.

## Files

| File | Purpose |
|------|---------|
| `data/state.json` | Incident tracking, posted update IDs, open incident list |
| `data/monitors.json` | Runtime-added monitors (via `/monitor add`) |

## State Schema

### `state.json`

```json
{
  "monitors": {
    "<monitor-id>": {
      "postedUpdateIds": ["update-id-1", "update-id-2"],
      "openIncidentIds": ["incident-id-1"],
      "lastPostedAt": "2026-03-02T15:50:31.184Z",
      "lastPinNoticeMessageId": "<message-id>",
      "incidents": {
        "<incident-id>": {
          "parentMessageId": "<message-id>",
          "threadId": "<thread-id>",
          "postedUpdateIds": ["update-id-1"],
          "updateMessageIds": {
            "update-id-1": "<message-id>"
          },
          "resolvedAt": "2026-03-02T15:47:09Z",
          "incidentName": "Elevated error rates"
        }
      }
    }
  }
}
```

**Field details:**

| Field | Scope | Purpose |
|-------|-------|---------|
| `postedUpdateIds` | Monitor | Deduplication list (last 500) to avoid re-posting updates |
| `openIncidentIds` | Monitor | Running list of incident IDs the bot considers "open", used for ghost detection |
| `lastPostedAt` | Monitor | Timestamp of the last posted update |
| `lastPinNoticeMessageId` | Monitor | ID of the bot's currently-visible "pinned a message" system notice. Empty string = tracked but no notice visible. Absent = uninitialized; first pin runs a one-time historical sweep before switching to ID tracking. |
| `incidents` | Monitor | Map of tracked incidents with Discord resource IDs |
| `parentMessageId` | Incident | The embed message in the channel that anchors the thread |
| `threadId` | Incident | The Discord thread ID for the incident |
| `postedUpdateIds` | Incident | Update IDs posted to this specific thread |
| `updateMessageIds` | Incident | Map of update IDs to their Discord message IDs (for editing/cleanup) |
| `resolvedAt` | Incident | When the incident was resolved or ghosted |

### `monitors.json`

```json
{
  "monitors": [
    {
      "id": "example",
      "channelId": "123456789",
      "baseUrl": "https://status.example.com",
      "label": "Example",
      "provider": "statuspage",
      "iconUrl": "https://status.example.com/favicon.ico",
      "addedBy": "discord-user-id",
      "addedAt": "2026-03-05T12:00:00Z"
    }
  ]
}
```

## Migration

The bot supports legacy single-monitor state. If `state.json` has a flat structure (no `monitors` key), the bot automatically migrates it into a `monitors.default` bucket on first read.

## Concurrency Safety

### State File

State reads and writes are not locked. Two things keep that safe:

- **`singleFlight`** wraps the poll loop so a cycle can never overlap with itself. A cycle can outrun `POLL_INTERVAL_MS` (slow or failing monitors, chatty thread creation); without the guard, the overrunning cycle and the next `setInterval` tick would both observe a brand-new incident with no thread mapping and each create a parent message plus thread, producing duplicate threads — only one of which survives the last-writer-wins `writeState`. While a run is in flight, later ticks coalesce into it.
- **Sequential iteration** — `postLatestUpdates` walks monitors with a `for...of`, so only one monitor is in flight at a time within a cycle.

Command handlers read state independently but only write during `/replay`, `/clean`, and `/cleanup`, which are user-triggered and unlikely to race with polling.

### Monitors File

Runtime monitor mutations (`/monitor add`, `/monitor remove`) use a promise-chain lock (`withMonitorLock`) to ensure read-modify-write operations on `monitors.json` are serialized. This prevents two concurrent `/monitor add` calls from overwriting each other.

## State Limits

- `postedUpdateIds` (monitor-level) is trimmed to the last 500 entries per poll cycle
- `postedUpdateIds` (incident-level) is trimmed to the last 500 entries whenever it is appended to — during polling and during `/replay`
- Incident state entries are only deleted when Discord resources are confirmed missing
- `/clean` preserves monitor-level `postedUpdateIds` for resolved incidents to prevent re-posting, but strips them for active incidents so they re-create threads

## File Safety

- Both files are written as a full JSON rewrite (`writeFile`), never appended to, so a write always lands a complete document
- Writes are **not** atomic — there is no temp-file-plus-rename, so a crash or power loss mid-write can leave a truncated file. `ensureStateFile()` only re-seeds when `state.json` is *missing*, so a truncated one fails `JSON.parse` on the next read instead of self-healing. If that happens, delete `data/state.json` and let the bot re-seed, then use `/replay` to restore threads.
- State is written after each monitor finishes rather than once at the end of a cycle, so a mid-cycle crash loses at most one monitor's progress
- The `data/` directory is created with `mkdir({ recursive: true })` if missing
- Files use `utf8` encoding with two-space indentation and a trailing newline for clean diffs
