import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/index.js";

describe("api", () => {
  const app = createApp({
    exposure: 0,
    risk: { bankroll: 1000, maxExposure: 100, riskFactor: 0.02 },
  });

  it("returns health", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("creates a bet", async () => {
    const res = await request(app).post("/v1/bets").send({
      serverSeed: "server",
      clientSeed: "client",
      nonce: 1,
      amount: 5,
      target: 60,
    });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("roll");
    expect(res.body).toHaveProperty("proof");
    expect(res.body).toHaveProperty("risk");
  });

  it("rejects bets over the dynamic max bet", async () => {
    const res = await request(app).post("/v1/bets").send({
      serverSeed: "server",
      clientSeed: "client",
      nonce: 2,
      amount: 100,
      target: 60,
    });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("max_bet_exceeded");
  });
});
