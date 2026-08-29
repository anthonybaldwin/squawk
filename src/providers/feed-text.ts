/**
 * Pure XML-text utilities shared by feed-consuming providers (instatus, feed).
 * No network, no DOM — just string and timestamp normalization.
 */

/** Decode the handful of XML/HTML entities that appear in status feeds. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Strip all tags and collapse whitespace; trim a single duplicate trailing period. */
export function plainText(html: string): string {
  const text = decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  // Some feeds append a period to bodies that already end in one, yielding "..".
  return text.replace(/\.\.$/, ".");
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Parse a feed update `<small>` timestamp into an ISO string, using `baseIso`
 * (the entry's published/updated time) to fill missing components.
 *
 *  - Statuspage form: "Jun 5, 17:25 UTC" / "Jun 5, 01:40:38" — month+day, no year.
 *  - Slack form:      "3:23pm PST" — time-of-day only, no date.
 *
 * Timezone abbreviations are ignored (clock time is treated as UTC); within a
 * single feed this keeps ordering and display consistent. `hasDate` is false for
 * time-only tokens so the caller can apply day-rollover across an ordered run.
 */
export function parseFeedTimestamp(token: string, baseIso: string): { iso: string; hasDate: boolean } | null {
  const base = new Date(baseIso);
  const baseValid = !Number.isNaN(base.getTime());
  const year = baseValid ? base.getUTCFullYear() : 1970;

  // Statuspage: "Mon D, HH:MM[:SS]"
  const md = token.match(/([A-Za-z]{3})\s+(\d{1,2})\s*,\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (md) {
    const month = MONTHS[md[1].toLowerCase()];
    if (month !== undefined) {
      const iso = new Date(Date.UTC(
        year, month, Number(md[2]), Number(md[3]), Number(md[4]), Number(md[5] ?? 0),
      )).toISOString();
      return { iso, hasDate: true };
    }
  }

  // Slack: "H:MM[am|pm]" time-only, anchored to the base date.
  const t = token.match(/(\d{1,2}):(\d{2})\s*([ap]m)?/i);
  if (t) {
    let hour = Number(t[1]);
    const min = Number(t[2]);
    const ampm = t[3]?.toLowerCase();
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    const d = baseValid ? base : new Date(Date.UTC(1970, 0, 1));
    const iso = new Date(Date.UTC(
      d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, min, 0,
    )).toISOString();
    return { iso, hasDate: false };
  }

  return null;
}
