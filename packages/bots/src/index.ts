export interface BetClient {
  createBet(input: {
    serverSeed: string;
    clientSeed: string;
    nonce: number;
    amount: number;
    target: number;
  }): Promise<{ won: boolean }>;
}

export interface BotConfig {
  startAmount: number;
  target: number;
  rounds: number;
}

export interface FlatBetConfig {
  amount: number;
  target: number;
  rounds: number;
}

export interface KellyBotConfig {
  bankroll: number;
  minBet: number;
  maxBet: number;
  winProbability: number; // 0..1
  payoutMultiplier: number; // includes stake, e.g. 1.98
  target: number;
  rounds: number;
}

export interface BotRound {
  won: boolean;
  amount: number;
}

export function calculateKellyFraction(winProbability: number, payoutMultiplier: number): number {
  if (winProbability <= 0 || winProbability >= 1) return 0;
  const b = payoutMultiplier - 1;
  if (b <= 0) return 0;

  const q = 1 - winProbability;
  const fraction = (b * winProbability - q) / b;
  return Math.max(0, Math.min(1, fraction));
}

export async function runMartingaleBot(client: BetClient, config: BotConfig) {
  let amount = config.startAmount;
  let nonce = 1;
  const history: BotRound[] = [];

  for (let i = 0; i < config.rounds; i += 1) {
    const result = await client.createBet({
      serverSeed: "bot-server-seed",
      clientSeed: "bot-client-seed",
      nonce,
      amount,
      target: config.target,
    });

    history.push({ won: result.won, amount });
    amount = result.won ? config.startAmount : amount * 2;
    nonce += 1;
  }

  return history;
}

export async function runFlatBetBot(client: BetClient, config: FlatBetConfig): Promise<BotRound[]> {
  let nonce = 1;
  const history: BotRound[] = [];

  for (let i = 0; i < config.rounds; i += 1) {
    const result = await client.createBet({
      serverSeed: "bot-server-seed",
      clientSeed: "bot-client-seed",
      nonce,
      amount: config.amount,
      target: config.target,
    });
    history.push({ won: result.won, amount: config.amount });
    nonce += 1;
  }

  return history;
}

export async function runKellyBot(client: BetClient, config: KellyBotConfig): Promise<BotRound[]> {
  let nonce = 1;
  let bankroll = config.bankroll;
  const history: BotRound[] = [];
  const fraction = calculateKellyFraction(config.winProbability, config.payoutMultiplier);

  for (let i = 0; i < config.rounds; i += 1) {
    const rawStake = bankroll * fraction;
    const amount = Math.max(config.minBet, Math.min(config.maxBet, Number(rawStake.toFixed(8))));
    const result = await client.createBet({
      serverSeed: "bot-server-seed",
      clientSeed: "bot-client-seed",
      nonce,
      amount,
      target: config.target,
    });

    history.push({ won: result.won, amount });
    if (result.won) {
      bankroll += amount * (config.payoutMultiplier - 1);
    } else {
      bankroll -= amount;
    }
    bankroll = Number(Math.max(0, bankroll).toFixed(8));
    nonce += 1;
  }

  return history;
}
