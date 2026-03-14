import { describe, expect, it } from "vitest";
import { runMartingaleBot } from "../src/index.js";

describe("bot", () => {
  it("doubles on loss and resets on win", async () => {
    const sequence = [{ won: false }, { won: false }, { won: true }];
    let idx = 0;

    const fakeClient = {
      createBet: async () => sequence[idx++],
    };

    const history = await runMartingaleBot(fakeClient as any, {
      startAmount: 1,
      target: 55,
      rounds: 3,
    });

    expect(history.map((h) => h.amount)).toEqual([1, 2, 4]);
  });
});
