export interface BetRequest {
  serverSeed: string;
  clientSeed: string;
  nonce: number;
  amount: number;
  target?: number;
  chance?: number;
  rollOver?: boolean;
  houseEdgeBps?: number;
}

export interface DuckDiceClientOptions {
  apiKey?: string;
}

export class DuckDiceClient {
  constructor(
    private readonly baseUrl: string,
    private readonly options: DuckDiceClientOptions = {},
  ) {}

  async health() {
    const res = await fetch(`${this.baseUrl}/health`);
    if (!res.ok) throw new Error(`health failed: ${res.status}`);
    return res.json();
  }

  async createBet(request: BetRequest) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.options.apiKey) {
      headers["x-api-key"] = this.options.apiKey;
    }

    const res = await fetch(`${this.baseUrl}/v1/bets`, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    });

    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error ?? `bet failed: ${res.status}`);
    return payload;
  }
}
