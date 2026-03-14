export class DuckDiceClient {
  constructor({ baseUrl = "http://localhost:4000" } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async createBet(payload) {
    const response = await fetch(`${this.baseUrl}/v1/bets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error || "request failed");
      error.data = data;
      throw error;
    }

    return data;
  }

  async releaseExposure(amount) {
    const response = await fetch(`${this.baseUrl}/v1/exposure/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount })
    });

    return response.json();
  }
}
