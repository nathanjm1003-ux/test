"""Evaluation harness: run agents in environments under budgets."""

from __future__ import annotations

import statistics
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Union

from agent_sandbox.agent import Agent
from agent_sandbox.environment import Environment, make


@dataclass
class EpisodeResult:
    """Metrics from one episode."""

    seed: int
    total_reward: float
    steps: int
    done: bool
    truncated: bool
    wall_time_s: float
    error: Optional[str] = None
    infos: List[Dict[str, Any]] = field(default_factory=list)

    @property
    def solved(self) -> bool:
        return self.done and self.error is None


@dataclass
class EvalReport:
    """Aggregate metrics across episodes."""

    episodes: List[EpisodeResult]

    @property
    def mean_reward(self) -> float:
        return statistics.fmean(e.total_reward for e in self.episodes)

    @property
    def mean_steps(self) -> float:
        return statistics.fmean(e.steps for e in self.episodes)

    @property
    def solve_rate(self) -> float:
        return sum(e.solved for e in self.episodes) / len(self.episodes)

    @property
    def error_rate(self) -> float:
        return sum(e.error is not None for e in self.episodes) / len(self.episodes)

    def summary(self) -> str:
        return (
            f"episodes={len(self.episodes)} "
            f"solve_rate={self.solve_rate:.2f} "
            f"mean_reward={self.mean_reward:.3f} "
            f"mean_steps={self.mean_steps:.1f} "
            f"error_rate={self.error_rate:.2f}"
        )


def run_episode(
    agent: Agent,
    env: Environment,
    seed: int = 0,
    max_steps: int = 1000,
    time_limit_s: Optional[float] = None,
    keep_infos: bool = False,
) -> EpisodeResult:
    """Run one episode, containing agent errors and enforcing budgets.

    An exception raised by the agent (or by the environment rejecting an
    invalid action) ends the episode and is recorded on
    ``EpisodeResult.error`` instead of propagating — a misbehaving agent
    can't crash an evaluation run.
    """
    start = time.monotonic()
    observation = env.reset(seed=seed)
    agent.reset(seed=seed)

    total_reward = 0.0
    steps = 0
    done = False
    truncated = False
    error: Optional[str] = None
    infos: List[Dict[str, Any]] = []

    while not done:
        if steps >= max_steps:
            truncated = True
            break
        if time_limit_s is not None and time.monotonic() - start > time_limit_s:
            truncated = True
            break
        try:
            action = agent.act(observation, env.action_space)
            result = env.step(action)
        except Exception as exc:  # noqa: BLE001 - sandbox boundary
            error = f"{type(exc).__name__}: {exc}"
            break
        steps += 1
        total_reward += result.reward
        done = result.done
        observation = result.observation
        if keep_infos:
            infos.append(result.info)
        try:
            agent.observe(result.observation, result.reward, result.done)
        except Exception as exc:  # noqa: BLE001 - sandbox boundary
            error = f"{type(exc).__name__}: {exc}"
            break

    return EpisodeResult(
        seed=seed,
        total_reward=total_reward,
        steps=steps,
        done=done,
        truncated=truncated,
        wall_time_s=time.monotonic() - start,
        error=error,
        infos=infos,
    )


def evaluate(
    agent: Agent,
    env: Union[Environment, str],
    num_episodes: int = 10,
    base_seed: int = 0,
    max_steps: int = 1000,
    time_limit_s: Optional[float] = None,
) -> EvalReport:
    """Run ``num_episodes`` episodes over consecutive seeds.

    ``env`` may be an :class:`Environment` instance or a registered name.
    """
    if isinstance(env, str):
        env = make(env)
    episodes = [
        run_episode(agent, env, seed=base_seed + i, max_steps=max_steps, time_limit_s=time_limit_s)
        for i in range(num_episodes)
    ]
    return EvalReport(episodes=episodes)
