"""Tabular Q-learning agent with persistence support."""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional

from agent_sandbox.agent import Agent
from agent_sandbox.environment import Environment


class QLearningAgent(Agent):
    """Epsilon-greedy tabular Q-learning.

    The Q-table maps ``str(state_fn(observation))`` to per-action values,
    so observations must reduce to a stable state key — for ``GridWorld``
    pass ``state_fn=lambda obs: obs["position"]``. The table persists
    across ``reset`` calls (episodes); use :func:`train` to run many
    episodes on a fixed map, and ``get_state``/``set_state`` (or
    ``agent_sandbox.persistence``) to save it to a file.
    """

    def __init__(
        self,
        alpha: float = 0.4,
        gamma: float = 0.95,
        epsilon: float = 0.2,
        state_fn: Optional[Callable[[Any], Any]] = None,
    ) -> None:
        super().__init__()
        self.alpha = alpha
        self.gamma = gamma
        self.epsilon = epsilon
        self.state_fn = state_fn
        self.q: Dict[str, Dict[str, float]] = {}
        self.episodes_trained = 0
        self._last: Optional[tuple] = None

    def _key(self, observation: Any) -> str:
        state = self.state_fn(observation) if self.state_fn else observation
        return str(state)

    def reset(self, seed: int = 0) -> None:
        # String-derived seed decorrelates the agent's stream from the
        # environment's (see RandomAgent). The Q-table is kept.
        import random

        self._rng = random.Random(f"QLearningAgent:{seed}")
        self._last = None

    def act(self, observation: Any, action_space: List[Any]) -> Any:
        s = self._key(observation)
        if self._rng.random() < self.epsilon:
            action = self._rng.choice(action_space)
        else:
            values = self.q.get(s, {})
            action = max(action_space, key=lambda a: values.get(str(a), 0.0))
        self._last = (s, str(action))
        return action

    def observe(self, observation: Any, reward: float, done: bool) -> None:
        if self._last is None:
            return
        s, a = self._last
        s2 = self._key(observation)
        future = 0.0 if done else max(self.q.get(s2, {}).values(), default=0.0)
        row = self.q.setdefault(s, {})
        old = row.get(a, 0.0)
        row[a] = old + self.alpha * (reward + self.gamma * future - old)
        if done:
            self._last = None

    def get_state(self) -> dict:
        return {
            "alpha": self.alpha,
            "gamma": self.gamma,
            "epsilon": self.epsilon,
            "q": self.q,
            "episodes_trained": self.episodes_trained,
        }

    def set_state(self, state: dict) -> None:
        self.alpha = state["alpha"]
        self.gamma = state["gamma"]
        self.epsilon = state["epsilon"]
        self.q = {s: dict(row) for s, row in state["q"].items()}
        self.episodes_trained = state["episodes_trained"]


def train(
    agent: Agent,
    env: Environment,
    episodes: int = 200,
    seed: int = 0,
    max_steps: int = 200,
) -> List[float]:
    """Train ``agent`` on the fixed map ``env.reset(seed)`` for ``episodes``.

    The environment is reset with the same seed every episode (same map,
    same hidden state) while the agent's exploration seed varies, so the
    agent can converge on that instance. Returns per-episode total rewards.
    """
    rewards: List[float] = []
    for i in range(episodes):
        obs = env.reset(seed=seed)
        agent.reset(seed=(seed + 1) * 100_003 + i)
        total, steps, done = 0.0, 0, False
        while not done and steps < max_steps:
            action = agent.act(obs, env.action_space)
            result = env.step(action)
            agent.observe(result.observation, result.reward, result.done)
            obs, done = result.observation, result.done
            total += result.reward
            steps += 1
        if isinstance(agent, QLearningAgent):
            agent.episodes_trained += 1
        rewards.append(total)
    return rewards
