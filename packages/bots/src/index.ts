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

export async function runMartingaleBot(client: BetClient, config: BotConfig) {
  let amount = config.startAmount;
  let nonce = 1;
  const history: Array<{ won: boolean; amount: number }> = [];

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
