/**
 * Slack implementation of {@link ChatPlatform}.
 *
 * Differences from Discord that shape this adapter:
 *
 * - **Threads are not channels.** A Slack thread *is* its parent message, so
 *   `threadId` is the parent's `ts` and every thread call needs the channel too.
 *   `conversations.replies` always returns the parent first, so it is filtered
 *   out to match Discord's "thread messages only" semantics.
 * - **No thread archiving, no pin system notices, no bot presence.** Those
 *   capabilities are off and the core skips the corresponding work.
 * - **Commands are declared in the app manifest, not over an API.** Slash
 *   command names are unique per workspace, so Squawk registers a single
 *   command (`/squawk` by default) and routes subcommands out of its text.
 * - **Update IDs travel as message metadata** rather than being scraped back
 *   out of a rendered embed, with a block scan as a fallback for messages
 *   posted before metadata was attached.
 */

import { SocketModeClient } from "@slack/socket-mode";
import type { KnownBlock, MessageAttachment } from "@slack/types";
import { WebClient } from "@slack/web-api";
import { env } from "../config";
import * as core from "../core";
import type { Embed, TextFormat } from "../render";
import type {
  ChatPlatform,
  CommandContext,
  PlatformCapabilities,
  PlatformMessage,
  ThreadInfo,
} from "./types";

/** Slack API errors that mean "this resource is gone or unreachable". */
const MISSING_ERRORS = new Set([
  "channel_not_found",
  "message_not_found",
  "thread_not_found",
]);

/** Slack API errors that mean "the delete was unnecessary or already done". */
const BENIGN_DELETE_ERRORS = new Set([
  "message_not_found",
  "cant_delete_message",
  "channel_not_found",
]);

const METADATA_EVENT_TYPE = "squawk_incident_update";

/** Slack Block Kit limits. */
const SECTION_TEXT_LIMIT = 2900;
const FIELD_TEXT_LIMIT = 1900;
const FIELDS_PER_SECTION = 10;

function slackErrorCode(error: unknown): string | undefined {
  const data = (error as { data?: { error?: string } })?.data;
  return typeof data?.error === "string" ? data.error : undefined;
}

function isMissingError(error: unknown): boolean {
  const code = slackErrorCode(error);
  return code !== undefined && MISSING_ERRORS.has(code);
}

function hexColor(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, "0")}`;
}

function parseHexColor(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value.replace(/^#/, ""), 16);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export const slackFormat: TextFormat = {
  // Slack mrkdwn reserves these three characters for its own markup.
  escape: (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  bold: (text) => `*${text}*`,
  strike: (text) => `~${text}~`,
  inlineCode: (text) => `\`${text}\``,
  link: (url, text) => `<${url}|${text}>`,
  timestamp: (value) => {
    if (!value) return "unknown";
    const date = new Date(value);
    const seconds = Math.floor(date.getTime() / 1000);
    if (!Number.isFinite(seconds)) return "unknown";
    // Slack renders this in each viewer's own timezone, like Discord's <t:…>.
    return `<!date^${seconds}^{date_short_pretty} {time}|${date.toISOString()}>`;
  },
  channel: (channelId) => `<#${channelId}>`,
  user: (userId) => `<@${userId}>`,
  subtext: (text) => `_${text}_`,
};

function truncateForSlack(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/**
 * Convert a neutral embed into a Slack attachment. The attachment wrapper is
 * what gives the message its colored accent bar — the closest analogue to a
 * Discord embed's color.
 */
export function toSlackAttachment(embed: Embed): MessageAttachment {
  const blocks: KnownBlock[] = [];

  if (embed.author) {
    const authorText = embed.author.url
      ? `<${embed.author.url}|${embed.author.name}>`
      : embed.author.name;
    blocks.push({
      type: "context",
      elements: [
        ...(embed.author.iconUrl
          ? [
              {
                type: "image" as const,
                image_url: embed.author.iconUrl,
                alt_text: embed.author.name,
              },
            ]
          : []),
        { type: "mrkdwn", text: truncateForSlack(authorText, FIELD_TEXT_LIMIT) },
      ],
    });
  }

  if (embed.title) {
    const titleText = embed.url ? `<${embed.url}|${embed.title}>` : embed.title;
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*${truncateForSlack(titleText, SECTION_TEXT_LIMIT - 2)}*` },
    });
  }

  if (embed.description) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: truncateForSlack(embed.description, SECTION_TEXT_LIMIT) },
    });
  }

  // Inline fields become Slack's two-column field sections (10 per section);
  // full-width fields each get their own section, matching how Discord lays
  // inline and non-inline fields out.
  let pendingInline: { name: string; value: string }[] = [];
  const flushInline = () => {
    while (pendingInline.length > 0) {
      const chunk = pendingInline.splice(0, FIELDS_PER_SECTION);
      blocks.push({
        type: "section",
        fields: chunk.map((field) => ({
          type: "mrkdwn" as const,
          text: truncateForSlack(`*${field.name}*\n${field.value}`, FIELD_TEXT_LIMIT),
        })),
      });
    }
  };

  for (const field of embed.fields ?? []) {
    if (field.inline) {
      pendingInline.push(field);
      continue;
    }
    flushInline();
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: truncateForSlack(`*${field.name}*\n${field.value}`, SECTION_TEXT_LIMIT),
      },
    });
  }
  flushInline();

  if (embed.footer) {
    blocks.push({
      type: "context",
      elements: [
        { type: "mrkdwn", text: truncateForSlack(embed.footer.text, FIELD_TEXT_LIMIT) },
      ],
    });
  }

  return { color: hexColor(embed.color), blocks };
}

/** Plain-text summary used for notifications and screen readers. */
export function fallbackText(embed: Embed): string {
  return truncateForSlack(
    [embed.author?.name, embed.title].filter(Boolean).join(" — ") || "Status update",
    200,
  );
}

/**
 * Re-render a posted attachment as removed: grey accent with every text
 * segment struck through. Mirrors the Discord adapter's ghosting, working from
 * the posted blocks because the incident is no longer fetchable by then.
 */
function toDeletedAttachment(attachment: MessageAttachment): MessageAttachment {
  const strike = (text: string) => {
    const bare = text.replace(/~/g, "");
    return bare.trim().length === 0 ? text : `~${bare}~`;
  };

  const blocks = (attachment.blocks ?? []).map((block) => {
    if (block.type === "section") {
      const section = { ...block } as Extract<KnownBlock, { type: "section" }>;
      if (section.text?.type === "mrkdwn") {
        section.text = { ...section.text, text: strike(section.text.text) };
      }
      if (section.fields) {
        section.fields = section.fields.map((field) => ({
          ...field,
          text: strike(field.text),
        }));
      }
      return section;
    }

    if (block.type === "context") {
      const context = { ...block } as Extract<KnownBlock, { type: "context" }>;
      context.elements = context.elements.map((element) =>
        element.type === "mrkdwn" || element.type === "plain_text"
          ? { ...element, text: strike(element.text) }
          : element,
      );
      return context;
    }

    return block;
  });

  return { color: hexColor(0x95a5a6), blocks: blocks as KnownBlock[] };
}

type SlackMessage = {
  ts?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  pinned_to?: string[];
  attachments?: MessageAttachment[];
  metadata?: { event_type?: string; event_payload?: Record<string, unknown> };
};

function extractUpdateId(message: SlackMessage): string | undefined {
  if (message.metadata?.event_type === METADATA_EVENT_TYPE) {
    const value = message.metadata.event_payload?.update_id;
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  // Fallback for messages posted before metadata was attached: the update ID is
  // rendered as an "ID" field in the attachment.
  for (const block of message.attachments?.[0]?.blocks ?? []) {
    if (block.type !== "section") continue;
    const section = block as Extract<KnownBlock, { type: "section" }>;
    for (const field of section.fields ?? []) {
      const match = /^\*ID\*\n(.+)$/.exec(field.text);
      if (match) return match[1].trim();
    }
  }

  return undefined;
}

/**
 * `self` lets a message posted by this app be attributed to its bot *user* ID
 * even in the rare shapes where Slack omits `user` and only reports `bot_id`,
 * so ownership checks (`/clean`, replay dedupe) don't silently miss our own
 * messages — or match another app's.
 */
function toPlatformMessage(
  message: SlackMessage,
  self: { userId?: string; botId?: string },
): PlatformMessage {
  const ts = message.ts ?? "";
  const isOurs = Boolean(self.botId && message.bot_id === self.botId);
  return {
    id: ts,
    authorId: message.user ?? (isOurs ? self.userId : undefined),
    authoredByBot: Boolean(message.bot_id) || message.subtype === "bot_message",
    createdAt: Math.floor(Number.parseFloat(ts) * 1000) || 0,
    pinned: Array.isArray(message.pinned_to) && message.pinned_to.length > 0,
    updateId: extractUpdateId(message),
    pinNotice: false,
    embedColor: parseHexColor(message.attachments?.[0]?.color),
  };
}

// ---------------------------------------------------------------------------
// Slash command parsing
// ---------------------------------------------------------------------------

/**
 * Strip Slack's auto-linking wrappers. Slack rewrites URLs, channel mentions
 * and user mentions inside slash-command text into `<…>` / `<…|label>` forms,
 * so `https://status.example.com` arrives as `<https://status.example.com>`.
 */
export function unwrapSlackLink(token: string): string {
  const match = /^<([^>]+)>$/.exec(token);
  if (!match) return token;

  const inner = match[1];
  const [target] = inner.split("|");

  if (target.startsWith("#") || target.startsWith("@")) {
    return target.slice(1);
  }
  if (target.startsWith("mailto:")) {
    return target.slice("mailto:".length);
  }
  return target;
}

/**
 * Split on whitespace, honoring double-quoted values so labels can contain
 * spaces. A quoted run glues onto the token it touches, so both `"Example Co"`
 * and `label="Example Co"` come back as single tokens.
 */
export function tokenize(text: string): string[] {
  return [...text.matchAll(/(?:"[^"]*"|[^\s"]+)+/g)].map((match) =>
    match[0].replace(/"/g, ""),
  );
}

export type ParsedCommand = {
  name?: string;
  subcommand?: string;
  options: Map<string, string>;
};

const POSITIONAL_OPTIONS: Record<string, string[]> = {
  status: ["target"],
  testpost: ["target"],
  replay: ["target"],
  cleanup: ["target"],
  clean: ["target", "limit"],
  "monitor add": ["url"],
  "monitor remove": ["id"],
};

const KNOWN_OPTIONS = new Set(["target", "limit", "url", "channel", "label", "id", "icon_url"]);

/**
 * Parse `status atlassian`, `clean limit=50`, or
 * `monitor add https://status.x.com label="Example Co"` into a normalized
 * command.
 *
 * A token counts as a named option only when everything before the `=` is
 * letters or underscores, so URLs (`https://status.x.com/p?a=b`) still land in
 * the positional slots. An unrecognized option name is an error rather than a
 * silently consumed positional.
 */
export function parseCommandText(text: string): ParsedCommand {
  const tokens = tokenize(text.trim());
  const options = new Map<string, string>();

  const name = tokens.shift()?.toLowerCase();
  let subcommand: string | undefined;
  if (name === "monitor") {
    subcommand = tokens.shift()?.toLowerCase();
  }

  const positionalKeys = [
    ...(POSITIONAL_OPTIONS[subcommand ? `${name} ${subcommand}` : (name ?? "")] ?? []),
  ];

  for (const token of tokens) {
    const named = /^([a-z_]+)=(.*)$/i.exec(token);
    if (named) {
      const key = named[1].toLowerCase();
      if (!KNOWN_OPTIONS.has(key)) {
        throw new Error(
          `Unknown option \`${key}\`. Valid options: ${[...KNOWN_OPTIONS].join(", ")}.`,
        );
      }
      options.set(key, unwrapSlackLink(named[2]));
      continue;
    }

    const key = positionalKeys.shift();
    if (key) {
      options.set(key, unwrapSlackLink(token));
    }
  }

  return { name, subcommand, options };
}

function buildHelpText(commandName: string): string {
  const lines: string[] = [`*Squawk commands* — usage: \`/${commandName} <subcommand> [options]\``];

  if (env.ENABLE_STATUS_COMMAND) {
    lines.push(`• \`/${commandName} status [target]\` — current page status and active incidents`);
  }
  if (env.ENABLE_TEST_COMMAND) {
    lines.push(`• \`/${commandName} testpost [target]\` — post a status preview into the monitor channel`);
  }
  if (env.ENABLE_REPLAY_COMMAND) {
    lines.push(`• \`/${commandName} replay [target]\` — replay active incident timelines into their threads`);
  }
  if (env.ENABLE_CLEANUP_COMMAND) {
    lines.push(`• \`/${commandName} cleanup [target]\` — ghost dangling incidents no longer in the API`);
  }
  if (env.ENABLE_CLEAN_COMMAND) {
    lines.push(`• \`/${commandName} clean [target] [limit]\` — delete recent bot messages in this channel`);
  }
  if (env.ENABLE_MONITOR_COMMAND) {
    lines.push(
      `• \`/${commandName} monitor add <url> [channel=#chan] [label="Name"] [id=slug] [icon_url=…]\``,
      `• \`/${commandName} monitor remove <id>\``,
      `• \`/${commandName} monitor list\``,
    );
  }

  lines.push(
    "",
    "_Options can be given positionally or as `key=value`. Quote values containing spaces._",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

export class SlackPlatform implements ChatPlatform {
  readonly id = "slack" as const;
  readonly displayName = "Slack";
  readonly format = slackFormat;
  readonly capabilities: PlatformCapabilities = {
    // Slack threads are just replies on a parent message: nothing to archive,
    // no system notice on pin, no bot presence, no slash-command autocomplete.
    threadArchive: false,
    pinNotices: false,
    deletableThreads: false,
    presence: false,
    autocomplete: false,
    // chat.delete has no age limit, unlike Discord's bulk delete.
    maxMessageDeleteAgeMs: undefined,
  };

  private readonly web: WebClient;
  private readonly socket: SocketModeClient;
  private readonly commandName: string;
  private readonly adminUserIds: Set<string>;
  /** Channels already verified as joined, to keep polling off conversations.info. */
  private readonly joinedChannels = new Set<string>();
  private userId?: string;
  private botId?: string;

  constructor() {
    if (!env.SLACK_BOT_TOKEN || !env.SLACK_APP_TOKEN) {
      throw new Error(
        "PLATFORM=slack requires both SLACK_BOT_TOKEN (xoxb-…) and SLACK_APP_TOKEN (xapp-…).",
      );
    }
    this.web = new WebClient(env.SLACK_BOT_TOKEN);
    this.socket = new SocketModeClient({ appToken: env.SLACK_APP_TOKEN });
    this.commandName = env.SLACK_COMMAND_NAME;
    this.adminUserIds = new Set(
      (env.SLACK_ADMIN_USER_IDS ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    );
  }

  botUserId(): string {
    if (!this.userId) {
      throw new Error("Bot user is not available.");
    }
    return this.userId;
  }

  private get self() {
    return { userId: this.userId, botId: this.botId };
  }

  // -- channels -------------------------------------------------------------

  async assertChannel(channelId: string): Promise<void> {
    // Polling calls this once per monitor per cycle; membership only changes
    // when someone removes the app, which surfaces as a post failure anyway.
    if (this.joinedChannels.has(channelId)) {
      return;
    }

    let info: Awaited<ReturnType<WebClient["conversations"]["info"]>>;
    try {
      info = await this.web.conversations.info({ channel: channelId });
    } catch (error) {
      if (isMissingError(error)) {
        throw new Error(
          `Channel \`${channelId}\` was not found. Check the channel ID and that Squawk is installed in this workspace.`,
        );
      }
      throw error;
    }

    const channel = info.channel as { is_member?: boolean; is_private?: boolean } | undefined;
    if (channel?.is_member) {
      this.joinedChannels.add(channelId);
      return;
    }

    // Public channels can be joined unattended; private channels and DMs must
    // have the app invited by a human.
    if (channel?.is_private) {
      throw new Error(
        `Squawk is not in <#${channelId}>. Invite it with \`/invite @Squawk\` in that channel.`,
      );
    }

    try {
      await this.web.conversations.join({ channel: channelId });
      this.joinedChannels.add(channelId);
    } catch (error) {
      throw new Error(
        `Squawk could not join <#${channelId}> (${slackErrorCode(error) ?? "unknown error"}). Invite it with \`/invite @Squawk\` in that channel.`,
      );
    }
  }

  async assertCanPost(channelId: string): Promise<void> {
    await this.assertChannel(channelId);
  }

  async sendChannelMessage(channelId: string, embed: Embed): Promise<string> {
    const result = await this.web.chat.postMessage({
      channel: channelId,
      text: fallbackText(embed),
      attachments: [toSlackAttachment(embed)],
    });
    if (!result.ts) {
      throw new Error(`Slack did not return a timestamp for the message in ${channelId}.`);
    }
    return result.ts;
  }

  /** Fetch one message by `ts`, whether it is top-level or a thread reply. */
  private async fetchRaw(
    channelId: string,
    messageId: string,
    threadId?: string,
  ): Promise<SlackMessage | null> {
    try {
      const result = threadId
        ? await this.web.conversations.replies({
            channel: channelId,
            ts: threadId,
            oldest: messageId,
            latest: messageId,
            inclusive: true,
            limit: 1,
            include_all_metadata: true,
          })
        : await this.web.conversations.history({
            channel: channelId,
            oldest: messageId,
            latest: messageId,
            inclusive: true,
            limit: 1,
            include_all_metadata: true,
          });

      const messages = (result.messages ?? []) as SlackMessage[];
      return messages.find((message) => message.ts === messageId) ?? null;
    } catch (error) {
      if (isMissingError(error)) return null;
      throw error;
    }
  }

  async fetchMessage(channelId: string, messageId: string): Promise<PlatformMessage | null> {
    const message = await this.fetchRaw(channelId, messageId);
    return message ? toPlatformMessage(message, this.self) : null;
  }

  async editMessage(channelId: string, messageId: string, embed: Embed): Promise<void> {
    try {
      await this.web.chat.update({
        channel: channelId,
        ts: messageId,
        text: fallbackText(embed),
        attachments: [toSlackAttachment(embed)],
      });
    } catch (error) {
      if (isMissingError(error)) return;
      throw error;
    }
  }

  async listChannelMessages(channelId: string, limit: number): Promise<PlatformMessage[]> {
    try {
      const result = await this.web.conversations.history({
        channel: channelId,
        limit,
        include_all_metadata: true,
      });
      return ((result.messages ?? []) as SlackMessage[]).map((message) =>
        toPlatformMessage(message, this.self),
      );
    } catch (error) {
      if (isMissingError(error)) return [];
      throw error;
    }
  }

  async deleteMessage(channelId: string, messageId: string): Promise<boolean> {
    try {
      await this.web.chat.delete({ channel: channelId, ts: messageId });
      return true;
    } catch (error) {
      const code = slackErrorCode(error);
      if (code !== undefined && BENIGN_DELETE_ERRORS.has(code)) return false;
      throw error;
    }
  }

  async deleteMessages(channelId: string, messageIds: string[]): Promise<string[]> {
    // Slack has no bulk delete; chat.delete is rate limited, and the WebClient
    // transparently retries on 429.
    const deleted: string[] = [];
    for (const messageId of messageIds) {
      if (await this.deleteMessage(channelId, messageId)) {
        deleted.push(messageId);
      }
    }
    return deleted;
  }

  async hasPinnedMessages(channelId: string): Promise<boolean> {
    try {
      const result = await this.web.pins.list({ channel: channelId });
      return (result.items ?? []).length > 0;
    } catch (error) {
      if (isMissingError(error)) return false;
      throw error;
    }
  }

  async pinMessage(channelId: string, messageId: string): Promise<void> {
    try {
      await this.web.pins.add({ channel: channelId, timestamp: messageId });
    } catch (error) {
      // `already_pinned` is the expected no-op; missing resources are handled
      // by the caller's own state pruning.
      if (slackErrorCode(error) === "already_pinned" || isMissingError(error)) return;
      throw error;
    }
  }

  async unpinMessage(channelId: string, messageId: string): Promise<void> {
    try {
      await this.web.pins.remove({ channel: channelId, timestamp: messageId });
    } catch (error) {
      if (slackErrorCode(error) === "no_pin" || isMissingError(error)) return;
      throw error;
    }
  }

  // -- threads --------------------------------------------------------------

  /**
   * A Slack thread has no separate identity — it is its parent message. Nothing
   * is created until the first reply is posted, so this just returns the parent
   * `ts` as the thread handle.
   */
  async createThread(
    _channelId: string,
    parentMessageId: string,
    _name: string,
    _reason: string,
  ): Promise<string> {
    return parentMessageId;
  }

  async fetchThread(channelId: string, threadId: string): Promise<ThreadInfo | null> {
    const parent = await this.fetchRaw(channelId, threadId);
    if (!parent) return null;
    // Slack threads are never archived and carry no name.
    return { id: threadId, archived: false };
  }

  async sendThreadMessage(
    channelId: string,
    threadId: string,
    embed: Embed,
    meta?: { updateId?: string; incidentId?: string },
  ): Promise<string> {
    const result = await this.web.chat.postMessage({
      channel: channelId,
      thread_ts: threadId,
      text: fallbackText(embed),
      attachments: [toSlackAttachment(embed)],
      ...(meta?.updateId
        ? {
            metadata: {
              event_type: METADATA_EVENT_TYPE,
              event_payload: {
                update_id: meta.updateId,
                ...(meta.incidentId ? { incident_id: meta.incidentId } : {}),
              },
            },
          }
        : {}),
    });
    if (!result.ts) {
      throw new Error(`Slack did not return a timestamp for the reply in ${channelId}.`);
    }
    return result.ts;
  }

  async strikeThreadMessage(
    channelId: string,
    threadId: string,
    messageId: string,
  ): Promise<void> {
    const message = await this.fetchRaw(channelId, messageId, threadId);
    const attachment = message?.attachments?.[0];
    if (!attachment) return;

    await this.web.chat.update({
      channel: channelId,
      ts: messageId,
      text: message?.text ?? "Removed incident update",
      attachments: [toDeletedAttachment(attachment)],
    });
  }

  async listThreadMessages(channelId: string, threadId: string): Promise<PlatformMessage[]> {
    const collected: PlatformMessage[] = [];
    let cursor: string | undefined;

    try {
      do {
        const result = await this.web.conversations.replies({
          channel: channelId,
          ts: threadId,
          limit: 200,
          cursor,
          include_all_metadata: true,
        });

        for (const message of (result.messages ?? []) as SlackMessage[]) {
          // conversations.replies always leads with the thread parent, which
          // lives in the channel rather than the thread.
          if (message.ts === threadId) continue;
          collected.push(toPlatformMessage(message, this.self));
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);
    } catch (error) {
      if (isMissingError(error)) return collected;
      throw error;
    }

    return collected;
  }

  async deleteThreadMessages(
    channelId: string,
    _threadId: string,
    messageIds: string[],
  ): Promise<string[]> {
    // Thread replies are deleted exactly like channel messages.
    return this.deleteMessages(channelId, messageIds);
  }

  async threadMessageExists(
    channelId: string,
    threadId: string,
    messageId: string,
  ): Promise<boolean> {
    return (await this.fetchRaw(channelId, messageId, threadId)) !== null;
  }

  async setThreadArchived(): Promise<void> {
    // Slack threads have no archived state; the core skips this via capabilities.
  }

  async deleteThread(): Promise<void> {
    // Nothing to delete: `deleteThreadMessages` already removed the replies and
    // the parent message is deleted with the rest of the channel's messages.
  }

  // -- commands -------------------------------------------------------------

  async registerCommands(): Promise<void> {
    // Slack slash commands are declared in the app manifest, not over an API.
  }

  setPresence(): void {
    // Slack has no bot presence; the core skips this via capabilities.
  }

  private async respond(responseUrl: string, body: Record<string, unknown>) {
    const response = await fetch(responseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response_type: "ephemeral", ...body }),
    });
    if (!response.ok) {
      console.error(`Slack response_url POST failed: ${response.status} ${response.statusText}`);
    }
  }

  /**
   * Resolve a `channel` option into a channel ID. Slack sends `<#C123|name>`
   * when link escaping is enabled and a bare `#name` when it is not.
   */
  private async resolveChannelId(value: string): Promise<string> {
    const candidate = unwrapSlackLink(value);
    if (/^[CGD][A-Z0-9]+$/i.test(candidate)) {
      return candidate;
    }

    const name = candidate.replace(/^#/, "").toLowerCase();
    let cursor: string | undefined;
    do {
      const result = await this.web.conversations.list({
        limit: 1000,
        cursor,
        exclude_archived: true,
        types: "public_channel,private_channel",
      });
      const match = (result.channels ?? []).find(
        (channel) => channel.name?.toLowerCase() === name,
      );
      if (match?.id) return match.id;
      cursor = result.response_metadata?.next_cursor || undefined;
    } while (cursor);

    throw new Error(`Could not find a channel named \`#${name}\`.`);
  }

  private buildContext(
    parsed: ParsedCommand,
    body: { channel_id: string; user_id: string; response_url: string },
  ): CommandContext {
    let replied = false;

    return {
      platform: this,
      channelId: body.channel_id,
      userId: body.user_id,
      subcommand: parsed.subcommand,
      getString: (name) => parsed.options.get(name),
      getInteger: (name) => {
        const raw = parsed.options.get(name);
        if (raw === undefined) return undefined;
        const parsedValue = Number.parseInt(raw, 10);
        if (!Number.isFinite(parsedValue)) {
          throw new Error(`\`${name}\` must be a number, received \`${raw}\`.`);
        }
        return parsedValue;
      },
      reply: async (payload) => {
        if (replied) return;
        replied = true;
        await this.respond(body.response_url, {
          text: payload.content ?? (payload.embeds?.[0] ? fallbackText(payload.embeds[0]) : " "),
          ...(payload.embeds?.length
            ? { attachments: payload.embeds.map(toSlackAttachment) }
            : {}),
        });
      },
    };
  }

  /**
   * Slack has no per-command permission model, so destructive commands are
   * gated on SLACK_ADMIN_USER_IDS when it is configured. Left unset, every
   * workspace member can run them.
   */
  private assertAdmin(userId: string, subcommand: string) {
    if (this.adminUserIds.size === 0 || this.adminUserIds.has(userId)) {
      return;
    }
    throw new Error(`\`${subcommand}\` is restricted to Squawk administrators in this workspace.`);
  }

  private async dispatch(
    parsed: ParsedCommand,
    body: { channel_id: string; user_id: string; response_url: string },
  ) {
    const context = this.buildContext(parsed, body);

    switch (parsed.name) {
      case "status":
        return core.handleStatusCommand(context);
      case "testpost":
        this.assertAdmin(body.user_id, "testpost");
        return core.handleTestPostCommand(context);
      case "replay":
        this.assertAdmin(body.user_id, "replay");
        return core.handleReplayCommand(context);
      case "clean":
        this.assertAdmin(body.user_id, "clean");
        return core.handleCleanCommand(context);
      case "cleanup":
        this.assertAdmin(body.user_id, "cleanup");
        return core.handleCleanupCommand(context);
      case "monitor":
        this.assertAdmin(body.user_id, "monitor");
        if (parsed.subcommand === "add" && parsed.options.has("channel")) {
          parsed.options.set(
            "channel",
            await this.resolveChannelId(parsed.options.get("channel") as string),
          );
        }
        return core.handleMonitorCommand(context);
      default:
        return context.reply({ content: buildHelpText(this.commandName) });
    }
  }

  async start(): Promise<void> {
    const auth = await this.web.auth.test();
    this.userId = auth.user_id;
    this.botId = auth.bot_id;
    console.log(`Logged in as ${auth.user} in ${auth.team} (${auth.team_id})`);

    this.socket.on("slash_commands", async ({ ack, body }) => {
      // Slack drops the command unless it is acknowledged within 3 seconds, so
      // ack first and deliver the result through response_url.
      await ack();

      const command = body as {
        command?: string;
        text?: string;
        channel_id: string;
        user_id: string;
        response_url: string;
      };

      if (command.command?.replace(/^\//, "") !== this.commandName) {
        return;
      }

      try {
        await this.dispatch(parseCommandText(command.text ?? ""), command);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unexpected error";
        await this.respond(command.response_url, { text: message });
      }
    });

    await this.socket.start();
  }
}
