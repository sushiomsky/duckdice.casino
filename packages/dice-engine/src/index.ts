import { createHash, createHmac } from "node:crypto";

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

export interface SeedRotationCommitment {
  currentSeedHash: string;
  nextSeedHash: string;
  rotations: number;
}

export interface SeedRotationResult extends SeedRotationCommitment {
  revealedServerSeed: string;
}

export function hashServerSeed(serverSeed: string): string {
  if (!serverSeed) throw new Error("serverSeed is required");
  return createHash("sha256").update(serverSeed).digest("hex");
}

export class ServerSeedRotator {
  private currentSeed: string;
  private nextSeed: string;
  private rotations = 0;

  constructor(currentSeed: string, nextSeed: string) {
    if (!currentSeed) throw new Error("currentSeed is required");
    if (!nextSeed) throw new Error("nextSeed is required");
    if (currentSeed === nextSeed) throw new Error("nextSeed must differ from currentSeed");
    this.currentSeed = currentSeed;
    this.nextSeed = nextSeed;
  }

  getCurrentSeed(): string {
    return this.currentSeed;
  }

  getCommitment(): SeedRotationCommitment {
    return {
      currentSeedHash: hashServerSeed(this.currentSeed),
      nextSeedHash: hashServerSeed(this.nextSeed),
      rotations: this.rotations,
    };
  }

  rotate(newNextSeed: string): SeedRotationResult {
    if (!newNextSeed) throw new Error("newNextSeed is required");
    if (newNextSeed === this.nextSeed) throw new Error("newNextSeed must differ from pending nextSeed");

    const revealedServerSeed = this.currentSeed;
    this.currentSeed = this.nextSeed;
    this.nextSeed = newNextSeed;
    this.rotations += 1;

    return {
      revealedServerSeed,
      ...this.getCommitment(),
    };
  }
}

export class NonceTracker {
  private latestNonceBySeedPair = new Map<string, number>();

  private static pairKey(serverSeed: string, clientSeed: string): string {
    if (!serverSeed) throw new Error("serverSeed is required");
    if (!clientSeed) throw new Error("clientSeed is required");
    return `${serverSeed}:${clientSeed}`;
  }

  track(serverSeed: string, clientSeed: string, nonce: number): number {
    if (!Number.isInteger(nonce) || nonce < 0) {
      throw new Error("nonce must be a non-negative integer");
    }

    const key = NonceTracker.pairKey(serverSeed, clientSeed);
    const latest = this.latestNonceBySeedPair.get(key);
    if (latest !== undefined && nonce <= latest) {
      throw new Error("nonce must strictly increase for this seed pair");
    }

    this.latestNonceBySeedPair.set(key, nonce);
    return nonce;
  }

  getLatest(serverSeed: string, clientSeed: string): number | undefined {
    const key = NonceTracker.pairKey(serverSeed, clientSeed);
    return this.latestNonceBySeedPair.get(key);
  }
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
