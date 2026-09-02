/**
 * Incident lifecycle and command handlers.
 *
 * Everything here is platform-neutral: it talks to Discord or Slack only
 * through the {@link ChatPlatform} seam and renders through `src/render.ts`.
 * Function order follows the original single-file convention — callees above
 * callers.
 */

import {
  env,
  MonitorRegistry,
  readRuntimeMonitors,
  withMonitorLock,
  writeRuntimeMonitors,
  type MonitorConfig,
  type RuntimeMonitorEntry,
} from "./config";
import { fetchMonitorIcon, monitorIcons } from "./icons";
import { detectProvider, getProvider, SUPPORTED_PROVIDERS } from "./providers";
import type { Incident, IncidentUpdate, Summary } from "./providers/types";
import {
  RESOLVED_COLOR,
  renderMissingParentEmbed,
  renderMonitorAddedEmbed,
  renderMonitorListEmbed,
  renderParentEmbed,
  renderStatusEmbed,
  renderUpdateEmbed,
  truncate,
} from "./render";
import {
  getMonitorState,
  readState,
  writeState,
  type BotState,
  type IncidentState,
  type MonitorState,
} from "./state";
import type { ChatPlatform, CommandContext, PlatformMessage } from "./platform/types";

let platform: ChatPlatform;
let registry: MonitorRegistry;

export function initCore(options: { platform: ChatPlatform; registry: MonitorRegistry }) {
  platform = options.platform;
  registry = options.registry;
}

function fmt() {
  return platform.format;
}

function fetchSummary(monitor: MonitorConfig): Promise<Summary> {
  return getProvider(monitor).fetchSummary(monitor);
}

function fetchIncidents(monitor: MonitorConfig): Promise<Incident[]> {
  return getProvider(monitor).fetchIncidents(monitor);
}

function monitorIds() {
  return registry.all.map((monitor) => monitor.id).join(", ");
}

// ---------------------------------------------------------------------------
// Pin notices
// ---------------------------------------------------------------------------

// Discord auto-posts a "X pinned a message to this channel" system message
// whenever a message is pinned and offers no API flag to suppress emission. To
// keep the channel from piling up these notices across many incidents, we track
// the ID of the one we want visible in monitor state and delete the previous one
// directly on each new pin. Steady-state cost is one targeted delete + one tiny
// fetch (limit 5) to capture the new notice's ID. The first invocation after an
// upgrade (or fresh state) does a one-time historical sweep with a wider fetch
// so we don't carry forward old accumulated notices. Platforms that don't emit
// such notices (Slack) skip the whole routine.
async function trackAndPrunePinNotice(
  channelId: string,
  monitorState: MonitorState,
  pinnedMessageId: string,
) {
  if (!platform.capabilities.pinNotices) {
    return;
  }

  const botUserId = platform.botUserId();
  const matchesNewNotice = (message: PlatformMessage) =>
    Boolean(message.pinNotice) &&
    message.authorId === botUserId &&
    message.referencedMessageId === pinnedMessageId;

  try {
    if (monitorState.lastPinNoticeMessageId === undefined) {
      // Migration / first run: scan widely once, keep the just-emitted notice
      // for our pin, delete every other bot-authored pin notice in range.
      const recent = await platform.listChannelMessages(channelId, 100);
      const keeper = recent.find(matchesNewNotice);
      for (const message of recent) {
        if (message.pinNotice && message.authorId === botUserId && message.id !== keeper?.id) {
          await platform.deleteMessage(channelId, message.id);
        }
      }
      monitorState.lastPinNoticeMessageId = keeper?.id ?? "";
      return;
    }

    if (monitorState.lastPinNoticeMessageId) {
      await platform.deleteMessage(channelId, monitorState.lastPinNoticeMessageId);
    }
    const recent = await platform.listChannelMessages(channelId, 5);
    monitorState.lastPinNoticeMessageId = recent.find(matchesNewNotice)?.id ?? "";
  } catch {
    // Cosmetic; ignore — the pin itself already succeeded.
  }
}

// Companion to trackAndPrunePinNotice: when nothing remains pinned in the
// channel, the lingering pin notice has nothing left to point at, so drop it.
async function dropTrackedPinNoticeIfChannelEmpty(
  channelId: string,
  monitorState: MonitorState,
) {
  if (!platform.capabilities.pinNotices || !monitorState.lastPinNoticeMessageId) {
    return;
  }

  try {
    if (await platform.hasPinnedMessages(channelId)) {
      return;
    }
    await platform.deleteMessage(channelId, monitorState.lastPinNoticeMessageId);
    monitorState.lastPinNoticeMessageId = "";
  } catch {
    // Cosmetic; ignore — the unpin itself already succeeded.
  }
}

async function unpinAndPrune(
  channelId: string,
  monitorState: MonitorState,
  messageId: string,
) {
  await platform.unpinMessage(channelId, messageId);
  await dropTrackedPinNoticeIfChannelEmpty(channelId, monitorState);
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

async function setArchived(
  channelId: string,
  threadId: string,
  archived: boolean,
  reason: string,
) {
  if (!platform.capabilities.threadArchive) {
    return;
  }
  await platform.setThreadArchived(channelId, threadId, archived, reason);
}

async function ensureIncidentThread(
  channelId: string,
  monitorState: MonitorState,
  monitor: MonitorConfig,
  incident: Incident,
): Promise<{ parentMessageId: string; threadId: string; archived: boolean }> {
  const existing = monitorState.incidents[incident.id];

  if (existing && existing.threadId) {
    const [parentMessage, thread] = await Promise.all([
      platform.fetchMessage(channelId, existing.parentMessageId),
      platform.fetchThread(channelId, existing.threadId),
    ]);

    if (parentMessage && thread) {
      return {
        parentMessageId: parentMessage.id,
        threadId: thread.id,
        archived: thread.archived,
      };
    }

    // Self-heal after manual cleanup or deleted threads/messages.
    delete monitorState.incidents[incident.id];
  }

  // If we have a parentMessageId but no threadId, a previous attempt sent the
  // parent message but failed to create the thread. Reuse the orphaned parent.
  const orphaned = monitorState.incidents[incident.id];
  let parentMessageId: string | undefined;

  if (orphaned?.parentMessageId && !orphaned.threadId) {
    const recovered = await platform.fetchMessage(channelId, orphaned.parentMessageId);
    if (recovered) {
      parentMessageId = recovered.id;
    } else {
      delete monitorState.incidents[incident.id];
    }
  }

  parentMessageId ??= await platform.sendChannelMessage(
    channelId,
    renderParentEmbed(fmt(), monitor, incident),
  );

  // Persist the parent message ID immediately so it can be recovered on retry.
  monitorState.incidents[incident.id] = {
    parentMessageId,
    threadId: "",
    postedUpdateIds: [],
    updateMessageIds: {},
    resolvedAt: incident.resolved_at ?? undefined,
    incidentName: incident.name,
  };

  if (!incident.resolved_at) {
    await platform.pinMessage(channelId, parentMessageId);
    await trackAndPrunePinNotice(channelId, monitorState, parentMessageId);
  }

  const threadId = await platform.createThread(
    channelId,
    parentMessageId,
    truncate(incident.name, 100),
    `${getProvider(monitor).displayName} incident ${incident.id}`,
  );

  monitorState.incidents[incident.id].threadId = threadId;

  return { parentMessageId, threadId, archived: false };
}

async function syncIncidentParentMessage(
  channelId: string,
  monitorState: MonitorState,
  monitor: MonitorConfig,
  incident: Incident,
) {
  const mapping = monitorState.incidents[incident.id];
  if (!mapping) {
    return;
  }

  const message = await platform.fetchMessage(channelId, mapping.parentMessageId);
  if (!message) {
    delete monitorState.incidents[incident.id];
    return;
  }

  await platform.editMessage(
    channelId,
    mapping.parentMessageId,
    renderParentEmbed(fmt(), monitor, incident),
  );

  if (!incident.resolved_at && !message.pinned) {
    await platform.pinMessage(channelId, mapping.parentMessageId);
    await trackAndPrunePinNotice(channelId, monitorState, mapping.parentMessageId);
  } else if (incident.resolved_at && message.pinned) {
    await unpinAndPrune(channelId, monitorState, mapping.parentMessageId);
  }
}

async function hasLiveIncidentMessages(
  channelId: string,
  monitorState: MonitorState,
  incident: Incident,
) {
  const mapping = monitorState.incidents[incident.id];
  if (!mapping || !mapping.threadId) {
    return false;
  }

  const [parentMessage, thread] = await Promise.all([
    platform.fetchMessage(channelId, mapping.parentMessageId),
    platform.fetchThread(channelId, mapping.threadId),
  ]);

  if (!parentMessage || !thread) {
    delete monitorState.incidents[incident.id];
    return false;
  }

  const threadMessages = await platform.listThreadMessages(channelId, mapping.threadId);
  return threadMessages.length > 0;
}

async function getMissingIncidentUpdates(
  channelId: string,
  threadId: string,
  incidentState: IncidentState,
  updates: IncidentUpdate[],
) {
  const missing: IncidentUpdate[] = [];

  for (const update of updates) {
    const messageId = incidentState.updateMessageIds[update.id];
    if (!messageId) {
      missing.push(update);
      continue;
    }

    if (!(await platform.threadMessageExists(channelId, threadId, messageId))) {
      delete incidentState.updateMessageIds[update.id];
      incidentState.postedUpdateIds = incidentState.postedUpdateIds.filter(
        (postedId) => postedId !== update.id,
      );
      missing.push(update);
    }
  }

  return missing;
}

async function getPresentThreadUpdateIds(channelId: string, threadId: string) {
  const botUserId = platform.botUserId();
  const messages = await platform.listThreadMessages(channelId, threadId);
  const present = new Set<string>();

  for (const message of messages) {
    if (!message.authoredByBot || message.authorId !== botUserId) {
      continue;
    }
    if (message.updateId) {
      present.add(message.updateId);
    }
  }

  return present;
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

async function handleMissingIncidents(
  channelId: string,
  monitorState: MonitorState,
  monitor: MonitorConfig,
  apiIncidentIds: Set<string>,
  vanishedIncidentIds: Set<string>,
) {
  for (const [incidentId, incidentState] of Object.entries(monitorState.incidents)) {
    if (incidentState.resolvedAt) continue;
    if (apiIncidentIds.has(incidentId)) continue;
    // Only ghost incidents we explicitly know were open, or that are tracked but gone.
    if (!vanishedIncidentIds.has(incidentId)) continue;

    console.log(
      `Incident "${incidentId}" for monitor "${monitor.id}" is no longer in the API. Marking as removed.`,
    );

    try {
      const parentMessage = await platform.fetchMessage(channelId, incidentState.parentMessageId);
      if (!parentMessage) {
        delete monitorState.incidents[incidentId];
        continue;
      }

      // If the embed is already green (resolved), the incident was properly
      // resolved before it aged out of the API. Just update state and skip
      // ghosting.
      if (parentMessage.embedColor === RESOLVED_COLOR) {
        if (parentMessage.pinned) {
          await unpinAndPrune(channelId, monitorState, parentMessage.id);
        }
        incidentState.resolvedAt = new Date().toISOString();
        continue;
      }

      const thread = incidentState.threadId
        ? await platform.fetchThread(channelId, incidentState.threadId)
        : null;

      const incidentName = incidentState.incidentName ?? thread?.name ?? "Unknown Incident";
      await platform.editMessage(
        channelId,
        parentMessage.id,
        renderMissingParentEmbed(fmt(), monitor, incidentName),
      );

      await unpinAndPrune(channelId, monitorState, parentMessage.id);

      if (thread) {
        for (const messageId of Object.values(incidentState.updateMessageIds)) {
          try {
            await platform.strikeThreadMessage(channelId, thread.id, messageId);
          } catch {
            // Update message may have been deleted, skip.
          }
        }

        if (!thread.archived) {
          await setArchived(
            channelId,
            thread.id,
            true,
            "Incident no longer available on status page",
          );
        }
      }

      incidentState.resolvedAt = new Date().toISOString();
    } catch (error) {
      console.error(
        `Failed to handle missing incident "${incidentId}" for monitor "${monitor.id}":`,
        error,
      );
    }
  }
}

export async function postLatestUpdatesForMonitor(monitor: MonitorConfig, state: BotState) {
  const [incidents] = await Promise.all([
    fetchIncidents(monitor),
    platform.assertChannel(monitor.channelId),
  ]);
  const channelId = monitor.channelId;
  const monitorState = getMonitorState(state, monitor.id);

  const allUpdates = incidents
    .flatMap((incident) =>
      incident.incident_updates.map((update) => ({
        incident,
        update,
      })),
    )
    .sort(
      (left, right) =>
        new Date(left.update.created_at).getTime() - new Date(right.update.created_at).getTime(),
    );

  if (monitorState.postedUpdateIds.length === 0 && !env.POST_EXISTING_UPDATES_ON_START) {
    const resolvedUpdates = allUpdates.filter(({ incident }) => incident.resolved_at);
    monitorState.postedUpdateIds = resolvedUpdates.map(({ update }) => update.id).slice(-500);
    monitorState.openIncidentIds = incidents.filter((i) => !i.resolved_at).map((i) => i.id);
    monitorState.lastPostedAt = new Date().toISOString();
    console.log(
      `Seeded ${monitorState.postedUpdateIds.length} resolved incident updates without posting for "${monitor.id}".`,
    );
    return;
  }

  const unseen = allUpdates.filter(({ update }) => !monitorState.postedUpdateIds.includes(update.id));

  for (const { incident, update } of unseen) {
    // Isolate each update so a transient platform error (rate limit, 5xx, a
    // thread/parent that needs healing) doesn't abort the rest of this
    // monitor's pending updates and prevent the outer writeState.
    try {
      const { parentMessageId, threadId, archived } = await ensureIncidentThread(
        channelId,
        monitorState,
        monitor,
        incident,
      );
      const incidentState = monitorState.incidents[incident.id];
      incidentState.resolvedAt = incident.resolved_at ?? undefined;

      if (archived) {
        await setArchived(channelId, threadId, false, "New incident update received");
      }

      if (!incidentState.postedUpdateIds.includes(update.id)) {
        const messageId = await platform.sendThreadMessage(
          channelId,
          threadId,
          renderUpdateEmbed(fmt(), monitor, incident, update),
          { updateId: update.id, incidentId: incident.id },
        );
        incidentState.postedUpdateIds.push(update.id);
        incidentState.updateMessageIds[update.id] = messageId;
        incidentState.postedUpdateIds = incidentState.postedUpdateIds.slice(-500);
      }

      await syncIncidentParentMessage(channelId, monitorState, monitor, incident);

      if (incident.resolved_at) {
        await unpinAndPrune(channelId, monitorState, parentMessageId);
        await setArchived(channelId, threadId, true, "Incident resolved");
      }

      monitorState.postedUpdateIds.push(update.id);
      monitorState.lastPostedAt = new Date().toISOString();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `Failed to post update "${update.id}" for incident "${incident.id}" on monitor "${monitor.id}": ${message}`,
      );
    }
  }

  const apiIncidentIds = new Set(incidents.map((incident) => incident.id));

  // Reconcile the tracked open incident list against what the API reports.
  // Incidents the bot tracked as "open" but no longer in the API are candidates
  // for ghosting.
  const previouslyOpen = new Set(monitorState.openIncidentIds);
  const vanishedIncidentIds = new Set([...previouslyOpen].filter((id) => !apiIncidentIds.has(id)));

  // Also check for tracked incidents that disappeared (covers pre-openIncidentIds state).
  for (const id of Object.keys(monitorState.incidents)) {
    if (!monitorState.incidents[id].resolvedAt && !apiIncidentIds.has(id)) {
      vanishedIncidentIds.add(id);
    }
  }

  await handleMissingIncidents(
    channelId,
    monitorState,
    monitor,
    apiIncidentIds,
    vanishedIncidentIds,
  );

  // Update the canonical open incident list from the API.
  monitorState.openIncidentIds = incidents.filter((i) => !i.resolved_at).map((i) => i.id);
  monitorState.postedUpdateIds = monitorState.postedUpdateIds.slice(-500);
}

export async function postLatestUpdates() {
  const state = await readState();
  // Isolate each monitor so a transient failure (platform 5xx, a misconfigured
  // channel, etc.) doesn't abort the loop and skip writeState. Without this, a
  // successful post for one monitor followed by a failure on the next would
  // lose the in-memory dedup advance for the first — the next poll would
  // re-post the same update IDs.
  for (const monitor of registry.all) {
    try {
      await postLatestUpdatesForMonitor(monitor, state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`postLatestUpdatesForMonitor("${monitor.id}") failed: ${message}`);
    }
  }
  await writeState(state);
}

// ---------------------------------------------------------------------------
// Command helpers
// ---------------------------------------------------------------------------

export function resolveMonitors(context: CommandContext): MonitorConfig[] {
  const requested = context.getString("target");

  if (requested) {
    const match = registry.find(requested);
    if (!match) {
      throw new Error(`Unknown target "${requested}". Configured targets: ${monitorIds()}`);
    }
    return [match];
  }

  if (registry.all.length === 1) {
    return [registry.all[0]];
  }

  const channelMatches = registry.all.filter(
    (monitor) => monitor.channelId === context.channelId,
  );
  if (channelMatches.length > 0) {
    return channelMatches;
  }

  throw new Error(`Multiple monitors are configured. Pass a target: ${monitorIds()}`);
}

async function assertMonitorChannelAccess(
  context: CommandContext,
  monitor: MonitorConfig,
  state: BotState,
) {
  if (context.channelId === monitor.channelId) {
    return;
  }

  const monitorState = getMonitorState(state, monitor.id);
  const allowedThreadIds = new Set(
    Object.values(monitorState.incidents).map((incident) => incident.threadId),
  );

  if (context.channelId && allowedThreadIds.has(context.channelId)) {
    return;
  }

  throw new Error(
    `This command can only be used in ${fmt().channel(monitor.channelId)} or its incident threads.`,
  );
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export async function handleStatusCommand(context: CommandContext) {
  if (!env.ENABLE_STATUS_COMMAND) {
    throw new Error("`status` is disabled.");
  }

  const targets = resolveMonitors(context);
  const state = await readState();
  await assertMonitorChannelAccess(context, targets[0], state);
  const embeds = await Promise.all(
    targets.map(async (monitor) => renderStatusEmbed(fmt(), monitor, await fetchSummary(monitor))),
  );
  await context.reply({ embeds });
}

export async function handleTestPostCommand(context: CommandContext) {
  if (!env.ENABLE_TEST_COMMAND) {
    throw new Error("`testpost` is disabled.");
  }

  const targets = resolveMonitors(context);
  const state = await readState();
  await assertMonitorChannelAccess(context, targets[0], state);

  const channelIds = new Set<string>();
  for (const monitor of targets) {
    const summary = await fetchSummary(monitor);
    await platform.assertChannel(monitor.channelId);
    await platform.sendChannelMessage(
      monitor.channelId,
      renderStatusEmbed(fmt(), monitor, summary, "Test"),
    );
    channelIds.add(monitor.channelId);
  }

  const channelMentions = [...channelIds].map((id) => fmt().channel(id)).join(", ");
  await context.reply({
    content: `Posted ${targets.length} status preview${targets.length === 1 ? "" : "s"} into ${channelMentions}.`,
  });
}

async function getReplayTargets(monitor: MonitorConfig) {
  const [summary, incidents] = await Promise.all([fetchSummary(monitor), fetchIncidents(monitor)]);
  const incidentById = new Map(incidents.map((incident) => [incident.id, incident]));

  const activeIncidents = summary.incidents
    .map((summaryIncident) => incidentById.get(summaryIncident.id) ?? summaryIncident)
    .map((incident) => ({
      incident,
      updates: [...incident.incident_updates].sort(
        (left, right) => new Date(left.created_at).getTime() - new Date(right.created_at).getTime(),
      ),
    }))
    .filter((candidate) => candidate.updates.length > 0)
    .sort(
      (left, right) =>
        new Date(left.incident.created_at).getTime() -
        new Date(right.incident.created_at).getTime(),
    );

  if (activeIncidents.length === 0) {
    throw new Error("No active incidents to replay.");
  }

  return activeIncidents;
}

async function replayIncidentTimeline(
  channelId: string,
  monitorState: MonitorState,
  monitor: MonitorConfig,
  incident: Incident,
  updates: IncidentUpdate[],
) {
  const { threadId, archived } = await ensureIncidentThread(
    channelId,
    monitorState,
    monitor,
    incident,
  );
  await syncIncidentParentMessage(channelId, monitorState, monitor, incident);
  const incidentState = monitorState.incidents[incident.id];
  if (!incidentState) {
    throw new Error(`Incident state for ${incident.id} was not initialized.`);
  }
  incidentState.resolvedAt = incident.resolved_at ?? undefined;

  if (archived) {
    await setArchived(channelId, threadId, false, "Replay requested");
  }

  for (const update of updates) {
    const messageId = await platform.sendThreadMessage(
      channelId,
      threadId,
      renderUpdateEmbed(fmt(), monitor, incident, update),
      { updateId: update.id, incidentId: incident.id },
    );
    if (!incidentState.postedUpdateIds.includes(update.id)) {
      incidentState.postedUpdateIds.push(update.id);
    }
    incidentState.updateMessageIds[update.id] = messageId;
  }

  incidentState.postedUpdateIds = incidentState.postedUpdateIds.slice(-500);
  if (incident.resolved_at) {
    await setArchived(channelId, threadId, true, "Incident resolved");
  }
}

function getReplaySummaryText(
  replayTargets: Array<{ incident: Incident; updates: IncidentUpdate[] }>,
) {
  const replayedCount = replayTargets.reduce((total, target) => total + target.updates.length, 0);
  const incidentNames = replayTargets.map((target) => fmt().inlineCode(target.incident.name));

  if (replayTargets.length === 1) {
    return `Replayed ${replayedCount} update${replayedCount === 1 ? "" : "s"} for ${incidentNames[0]}.`;
  }

  return `Replayed ${replayedCount} updates across ${replayTargets.length} incidents: ${incidentNames.join(", ")}.`;
}

function getReplaySkippedText(skippedIncidents: Incident[]) {
  if (skippedIncidents.length === 0) {
    return "";
  }

  const incidentNames = skippedIncidents
    .map((incident) => fmt().inlineCode(incident.name))
    .join(", ");
  return `Skipped incidents that already have live thread messages: ${incidentNames}.`;
}

export async function handleReplayCommand(context: CommandContext) {
  if (!env.ENABLE_REPLAY_COMMAND) {
    throw new Error("`replay` is disabled.");
  }

  const targets = resolveMonitors(context);
  const state = await readState();
  await assertMonitorChannelAccess(context, targets[0], state);

  const replayedTargets: Array<{ incident: Incident; updates: IncidentUpdate[] }> = [];
  const skippedIncidents: Incident[] = [];

  for (const monitor of targets) {
    const [replayTargets] = await Promise.all([
      getReplayTargets(monitor),
      platform.assertChannel(monitor.channelId),
    ]);
    const channelId = monitor.channelId;
    const monitorState = getMonitorState(state, monitor.id);

    for (const { incident, updates } of replayTargets) {
      const existing = monitorState.incidents[incident.id];
      const thread = existing?.threadId
        ? await platform.fetchThread(channelId, existing.threadId)
        : null;
      let missingUpdates = updates;

      if (existing && thread) {
        const missingFromTrackedState = await getMissingIncidentUpdates(
          channelId,
          thread.id,
          existing,
          updates,
        );
        const presentThreadUpdateIds = await getPresentThreadUpdateIds(channelId, thread.id);
        const missingIds = new Set([
          ...missingFromTrackedState.map((update) => update.id),
          ...updates.filter((update) => !presentThreadUpdateIds.has(update.id)).map((u) => u.id),
        ]);
        missingUpdates = updates.filter((update) => missingIds.has(update.id));
      }

      if (
        missingUpdates.length === 0 &&
        (await hasLiveIncidentMessages(channelId, monitorState, incident))
      ) {
        skippedIncidents.push(incident);
        continue;
      }

      await replayIncidentTimeline(channelId, monitorState, monitor, incident, missingUpdates);
      replayedTargets.push({ incident, updates: missingUpdates });
    }
  }

  await writeState(state);

  if (replayedTargets.length === 0) {
    await context.reply({
      content: getReplaySkippedText(skippedIncidents) || "Nothing to replay.",
    });
    return;
  }

  const replayText = getReplaySummaryText(replayedTargets);
  const skippedText = getReplaySkippedText(skippedIncidents);
  await context.reply({
    content: skippedText ? `${replayText}\n${skippedText}` : replayText,
  });
}

export async function handleCleanupCommand(context: CommandContext) {
  if (!env.ENABLE_CLEANUP_COMMAND) {
    throw new Error("`cleanup` is disabled.");
  }

  const state = await readState();
  const requested = context.getString("target");
  const targetsToClean: MonitorConfig[] = [];
  if (requested) {
    const match = registry.find(requested);
    if (!match) throw new Error(`Unknown target "${requested}".`);
    targetsToClean.push(match);
  } else {
    targetsToClean.push(...registry.all);
  }

  let totalGhosted = 0;

  for (const monitor of targetsToClean) {
    const [incidents] = await Promise.all([
      fetchIncidents(monitor),
      platform.assertChannel(monitor.channelId),
    ]);
    const monitorState = getMonitorState(state, monitor.id);
    const apiIncidentIds = new Set(incidents.map((incident) => incident.id));

    const vanishedIncidentIds = new Set<string>();
    for (const [id, incidentState] of Object.entries(monitorState.incidents)) {
      if (!incidentState.resolvedAt && !apiIncidentIds.has(id)) {
        vanishedIncidentIds.add(id);
      }
    }

    const before = Object.values(monitorState.incidents).filter((i) => !i.resolvedAt).length;
    await handleMissingIncidents(
      monitor.channelId,
      monitorState,
      monitor,
      apiIncidentIds,
      vanishedIncidentIds,
    );
    const after = Object.values(monitorState.incidents).filter((i) => !i.resolvedAt).length;
    totalGhosted += before - after;

    monitorState.openIncidentIds = incidents.filter((i) => !i.resolved_at).map((i) => i.id);
  }

  await writeState(state);

  const label =
    targetsToClean.length === 1 ? targetsToClean[0].id : `${targetsToClean.length} monitors`;
  await context.reply({
    content:
      totalGhosted === 0
        ? `No dangling incidents found for ${label}.`
        : `Ghosted ${totalGhosted} dangling incident${totalGhosted === 1 ? "" : "s"} for ${label}.`,
  });
}

export async function handleCleanCommand(context: CommandContext) {
  if (!env.ENABLE_CLEAN_COMMAND) {
    throw new Error("`clean` is disabled.");
  }

  const state = await readState();
  const channelId = context.channelId;
  const requested = context.getString("target");

  // `clean` bulk-deletes the invoking channel's history, so it must be run in a
  // monitor's own channel — never in an incident thread.
  if (!registry.all.some((monitor) => monitor.channelId === channelId)) {
    throw new Error("`clean` can only be used in a configured monitor channel.");
  }

  let channelMonitors: MonitorConfig[];
  if (requested) {
    const match = registry.find(requested);
    if (!match) {
      throw new Error(`Unknown target "${requested}". Configured targets: ${monitorIds()}`);
    }
    channelMonitors = [match];
  } else {
    channelMonitors = registry.all.filter((monitor) => monitor.channelId === channelId);
    if (channelMonitors.length === 0) {
      throw new Error("`clean` can only be used in a configured monitor channel.");
    }
  }

  await assertMonitorChannelAccess(context, channelMonitors[0], state);

  const limit = context.getInteger("limit") ?? 100;
  const botUserId = platform.botUserId();
  const messages = await platform.listChannelMessages(channelId, limit);

  // When targeting a specific monitor, only delete its tracked parent messages.
  // When cleaning all monitors in a channel, delete all bot messages.
  const trackedParentIds = requested
    ? new Set(
        channelMonitors.flatMap((monitor) =>
          Object.values(getMonitorState(state, monitor.id).incidents).map(
            (incident) => incident.parentMessageId,
          ),
        ),
      )
    : undefined;

  const maxAge = platform.capabilities.maxMessageDeleteAgeMs;
  const deletableMessages = messages.filter((message) => {
    if (!message.authoredByBot || message.authorId !== botUserId) {
      return false;
    }

    if (trackedParentIds && !trackedParentIds.has(message.id)) {
      return false;
    }

    return maxAge === undefined || Date.now() - message.createdAt < maxAge;
  });

  let deletedThreadMessageCount = 0;
  for (const channelMonitor of channelMonitors) {
    const monitorState = getMonitorState(state, channelMonitor.id);
    for (const [incidentId, mapping] of Object.entries(monitorState.incidents)) {
      const thread = mapping.threadId
        ? await platform.fetchThread(channelId, mapping.threadId)
        : null;
      if (!thread) {
        delete monitorState.incidents[incidentId];
        continue;
      }

      const threadMessages = await platform.listThreadMessages(channelId, thread.id);
      const threadBotMessageIds = threadMessages
        .filter((message) => message.authoredByBot && message.authorId === botUserId)
        .map((message) => message.id);

      if (threadBotMessageIds.length > 0) {
        const deleted = await platform.deleteThreadMessages(
          channelId,
          thread.id,
          threadBotMessageIds,
        );
        deletedThreadMessageCount += deleted.length;
      }

      await platform.deleteThread(channelId, thread.id);
      // Only strip update IDs for unresolved incidents so they re-post and
      // get new threads. Resolved ones stay "seen" to prevent flooding.
      if (!mapping.resolvedAt) {
        monitorState.postedUpdateIds = monitorState.postedUpdateIds.filter(
          (updateId) => !mapping.postedUpdateIds.includes(updateId),
        );
      }
      delete monitorState.incidents[incidentId];
    }
  }

  if (deletableMessages.length === 0) {
    await writeState(state);
    await context.reply({
      content:
        deletedThreadMessageCount > 0
          ? `Deleted ${deletedThreadMessageCount} bot-authored thread message${deletedThreadMessageCount === 1 ? "" : "s"} and removed incident threads for ${fmt().channel(channelId)}.`
          : `No recent bot-authored messages found in ${fmt().channel(channelId)}.`,
    });
    return;
  }

  const deleted = new Set(
    await platform.deleteMessages(
      channelId,
      deletableMessages.map((message) => message.id),
    ),
  );

  for (const channelMonitor of channelMonitors) {
    const monitorState = getMonitorState(state, channelMonitor.id);
    for (const [incidentId, mapping] of Object.entries(monitorState.incidents)) {
      if (deleted.has(mapping.parentMessageId)) {
        // Only strip update IDs for unresolved incidents so they re-post and
        // get new threads. Resolved ones stay "seen" to prevent flooding.
        if (!mapping.resolvedAt) {
          monitorState.postedUpdateIds = monitorState.postedUpdateIds.filter(
            (updateId) => !mapping.postedUpdateIds.includes(updateId),
          );
        }
        delete monitorState.incidents[incidentId];
      }
    }
  }
  await writeState(state);

  await context.reply({
    content: `Deleted ${deleted.size} bot-authored channel message${deleted.size === 1 ? "" : "s"} and ${deletedThreadMessageCount} bot-authored thread message${deletedThreadMessageCount === 1 ? "" : "s"} in ${fmt().channel(channelId)}.`,
  });
}

function deriveMonitorId(pageName: string): string {
  return pageName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
}

export async function handleMonitorAdd(context: CommandContext) {
  const rawUrl = context.getString("url");
  if (!rawUrl) {
    throw new Error("A status page `url` is required.");
  }
  const baseUrl = rawUrl.replace(/\/+$/, "");
  const channelId = context.getString("channel") ?? context.channelId;

  if (!channelId) {
    throw new Error("Could not determine a target channel.");
  }

  // Probe each supported provider in order; the first one to recognize the URL wins.
  const detected = await detectProvider(baseUrl);
  if (!detected) {
    const supported = SUPPORTED_PROVIDERS.map((provider) => provider.displayName).join(", ");
    throw new Error(
      `Could not reach a supported status page at ${fmt().inlineCode(baseUrl)}. Supported providers: ${supported}. Example URLs: ${fmt().inlineCode("https://status.atlassian.com")} (Statuspage), ${fmt().inlineCode("https://status.openai.com")} (incident.io).`,
    );
  }
  const { provider, summary } = detected;

  await platform.assertCanPost(channelId);

  const label = context.getString("label");
  const iconUrl = context.getString("icon_url");
  const providedId = context.getString("id");
  const monitorId = providedId ?? deriveMonitorId(summary.page.name);

  if (!monitorId) {
    throw new Error("Could not derive a monitor ID. Please provide one with the `id` option.");
  }

  // Collision check.
  if (registry.find(monitorId)) {
    const source = registry.isEnvMonitor(monitorId) ? " (configured via environment)" : "";
    throw new Error(
      `A monitor with ID ${fmt().inlineCode(monitorId)} already exists${source}.`,
    );
  }

  // Duplicate URL check — same status page should only be tracked once.
  const existingUrl = registry.all.find(
    (monitor) => monitor.baseUrl.replace(/\/+$/, "") === baseUrl,
  );
  if (existingUrl) {
    throw new Error(
      `A monitor for ${fmt().inlineCode(baseUrl)} already exists (${fmt().inlineCode(existingUrl.id)} in ${fmt().channel(existingUrl.channelId)}).`,
    );
  }

  const entry: RuntimeMonitorEntry = {
    id: monitorId,
    channelId,
    baseUrl,
    label,
    iconUrl,
    provider: provider.id,
    addedBy: context.userId,
    addedAt: new Date().toISOString(),
  };

  await withMonitorLock(async () => {
    const existing = await readRuntimeMonitors();
    existing.push(entry);
    await writeRuntimeMonitors(existing);
    registry.rebuild(existing);
  });

  // Cache icon for the new monitor.
  const icon = await fetchMonitorIcon(entry);
  if (icon) {
    monitorIcons.set(monitorId, icon);
  }

  // Re-register commands so autocomplete picks up the new monitor.
  await platform.registerCommands();

  // Trigger immediate first poll.
  try {
    const state = await readState();
    await postLatestUpdatesForMonitor(entry, state);
    await writeState(state);
  } catch (error) {
    console.error(`First poll for new monitor "${monitorId}" failed.`, error);
  }

  await context.reply({ embeds: [renderMonitorAddedEmbed(fmt(), entry, summary)] });
}

export async function handleMonitorRemove(context: CommandContext) {
  const monitorId = context.getString("id");
  if (!monitorId) {
    throw new Error("A monitor `id` is required.");
  }

  if (registry.isEnvMonitor(monitorId)) {
    throw new Error(
      `Monitor ${fmt().inlineCode(monitorId)} is configured via environment variables. Remove it from your config instead.`,
    );
  }

  let removedChannelId: string | undefined;

  await withMonitorLock(async () => {
    const existing = await readRuntimeMonitors();
    const index = existing.findIndex((entry) => entry.id === monitorId);
    if (index === -1) {
      throw new Error(`No runtime monitor with ID ${fmt().inlineCode(monitorId)} found.`);
    }
    removedChannelId = existing[index].channelId;
    existing.splice(index, 1);
    await writeRuntimeMonitors(existing);
    registry.rebuild(existing);
  });

  monitorIcons.delete(monitorId);
  await platform.registerCommands();

  const channelHint = removedChannelId
    ? ` Use ${fmt().inlineCode("clean")} in ${fmt().channel(removedChannelId)} to remove them.`
    : "";
  await context.reply({
    content: `Removed monitor ${fmt().inlineCode(monitorId)}. Existing threads preserved.${channelHint}`,
  });
}

export async function handleMonitorList(context: CommandContext) {
  if (registry.all.length === 0) {
    await context.reply({
      content: `No monitors configured. Use ${fmt().inlineCode("monitor add")} or set ${fmt().inlineCode("MONITORS_JSON")}.`,
    });
    return;
  }

  const runtimeEntries = await readRuntimeMonitors();
  const runtimeMeta = new Map(
    runtimeEntries.map((entry) => [entry.id, { addedBy: entry.addedBy, addedAt: entry.addedAt }]),
  );

  await context.reply({
    embeds: [
      renderMonitorListEmbed(
        fmt(),
        registry.all,
        (id) => registry.isEnvMonitor(id),
        runtimeMeta,
      ),
    ],
  });
}

export async function handleMonitorCommand(context: CommandContext) {
  if (!env.ENABLE_MONITOR_COMMAND) {
    throw new Error("`monitor` is disabled.");
  }

  switch (context.subcommand) {
    case "add":
      return handleMonitorAdd(context);
    case "remove":
      return handleMonitorRemove(context);
    case "list":
      return handleMonitorList(context);
    default:
      throw new Error("Unknown `monitor` subcommand. Use `add`, `remove`, or `list`.");
  }
}

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

export function startPresenceRotation(appVersion: string) {
  if (!platform.capabilities.presence) {
    return;
  }

  const startedAt = Date.now();
  let rotationIndex = 0;

  function updatePresence() {
    void readState()
      .then((state) => {
        let totalIncidents = 0;
        for (const monitorId of Object.keys(state.monitors)) {
          totalIncidents += state.monitors[monitorId].openIncidentIds.length;
        }

        const uptimeMs = Date.now() - startedAt;
        const uptimeDays = Math.floor(uptimeMs / 86_400_000);
        const uptimeHours = Math.floor((uptimeMs % 86_400_000) / 3_600_000);
        const uptimeMinutes = Math.floor((uptimeMs % 3_600_000) / 60_000);
        const uptimeStr =
          uptimeDays > 0
            ? `${uptimeDays}d ${uptimeHours}h`
            : uptimeHours > 0
              ? `${uptimeHours}h ${uptimeMinutes}m`
              : `${uptimeMinutes}m`;

        const monitorCount = registry.all.length;
        const activities = [
          {
            text: `${monitorCount || "No"} status page${monitorCount === 1 ? "" : "s"}`,
            kind: "watching" as const,
          },
          {
            text: `${totalIncidents || "No"} active incident${totalIncidents === 1 ? "" : "s"}`,
            kind: "watching" as const,
          },
          { text: `v${appVersion} (Uptime: ${uptimeStr})`, kind: "playing" as const },
        ];

        platform.setPresence(activities[rotationIndex % activities.length]);
        rotationIndex++;
      })
      .catch((error) => {
        console.error("Presence update failed.", error);
      });
  }

  updatePresence();
  setInterval(updatePresence, 15_000);
}

/** Monitor IDs and labels, for command autocomplete. */
export function monitorChoices(query: string) {
  const needle = query.toLowerCase();
  return registry.all
    .filter(
      (monitor) =>
        monitor.id.toLowerCase().includes(needle) ||
        (monitor.label?.toLowerCase().includes(needle) ?? false),
    )
    .slice(0, 25)
    .map((monitor) => ({
      name: monitor.label ? `${monitor.id} (${monitor.label})` : monitor.id,
      value: monitor.id,
    }));
}

/** Runtime-only monitor IDs, for `monitor remove` autocomplete. */
export async function runtimeMonitorChoices(query: string) {
  const needle = query.toLowerCase();
  const runtimeEntries = await readRuntimeMonitors();
  return runtimeEntries
    .filter(
      (entry) =>
        entry.id.toLowerCase().includes(needle) ||
        (entry.label?.toLowerCase().includes(needle) ?? false),
    )
    .slice(0, 25)
    .map((entry) => ({
      name: entry.label ? `${entry.id} (${entry.label})` : entry.id,
      value: entry.id,
    }));
}
