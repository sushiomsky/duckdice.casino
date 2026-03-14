import React from 'react';

type DiceControlsProps = {
  betAmount: number;
  setBetAmount: (value: number) => void;
  chance: number;
  setChance: (value: number) => void;
  over: boolean;
  setOver: (value: boolean) => void;
  autobetEnabled: boolean;
  setAutobetEnabled: (value: boolean) => void;
  onRoll: () => void;
  rolling: boolean;
};

export function DiceControls({
  betAmount,
  setBetAmount,
  chance,
  setChance,
  over,
  setOver,
  autobetEnabled,
  setAutobetEnabled,
  onRoll,
  rolling,
}: DiceControlsProps) {
  const chanceHue = Math.floor((chance / 95) * 120);

  return (
    <section className="dd-panel" aria-label="Dice controls">
      <h2>Dice Controls</h2>
      <label>
        Bet Amount
        <input
          type="number"
          min={0.01}
          step={0.01}
          value={betAmount}
          onChange={(event) => setBetAmount(Number(event.target.value))}
          aria-label="Bet amount"
        />
      </label>

      <label>
        Chance {chance.toFixed(2)}%
        <input
          type="range"
          min={1}
          max={95}
          value={chance}
          onChange={(event) => setChance(Number(event.target.value))}
          style={{ accentColor: `hsl(${chanceHue}, 90%, 50%)` }}
          aria-label="Win chance slider"
        />
      </label>

      <div className="dd-toggle-row" role="group" aria-label="Roll mode">
        <button
          className={over ? 'dd-btn active' : 'dd-btn'}
          onClick={() => setOver(true)}
          type="button"
          title="Win if roll is over target"
        >
          Roll Over
        </button>
        <button
          className={!over ? 'dd-btn active' : 'dd-btn'}
          onClick={() => setOver(false)}
          type="button"
          title="Win if roll is under target"
        >
          Roll Under
        </button>
      </div>

      <div className="dd-quick-bets" role="group" aria-label="Quick bet buttons">
        <button className="dd-btn" onClick={() => setBetAmount(Math.max(0.01, betAmount / 2))} type="button">1/2</button>
        <button className="dd-btn" onClick={() => setBetAmount(1)} type="button">1</button>
        <button className="dd-btn" onClick={() => setBetAmount(10)} type="button">Max</button>
        <button className="dd-btn" onClick={() => setBetAmount(2.5)} type="button">Custom</button>
      </div>

      <label className="dd-checkbox">
        <input
          type="checkbox"
          checked={autobetEnabled}
          onChange={(event) => setAutobetEnabled(event.target.checked)}
          aria-label="Enable autobet"
        />
        Enable Autobet
      </label>

      <button
        className="dd-roll-btn"
        onClick={onRoll}
        disabled={rolling}
        type="button"
        title="Place bet and roll instantly"
      >
        {rolling ? 'Rolling...' : 'Roll Dice'}
      </button>
    </section>
  );
}
