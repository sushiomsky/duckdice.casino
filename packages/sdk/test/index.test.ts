import { describe, expect, it, vi } from "vitest";
import { DuckDiceClient } from "../src/index.js";

describe("sdk", () => {
  it("calls health endpoint", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: "ok" }) });
    vi.stubGlobal("fetch", mockFetch);

    const client = new DuckDiceClient("http://api");
    const out = await client.health();
    expect(out.status).toBe("ok");
  });

  it("calls v1 bets endpoint with optional api key", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ bet: { won: true } }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new DuckDiceClient("http://api", { apiKey: "test-key" });
    const payload = await client.createBet({
      serverSeed: "server",
      clientSeed: "client",
      nonce: 1,
      amount: 2,
      target: 60,
    });

    expect(payload.bet.won).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith("http://api/v1/bets", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "test-key",
      },
      body: JSON.stringify({
        serverSeed: "server",
        clientSeed: "client",
        nonce: 1,
        amount: 2,
        target: 60,
      }),
    });
  });

  it("calls v1 bankroll endpoint with auth header", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ bankroll: 1000, exposure: 100, available: 900 }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new DuckDiceClient("http://api", { apiKey: "test-key" });
    const bankroll = await client.getBankroll();
    expect(bankroll.available).toBe(900);

    expect(mockFetch).toHaveBeenCalledWith("http://api/v1/bankroll", {
      headers: { "x-api-key": "test-key" },
    });
  });

  it("calls v1 rolls endpoint with auth header", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ rolls: [{ id: 1, won: true }] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new DuckDiceClient("http://api", { apiKey: "test-key" });
    const history = await client.getRollHistory();
    expect(history.rolls).toHaveLength(1);

    expect(mockFetch).toHaveBeenCalledWith("http://api/v1/rolls", {
      headers: { "x-api-key": "test-key" },
    });
  });
});
