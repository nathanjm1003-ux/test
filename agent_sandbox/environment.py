"""Base environment interface and registry."""

from __future__ import annotations

import abc
import random
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List


@dataclass
class StepResult:
    """Outcome of a single environment step."""

    observation: Any
    reward: float
    done: bool
    info: Dict[str, Any] = field(default_factory=dict)


class Environment(abc.ABC):
    """A small Gym-style episodic task.

    Subclasses must be fully deterministic given the seed passed to
    ``reset`` so that evaluation runs are reproducible.
    """

    def __init__(self) -> None:
        self._rng = random.Random()

    @abc.abstractmethod
    def reset(self, seed: int = 0) -> Any:
        """Start a new episode and return the initial observation."""

    @abc.abstractmethod
    def step(self, action: Any) -> StepResult:
        """Apply ``action`` and return the resulting :class:`StepResult`."""

    @property
    @abc.abstractmethod
    def action_space(self) -> List[Any]:
        """The list of legal actions in the current state."""


_REGISTRY: Dict[str, Callable[[], Environment]] = {}


def register(name: str, factory: Callable[[], Environment]) -> None:
    """Register an environment factory under ``name``."""
    if name in _REGISTRY:
        raise ValueError(f"environment {name!r} is already registered")
    _REGISTRY[name] = factory


def make(name: str) -> Environment:
    """Instantiate a registered environment by name."""
    try:
        factory = _REGISTRY[name]
    except KeyError:
        known = ", ".join(sorted(_REGISTRY)) or "<none>"
        raise KeyError(f"unknown environment {name!r}; registered: {known}") from None
    return factory()


def registered_names() -> List[str]:
    """Names of all registered environments, sorted."""
    return sorted(_REGISTRY)
