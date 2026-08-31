import { describe, expect, test } from "bun:test";
import { resolvePlatformId, withoutBlankValues, type Env } from "./config";

describe("withoutBlankValues", () => {
  test("drops keys a .env file exports as empty placeholders", () => {
    expect(
      withoutBlankValues({ DISCORD_GUILD_ID: "", SLACK_COMMAND_NAME: "  ", PLATFORM: "slack" }),
    ).toEqual({ PLATFORM: "slack" });
  });

  test("keeps values that only look empty", () => {
    expect(withoutBlankValues({ POLL_INTERVAL_MS: "0" })).toEqual({ POLL_INTERVAL_MS: "0" });
  });
});

const base = { SLACK_COMMAND_NAME: "squawk" } as Env;

describe("resolvePlatformId", () => {
  test("honors an explicit PLATFORM", () => {
    expect(resolvePlatformId({ ...base, PLATFORM: "slack", DISCORD_TOKEN: "x" })).toBe("slack");
  });

  test("infers the platform from whichever bot token is set", () => {
    expect(resolvePlatformId({ ...base, DISCORD_TOKEN: "x" })).toBe("discord");
    expect(resolvePlatformId({ ...base, SLACK_BOT_TOKEN: "x" })).toBe("slack");
  });

  test("refuses to guess when both tokens are set", () => {
    expect(() => resolvePlatformId({ ...base, DISCORD_TOKEN: "x", SLACK_BOT_TOKEN: "y" })).toThrow(
      /one chat platform per deployment/,
    );
  });

  test("explains what to configure when neither is set", () => {
    expect(() => resolvePlatformId(base)).toThrow(/No chat platform configured/);
  });
});
