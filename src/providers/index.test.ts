import { test, expect, describe, afterEach } from "bun:test";
import { detectProvider, SUPPORTED_PROVIDERS } from "./index";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("detectProvider with Instatus", () => {
  test("auto-detects an Instatus page", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v3/summary.json")) {
        return new Response(
          JSON.stringify({ page: { name: "Kagi", url: "https://status.kagi.com", status: "UP" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const detected = await detectProvider("https://status.kagi.com");
    expect(detected?.provider.id).toBe("instatus");
    expect(detected?.summary.page.name).toBe("Kagi");
  });
});

describe("provider registry", () => {
  test("feed provider is registered and probed last", () => {
    const ids = SUPPORTED_PROVIDERS.map((p) => p.id);
    expect(ids).toContain("feed");
    expect(ids[ids.length - 1]).toBe("feed");
  });
});

describe("detectProvider feed fallback", () => {
  test("falls through to the feed provider for a direct Atom URL", async () => {
    const atom = `<?xml version="1.0" encoding="UTF-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <title>Example System Status</title>
        <link rel="alternate" type="text/html" href="https://status.example.com" />
        <entry>
          <id>https://status.example.com/incidents/1</id>
          <published>2026-06-05T00:00:00Z</published>
          <updated>2026-06-05T00:10:00Z</updated>
          <title>Something broke</title>
          <content type="html">&lt;p&gt;&lt;small&gt;Jun 5, 00:00 UTC&lt;/small&gt;&lt;br&gt;&lt;strong&gt;Investigating&lt;/strong&gt; - Looking into it.&lt;/p&gt;</content>
        </entry>
      </feed>`;

    // Every endpoint returns the Atom doc: the vendor providers fail to parse it
    // (not their JSON/widget shape) and the feed provider matches the URL itself.
    globalThis.fetch = (async (_input: string | URL | Request) =>
      new Response(atom, { status: 200, headers: { "content-type": "application/atom+xml" } })) as typeof fetch;

    const detected = await detectProvider("https://status.example.com/feed/atom");
    expect(detected?.provider.id).toBe("feed");
    expect(detected?.summary.page.name).toBe("Example System Status");
    expect(detected?.summary.page.url).toBe("https://status.example.com");
  });
});
