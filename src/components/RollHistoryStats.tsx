import React from 'react';

type RollEntry = {
  id: number;
  value: number;
  profit: number;
};

type RollHistoryStatsProps = {
  history: RollEntry[];
};

export function RollHistoryStats({ history }: RollHistoryStatsProps) {
  const totalProfit = history.reduce((sum, entry) => sum + entry.profit, 0);
  const wins = history.filter((entry) => entry.profit > 0).length;
  const losses = history.length - wins;

  return (
    <section className="dd-panel" aria-label="Roll history and stats">
      <h2>Roll History / Stats</h2>
      <p className={totalProfit >= 0 ? 'profit' : 'loss'}>
        P/L: ${totalProfit.toFixed(2)}
      </p>
      <p>Bet Distribution: {wins} Wins / {losses} Losses</p>
      <h3>Last 20 Rolls</h3>
      <ul className="dd-history-list">
        {history.slice(0, 20).map((entry) => (
          <li key={entry.id} className={entry.profit >= 0 ? 'profit' : 'loss'}>
            #{entry.id} → {entry.value.toFixed(2)} ({entry.profit >= 0 ? '+' : ''}{entry.profit.toFixed(2)})
          </li>
        ))}
      </ul>
      <h3>Player Leaderboard</h3>
      <ul>
        <li>WhaleAlpha +$1,204</li>
        <li>DiceNinja +$842</li>
        <li>BotOrbit -$221</li>
      </ul>
      <h3>Bot Activity</h3>
      <p>Live API Bets: 14/min</p>
    </section>
  );
}
