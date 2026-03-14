from __future__ import annotations

from typing import Any, Dict
import requests


class DuckDiceClient:
    def __init__(self, base_url: str = "http://localhost:4000", timeout: float = 5.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def create_bet(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        response = requests.post(
            f"{self.base_url}/v1/bets", json=payload, timeout=self.timeout
        )
        response.raise_for_status()
        return response.json()

    def release_exposure(self, amount: float) -> Dict[str, Any]:
        response = requests.post(
            f"{self.base_url}/v1/exposure/release",
            json={"amount": amount},
            timeout=self.timeout,
        )
        response.raise_for_status()
        return response.json()
