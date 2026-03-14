import { createHmac } from "node:crypto";

export interface DiceRollInput {
  serverSeed: string;
  clientSeed: string;
  nonce: number;
}

export interface BetInput extends DiceRollInput {
  amount: number;
  chance: number; // 0.01..99.99 win probability in %
  rollOver: boolean;
  houseEdgeBps?: number;
}

export interface BetResult {
  roll: number;
  won: boolean;
  payout: number;
  proof: string;
}

export function rollDice(input: DiceRollInput): { roll: number; proof: string } {
  const message = `${input.clientSeed}:${input.nonce}`;
  const proof = createHmac("sha256", input.serverSeed).update(message).digest("hex");

  const bucket = Number.parseInt(proof.slice(0, 13), 16);
  const max = 0x1fffffffffffff;
  const roll = Math.floor((bucket / max) * 10000) / 100;

  return { roll: Number(roll.toFixed(2)), proof };
}

export function settleBet(input: BetInput): BetResult {
  if (input.amount <= 0) throw new Error("amount must be positive");
  if (input.chance < 0.01 || input.chance > 99.99) throw new Error("chance must be between 0.01 and 99.99");

  const { roll, proof } = rollDice(input);
  const won = input.rollOver ? roll > (100 - input.chance) : roll < input.chance;

  const houseEdgeBps = input.houseEdgeBps ?? 100;
  const edgeMultiplier = 1 - houseEdgeBps / 10_000;
  const multiplier = (100 / input.chance) * edgeMultiplier;
  const payout = won ? Number((input.amount * multiplier).toFixed(8)) : 0;

  return { roll, won, payout, proof };
}
