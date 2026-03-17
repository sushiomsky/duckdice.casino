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

export interface BankrollResponse {
  bankroll: number;
  exposure: number;
  available: number;
  maxExposure?: number;
  maxPayout?: number;
  emergencyStop?: boolean;
}

export interface RollHistoryResponse {
  rolls: Array<{
    id: number;
    timestamp: string;
    amount: number;
    chance: number;
    rollOver: boolean;
    target: number;
    roll: number;
    won: boolean;
    payout: number;
    proof: string;
  }>;
}

export class DuckDiceClient {
  constructor(
    private readonly baseUrl: string,
    private readonly options: DuckDiceClientOptions = {},
  ) {}

  private authHeaders(contentType = false): Record<string, string> {
    const headers: Record<string, string> = {};
    if (contentType) {
      headers["content-type"] = "application/json";
    }
    if (this.options.apiKey) {
      headers["x-api-key"] = this.options.apiKey;
    }
    return headers;
  }

  async health() {
    const res = await fetch(`${this.baseUrl}/health`);
    if (!res.ok) throw new Error(`health failed: ${res.status}`);
    return res.json();
  }

  async createBet(request: BetRequest) {
    const res = await fetch(`${this.baseUrl}/v1/bets`, {
      method: "POST",
      headers: this.authHeaders(true),
      body: JSON.stringify(request),
    });

    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error ?? `bet failed: ${res.status}`);
    return payload;
  }

  async getBankroll(): Promise<BankrollResponse> {
    const res = await fetch(`${this.baseUrl}/v1/bankroll`, {
      headers: this.authHeaders(),
    });

    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error ?? `bankroll failed: ${res.status}`);
    return payload;
  }

  async getRollHistory(): Promise<RollHistoryResponse> {
    const res = await fetch(`${this.baseUrl}/v1/rolls`, {
      headers: this.authHeaders(),
    });

    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error ?? `roll history failed: ${res.status}`);
    return payload;
  }
}
