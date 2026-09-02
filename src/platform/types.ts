/**
 * The chat-platform seam.
 *
 * `src/core.ts` drives the entire incident lifecycle through this interface, so
 * adding a platform means implementing `ChatPlatform` and nothing else. Two
 * conventions keep the core free of platform error handling:
 *
 * - **`null` means "gone".** Any lookup that returns `null` is telling the core
 *   that the resource is missing or unreachable in a way that warrants pruning
 *   state (Discord's 10003/10008/50001/50013/50035, Slack's `channel_not_found`
 *   / `message_not_found`). Every other failure throws and is handled upstream.
 * - **Threads are addressed by `(channelId, threadId)`.** Discord threads are
 *   standalone channels and ignore the channel argument; Slack threads are the
 *   `thread_ts` of a parent message and need both.
 */

import type { PlatformId } from "../config";
import type { Embed, TextFormat } from "../render";

export type PlatformMessage = {
  id: string;
  /** Platform user ID of the author, when the platform exposes one. */
  authorId?: string;
  authoredByBot: boolean;
  /** Epoch milliseconds. */
  createdAt: number;
  pinned?: boolean;
  /** Incident update ID carried by this message, for incident-update posts. */
  updateId?: string;
  /** The platform's automatic "pinned a message to this channel" system notice. */
  pinNotice?: boolean;
  /** Message this one refers to — used to match a pin notice to its pin. */
  referencedMessageId?: string;
  /** Accent color of the message's embed, when it has one. */
  embedColor?: number;
};

export type ThreadInfo = {
  id: string;
  /** Threads have names on Discord; Slack threads do not. */
  name?: string;
  archived: boolean;
};

export type PlatformCapabilities = {
  /** Threads can be archived and unarchived (Discord). */
  threadArchive: boolean;
  /** The platform posts a system notice on pin that the core prunes (Discord). */
  pinNotices: boolean;
  /** Threads are first-class channels that can be deleted outright (Discord). */
  deletableThreads: boolean;
  /** The bot can advertise a rotating activity/presence (Discord). */
  presence: boolean;
  /** Commands offer typed option autocomplete (Discord). */
  autocomplete: boolean;
  /** Messages older than this cannot be deleted (Discord's 14-day bulk limit). */
  maxMessageDeleteAgeMs?: number;
};

export type PresenceActivity = {
  text: string;
  kind: "watching" | "playing";
};

export interface ChatPlatform {
  readonly id: PlatformId;
  readonly displayName: string;
  readonly capabilities: PlatformCapabilities;
  readonly format: TextFormat;

  /** Connect, register commands, and start dispatching to the core. */
  start(): Promise<void>;
  /** The bot's own user ID. Only valid after `start()` resolves. */
  botUserId(): string;

  /** Throw a user-facing error when the channel is missing or unpostable. */
  assertChannel(channelId: string): Promise<void>;
  /** Same as `assertChannel`, plus the permission checks `/monitor add` needs. */
  assertCanPost(channelId: string): Promise<void>;

  sendChannelMessage(channelId: string, embed: Embed): Promise<string>;
  fetchMessage(channelId: string, messageId: string): Promise<PlatformMessage | null>;
  editMessage(channelId: string, messageId: string, embed: Embed): Promise<void>;
  listChannelMessages(channelId: string, limit: number): Promise<PlatformMessage[]>;
  /**
   * Delete a single message regardless of age. Resolves `false` when it was
   * already gone. Used for pin-notice pruning, which must reach messages older
   * than a platform's bulk-delete window.
   */
  deleteMessage(channelId: string, messageId: string): Promise<boolean>;
  /** Delete as many of `messageIds` as possible; returns the IDs actually deleted. */
  deleteMessages(channelId: string, messageIds: string[]): Promise<string[]>;
  hasPinnedMessages(channelId: string): Promise<boolean>;
  pinMessage(channelId: string, messageId: string): Promise<void>;
  unpinMessage(channelId: string, messageId: string): Promise<void>;

  createThread(
    channelId: string,
    parentMessageId: string,
    name: string,
    reason: string,
  ): Promise<string>;
  fetchThread(channelId: string, threadId: string): Promise<ThreadInfo | null>;
  sendThreadMessage(
    channelId: string,
    threadId: string,
    embed: Embed,
    meta?: { updateId?: string; incidentId?: string },
  ): Promise<string>;
  /** Re-render one thread message as removed: grey accent, struck-through text. */
  strikeThreadMessage(channelId: string, threadId: string, messageId: string): Promise<void>;
  listThreadMessages(channelId: string, threadId: string): Promise<PlatformMessage[]>;
  /** Delete messages inside a thread; returns the IDs actually deleted. */
  deleteThreadMessages(
    channelId: string,
    threadId: string,
    messageIds: string[],
  ): Promise<string[]>;
  /** `false` when the message is gone; throws on any other failure. */
  threadMessageExists(
    channelId: string,
    threadId: string,
    messageId: string,
  ): Promise<boolean>;
  setThreadArchived(
    channelId: string,
    threadId: string,
    archived: boolean,
    reason: string,
  ): Promise<void>;
  deleteThread(channelId: string, threadId: string): Promise<void>;

  /** Push the current command set to the platform. A no-op where commands are declarative. */
  registerCommands(): Promise<void>;
  setPresence(activity: PresenceActivity): void;
}

/**
 * One command invocation, normalized across platforms. Discord fills this from
 * a `ChatInputCommandInteraction`; Slack parses it out of the slash command's
 * text payload.
 */
export type CommandContext = {
  platform: ChatPlatform;
  /** Channel the command was invoked in. */
  channelId: string;
  /** Invoking user's platform ID. */
  userId: string;
  subcommand?: string;
  getString(name: string): string | undefined;
  getInteger(name: string): number | undefined;
  /** Send the (ephemeral) response. Safe to call once per invocation. */
  reply(payload: { content?: string; embeds?: Embed[] }): Promise<void>;
};
