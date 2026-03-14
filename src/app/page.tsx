'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AutobetBotPanel } from '../components/AutobetBotPanel';
import { DiceAnimation } from '../components/DiceAnimation';
import { DiceControls } from '../components/DiceControls';
import { Footer } from '../components/Footer';
import { Header } from '../components/Header';
import { RollHistoryStats } from '../components/RollHistoryStats';

type RollEntry = {
  id: number;
  value: number;
  profit: number;
};

function toHex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256(input: string) {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return toHex(hash);
}

export default function Home() {
  const [wallet, setWallet] = useState(1250);
  const [lpShare] = useState(2.4);
  const [betAmount, setBetAmount] = useState(1);
  const [chance, setChance] = useState(49.5);
  const [over, setOver] = useState(true);
  const [autobetEnabled, setAutobetEnabled] = useState(false);
  const [intervalMs, setIntervalMs] = useState(1200);
  const [randomization, setRandomization] = useState(18);
  const [rolling, setRolling] = useState(false);
  const [rollValue, setRollValue] = useState(0);
  const [nonce, setNonce] = useState(0);
  const [won, setWon] = useState<boolean | null>(null);
  const [history, setHistory] = useState<RollEntry[]>([]);

  const clientSeed = useMemo(() => 'duckdice-player-seed', []);
  const serverSeed = useMemo(() => 'server-secret-seed-v1', []);
  const [serverSeedHash, setServerSeedHash] = useState('');

  const timerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    sha256(serverSeed).then(setServerSeedHash);
  }, [serverSeed]);

  const payoutMultiplier = useMemo(() => Number((99 / chance).toFixed(2)), [chance]);
  const dynamicDelay = useMemo(
    () => Math.max(250, intervalMs + (Math.random() * 2 - 1) * (intervalMs * (randomization / 100))),
    [intervalMs, randomization],
  );

  const roll = async () => {
    setRolling(true);

    const nextNonce = nonce + 1;
    const fairHash = await sha256(`${serverSeed}:${clientSeed}:${nextNonce}`);
    const numeric = parseInt(fairHash.slice(0, 8), 16);
    const value = (numeric % 10000) / 100;

    const isWin = over ? value > 100 - chance : value < chance;
    const profit = isWin ? betAmount * (payoutMultiplier - 1) : -betAmount;

    setTimeout(() => {
      setRollValue(value);
      setWon(isWin);
      setWallet((prev) => prev + profit);
      setHistory((prev) => [{ id: nextNonce, value, profit }, ...prev].slice(0, 100));
      setNonce(nextNonce);
      setRolling(false);
    }, 450);
  };

  useEffect(() => {
    if (!autobetEnabled) {
      if (timerRef.current) clearTimeout(timerRef.current);
      return;
    }

    timerRef.current = setTimeout(roll, dynamicDelay);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  });

  return (
    <main className="dd-app">
      <Header walletBalance={wallet} lpShare={lpShare} />

      <section className="dd-main-grid">
        <DiceControls
          betAmount={betAmount}
          setBetAmount={setBetAmount}
          chance={chance}
          setChance={setChance}
          over={over}
          setOver={setOver}
          autobetEnabled={autobetEnabled}
          setAutobetEnabled={setAutobetEnabled}
          onRoll={roll}
          rolling={rolling}
        />

        <RollHistoryStats history={history} />
      </section>

      <DiceAnimation
        rollValue={rollValue}
        rolling={rolling}
        won={won}
        serverSeedHash={serverSeedHash}
        clientSeed={clientSeed}
        nonce={nonce}
      />

      <AutobetBotPanel
        autobetEnabled={autobetEnabled}
        intervalMs={intervalMs}
        setIntervalMs={setIntervalMs}
        randomization={randomization}
        setRandomization={setRandomization}
      />

      <Footer serverSeedHash={serverSeedHash} />
    </main>
  );
}
