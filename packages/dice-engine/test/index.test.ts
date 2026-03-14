import { describe, expect, it } from "vitest";
import { rollDice, settleBet } from "../src/index.js";

describe("dice engine", () => {
  it("is deterministic", () => {
    const a = rollDice({ serverSeed: "s1", clientSeed: "c1", nonce: 1 });
    const b = rollDice({ serverSeed: "s1", clientSeed: "c1", nonce: 1 });
    expect(a).toEqual(b);
  });

  it("settles wins and losses", () => {
    const win = settleBet({ serverSeed: "A", clientSeed: "B", nonce: 2, amount: 10, target: 99 });
    expect(win.won).toBe(true);
    expect(win.payout).toBeGreaterThan(0);

    const lose = settleBet({ serverSeed: "A", clientSeed: "B", nonce: 2, amount: 10, target: 1 });
    expect(lose.won).toBe(false);
    expect(lose.payout).toBe(0);
  });
});
