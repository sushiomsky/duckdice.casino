import React from 'react';

type HeaderProps = {
  walletBalance: number;
  lpShare: number;
};

export function Header({ walletBalance, lpShare }: HeaderProps) {
  return (
    <header className="dd-header" role="banner">
      <div className="dd-logo" aria-label="DuckDice Casino">
        🦆 DuckDice
      </div>
      <nav className="dd-header-stats" aria-label="Account summary">
        <span>Wallet: ${walletBalance.toFixed(2)}</span>
        <span>LP Share: {lpShare.toFixed(2)}%</span>
        <button className="dd-ghost-btn" type="button">DAO</button>
      </nav>
    </header>
  );
}
