import { describe, expect, it } from "vitest";
import { NonceTracker, ServerSeedRotator, hashServerSeed, rollDice, settleBet } from "../src/index.js";

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

  it("tracks nonce sequence per server/client seed pair", () => {
    const tracker = new NonceTracker();
    tracker.track("server-A", "client-A", 1);
    tracker.track("server-A", "client-A", 2);
    expect(tracker.getLatest("server-A", "client-A")).toBe(2);

    tracker.track("server-B", "client-A", 1);
    expect(tracker.getLatest("server-B", "client-A")).toBe(1);
  });

  it("rejects duplicate or decreasing nonce for same seed pair", () => {
    const tracker = new NonceTracker();
    tracker.track("server-A", "client-A", 3);

    expect(() => tracker.track("server-A", "client-A", 3)).toThrow("nonce must strictly increase");
    expect(() => tracker.track("server-A", "client-A", 2)).toThrow("nonce must strictly increase");
  });

  it("rotates server seed and exposes deterministic commitment hashes", () => {
    const rotator = new ServerSeedRotator("seed-1", "seed-2");
    expect(rotator.getCommitment()).toEqual({
      currentSeedHash: hashServerSeed("seed-1"),
      nextSeedHash: hashServerSeed("seed-2"),
      rotations: 0,
    });

    const rotation = rotator.rotate("seed-3");
    expect(rotation).toEqual({
      revealedServerSeed: "seed-1",
      currentSeedHash: hashServerSeed("seed-2"),
      nextSeedHash: hashServerSeed("seed-3"),
      rotations: 1,
    });
    expect(rotator.getCurrentSeed()).toBe("seed-2");
  });
});
