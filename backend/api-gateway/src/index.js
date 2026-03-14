const express = require("express");
const axios = require("axios");
const amqplib = require("amqplib");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(express.json());

const config = {
  port: Number(process.env.PORT || 4000),
  diceEngineUrl: process.env.DICE_ENGINE_URL || "http://dice-engine:4001",
  riskEngineUrl: process.env.RISK_ENGINE_URL || "http://risk-engine:4002",
  rabbitUrl: process.env.RABBITMQ_URL || "amqp://rabbitmq:5672",
  eventsExchange: process.env.EVENTS_EXCHANGE || "duckdice.events"
};

let rabbitChannel;

async function connectRabbitWithRetry() {
  while (!rabbitChannel) {
    try {
      const conn = await amqplib.connect(config.rabbitUrl);
      rabbitChannel = await conn.createChannel();
      await rabbitChannel.assertExchange(config.eventsExchange, "topic", { durable: true });
      console.log("api-gateway connected to RabbitMQ");
    } catch (err) {
      console.error("api-gateway rabbit connection failed; retrying in 2s", err.message);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

function publishEvent(routingKey, payload) {
  if (!rabbitChannel) return;
  rabbitChannel.publish(config.eventsExchange, routingKey, Buffer.from(JSON.stringify(payload)), {
    contentType: "application/json",
    persistent: true
  });
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "api-gateway" });
});

app.post("/v1/bets", async (req, res) => {
  const betId = uuidv4();
  const createdAt = new Date().toISOString();
  const payload = { ...req.body, betId, createdAt };

  try {
    const settleResponse = await axios.post(`${config.diceEngineUrl}/v1/settle`, payload, { timeout: 2000 });
    const settlement = settleResponse.data;

    const riskResponse = await axios.post(`${config.riskEngineUrl}/v1/evaluate`, {
      requestedPayout: settlement.payout,
      commit: true
    }, { timeout: 2000 });

    const risk = riskResponse.data;
    if (!risk.accepted) {
      publishEvent("bet.rejected", { ...payload, settlement, risk });
      return res.status(422).json({ betId, error: risk.reason, risk });
    }

    publishEvent("bet.accepted", { ...payload, settlement, risk });
    return res.status(201).json({ betId, settlement, risk });
  } catch (error) {
    const detail = error.response?.data || { message: error.message };
    publishEvent("bet.error", { ...payload, detail });
    return res.status(400).json({ error: "bet_processing_failed", detail });
  }
});

app.post("/v1/exposure/release", async (req, res) => {
  try {
    const response = await axios.post(`${config.riskEngineUrl}/v1/release`, req.body, { timeout: 2000 });
    return res.status(200).json(response.data);
  } catch (error) {
    const detail = error.response?.data || { message: error.message };
    return res.status(400).json({ error: "release_failed", detail });
  }
});

connectRabbitWithRetry().catch((err) => {
  console.error("Rabbit bootstrap failed", err);
  process.exit(1);
});

app.listen(config.port, () => {
  console.log(`api-gateway listening on ${config.port}`);
});
