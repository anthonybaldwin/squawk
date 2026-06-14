import { test, expect, describe, beforeEach } from "bun:test";

// index.ts parses env and reads monitors at import time. Provide the minimum
// required config so importing the module (with main() guarded by
// `import.meta.main`) is side-effect-free.
process.env.DISCORD_TOKEN ??= "test-token";
process.env.DISCORD_APPLICATION_ID ??= "test-app";
process.env.MONITORS_JSON ??= "[]";

const { singleFlight } = await import("./index");

describe("singleFlight", () => {
  let runs: number;
  let gate: Promise<void>;
  let release: () => void;

  function newGate() {
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  }

  beforeEach(() => {
    runs = 0;
    newGate();
  });

  test("does not start a second run while one is in flight", async () => {
    const guarded = singleFlight(async () => {
      runs += 1;
      await gate;
    });

    const first = guarded();
    const second = guarded(); // fires before the first settles

    // The whole point: a poll cycle that outruns POLL_INTERVAL_MS must never
    // run concurrently with the next tick, or both create duplicate threads.
    expect(runs).toBe(1);

    release();
    await Promise.all([first, second]);
    expect(runs).toBe(1);
  });

  test("runs again once the previous run has settled", async () => {
    const guarded = singleFlight(async () => {
      runs += 1;
      await gate;
    });

    const first = guarded();
    expect(runs).toBe(1);
    release();
    await first;

    newGate();
    const second = guarded();
    expect(runs).toBe(2);
    release();
    await second;
    expect(runs).toBe(2);
  });

  test("re-arms after the task rejects", async () => {
    let shouldThrow = true;
    const guarded = singleFlight(async () => {
      runs += 1;
      if (shouldThrow) {
        throw new Error("boom");
      }
    });

    await expect(guarded()).rejects.toThrow("boom");

    shouldThrow = false;
    await guarded(); // a failed run must not wedge the guard permanently
    expect(runs).toBe(2);
  });
});
