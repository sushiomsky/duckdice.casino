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
});
