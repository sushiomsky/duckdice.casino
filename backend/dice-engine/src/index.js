const crypto = require("node:crypto");
const express = require("express");

const app = express();
app.use(express.json());

function rollDice({ serverSeed, clientSeed, nonce }) {
  const payload = `${serverSeed}:${clientSeed}:${nonce}`;
  const proof = crypto.createHash("sha256").update(payload).digest("hex");
  const bucket = Number.parseInt(proof.slice(0, 13), 16);
  const max = 0x1fffffffffffff;
  const roll = Math.floor((bucket / max) * 10000) / 100;

  return { roll: Number(roll.toFixed(2)), proof };
}

function settleBet({ serverSeed, clientSeed, nonce, amount, target, houseEdgeBps = 100 }) {
  if (amount <= 0) throw new Error("amount must be positive");
  if (target < 1 || target > 99) throw new Error("target must be between 1 and 99");

  const { roll, proof } = rollDice({ serverSeed, clientSeed, nonce });
  const won = roll < target;
  const multiplier = (100 - houseEdgeBps / 100) / target;
  const payout = won ? Number((amount * multiplier).toFixed(8)) : 0;

  return { roll, won, payout, proof };
}

app.get("/health", (_req, res) => res.json({ status: "ok", service: "dice-engine" }));

app.post("/v1/settle", (req, res) => {
  try {
    const result = settleBet(req.body);
    return res.status(200).json(result);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

const port = Number(process.env.PORT || 4001);
app.listen(port, () => {
  console.log(`dice-engine listening on ${port}`);
});
