"""A K-armed Bernoulli bandit for testing exploration/exploitation."""

from __future__ import annotations

from typing import Any, List

from agent_sandbox.environment import Environment, StepResult


class BernoulliBandit(Environment):
    """Pull one of ``num_arms`` arms for ``horizon`` steps.

    Each arm pays 1 with a hidden probability drawn uniformly at reset.
    Observation: the number of pulls made so far. The hidden arm
    probabilities are exposed in ``info["best_arm"]`` on the final step
    so harnesses can compute regret.
    """

    def __init__(self, num_arms: int = 5, horizon: int = 100) -> None:
        super().__init__()
        self.num_arms = num_arms
        self.horizon = horizon
        self.probs: List[float] = []
        self.pulls = 0

    def reset(self, seed: int = 0) -> Any:
        self._rng.seed(seed)
        self.probs = [self._rng.random() for _ in range(self.num_arms)]
        self.pulls = 0
        return {"pulls": 0}

    def step(self, action: Any) -> StepResult:
        if not isinstance(action, int) or not 0 <= action < self.num_arms:
            raise ValueError(f"invalid arm {action!r}; expected int in [0, {self.num_arms})")
        self.pulls += 1
        reward = 1.0 if self._rng.random() < self.probs[action] else 0.0
        done = self.pulls >= self.horizon
        info = {}
        if done:
            info["best_arm"] = max(range(self.num_arms), key=lambda a: self.probs[a])
            info["best_prob"] = max(self.probs)
        return StepResult({"pulls": self.pulls}, reward, done, info)

    @property
    def action_space(self) -> List[Any]:
        return list(range(self.num_arms))
