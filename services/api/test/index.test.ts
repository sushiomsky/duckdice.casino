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

  it("creates a bet and returns json payload", async () => {
    const res = await request(app).post("/bet").set("x-api-key", apiKey).send({
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
    const rolls = await request(app).get("/rolls").set("x-api-key", apiKey);
    expect(rolls.status).toBe(200);
    expect(Array.isArray(rolls.body.rolls)).toBe(true);

    const bankroll = await request(app).get("/bankroll").set("x-api-key", apiKey);
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
});
