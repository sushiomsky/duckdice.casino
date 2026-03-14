import { createHash } from "node:crypto";

export interface DiceRollInput {
  serverSeed: string;
  clientSeed: string;
  nonce: number;
}

export interface BetInput extends DiceRollInput {
  amount: number;
  target: number; // 1..99 roll-under target
  houseEdgeBps?: number;
}

export interface BetResult {
  roll: number;
  won: boolean;
  payout: number;
  proof: string;
}

export function rollDice(input: DiceRollInput): { roll: number; proof: string } {
  const payload = `${input.serverSeed}:${input.clientSeed}:${input.nonce}`;
  const proof = createHash("sha256").update(payload).digest("hex");
  const bucket = Number.parseInt(proof.slice(0, 13), 16);
  const max = 0x1fffffffffffff;
  const roll = Math.floor((bucket / max) * 10000) / 100;
  return { roll: Number(roll.toFixed(2)), proof };
}

export function settleBet(input: BetInput): BetResult {
  if (input.target < 1 || input.target > 99) throw new Error("target must be between 1 and 99");
  if (input.amount <= 0) throw new Error("amount must be positive");

  const { roll, proof } = rollDice(input);
  const won = roll < input.target;
  const houseEdgeBps = input.houseEdgeBps ?? 100;
  const multiplier = ((100 - houseEdgeBps / 100) / input.target);
  const payout = won ? Number((input.amount * multiplier).toFixed(8)) : 0;

  return { roll, won, payout, proof };
}
