import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'DuckDice UX Prototype',
  description: 'Fast, responsive, provably-fair DuckDice interface',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
