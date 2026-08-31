# Slack Setup

Squawk runs on Slack via [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode), so it needs no public HTTP endpoint and deploys exactly like the Discord bot — behind a NAT, in Docker, anywhere with outbound HTTPS.

One deployment drives one platform. See [Configuration](Configuration.md#chat-platform) for how `PLATFORM` is chosen.

## 1. Create the app

Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From an app manifest**, pick your workspace, and paste:

```yaml
display_information:
  name: Squawk
  description: Posts status page incidents into Slack as threaded conversations.
  background_color: "#2fb344"
features:
  bot_user:
    display_name: Squawk
    always_online: false
  slash_commands:
    - command: /squawk
      description: Status page monitoring and incident threads
      usage_hint: status | testpost | replay | clean | cleanup | monitor | help
      should_escape: false
oauth_config:
  scopes:
    bot:
      - channels:history
      - channels:join
      - channels:read
      - chat:write
      - commands
      - groups:history
      - groups:read
      - pins:read
      - pins:write
settings:
  interactivity:
    is_enabled: false
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
```

If `/squawk` is already taken in your workspace, change the `command:` here and set [`SLACK_COMMAND_NAME`](Configuration.md#slack) to match.

### Scopes

| Scope | Purpose |
|-------|---------|
| `chat:write` | Post, edit, and delete incident messages |
| `commands` | Receive the slash command |
| `channels:history`, `groups:history` | Read threads for replay deduplication and `/squawk clean` |
| `channels:read`, `groups:read` | Resolve channel IDs and membership |
| `channels:join` | Join public monitor channels unattended |
| `pins:write`, `pins:read` | Pin active incidents, unpin resolved ones |

`chat:write` only permits deleting the app's own messages, so `/squawk clean` can never remove anyone else's.

## 2. Get the two tokens

Squawk needs both:

| Token | Where | Env var |
|-------|-------|---------|
| Bot token (`xoxb-…`) | **OAuth & Permissions** → Install to Workspace | `SLACK_BOT_TOKEN` |
| App-level token (`xapp-…`) | **Basic Information** → App-Level Tokens → Generate, with the `connections:write` scope | `SLACK_APP_TOKEN` |

The app-level token is what opens the Socket Mode connection. Without it Squawk will not start.

## 3. Configure

```env
PLATFORM=slack
SLACK_BOT_TOKEN=xoxb-…
SLACK_APP_TOKEN=xapp-…
MONITORS_JSON=[{"id":"atlassian","channelId":"C0123ABCDEF","baseUrl":"https://status.atlassian.com","label":"Atlassian"}]
```

To find a channel ID: open the channel in Slack → click its name → the ID is at the bottom of the **About** tab.

Squawk joins public monitor channels on its own. For a **private** channel, invite it first:

```
/invite @Squawk
```

## 4. Restrict the destructive commands

Slack has no per-command permission model, so unlike Discord's **Manage Server** gate, any workspace member can run `/squawk clean` by default. Set `SLACK_ADMIN_USER_IDS` to lock the destructive subcommands (`testpost`, `replay`, `clean`, `cleanup`, `monitor`) down to named users:

```env
SLACK_ADMIN_USER_IDS=U01ABCDEF,U02GHIJKL
```

A user ID is on their Slack profile under **More** → **Copy member ID**.

## Commands

Slack slash command names are unique per workspace and cannot be registered over an API, so all six commands are subcommands of one manifest-declared command:

```
/squawk status [target]
/squawk testpost [target]
/squawk replay [target]
/squawk cleanup [target]
/squawk clean [target] [limit]
/squawk monitor add <url> [channel=#ops] [label="Example Co"] [id=slug] [icon_url=…]
/squawk monitor remove <id>
/squawk monitor list
/squawk help
```

Options can be positional or `key=value`; quote values containing spaces. Since Slack offers no slash-command autocomplete, `/squawk help` lists whatever is enabled. See [Commands](Commands.md) for full behavior.

## What differs from Discord

| Behavior | Discord | Slack |
|----------|---------|-------|
| Incident grouping | One thread per incident | One thread per incident (replies on the parent message) |
| Thread archiving | Archived on resolve | Not available — Slack threads have no archived state |
| Pin system notices | Auto-posted, pruned by Squawk | Not applicable |
| Bot presence | Rotating monitor/incident/uptime status | Not available |
| Command autocomplete | Yes, for `target` and monitor `id` | Not available — use `/squawk help` |
| Command permissions | **Manage Server** | `SLACK_ADMIN_USER_IDS` |
| Rich rendering | Embeds | Block Kit attachments with the same color accents |
| Bulk delete | Up to 100 messages, 14-day limit | Deleted one at a time, no age limit |

## Troubleshooting

**`invalid_auth` at startup** — `SLACK_BOT_TOKEN` is wrong or the app was uninstalled. Reinstall from **OAuth & Permissions**.

**Starts, but the slash command does nothing** — the command name in the manifest and `SLACK_COMMAND_NAME` disagree. Squawk ignores commands it does not own.

**`not_in_channel` when posting** — Squawk is not in the channel and could not join it (private channels). Run `/invite @Squawk` there.

**`Channel … was not found` for a channel that exists** — Slack reports a private channel the app was never invited to the same way it reports a wrong ID. Run `/invite @Squawk` in that channel.

**`missing_scope`** — a scope was added after install. Reinstall the app so the bot token picks it up.
