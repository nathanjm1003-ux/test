"""Agent interface and reference baselines."""

from __future__ import annotations

import abc
import random
from typing import Any, List, Optional


class Agent(abc.ABC):
    """Minimal interface an agent must implement to run in the harness."""

    def reset(self, seed: int = 0) -> None:
        """Called at the start of each episode. Override to clear state."""

    @abc.abstractmethod
    def act(self, observation: Any, action_space: List[Any]) -> Any:
        """Choose one of ``action_space`` given ``observation``."""

    def observe(self, observation: Any, reward: float, done: bool) -> None:
        """Feedback after each step. Override to learn online."""

    def get_state(self) -> Optional[dict]:
        """JSON-serializable state for persistence; None if unsupported."""
        return None

    def set_state(self, state: dict) -> None:
        """Restore state produced by ``get_state``."""
        raise NotImplementedError(
            f"{type(self).__name__} does not support persistence"
        )


class RandomAgent(Agent):
    """Uniform-random baseline; useful as a floor for any environment."""

    def __init__(self) -> None:
        self._rng = random.Random()

    def reset(self, seed: int = 0) -> None:
        # Seed with a string derived from the seed rather than the raw int:
        # the environment seeds its own RNG with the same int, and sharing
        # the stream lets the agent's draws mirror the environment's hidden
        # state (e.g. guessing GuessNumber's secret on the first try).
        self._rng.seed(f"RandomAgent:{seed}")

    def act(self, observation: Any, action_space: List[Any]) -> Any:
        return self._rng.choice(action_space)
