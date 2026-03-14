import React from 'react';

type FooterProps = {
  serverSeedHash: string;
};

export function Footer({ serverSeedHash }: FooterProps) {
  return (
    <footer className="dd-footer" role="contentinfo">
      <p>Provably Fair Seed Hash: <code>{serverSeedHash}</code></p>
      <nav aria-label="Legal and docs">
        <a href="#" aria-label="Terms">Terms</a>
        <a href="#" aria-label="Documentation">Docs</a>
      </nav>
    </footer>
  );
}
