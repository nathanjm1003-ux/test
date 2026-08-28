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

For continuous control, ``agent_sandbox.creature`` is a 3D mass-spring
movement simulator: creatures are point masses joined by springs, some of
which are muscles driven by control parameters, and :func:`evolve`
searches those parameters for a goal such as walking or jumping.
"""

from agent_sandbox.agent import Agent, RandomAgent
from agent_sandbox.creature import (
    CreatureSim,
    EvolutionReport,
    Experiment,
    GoalSpec,
    Morphology,
    MorphologyError,
    MuscleController,
    Physics,
    custom_morphology,
    evolve,
    fitness,
    load_experiment,
    make_goal,
    make_morphology,
    register_morphology,
    rollout,
    save_experiment,
)
from agent_sandbox.environment import Environment, StepResult, make, register
from agent_sandbox.harness import EpisodeResult, EvalReport, evaluate, run_episode
from agent_sandbox.persistence import load_agent, save_agent
from agent_sandbox.qlearning import QLearningAgent, train
from agent_sandbox.tools import ToolBudgetExceeded, ToolCall, ToolNotAllowed, ToolSandbox

# Importing the environments package registers the built-in environments.
from agent_sandbox import environments as _environments  # noqa: F401

__all__ = [
    "Agent",
    "RandomAgent",
    "QLearningAgent",
    "train",
    "save_agent",
    "load_agent",
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
    "CreatureSim",
    "MuscleController",
    "EvolutionReport",
    "evolve",
    "fitness",
    "rollout",
    "make_morphology",
    "make_goal",
    "Morphology",
    "MorphologyError",
    "custom_morphology",
    "register_morphology",
    "GoalSpec",
    "Physics",
    "Experiment",
    "save_experiment",
    "load_experiment",
]

__version__ = "0.1.0"
