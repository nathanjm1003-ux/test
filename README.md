# agent-sandbox

A lightweight, dependency-free testing sandbox for machine learning / AI agents.
Everything is pure Python stdlib (pytest only for the test suite), deterministic,
and seedable, so agent behavior can be tested reproducibly in CI.

## What's inside

| Component | Module | Purpose |
|---|---|---|
| Environments | `agent_sandbox.environments` | Small Gym-style tasks: `grid_world`, `bandit`, `guess_number` |
| Agent interface | `agent_sandbox.agent` | `Agent` base class (`reset` / `act` / `observe`) + `RandomAgent` baseline |
| Harness | `agent_sandbox.harness` | Runs episodes under step/time budgets, contains agent crashes, aggregates metrics across seeds |
| Tool sandbox | `agent_sandbox.tools` | For tool-using (LLM-style) agents: records every call, enforces call budgets, blocks unregistered tools |

## Quick start

```bash
pip install -e ".[dev]"
pytest              # run the test suite
python examples/run_demo.py
```

## Evaluating an agent

```python
from agent_sandbox import Agent, evaluate

class MyAgent(Agent):
    def act(self, observation, action_space):
        return action_space[0]

report = evaluate(MyAgent(), "grid_world", num_episodes=20, max_steps=200)
print(report.summary())
# episodes=20 solve_rate=0.05 mean_reward=... mean_steps=... error_rate=0.00
```

Key safety properties of the harness:

- **Budgets** — `max_steps` and `time_limit_s` truncate runaway episodes.
- **Crash containment** — exceptions raised by the agent (or invalid actions
  rejected by the environment) end the episode and are recorded on
  `EpisodeResult.error` instead of crashing the evaluation.
- **Reproducibility** — each episode runs on an explicit seed; identical
  agent + environment + seed always produce identical results.

## Training and saving agents

`QLearningAgent` is a tabular Q-learner whose Q-table survives across
episodes. `train()` runs it repeatedly on one fixed map (same env seed,
varying exploration), and any agent with `get_state`/`set_state` can be
saved to a JSON file and restored later:

```python
from agent_sandbox import QLearningAgent, train, save_agent, load_agent, run_episode
from agent_sandbox.environments import GridWorld

env = GridWorld(size=5)
agent = QLearningAgent(state_fn=lambda obs: obs["position"])
train(agent, env, episodes=300, seed=3)

save_agent(agent, "trained.json")
agent = load_agent("trained.json", factory=lambda: QLearningAgent(state_fn=lambda o: o["position"]))

agent.epsilon = 0.0                     # act greedily
print(run_episode(agent, env, seed=3).total_reward)
```

## Testing tool-using agents

```python
from agent_sandbox import ToolSandbox

sandbox = ToolSandbox(max_total_calls=20)
sandbox.register("search", my_search_fn, max_calls=5)

sandbox.call("search", "query")        # runs and records the call
sandbox.call("rm_rf")                  # raises ToolNotAllowed
sandbox.transcript                     # full ordered record: args, results, errors, timing
```

## Adding an environment

Subclass `Environment`, implement `reset` / `step` / `action_space`
(deterministic given the seed), and register it:

```python
from agent_sandbox import register
register("my_task", MyTask)
```

It's then available to `make("my_task")` and `evaluate(agent, "my_task", ...)`.
