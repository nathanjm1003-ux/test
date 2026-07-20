"""agent_sandbox: a lightweight testing sandbox for ML / AI agents.

The sandbox has three pillars:

- Environments (``agent_sandbox.environments``): small, deterministic,
  seedable tasks with a Gym-style ``reset``/``step`` API.
- Agents (``agent_sandbox.agent``): a minimal ``Agent`` interface plus
  reference baselines to test the harness against.
- Harness (``agent_sandbox.harness``): runs episodes under step/time
  budgets and aggregates metrics across seeds.

For tool-using (LLM-style) agents, ``agent_sandbox.tools`` provides a
``ToolSandbox`` that records every call, enforces call budgets, and
blocks unregistered tools.
"""

from agent_sandbox.agent import Agent, RandomAgent
from agent_sandbox.environment import Environment, StepResult, make, register
from agent_sandbox.harness import EpisodeResult, EvalReport, evaluate, run_episode
from agent_sandbox.tools import ToolBudgetExceeded, ToolCall, ToolNotAllowed, ToolSandbox

# Importing the environments package registers the built-in environments.
from agent_sandbox import environments as _environments  # noqa: F401

__all__ = [
    "Agent",
    "RandomAgent",
    "Environment",
    "StepResult",
    "make",
    "register",
    "EpisodeResult",
    "EvalReport",
    "evaluate",
    "run_episode",
    "ToolSandbox",
    "ToolCall",
    "ToolBudgetExceeded",
    "ToolNotAllowed",
]

__version__ = "0.1.0"
