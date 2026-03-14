import React from 'react';

type AutobetBotPanelProps = {
  autobetEnabled: boolean;
  intervalMs: number;
  setIntervalMs: (value: number) => void;
  randomization: number;
  setRandomization: (value: number) => void;
};

export function AutobetBotPanel({
  autobetEnabled,
  intervalMs,
  setIntervalMs,
  randomization,
  setRandomization,
}: AutobetBotPanelProps) {
  return (
    <section className="dd-bottom-panel" aria-label="Chat, strategy and bot config">
      <h2>Autobet / Bot Panel</h2>
      <div className="dd-bottom-grid">
        <div>
          <h3>Chat</h3>
          <p>GG! Next roll in 3s...</p>
        </div>
        <div>
          <h3>Strategy</h3>
          <p>Template: Martingale Lite</p>
          <progress value={68} max={100} aria-label="Strategy progress">68%</progress>
        </div>
        <div>
          <h3>Bot Config</h3>
          <p>Status: {autobetEnabled ? 'Active' : 'Idle'}</p>
          <label>
            Interval (ms)
            <input
              type="number"
              min={200}
              step={100}
              value={intervalMs}
              onChange={(event) => setIntervalMs(Number(event.target.value))}
              title="Set autobet interval"
            />
          </label>
          <label>
            Randomization (%)
            <input
              type="range"
              min={0}
              max={100}
              value={randomization}
              onChange={(event) => setRandomization(Number(event.target.value))}
              title="Vary bot interval randomly"
            />
          </label>
        </div>
      </div>
    </section>
  );
}
