"""Save and load agents as JSON files.

Any agent whose ``get_state`` returns a JSON-serializable dict (and whose
``set_state`` restores it) can round-trip through :func:`save_agent` /
:func:`load_agent`. Built-in persistable agents load by class name;
custom agents pass an explicit ``factory``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Callable, Dict, Optional, Union

from agent_sandbox.agent import Agent
from agent_sandbox.qlearning import QLearningAgent

FORMAT = "agent-sandbox-agent"
VERSION = 1

_BUILTIN: Dict[str, Callable[[], Agent]] = {
    "QLearningAgent": QLearningAgent,
}


def save_agent(agent: Agent, path: Union[str, Path]) -> None:
    """Write ``agent``'s state to ``path`` as JSON."""
    state = agent.get_state()
    if state is None:
        raise TypeError(
            f"{type(agent).__name__} does not support persistence "
            "(get_state returned None)"
        )
    payload = {
        "format": FORMAT,
        "version": VERSION,
        "agent_class": type(agent).__name__,
        "state": state,
    }
    Path(path).write_text(json.dumps(payload, indent=2))


def load_agent(
    path: Union[str, Path],
    factory: Optional[Callable[[], Agent]] = None,
) -> Agent:
    """Instantiate an agent from a file written by :func:`save_agent`.

    ``factory`` builds the empty agent to restore into; when omitted, the
    saved class name is looked up among the built-in persistable agents.
    Note that non-serializable constructor arguments (e.g. a ``state_fn``)
    are not saved — pass a ``factory`` that supplies them.
    """
    payload = json.loads(Path(path).read_text())
    if payload.get("format") != FORMAT:
        raise ValueError(f"{path} is not an agent-sandbox agent file")
    if factory is None:
        cls_name = payload["agent_class"]
        factory = _BUILTIN.get(cls_name)
        if factory is None:
            raise ValueError(
                f"no built-in agent class {cls_name!r}; pass a factory"
            )
    agent = factory()
    agent.set_state(payload["state"])
    return agent
