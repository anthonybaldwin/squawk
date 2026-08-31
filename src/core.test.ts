/**
 * End-to-end exercise of the incident lifecycle against an in-memory
 * ChatPlatform. This is the regression net for the platform split: the flow
 * asserted here (parent + thread + pin → update → resolve → ghost) is exactly
 * what the Discord bot did before the core became platform-neutral.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MonitorRegistry, type MonitorConfig } from "./config";
import { initCore, postLatestUpdatesForMonitor } from "./core";
import { discordFormat } from "./platform/discord";
import type {
  ChatPlatform,
  PlatformCapabilities,
  PlatformMessage,
  ThreadInfo,
} from "./platform/types";
import type { Embed } from "./render";
import { MISSING_INCIDENT_COLOR } from "./render";
import type { Incident } from "./providers/types";
import { defaultMonitorState, type BotState } from "./state";

const BOT_USER_ID = "bot-1";

type FakeMessage = {
  id: string;
  channelId: string;
  threadId?: string;
  embed: Embed;
  pinned: boolean;
  updateId?: string;
  createdAt: number;
};

class FakePlatform implements ChatPlatform {
  readonly id = "discord" as const;
  readonly displayName = "Fake";
  readonly format = discordFormat;
  readonly capabilities: PlatformCapabilities = {
    threadArchive: true,
    pinNotices: false,
    deletableThreads: true,
    presence: false,
    autocomplete: false,
  };

  messages = new Map<string, FakeMessage>();
  threads = new Map<string, { id: string; name: string; archived: boolean }>();
  private counter = 0;

  private nextId() {
    return `m${++this.counter}`;
  }

  channelMessages(channelId: string) {
    return [...this.messages.values()].filter(
      (message) => message.channelId === channelId && !message.threadId,
    );
  }

  threadMessages(threadId: string) {
    return [...this.messages.values()].filter((message) => message.threadId === threadId);
  }

  botUserId() {
    return BOT_USER_ID;
  }

  private toPlatformMessage(message: FakeMessage): PlatformMessage {
    return {
      id: message.id,
      authorId: BOT_USER_ID,
      authoredByBot: true,
      createdAt: message.createdAt,
      pinned: message.pinned,
      updateId: message.updateId,
      embedColor: message.embed.color,
    };
  }

  async assertChannel() {}
  async assertCanPost() {}

  async sendChannelMessage(channelId: string, embed: Embed) {
    const id = this.nextId();
    this.messages.set(id, { id, channelId, embed, pinned: false, createdAt: Date.now() });
    return id;
  }

  async fetchMessage(_channelId: string, messageId: string) {
    const message = this.messages.get(messageId);
    return message ? this.toPlatformMessage(message) : null;
  }

  async editMessage(_channelId: string, messageId: string, embed: Embed) {
    const message = this.messages.get(messageId);
    if (message) message.embed = embed;
  }

  async listChannelMessages(channelId: string, limit: number) {
    return this.channelMessages(channelId).slice(-limit).map((m) => this.toPlatformMessage(m));
  }

  async deleteMessage(_channelId: string, messageId: string) {
    return this.messages.delete(messageId);
  }

  async deleteMessages(_channelId: string, messageIds: string[]) {
    return messageIds.filter((id) => this.messages.delete(id));
  }

  async hasPinnedMessages(channelId: string) {
    return this.channelMessages(channelId).some((message) => message.pinned);
  }

  async pinMessage(_channelId: string, messageId: string) {
    const message = this.messages.get(messageId);
    if (message) message.pinned = true;
  }

  async unpinMessage(_channelId: string, messageId: string) {
    const message = this.messages.get(messageId);
    if (message) message.pinned = false;
  }

  async createThread(_channelId: string, parentMessageId: string, name: string) {
    const id = `t-${parentMessageId}`;
    this.threads.set(id, { id, name, archived: false });
    return id;
  }

  async fetchThread(_channelId: string, threadId: string): Promise<ThreadInfo | null> {
    return this.threads.get(threadId) ?? null;
  }

  async sendThreadMessage(
    channelId: string,
    threadId: string,
    embed: Embed,
    meta?: { updateId?: string },
  ) {
    const id = this.nextId();
    this.messages.set(id, {
      id,
      channelId,
      threadId,
      embed,
      pinned: false,
      updateId: meta?.updateId,
      createdAt: Date.now(),
    });
    return id;
  }

  async strikeThreadMessage(_channelId: string, _threadId: string, messageId: string) {
    const message = this.messages.get(messageId);
    if (message) {
      message.embed = { ...message.embed, color: MISSING_INCIDENT_COLOR };
    }
  }

  async listThreadMessages(_channelId: string, threadId: string) {
    return this.threadMessages(threadId).map((m) => this.toPlatformMessage(m));
  }

  async deleteThreadMessages(_channelId: string, _threadId: string, messageIds: string[]) {
    return messageIds.filter((id) => this.messages.delete(id));
  }

  async threadMessageExists(_channelId: string, _threadId: string, messageId: string) {
    return this.messages.has(messageId);
  }

  async setThreadArchived(_channelId: string, threadId: string, archived: boolean) {
    const thread = this.threads.get(threadId);
    if (thread) thread.archived = archived;
  }

  async deleteThread(_channelId: string, threadId: string) {
    this.threads.delete(threadId);
  }

  async registerCommands() {}
  setPresence() {}
  async start() {}
}

const monitor: MonitorConfig = {
  id: "example",
  channelId: "C1",
  baseUrl: "https://status.example.com",
  label: "Example",
};

function incident(overrides: Partial<Incident> = {}): Incident {
  return {
    id: "i1",
    name: "Elevated errors",
    status: "investigating",
    impact: "major",
    created_at: "2026-01-02T03:00:00.000Z",
    incident_updates: [
      {
        id: "u1",
        status: "investigating",
        body: "Looking into it.",
        created_at: "2026-01-02T03:01:00.000Z",
      },
    ],
    ...overrides,
  };
}

const realFetch = globalThis.fetch;

/** Serve the Statuspage incidents endpoint the provider polls. */
function serveIncidents(incidents: Incident[]) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/api/v2/incidents.json")) {
      return new Response(JSON.stringify({ page: {}, incidents }), {
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
}

let platform: FakePlatform;
let state: BotState;

beforeEach(() => {
  platform = new FakePlatform();
  initCore({ platform, registry: new MonitorRegistry([monitor]) });
  // Start from a monitor that has already been seeded, so the first poll posts
  // rather than taking the "seed silently on first run" branch.
  state = { monitors: { example: { ...defaultMonitorState(), postedUpdateIds: ["seed"] } } };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("first poll on a fresh monitor", () => {
  test("seeds resolved updates without posting", async () => {
    serveIncidents([incident({ resolved_at: "2026-01-02T04:00:00.000Z", status: "resolved" })]);
    const fresh: BotState = { monitors: {} };

    await postLatestUpdatesForMonitor(monitor, fresh);

    expect(platform.messages.size).toBe(0);
    expect(fresh.monitors.example.postedUpdateIds).toEqual(["u1"]);
  });
});

describe("a new incident", () => {
  beforeEach(async () => {
    serveIncidents([incident()]);
    await postLatestUpdatesForMonitor(monitor, state);
  });

  test("posts a pinned parent message in the channel", () => {
    const parents = platform.channelMessages("C1");
    expect(parents).toHaveLength(1);
    expect(parents[0].pinned).toBe(true);
    expect(parents[0].embed.title).toBe("Elevated errors");
  });

  test("opens a thread and posts the update into it", () => {
    const [thread] = [...platform.threads.values()];
    expect(thread.name).toBe("Elevated errors");
    const posts = platform.threadMessages(thread.id);
    expect(posts).toHaveLength(1);
    expect(posts[0].updateId).toBe("u1");
  });

  test("records the incident in state", () => {
    const tracked = state.monitors.example.incidents.i1;
    expect(tracked.postedUpdateIds).toEqual(["u1"]);
    expect(tracked.incidentName).toBe("Elevated errors");
    expect(state.monitors.example.openIncidentIds).toEqual(["i1"]);
  });

  test("does not repost the same update on the next poll", async () => {
    const before = platform.messages.size;
    await postLatestUpdatesForMonitor(monitor, state);
    expect(platform.messages.size).toBe(before);
  });
});

describe("a follow-up update", () => {
  test("posts to the existing thread and refreshes the parent", async () => {
    serveIncidents([incident()]);
    await postLatestUpdatesForMonitor(monitor, state);

    serveIncidents([
      incident({
        incident_updates: [
          ...incident().incident_updates,
          {
            id: "u2",
            status: "identified",
            body: "Cause identified.",
            created_at: "2026-01-02T03:30:00.000Z",
          },
        ],
      }),
    ]);
    await postLatestUpdatesForMonitor(monitor, state);

    const [thread] = [...platform.threads.values()];
    expect(platform.threadMessages(thread.id).map((m) => m.updateId)).toEqual(["u1", "u2"]);
    expect(platform.channelMessages("C1")[0].embed.description).toContain("Cause identified.");
  });
});

describe("a resolved incident", () => {
  test("unpins the parent and archives the thread", async () => {
    serveIncidents([incident()]);
    await postLatestUpdatesForMonitor(monitor, state);

    serveIncidents([
      incident({
        status: "resolved",
        resolved_at: "2026-01-02T04:00:00.000Z",
        incident_updates: [
          ...incident().incident_updates,
          {
            id: "u2",
            status: "resolved",
            body: "All clear.",
            created_at: "2026-01-02T04:00:00.000Z",
          },
        ],
      }),
    ]);
    await postLatestUpdatesForMonitor(monitor, state);

    expect(platform.channelMessages("C1")[0].pinned).toBe(false);
    expect([...platform.threads.values()][0].archived).toBe(true);
    expect(state.monitors.example.openIncidentIds).toEqual([]);
  });
});

describe("an incident that vanishes from the API", () => {
  test("ghosts the parent, strikes the updates, and archives the thread", async () => {
    serveIncidents([incident()]);
    await postLatestUpdatesForMonitor(monitor, state);
    const [thread] = [...platform.threads.values()];

    serveIncidents([]);
    await postLatestUpdatesForMonitor(monitor, state);

    const parent = platform.channelMessages("C1")[0];
    expect(parent.embed.color).toBe(MISSING_INCIDENT_COLOR);
    expect(parent.embed.title).toBe("~~Elevated errors~~");
    expect(parent.pinned).toBe(false);
    expect(platform.threadMessages(thread.id)[0].embed.color).toBe(MISSING_INCIDENT_COLOR);
    expect(platform.threads.get(thread.id)?.archived).toBe(true);
    expect(state.monitors.example.incidents.i1.resolvedAt).toBeDefined();
  });
});

describe("self-healing", () => {
  test("recreates the parent and thread after they are deleted out from under us", async () => {
    serveIncidents([incident()]);
    await postLatestUpdatesForMonitor(monitor, state);

    platform.messages.clear();
    platform.threads.clear();

    serveIncidents([
      incident({
        incident_updates: [
          ...incident().incident_updates,
          {
            id: "u2",
            status: "identified",
            body: "Cause identified.",
            created_at: "2026-01-02T03:30:00.000Z",
          },
        ],
      }),
    ]);
    await postLatestUpdatesForMonitor(monitor, state);

    expect(platform.channelMessages("C1")).toHaveLength(1);
    expect([...platform.threads.values()]).toHaveLength(1);
  });
});
