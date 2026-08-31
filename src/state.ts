/**
 * Persistent bot state (`data/state.json`).
 *
 * Message and thread IDs stored here are opaque platform handles: Discord
 * snowflakes on a Discord deployment, Slack `ts` values and channel IDs on a
 * Slack one. A single state file therefore belongs to a single platform.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type IncidentState = {
  parentMessageId: string;
  threadId: string;
  postedUpdateIds: string[];
  updateMessageIds: Record<string, string>;
  resolvedAt?: string;
  /**
   * Incident name captured when the thread was created. Used to label ghosted
   * incidents once they have vanished from the status page API. Older state
   * predates this field; Discord falls back to the thread name, which Slack
   * threads do not have.
   */
  incidentName?: string;
};

export type MonitorState = {
  postedUpdateIds: string[];
  lastPostedAt?: string;
  /** Running set of incident IDs the bot considers "open". Used to reliably detect ghost closures. */
  openIncidentIds: string[];
  /**
   * ID of the bot-authored "X pinned a message to this channel" system notice
   * we currently keep visible (Discord emits one per pin and offers no API to
   * suppress). Empty string = tracked but no notice currently visible.
   * `undefined` = never initialized; next pin will run a one-time sweep of
   * historical notices in the channel before switching to ID tracking.
   */
  lastPinNoticeMessageId?: string;
  incidents: Record<string, IncidentState>;
};

export type BotState = {
  monitors: Record<string, MonitorState>;
};

export const statePath = resolve("data", "state.json");

export const defaultMonitorState = (): MonitorState => ({
  postedUpdateIds: [],
  openIncidentIds: [],
  incidents: {},
});

const defaultState: BotState = {
  monitors: {},
};

export function getMonitorState(state: BotState, monitorId: string): MonitorState {
  if (!state.monitors[monitorId]) {
    state.monitors[monitorId] = defaultMonitorState();
  }

  const monitorState = state.monitors[monitorId];
  monitorState.openIncidentIds ??= [];

  for (const incidentState of Object.values(monitorState.incidents)) {
    incidentState.postedUpdateIds ??= [];
    incidentState.updateMessageIds ??= {};
  }

  return monitorState;
}

export async function ensureStateFile() {
  await mkdir(dirname(statePath), { recursive: true });

  try {
    await readFile(statePath, "utf8");
  } catch {
    await writeState(defaultState);
  }
}

export async function readState(): Promise<BotState> {
  await ensureStateFile();
  const raw = await readFile(statePath, "utf8");
  const parsed = JSON.parse(raw) as Partial<BotState>;
  if (parsed.monitors) {
    const normalized: BotState = {
      monitors: parsed.monitors,
    };

    for (const monitorId of Object.keys(normalized.monitors)) {
      getMonitorState(normalized, monitorId);
    }

    return normalized;
  }

  // Migrate legacy single-monitor state into the default monitor bucket.
  const legacyMonitor = defaultMonitorState();
  legacyMonitor.postedUpdateIds = (parsed as Partial<MonitorState>).postedUpdateIds ?? [];
  legacyMonitor.openIncidentIds = (parsed as Partial<MonitorState>).openIncidentIds ?? [];
  legacyMonitor.lastPostedAt = (parsed as Partial<MonitorState>).lastPostedAt;
  legacyMonitor.incidents = (parsed as Partial<MonitorState>).incidents ?? {};

  return {
    monitors: {
      default: legacyMonitor,
    },
  };
}

export async function writeState(state: BotState) {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
