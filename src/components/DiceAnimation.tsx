import React from 'react';

type DiceAnimationProps = {
  rollValue: number;
  rolling: boolean;
  won: boolean | null;
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
};

export function DiceAnimation({
  rollValue,
  rolling,
  won,
  serverSeedHash,
  clientSeed,
  nonce,
}: DiceAnimationProps) {
  return (
    <section className="dd-dice-stage" aria-live="polite">
      <h2>Dice Roll</h2>
      <div className={rolling ? 'dd-dice rolling' : `dd-dice ${won === null ? '' : won ? 'win' : 'loss'}`}>
        {rollValue.toFixed(2)}
      </div>
      <div className="dd-fair-box">
        <p><strong>Server Seed Hash:</strong> <code>{serverSeedHash}</code></p>
        <p><strong>Client Seed:</strong> <code>{clientSeed}</code></p>
        <p><strong>Nonce:</strong> {nonce}</p>
      </div>
    </section>
  );
}
