import { test, expect, describe, afterEach } from "bun:test";
import { detectProvider } from "./index";

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
