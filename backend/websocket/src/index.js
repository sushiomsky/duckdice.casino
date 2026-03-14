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

function broadcast(data) {
  const message = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "websocket", clients: wss.clients.size });
});

async function consumeEventsWithRetry() {
  while (true) {
    try {
      const conn = await amqplib.connect(config.rabbitUrl);
      const channel = await conn.createChannel();
      await channel.assertExchange(config.eventsExchange, "topic", { durable: true });
      await channel.assertQueue(config.queueName, { durable: true });
      await channel.bindQueue(config.queueName, config.eventsExchange, "bet.*");

      console.log("websocket connected to RabbitMQ");
      channel.consume(config.queueName, (message) => {
        if (!message) return;
        try {
          const event = JSON.parse(message.content.toString("utf-8"));
          broadcast({ routingKey: message.fields.routingKey, event });
          channel.ack(message);
        } catch (err) {
          console.error("invalid event payload", err);
          channel.nack(message, false, false);
        }
      });
      return;
    } catch (error) {
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
