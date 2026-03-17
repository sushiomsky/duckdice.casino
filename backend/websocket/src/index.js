const http = require("node:http");
const express = require("express");
const amqplib = require("amqplib");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);

const config = {
  port: Number(process.env.PORT || 4010),
  rabbitUrl: process.env.RABBITMQ_URL || "amqp://rabbitmq:5672",
  eventsExchange: process.env.EVENTS_EXCHANGE || "duckdice.events",
  queueName: process.env.WS_QUEUE_NAME || "duckdice.websocket"
};

const wss = new WebSocket.Server({ server });
let rabbitConnection;
let rabbitChannel;
let consumerTag;
const metrics = {
  messagesConsumed: 0,
  broadcasts: 0,
  deliveredFrames: 0,
  invalidPayloads: 0,
  nacks: 0,
  lastMessageAt: null
};

function broadcast(data) {
  const message = JSON.stringify(data);
  let delivered = 0;
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
      delivered += 1;
    }
  }
  metrics.broadcasts += 1;
  metrics.deliveredFrames += delivered;
  return delivered;
}

app.get("/health", async (_req, res) => {
  let queue = null;
  if (rabbitChannel) {
    try {
      const info = await rabbitChannel.checkQueue(config.queueName);
      queue = {
        name: info.queue,
        messages: info.messageCount,
        consumers: info.consumerCount
      };
    } catch (error) {
      queue = {
        name: config.queueName,
        error: error.message
      };
    }
  }

  res.json({
    status: "ok",
    service: "websocket",
    clients: wss.clients.size,
    infra: {
      rabbitmq: Boolean(rabbitConnection),
      consumerActive: Boolean(consumerTag)
    },
    stream: {
      exchange: config.eventsExchange,
      queue
    },
    metrics
  });
});

async function consumeEventsWithRetry() {
  while (true) {
    try {
      const conn = await amqplib.connect(config.rabbitUrl);
      const channel = await conn.createChannel();
      await channel.assertExchange(config.eventsExchange, "topic", { durable: true });
      await channel.assertQueue(config.queueName, { durable: true });
      await channel.bindQueue(config.queueName, config.eventsExchange, "bet.*");
      rabbitConnection = conn;
      rabbitChannel = channel;

      console.log("websocket connected to RabbitMQ");
      const consumeResponse = await channel.consume(config.queueName, (message) => {
        if (!message) return;
        try {
          const event = JSON.parse(message.content.toString("utf-8"));
          metrics.messagesConsumed += 1;
          metrics.lastMessageAt = new Date().toISOString();
          broadcast({ routingKey: message.fields.routingKey, event });
          channel.ack(message);
        } catch (err) {
          metrics.invalidPayloads += 1;
          metrics.nacks += 1;
          console.error("invalid event payload", err);
          channel.nack(message, false, false);
        }
      });
      consumerTag = consumeResponse.consumerTag;
      return;
    } catch (error) {
      rabbitConnection = undefined;
      rabbitChannel = undefined;
      consumerTag = undefined;
      console.error("websocket rabbit connection failed; retrying in 2s", error.message);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

wss.on("connection", (socket) => {
  socket.send(JSON.stringify({ type: "welcome", message: "connected to duckdice events" }));
});

consumeEventsWithRetry().catch((err) => {
  console.error("consumer bootstrap failed", err);
  process.exit(1);
});

server.listen(config.port, () => {
  console.log(`websocket service listening on ${config.port}`);
});
