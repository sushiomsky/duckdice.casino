export interface BetRequest {
  serverSeed: string;
  clientSeed: string;
  nonce: number;
  amount: number;
  target: number;
}

export class DuckDiceClient {
  constructor(private readonly baseUrl: string) {}

  async health() {
    const res = await fetch(`${this.baseUrl}/health`);
    if (!res.ok) throw new Error(`health failed: ${res.status}`);
    return res.json();
  }

  async createBet(request: BetRequest) {
    const res = await fetch(`${this.baseUrl}/v1/bets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });

    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error ?? `bet failed: ${res.status}`);
    return payload;
  }
}
