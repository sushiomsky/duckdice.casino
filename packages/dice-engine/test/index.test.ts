import { describe, expect, it } from "vitest";
import { rollDice, settleBet } from "../src/index.js";

describe("dice engine", () => {
  it("produces deterministic HMAC_SHA256 rolls", () => {
    const result = rollDice({ serverSeed: "server-seed-1", clientSeed: "client-seed-1", nonce: 42 });

    expect(result).toEqual({
      proof: "e642c80c46e438195511288766b90085e507c84a8d50320dafed843ea6630813",
      roll: 44.97,
    });
  });

  it("settles roll-under bets", () => {
    const win = settleBet({
      serverSeed: "A",
      clientSeed: "B",
      nonce: 2,
      amount: 10,
      chance: 10,
      rollOver: false,
    });

    expect(win.roll).toBe(9.08);
    expect(win.won).toBe(true);
    expect(win.payout).toBe(99);
  });

  it("settles roll-over bets", () => {
    const lose = settleBet({
      serverSeed: "A",
      clientSeed: "B",
      nonce: 2,
      amount: 10,
      chance: 10,
      rollOver: true,
    });

    expect(lose.roll).toBe(9.08);
    expect(lose.won).toBe(false);
    expect(lose.payout).toBe(0);
  });
});
