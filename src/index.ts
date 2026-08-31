/**
 * Entry point.
 *
 * Squawk drives one chat platform per deployment, chosen by `PLATFORM` (or
 * inferred from whichever bot token is configured). Everything past this file
 * is platform-neutral: `src/core.ts` owns the incident lifecycle and talks to
 * Discord or Slack only through `src/platform/types.ts`.
 */

import {
  env,
  loadMonitors,
  MonitorRegistry,
  readPackageVersion,
  readRuntimeMonitors,
  resolvePlatformId,
  type PlatformId,
} from "./config";
import { initCore, postLatestUpdates, startPresenceRotation } from "./core";
import { cacheMonitorIcons } from "./icons";
import { ensureStateFile } from "./state";
import type { ChatPlatform } from "./platform/types";

async function createPlatform(id: PlatformId): Promise<ChatPlatform> {
  if (id === "slack") {
    const { SlackPlatform } = await import("./platform/slack");
    return new SlackPlatform();
  }

  const { DiscordPlatform } = await import("./platform/discord");
  return new DiscordPlatform();
}

/**
 * Serialize an async task so it never runs concurrently with itself. While a
 * run is in flight, additional calls return that same in-flight promise
 * instead of starting a new run; once it settles, the next call starts fresh.
 *
 * The poll loop uses this because `postLatestUpdates` can outrun
 * `POLL_INTERVAL_MS` (slow/failing monitors retry with backoff, thread
 * creation is chatty). Without a guard, an overrunning cycle and the next
 * `setInterval` tick run concurrently, both see a brand-new incident with no
 * thread mapping, and each creates a parent message + thread — producing
 * duplicate threads (only one of which survives the last-writer-wins
 * `writeState`).
 */
export function singleFlight(task: () => Promise<void>): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  return () => {
    if (inFlight) return inFlight;
    inFlight = task().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

async function main() {
  const platformId = resolvePlatformId();
  const registry = new MonitorRegistry(loadMonitors(platformId));
  const appVersion = env.APP_VERSION ?? (await readPackageVersion());

  await ensureStateFile();
  registry.rebuild(await readRuntimeMonitors());

  const platform = await createPlatform(platformId);
  initCore({ platform, registry });

  await cacheMonitorIcons(registry.all);
  await platform.start();

  console.log(`Squawk v${appVersion} running on ${platform.displayName}.`);
  startPresenceRotation(appVersion);

  // Guard against re-entrancy: if a poll cycle outruns POLL_INTERVAL_MS, the
  // next tick coalesces into the in-flight run rather than racing it and
  // creating duplicate incident threads.
  const poll = singleFlight(() => postLatestUpdates());

  try {
    await poll();
  } catch (error) {
    console.error("Initial poll failed.", error);
  }

  setInterval(() => {
    void poll().catch((error) => {
      console.error("Polling failed.", error);
    });
  }, env.POLL_INTERVAL_MS);
}

// Only boot the bot when run directly (`bun src/index.ts`). Guarding on
// `import.meta.main` keeps the module importable from tests without connecting
// to a chat platform or starting the poll loop.
if (import.meta.main) {
  await main();
}
