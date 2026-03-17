import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/index.js";

describe("api", () => {
  const apiKey = "test-key";
  const app = createApp({
    exposure: 0,
    apiKey,
    rateLimit: { windowMs: 10_000, maxRequests: 20 },
    rolls: [],
    risk: { bankroll: 1000, riskFactor: 0.05, maxExposure: 100, maxPayout: 200 },
  });

  it("returns health", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("rejects missing api key", async () => {
    const res = await request(app).get("/bankroll");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  it("creates a bet via v1 endpoint and returns json payload", async () => {
    const res = await request(app).post("/v1/bets").set("x-api-key", apiKey).send({
      serverSeed: "server",
      clientSeed: "client",
      nonce: 1,
      amount: 5,
      target: 60,
    });

    expect(res.status).toBe(201);
    expect(res.body.bet).toHaveProperty("roll");
    expect(res.body.bet).toHaveProperty("proof");
    expect(res.body).toHaveProperty("exposure");
  });

  it("returns rolls, bankroll and stats", async () => {
    const rolls = await request(app).get("/v1/rolls").set("x-api-key", apiKey);
    expect(rolls.status).toBe(200);
    expect(Array.isArray(rolls.body.rolls)).toBe(true);

    const bankroll = await request(app).get("/v1/bankroll").set("x-api-key", apiKey);
    expect(bankroll.status).toBe(200);
    expect(bankroll.body).toHaveProperty("bankroll");
    expect(bankroll.body).toHaveProperty("available");

    const stats = await request(app).get("/stats").set("x-api-key", apiKey);
    expect(stats.status).toBe(200);
    expect(stats.body.stats).toHaveProperty("totalBets");
    expect(stats.body.stats).toHaveProperty("winRate");
  });

  it("rate limits requests", async () => {
    const limitedApp = createApp({
      exposure: 0,
      apiKey,
      rolls: [],
      risk: { bankroll: 1000, riskFactor: 0.05, maxExposure: 100, maxPayout: 200 },
      rateLimit: { windowMs: 60_000, maxRequests: 1 },
    });

    const first = await request(limitedApp).get("/rolls").set("x-api-key", apiKey);
    expect(first.status).toBe(200);

    const second = await request(limitedApp).get("/rolls").set("x-api-key", apiKey);
    expect(second.status).toBe(429);
    expect(second.body.error).toBe("rate_limit_exceeded");
  });

  it("keeps legacy route aliases for compatibility", async () => {
    const bet = await request(app).post("/bet").set("x-api-key", apiKey).send({
      serverSeed: "legacy-server",
      clientSeed: "legacy-client",
      nonce: 2,
      amount: 5,
      target: 60,
    });
    expect(bet.status).toBe(201);

    const rolls = await request(app).get("/rolls").set("x-api-key", apiKey);
    expect(rolls.status).toBe(200);

    const bankroll = await request(app).get("/bankroll").set("x-api-key", apiKey);
    expect(bankroll.status).toBe(200);
  });

  it("rejects duplicate nonce for same server and client seed pair", async () => {
    const nonceApp = createApp({
      exposure: 0,
      apiKey,
      rolls: [],
      risk: { bankroll: 1000, riskFactor: 0.05, maxExposure: 100, maxPayout: 200 },
      rateLimit: { windowMs: 60_000, maxRequests: 10 },
    });

    const first = await request(nonceApp).post("/v1/bets").set("x-api-key", apiKey).send({
      serverSeed: "nonce-server",
      clientSeed: "nonce-client",
      nonce: 1,
      amount: 5,
      target: 60,
    });
    expect(first.status).toBe(201);

    const duplicate = await request(nonceApp).post("/v1/bets").set("x-api-key", apiKey).send({
      serverSeed: "nonce-server",
      clientSeed: "nonce-client",
      nonce: 1,
      amount: 5,
      target: 60,
    });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.error).toContain("nonce must strictly increase");
  });

  it("toggles emergency stop and blocks new bets", async () => {
    const stoppedApp = createApp({
      exposure: 0,
      apiKey,
      rolls: [],
      risk: { bankroll: 1000, riskFactor: 0.05, maxExposure: 100, maxPayout: 200, emergencyStop: false },
      rateLimit: { windowMs: 60_000, maxRequests: 20 },
    });

    const enable = await request(stoppedApp)
      .post("/v1/admin/emergency-stop")
      .set("x-api-key", apiKey)
      .send({ enabled: true });
    expect(enable.status).toBe(200);
    expect(enable.body.emergencyStop).toBe(true);

    const blockedBet = await request(stoppedApp).post("/v1/bets").set("x-api-key", apiKey).send({
      serverSeed: "stop-server",
      clientSeed: "stop-client",
      nonce: 1,
      amount: 5,
      target: 60,
    });
    expect(blockedBet.status).toBe(422);
    expect(blockedBet.body.error).toBe("emergency_stop");

    const bankroll = await request(stoppedApp).get("/v1/bankroll").set("x-api-key", apiKey);
    expect(bankroll.status).toBe(200);
    expect(bankroll.body.emergencyStop).toBe(true);
  });
});
