/**
 * Environment parsing, monitor configuration, and runtime monitor persistence.
 *
 * Everything here is chat-platform agnostic. `channelId` on a monitor is
 * interpreted by whichever platform adapter is active for this deployment —
 * a Discord snowflake when `PLATFORM=discord`, a Slack channel ID (`C…`) when
 * `PLATFORM=slack`. Squawk runs exactly one platform per process.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";

export type PlatformId = "discord" | "slack";

const booleanFromEnv = z
  .string()
  .trim()
  .toLowerCase()
  .transform((value, context) => {
    if (["true", "1", "yes", "on"].includes(value)) {
      return true;
    }

    if (["false", "0", "no", "off"].includes(value)) {
      return false;
    }

    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Expected a boolean-like value, received "${value}"`,
    });
    return z.NEVER;
  });

export const monitorSchema = z.object({
  id: z.string().min(1),
  channelId: z.string().min(1),
  baseUrl: z.string().url(),
  label: z.string().min(1).optional(),
  iconUrl: z.string().url().optional(),
  provider: z.enum(["statuspage", "incidentio", "instatus"]).optional(),
});

export type MonitorConfig = z.infer<typeof monitorSchema>;

export type RuntimeMonitorEntry = MonitorConfig & {
  addedBy: string;
  addedAt: string;
};

type RuntimeMonitorFile = {
  monitors: RuntimeMonitorEntry[];
};

const envSchema = z.object({
  // Which chat platform this deployment drives. Optional — inferred from the
  // credentials that are present when omitted.
  PLATFORM: z.enum(["discord", "slack"]).optional(),

  DISCORD_TOKEN: z.string().min(1).optional(),
  DISCORD_APPLICATION_ID: z.string().min(1).optional(),
  DISCORD_GUILD_ID: z.string().min(1).optional(),
  DISCORD_CHANNEL_ID: z.string().min(1).optional(),

  SLACK_BOT_TOKEN: z.string().min(1).optional(),
  SLACK_APP_TOKEN: z.string().min(1).optional(),
  SLACK_CHANNEL_ID: z.string().min(1).optional(),
  // Slack has no per-command permission model comparable to Discord's
  // "Manage Server" default. When set, only these user IDs may run the
  // destructive commands (testpost, replay, clean, cleanup, monitor).
  SLACK_ADMIN_USER_IDS: z.string().optional(),
  // Slack registers commands in the app manifest rather than over an API, and
  // command names are unique per workspace. Squawk therefore exposes a single
  // command with subcommands (`/squawk status`, `/squawk monitor add`, …) whose
  // name can be changed to avoid collisions with other installed apps.
  SLACK_COMMAND_NAME: z
    .string()
    .min(1)
    .default("squawk")
    .transform((value) => value.replace(/^\//, "")),

  STATUSPAGE_BASE_URL: z.string().url().optional(),
  // MONITORS_JSON is the canonical multi-monitor config (covers both
  // Statuspage.io and incident.io). STATUSPAGE_MONITORS_JSON is the
  // pre-rename alias — still honored, with a deprecation warning at
  // startup. Either may be set; if both are set, MONITORS_JSON wins.
  MONITORS_JSON: z.string().optional(),
  STATUSPAGE_MONITORS_JSON: z.string().optional(),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  POST_EXISTING_UPDATES_ON_START: booleanFromEnv.default(false),
  ENABLE_REPLAY_COMMAND: booleanFromEnv.default(true),
  ENABLE_CLEAN_COMMAND: booleanFromEnv.default(true),
  ENABLE_STATUS_COMMAND: booleanFromEnv.default(true),
  ENABLE_TEST_COMMAND: booleanFromEnv.default(true),
  ENABLE_MONITOR_COMMAND: booleanFromEnv.default(true),
  ENABLE_CLEANUP_COMMAND: booleanFromEnv.default(true),
  APP_VERSION: z.string().min(1).optional(),
});

export type Env = z.infer<typeof envSchema>;

export const env: Env = envSchema.parse(process.env);

/**
 * Decide which platform adapter to boot. An explicit `PLATFORM` always wins;
 * otherwise the presence of a bot token picks the platform. Configuring both
 * is an error rather than a silent preference — one process drives one
 * platform, and guessing would post incidents somewhere unexpected.
 */
export function resolvePlatformId(source: Env = env): PlatformId {
  const hasDiscord = Boolean(source.DISCORD_TOKEN);
  const hasSlack = Boolean(source.SLACK_BOT_TOKEN);

  if (source.PLATFORM) {
    return source.PLATFORM;
  }

  if (hasDiscord && hasSlack) {
    throw new Error(
      "Both DISCORD_TOKEN and SLACK_BOT_TOKEN are set. Squawk runs one chat platform per deployment — set PLATFORM=discord or PLATFORM=slack to pick one.",
    );
  }

  if (hasDiscord) return "discord";
  if (hasSlack) return "slack";

  throw new Error(
    "No chat platform configured. Set DISCORD_TOKEN + DISCORD_APPLICATION_ID for Discord, or SLACK_BOT_TOKEN + SLACK_APP_TOKEN for Slack.",
  );
}

/** Channel env var used by the legacy single-monitor config, per platform. */
function legacyChannelId(platform: PlatformId, source: Env): string | undefined {
  return platform === "discord" ? source.DISCORD_CHANNEL_ID : source.SLACK_CHANNEL_ID;
}

export function loadMonitors(platform: PlatformId, source: Env = env): MonitorConfig[] {
  const rawMonitors = source.MONITORS_JSON ?? source.STATUSPAGE_MONITORS_JSON;
  if (rawMonitors) {
    if (!source.MONITORS_JSON && source.STATUSPAGE_MONITORS_JSON) {
      console.warn(
        "STATUSPAGE_MONITORS_JSON is deprecated; rename to MONITORS_JSON. " +
          "The legacy name still works but will be removed in a future release.",
      );
    }
    const parsed = JSON.parse(rawMonitors) as unknown;
    return z.array(monitorSchema).parse(parsed);
  }

  const channelId = legacyChannelId(platform, source);
  if (channelId && source.STATUSPAGE_BASE_URL) {
    return [
      {
        id: "default",
        channelId,
        baseUrl: source.STATUSPAGE_BASE_URL,
      },
    ];
  }

  const channelVar = platform === "discord" ? "DISCORD_CHANNEL_ID" : "SLACK_CHANNEL_ID";
  throw new Error(
    `Configure either MONITORS_JSON or both ${channelVar} and STATUSPAGE_BASE_URL.`,
  );
}

export const runtimeMonitorsPath = resolve("data", "monitors.json");

export async function readRuntimeMonitors(): Promise<RuntimeMonitorEntry[]> {
  try {
    const raw = await readFile(runtimeMonitorsPath, "utf8");
    const parsed = JSON.parse(raw) as RuntimeMonitorFile;
    return parsed.monitors ?? [];
  } catch {
    return [];
  }
}

export async function writeRuntimeMonitors(entries: RuntimeMonitorEntry[]) {
  await mkdir(dirname(runtimeMonitorsPath), { recursive: true });
  const data: RuntimeMonitorFile = { monitors: entries };
  await writeFile(runtimeMonitorsPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

// Simple promise-chain lock for read-modify-write safety on monitors.json.
let monitorLockChain = Promise.resolve();

export function withMonitorLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = monitorLockChain.then(fn, fn);
  monitorLockChain = next.then(
    () => {},
    () => {},
  );
  return next;
}

/**
 * The live monitor list. Env-configured monitors always win over runtime ones
 * so that a `/monitor add` can never shadow a deployment's declared config.
 */
export class MonitorRegistry {
  readonly envMonitors: MonitorConfig[];
  readonly envMonitorIds: Set<string>;
  private current: MonitorConfig[];

  constructor(envMonitors: MonitorConfig[]) {
    this.envMonitors = envMonitors;
    this.envMonitorIds = new Set(envMonitors.map((monitor) => monitor.id));
    this.current = [...envMonitors];
  }

  get all(): MonitorConfig[] {
    return this.current;
  }

  find(id: string): MonitorConfig | undefined {
    return this.current.find((monitor) => monitor.id === id);
  }

  isEnvMonitor(id: string): boolean {
    return this.envMonitorIds.has(id);
  }

  rebuild(runtime: RuntimeMonitorEntry[]) {
    const merged: MonitorConfig[] = [...this.envMonitors];
    for (const entry of runtime) {
      if (!this.envMonitorIds.has(entry.id)) {
        merged.push(entry);
      }
    }
    this.current = merged;
  }
}

export async function readPackageVersion(): Promise<string> {
  const raw = await readFile(resolve("package.json"), "utf8");
  return (JSON.parse(raw) as { version: string }).version;
}
