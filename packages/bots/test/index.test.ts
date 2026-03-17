import { describe, expect, it } from "vitest";
import { calculateKellyFraction, runFlatBetBot, runKellyBot, runMartingaleBot } from "../src/index.js";

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

  it("keeps constant amount in flat bet strategy", async () => {
    const sequence = [{ won: true }, { won: false }, { won: true }];
    let idx = 0;
    const fakeClient = {
      createBet: async () => sequence[idx++],
    };

    const history = await runFlatBetBot(fakeClient as any, {
      amount: 2,
      target: 50,
      rounds: 3,
    });

    expect(history.map((h) => h.amount)).toEqual([2, 2, 2]);
  });

  it("calculates bounded Kelly fraction", () => {
    expect(calculateKellyFraction(0.55, 2)).toBeCloseTo(0.1, 5);
    expect(calculateKellyFraction(0.49, 2)).toBe(0);
  });

  it("adjusts stake using Kelly strategy and bankroll changes", async () => {
    const sequence = [{ won: true }, { won: false }, { won: false }];
    let idx = 0;
    const fakeClient = {
      createBet: async () => sequence[idx++],
    };

    const history = await runKellyBot(fakeClient as any, {
      bankroll: 100,
      minBet: 1,
      maxBet: 10,
      winProbability: 0.55,
      payoutMultiplier: 2,
      target: 50,
      rounds: 3,
    });

    expect(history.map((h) => h.amount)).toEqual([10, 10, 10]);
  });
});
