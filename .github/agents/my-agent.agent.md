---
# Fill in the fields below to create a basic custom agent for your repository.
# The Copilot CLI can be used for local testing: https://gh.io/customagents/cli
# To make this agent available, merge this file into the default repository branch.
# For format details, see: https://gh.io/customagents/config

name:
description:
---

# My Agent

# DuckDice Protocol – Autonomous Coding Agents

This repository contains the open-source implementation of the DuckDice casino protocol.

The goal is to build a production-grade crypto dice casino with:

- provably fair dice engine
- bot-friendly API
- on-chain bankroll
- liquidity provider pool
- open SDK
- DAO governance

Architecture Overview

frontend/
React / Next.js casino UI

backend/
dice-engine
risk-engine
api-gateway
websocket
wallet-service

contracts/
bankroll pool
casino token
staking

sdk/
python
javascript

bots/
example strategies

infra/
docker
docker-compose
kubernetes

analytics/
probability models
bet stream analysis


Development Principles

1. deterministic provably fair RNG
2. mathematically safe bankroll management
3. horizontally scalable services
4. bot-first API design
5. real-time bet streaming
6. security-first smart contracts


Provably Fair RNG

roll = HMAC_SHA256(server_seed, client_seed + nonce)

The result must produce a number between 0.00 and 99.99.

Server seeds rotate periodically and must be verifiable.


Risk Engine Rules

Maximum bet must satisfy:

max_bet = bankroll * risk_factor / multiplier

Default risk_factor = 0.5%

The system must prevent:

- bankroll depletion
- payout exceeding 5% of bankroll


API Design

All APIs must be REST + WebSocket.

Endpoints:

POST /bet
GET /rolls
GET /bankroll
GET /stats
WS /bets


Smart Contracts

Bankroll contract must allow:

deposit liquidity
withdraw liquidity
receive casino profits


Testing Requirements

All critical modules require:

unit tests
integration tests
simulation tests


Target Performance

20+ bets/sec
<100ms latency
10M bets/day


Coding Stack

Backend: Go or Rust
Frontend: Next.js
Contracts: Solidity
Infrastructure: Docker
