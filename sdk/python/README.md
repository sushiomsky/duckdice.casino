# DuckDice Python SDK

```python
from duckdice_sdk import DuckDiceClient

client = DuckDiceClient(base_url="http://localhost:4000")
result = client.create_bet({
    "serverSeed": "server-secret",
    "clientSeed": "client-seed",
    "nonce": 1,
    "amount": 10,
    "target": 55,
})
print(result)
```
