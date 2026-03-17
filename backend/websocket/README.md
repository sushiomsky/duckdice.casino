# DuckDice backend websocket service

Streams RabbitMQ `bet.*` events to connected WebSocket clients.

## Endpoints
- `GET /health` returns:
  - client count
  - RabbitMQ consumer connectivity state
  - queue diagnostics (message depth/consumer count)
  - stream metrics (`messagesConsumed`, `broadcasts`, `deliveredFrames`, `invalidPayloads`, `nacks`)
