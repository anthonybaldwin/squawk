import { test, expect, describe } from "bun:test";
import { decodeEntities, plainText, parseFeedTimestamp } from "./feed-text";

describe("decodeEntities", () => {
  test("decodes the entities that appear in status feeds", () => {
    expect(decodeEntities("a &amp; b")).toBe("a & b");
    expect(decodeEntities("&lt;p&gt;hi&lt;/p&gt;")).toBe("<p>hi</p>");
    expect(decodeEntities("&quot;x&quot; &apos;y&apos;")).toBe('"x" \'y\'');
    expect(decodeEntities("it&#39;s")).toBe("it's");
  });
});

describe("plainText", () => {
  test("strips tags, decodes entities, collapses whitespace", () => {
    expect(plainText("<p>hello   <strong>world</strong></p>")).toBe("hello world");
    expect(plainText("a &amp;amp; b")).toBe("a &amp; b");
  });
  test("trims a single duplicate trailing period", () => {
    expect(plainText("Done..")).toBe("Done.");
  });
});

describe("parseFeedTimestamp", () => {
  const base = "2026-06-05T00:00:00Z";

  test("parses Statuspage 'Mon D, HH:MM TZ' form with date", () => {
    const r = parseFeedTimestamp("Jun 5, 17:25 UTC", base);
    expect(r).not.toBeNull();
    expect(r!.hasDate).toBe(true);
    expect(r!.iso).toBe("2026-06-05T17:25:00.000Z");
  });

  test("parses Statuspage form with seconds", () => {
    const r = parseFeedTimestamp("Jun 5, 01:40:38", base);
    expect(r!.iso).toBe("2026-06-05T01:40:38.000Z");
  });

  test("parses Slack time-only 'H:MMpm TZ' anchored to base date, hasDate=false", () => {
    const r = parseFeedTimestamp("3:23pm PST", base);
    expect(r).not.toBeNull();
    expect(r!.hasDate).toBe(false);
    expect(r!.iso).toBe("2026-06-05T15:23:00.000Z");
  });

  test("handles 12am/12pm correctly", () => {
    expect(parseFeedTimestamp("12:00am PST", base)!.iso).toBe("2026-06-05T00:00:00.000Z");
    expect(parseFeedTimestamp("12:30pm PST", base)!.iso).toBe("2026-06-05T12:30:00.000Z");
  });

  test("returns null when nothing parses", () => {
    expect(parseFeedTimestamp("no time here", base)).toBeNull();
  });
});
