/**
 * Discord implementation of {@link ChatPlatform}.
 *
 * Threads are real channels here, so the `channelId` argument is only used to
 * locate the parent channel — thread operations resolve the thread by its own
 * ID. Discord API errors that mean "this resource is gone" are translated into
 * `null`/`false` returns so the core can prune state without knowing any
 * Discord error codes.
 */

import {
  ActivityType,
  AutocompleteInteraction,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  DiscordAPIError,
  EmbedBuilder,
  GatewayIntentBits,
  Message,
  MessageFlags,
  MessageType,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  TextChannel,
  ThreadAutoArchiveDuration,
  ThreadChannel,
} from "discord.js";
import { env } from "../config";
import * as core from "../core";
import type { Embed, TextFormat } from "../render";
import type {
  ChatPlatform,
  CommandContext,
  PlatformCapabilities,
  PlatformMessage,
  PresenceActivity,
  ThreadInfo,
} from "./types";

/**
 * Discord error codes that mean "the resource is gone or unreachable" —
 * Unknown Channel, Unknown Message, Missing Access, Missing Permissions, and
 * Invalid Form Body (raised when editing a message that no longer exists in a
 * usable state). Anything else propagates.
 */
function isCleanupError(error: unknown): error is DiscordAPIError {
  return (
    error instanceof DiscordAPIError &&
    [10003, 10008, 50001, 50013, 50035].includes(Number(error.code))
  );
}

/** Discord's bulk delete refuses messages older than 14 days. */
const MAX_BULK_DELETE_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** Discord caps embeds at 25 fields. */
const MAX_EMBED_FIELDS = 25;

export const discordFormat: TextFormat = {
  escape: (text) => text,
  bold: (text) => `**${text}**`,
  strike: (text) => `~~${text}~~`,
  inlineCode: (text) => `\`${text}\``,
  link: (url, text) => `[${text}](${url})`,
  timestamp: (value) => {
    if (!value) return "unknown";
    return `<t:${Math.floor(new Date(value).getTime() / 1000)}:f>`;
  },
  channel: (channelId) => `<#${channelId}>`,
  user: (userId) => `<@${userId}>`,
  subtext: (text) => `-# ${text}`,
};

export function toDiscordEmbed(embed: Embed): EmbedBuilder {
  const builder = new EmbedBuilder().setColor(embed.color);

  if (embed.author) {
    builder.setAuthor({
      name: embed.author.name,
      iconURL: embed.author.iconUrl,
      url: embed.author.url,
    });
  }
  if (embed.title) builder.setTitle(embed.title);
  if (embed.url) builder.setURL(embed.url);
  if (embed.description) builder.setDescription(embed.description);
  if (embed.fields?.length) {
    builder.addFields(
      embed.fields.slice(0, MAX_EMBED_FIELDS).map((field) => ({
        name: field.name,
        value: field.value,
        inline: field.inline,
      })),
    );
  }
  if (embed.footer) builder.setFooter({ text: embed.footer.text });

  return builder;
}

/**
 * Re-render an already-posted embed as removed: grey accent with every text
 * segment struck through. Works from the posted embed rather than the incident,
 * because ghosting happens precisely when the incident is no longer fetchable.
 */
function toDeletedEmbed(original: EmbedBuilder): EmbedBuilder {
  const data = original.toJSON();
  const embed = new EmbedBuilder().setColor(0x95a5a6);

  if (data.author) {
    embed.setAuthor({ name: data.author.name, iconURL: data.author.icon_url });
  }

  if (data.title) {
    embed.setTitle(`~~${data.title.replace(/~~/g, "")}~~`);
  }

  if (data.description) {
    embed.setDescription(`~~${data.description.replace(/~~/g, "").slice(0, 3996)}~~`);
  }

  if (data.fields) {
    embed.addFields(
      data.fields.map((field) => ({
        name: field.name,
        value: `~~${field.value.replace(/~~/g, "")}~~`,
        inline: field.inline,
      })),
    );
  }

  if (data.url) {
    embed.setURL(data.url);
  }

  return embed;
}

function extractUpdateId(message: Message): string | undefined {
  const embed = message.embeds[0];
  if (!embed) {
    return undefined;
  }

  const idField = embed.fields.find((field) => field.name === "ID");
  if (idField) {
    return idField.value.trim() || undefined;
  }

  // Fallback: older messages may still have the ID in the footer.
  return embed.footer?.text?.trim() || undefined;
}

function toPlatformMessage(message: Message): PlatformMessage {
  return {
    id: message.id,
    authorId: message.author.id,
    authoredByBot: message.author.bot,
    createdAt: message.createdTimestamp,
    pinned: message.pinned,
    updateId: extractUpdateId(message),
    pinNotice: message.type === MessageType.ChannelPinnedMessage,
    referencedMessageId: message.reference?.messageId,
    embedColor: message.embeds[0]?.color ?? undefined,
  };
}

export class DiscordPlatform implements ChatPlatform {
  readonly id = "discord" as const;
  readonly displayName = "Discord";
  readonly format = discordFormat;
  readonly capabilities: PlatformCapabilities = {
    threadArchive: true,
    pinNotices: true,
    deletableThreads: true,
    presence: true,
    autocomplete: true,
    maxMessageDeleteAgeMs: MAX_BULK_DELETE_AGE_MS,
  };

  private readonly client: Client;
  private readonly token: string;
  private readonly applicationId: string;

  constructor() {
    if (!env.DISCORD_TOKEN || !env.DISCORD_APPLICATION_ID) {
      throw new Error(
        "PLATFORM=discord requires both DISCORD_TOKEN and DISCORD_APPLICATION_ID.",
      );
    }
    this.token = env.DISCORD_TOKEN;
    this.applicationId = env.DISCORD_APPLICATION_ID;
    this.client = new Client({ intents: [GatewayIntentBits.Guilds] });
  }

  botUserId(): string {
    const id = this.client.user?.id;
    if (!id) {
      throw new Error("Bot user is not available.");
    }
    return id;
  }

  // -- channels -------------------------------------------------------------

  private async getChannel(channelId: string): Promise<TextChannel> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      throw new Error(`Configured channel ${channelId} must point to a text channel.`);
    }
    return channel as TextChannel;
  }

  private async getThread(threadId: string): Promise<ThreadChannel | null> {
    try {
      const channel = await this.client.channels.fetch(threadId);
      return channel?.isThread() ? channel : null;
    } catch (error) {
      if (isCleanupError(error)) return null;
      throw error;
    }
  }

  async assertChannel(channelId: string): Promise<void> {
    await this.getChannel(channelId);
  }

  async assertCanPost(channelId: string): Promise<void> {
    const channel = await this.getChannel(channelId).catch(() => null);
    if (!channel) {
      throw new Error(`<#${channelId}> must be a text channel.`);
    }

    const botMember = channel.guild.members.me;
    if (botMember) {
      const permissions = channel.permissionsFor(botMember);
      if (
        !permissions?.has("SendMessages") ||
        !permissions.has("EmbedLinks") ||
        !permissions.has("CreatePublicThreads")
      ) {
        throw new Error(
          `I'm missing permissions in <#${channelId}>. I need **Send Messages**, **Embed Links**, and **Create Public Threads**.`,
        );
      }
    }
  }

  async sendChannelMessage(channelId: string, embed: Embed): Promise<string> {
    const channel = await this.getChannel(channelId);
    const message = await channel.send({ embeds: [toDiscordEmbed(embed)] });
    return message.id;
  }

  private async fetchRaw(channelId: string, messageId: string): Promise<Message | null> {
    try {
      const channel = await this.getChannel(channelId);
      return await channel.messages.fetch(messageId);
    } catch (error) {
      if (isCleanupError(error)) return null;
      throw error;
    }
  }

  async fetchMessage(channelId: string, messageId: string): Promise<PlatformMessage | null> {
    const message = await this.fetchRaw(channelId, messageId);
    return message ? toPlatformMessage(message) : null;
  }

  async editMessage(channelId: string, messageId: string, embed: Embed): Promise<void> {
    const message = await this.fetchRaw(channelId, messageId);
    if (!message) return;
    try {
      await message.edit({ embeds: [toDiscordEmbed(embed)] });
    } catch (error) {
      if (isCleanupError(error)) return;
      throw error;
    }
  }

  async listChannelMessages(channelId: string, limit: number): Promise<PlatformMessage[]> {
    const channel = await this.getChannel(channelId);
    const messages = await channel.messages.fetch({ limit });
    return [...messages.values()].map(toPlatformMessage);
  }

  async deleteMessage(channelId: string, messageId: string): Promise<boolean> {
    try {
      const channel = await this.getChannel(channelId);
      await channel.messages.delete(messageId);
      return true;
    } catch (error) {
      if (isCleanupError(error)) return false;
      throw error;
    }
  }

  async deleteMessages(channelId: string, messageIds: string[]): Promise<string[]> {
    if (messageIds.length === 0) return [];
    // discord.js routes a single ID to a plain delete, but reports it back only
    // if the message happens to be cached. Do that case ourselves so the caller
    // always learns the delete succeeded.
    if (messageIds.length === 1) {
      return (await this.deleteMessage(channelId, messageIds[0])) ? messageIds : [];
    }
    const channel = await this.getChannel(channelId);
    const deleted = await channel.bulkDelete(messageIds, true).catch(() => null);
    return deleted ? [...deleted.keys()] : [];
  }

  async hasPinnedMessages(channelId: string): Promise<boolean> {
    const channel = await this.getChannel(channelId);
    const pinned = await channel.messages.fetchPinned();
    return pinned.size > 0;
  }

  async pinMessage(channelId: string, messageId: string): Promise<void> {
    const message = await this.fetchRaw(channelId, messageId);
    await message?.pin().catch(() => null);
  }

  async unpinMessage(channelId: string, messageId: string): Promise<void> {
    const message = await this.fetchRaw(channelId, messageId);
    await message?.unpin().catch(() => null);
  }

  // -- threads --------------------------------------------------------------

  async createThread(
    channelId: string,
    parentMessageId: string,
    name: string,
    reason: string,
  ): Promise<string> {
    const message = await this.fetchRaw(channelId, parentMessageId);
    if (!message) {
      throw new Error(`Parent message ${parentMessageId} is missing; cannot start a thread.`);
    }
    const thread = await message.startThread({
      name,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      reason,
    });
    return thread.id;
  }

  async fetchThread(_channelId: string, threadId: string): Promise<ThreadInfo | null> {
    const thread = await this.getThread(threadId);
    if (!thread) return null;
    return { id: thread.id, name: thread.name, archived: Boolean(thread.archived) };
  }

  async sendThreadMessage(
    _channelId: string,
    threadId: string,
    embed: Embed,
  ): Promise<string> {
    const thread = await this.getThread(threadId);
    if (!thread) {
      throw new Error(`Thread ${threadId} is missing.`);
    }
    const message = await thread.send({ embeds: [toDiscordEmbed(embed)] });
    return message.id;
  }

  async strikeThreadMessage(
    _channelId: string,
    threadId: string,
    messageId: string,
  ): Promise<void> {
    const thread = await this.getThread(threadId);
    if (!thread) return;
    const message = await thread.messages.fetch(messageId);
    if (message.embeds.length === 0) return;
    await message.edit({ embeds: [toDeletedEmbed(EmbedBuilder.from(message.embeds[0]))] });
  }

  async listThreadMessages(_channelId: string, threadId: string): Promise<PlatformMessage[]> {
    const thread = await this.getThread(threadId);
    if (!thread) return [];

    const collected: PlatformMessage[] = [];
    let before: string | undefined;

    while (true) {
      const batch = await thread.messages.fetch({ limit: 100, before });
      if (batch.size === 0) break;

      for (const message of batch.values()) {
        collected.push(toPlatformMessage(message));
      }

      if (batch.size < 100) break;
      before = batch.last()?.id;
    }

    return collected;
  }

  async deleteThreadMessages(
    _channelId: string,
    threadId: string,
    messageIds: string[],
  ): Promise<string[]> {
    if (messageIds.length === 0) return [];
    const thread = await this.getThread(threadId);
    if (!thread) return [];
    const deleted = await thread.bulkDelete(messageIds, true).catch(() => null);
    return deleted ? [...deleted.keys()] : [];
  }

  async threadMessageExists(
    _channelId: string,
    threadId: string,
    messageId: string,
  ): Promise<boolean> {
    const thread = await this.getThread(threadId);
    if (!thread) return false;
    try {
      await thread.messages.fetch(messageId);
      return true;
    } catch (error) {
      if (isCleanupError(error)) return false;
      throw error;
    }
  }

  async setThreadArchived(
    _channelId: string,
    threadId: string,
    archived: boolean,
    reason: string,
  ): Promise<void> {
    const thread = await this.getThread(threadId);
    if (!thread || thread.archived === archived) return;
    // Archive/unarchive failures are logged but non-fatal.
    await thread.setArchived(archived, reason).catch((error) => {
      console.error(`Failed to set thread ${threadId} archived=${archived}:`, error);
    });
  }

  async deleteThread(_channelId: string, threadId: string): Promise<void> {
    const thread = await this.getThread(threadId);
    await thread?.delete("Clean command requested").catch(() => null);
  }

  // -- commands -------------------------------------------------------------

  private buildCommands() {
    const built: Array<{ toJSON(): unknown }> = [];

    if (env.ENABLE_STATUS_COMMAND) {
      built.push(
        new SlashCommandBuilder()
          .setName("status")
          .setDescription("Get the current status for one configured status page.")
          .addStringOption((option) =>
            option
              .setName("target")
              .setDescription("Optional monitor id when more than one status page is configured.")
              .setRequired(false)
              .setAutocomplete(true),
          ),
      );
    }

    if (env.ENABLE_TEST_COMMAND) {
      built.push(
        new SlashCommandBuilder()
          .setName("testpost")
          .setDescription("Post a preview of the current status without marking anything as sent.")
          .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
          .addStringOption((option) =>
            option
              .setName("target")
              .setDescription("Optional monitor id when more than one status page is configured.")
              .setRequired(false)
              .setAutocomplete(true),
          ),
      );
    }

    if (env.ENABLE_REPLAY_COMMAND) {
      built.push(
        new SlashCommandBuilder()
          .setName("replay")
          .setDescription("Replay active incident timelines into their configured threads for testing.")
          .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
          .addStringOption((option) =>
            option
              .setName("target")
              .setDescription("Optional monitor id when more than one status page is configured.")
              .setRequired(false)
              .setAutocomplete(true),
          ),
      );
    }

    if (env.ENABLE_CLEAN_COMMAND) {
      built.push(
        new SlashCommandBuilder()
          .setName("clean")
          .setDescription("Delete recent bot-authored messages in the current channel.")
          .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
          .addStringOption((option) =>
            option
              .setName("target")
              .setDescription("Optional monitor id. Omit to clean all monitors in this channel.")
              .setRequired(false)
              .setAutocomplete(true),
          )
          .addIntegerOption((option) =>
            option
              .setName("limit")
              .setDescription("How many recent messages to inspect. Defaults to 100.")
              .setMinValue(1)
              .setMaxValue(100)
              .setRequired(false),
          ),
      );
    }

    if (env.ENABLE_CLEANUP_COMMAND) {
      built.push(
        new SlashCommandBuilder()
          .setName("cleanup")
          .setDescription("Find and ghost dangling incident threads no longer in the status page API.")
          .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
          .addStringOption((option) =>
            option
              .setName("target")
              .setDescription("Optional monitor id. Omit to clean all monitors.")
              .setRequired(false)
              .setAutocomplete(true),
          ),
      );
    }

    if (env.ENABLE_MONITOR_COMMAND) {
      built.push(
        new SlashCommandBuilder()
          .setName("monitor")
          .setDescription("Manage runtime status page monitors.")
          .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
          .addSubcommand((sub) =>
            sub
              .setName("add")
              .setDescription("Add a new status page monitor (Statuspage.io, incident.io, or Instatus).")
              .addStringOption((opt) =>
                opt
                  .setName("url")
                  .setDescription("Public status page URL (e.g. https://status.atlassian.com or https://status.openai.com)")
                  .setRequired(true),
              )
              .addChannelOption((opt) =>
                opt
                  .setName("channel")
                  .setDescription("Channel to post updates in. Defaults to the current channel.")
                  .addChannelTypes(ChannelType.GuildText)
                  .setRequired(false),
              )
              .addStringOption((opt) =>
                opt.setName("label").setDescription("Display name for the monitor.").setRequired(false),
              )
              .addStringOption((opt) =>
                opt
                  .setName("id")
                  .setDescription("Unique ID for the monitor. Auto-derived from page name if omitted.")
                  .setRequired(false),
              )
              .addStringOption((opt) =>
                opt
                  .setName("icon_url")
                  .setDescription("Custom icon URL for embeds. Overrides auto-detected favicon.")
                  .setRequired(false),
              ),
          )
          .addSubcommand((sub) =>
            sub
              .setName("remove")
              .setDescription("Remove a runtime monitor.")
              .addStringOption((opt) =>
                opt
                  .setName("id")
                  .setDescription("Monitor ID to remove.")
                  .setRequired(true)
                  .setAutocomplete(true),
              ),
          )
          .addSubcommand((sub) => sub.setName("list").setDescription("List all configured monitors.")),
      );
    }

    return built.map((command) => command.toJSON());
  }

  async registerCommands(): Promise<void> {
    const rest = new REST({ version: "10" }).setToken(this.token);
    const route = env.DISCORD_GUILD_ID
      ? Routes.applicationGuildCommands(this.applicationId, env.DISCORD_GUILD_ID)
      : Routes.applicationCommands(this.applicationId);

    await rest.put(route, { body: this.buildCommands() });
  }

  setPresence(activity: PresenceActivity): void {
    this.client.user?.setActivity(activity.text, {
      type: activity.kind === "watching" ? ActivityType.Watching : ActivityType.Playing,
    });
  }

  // -- dispatch -------------------------------------------------------------

  private toContext(interaction: ChatInputCommandInteraction): CommandContext {
    return {
      platform: this,
      channelId: interaction.channelId,
      userId: interaction.user.id,
      subcommand: interaction.options.getSubcommand(false) ?? undefined,
      getString: (name) => {
        // `/monitor add`'s channel option is a channel picker, not a string.
        if (name === "channel") {
          return interaction.options.getChannel("channel")?.id ?? undefined;
        }
        return interaction.options.getString(name) ?? undefined;
      },
      getInteger: (name) => interaction.options.getInteger(name) ?? undefined,
      reply: async (payload) => {
        await interaction.editReply({
          content: payload.content,
          embeds: payload.embeds?.map(toDiscordEmbed),
        });
      },
    };
  }

  private async handleAutocomplete(interaction: AutocompleteInteraction) {
    const focused = interaction.options.getFocused(true);

    if (interaction.commandName === "monitor" && focused.name === "id") {
      // Only runtime monitors can be removed, so only offer those.
      await interaction.respond(await core.runtimeMonitorChoices(focused.value));
      return;
    }

    if (focused.name === "target") {
      await interaction.respond(core.monitorChoices(focused.value));
    }
  }

  private async dispatch(interaction: ChatInputCommandInteraction) {
    // Every handler replies via editReply, so defer up front.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const context = this.toContext(interaction);

    switch (interaction.commandName) {
      case "status":
        return core.handleStatusCommand(context);
      case "replay":
        return core.handleReplayCommand(context);
      case "testpost":
        return core.handleTestPostCommand(context);
      case "clean":
        return core.handleCleanCommand(context);
      case "cleanup":
        return core.handleCleanupCommand(context);
      case "monitor":
        return core.handleMonitorCommand(context);
      default:
        return;
    }
  }

  async start(): Promise<void> {
    await this.registerCommands();

    this.client.on("interactionCreate", async (interaction) => {
      if (interaction.isAutocomplete()) {
        try {
          await this.handleAutocomplete(interaction);
        } catch (error) {
          console.error("Autocomplete handler failed.", error);
        }
        return;
      }

      if (!interaction.isChatInputCommand()) {
        return;
      }

      try {
        await this.dispatch(interaction);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unexpected error";
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral });
        } else {
          await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
        }
      }
    });

    const ready = new Promise<void>((resolve) => {
      this.client.once("clientReady", () => {
        console.log(`Logged in as ${this.client.user?.tag}`);
        resolve();
      });
    });

    await this.client.login(this.token);
    await ready;
  }
}
