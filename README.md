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

## 3D movement simulator

`agent_sandbox.creature` simulates creatures built from point masses joined
by springs. Springs marked as *muscles* have an oscillating rest length:

    L_i(t) = L0_i * (1 + amp_i * sin(2*pi*freq*t + phase_i))

so a controller is one global `freq` plus a per-muscle `amp` and `phase`.
Rhythmic contraction pushing against ground friction is what produces
locomotion — nothing about walking is hard-coded.

Three body plans ship in `MORPHOLOGIES`: `blob` (tetrahedron, 6 muscles),
`quadruped` (rigid body on four muscle legs, 12 muscles), and `worm`
(zig-zag chain that inches along, 9 muscles). Set the parameters by hand,
or hand `evolve()` a goal — `walk`, `jump`, `stand`, or `reach:X,Z` — and
let a (mu, lambda) evolution strategy search for them:

```python
from agent_sandbox import evolve, make_goal, make_morphology, rollout, save_agent

morph = make_morphology("quadruped")
report = evolve(morph, make_goal("walk"), generations=30, population=20, seed=0)

traj = rollout(morph, report.best)
print(f"walked {traj.final[0] - traj.start[0]:.2f} m")
save_agent(report.best, "walker.json")     # trained creatures are persistable
```

`examples/evolve_walker.py` runs this from the command line with a live
fitness bar per generation. The simulation is deterministic — the same
parameters always yield the same trajectory — and `evolve` is reproducible
per seed.

### Everything is editable

The body, the goal and the physics are all data, not code.

A **body** is node positions plus `(a, b, is_muscle)` edges; rest lengths
come from the geometry, so a spring starts relaxed. Definitions that
couldn't be simulated (self-loops, duplicate springs, nodes below the
floor) raise `MorphologyError` rather than failing later:

```python
from agent_sandbox import custom_morphology

tripod = custom_morphology("tripod",
    [(0.4, 0.05, 0), (-0.2, 0.05, 0.35), (-0.2, 0.05, -0.35), (0, 0.6, 0)],
    [(0, 3, True), (1, 3, True), (2, 3, True),      # three muscle legs
     (0, 1, False), (1, 2, False), (2, 0, False)])  # a rigid base
```

A **goal** is weights over measured terms of the trajectory — `forward`,
`lateral`, `sideways`, `travel`, `peak_height`, `mean_height`,
`final_height`, `to_target`, `effort`. Weights carry the sign, so a
penalty is a negative weight, and the built-in goals are just weight sets
(`walk` is `forward=1, sideways=-0.3`). A new objective needs no new code:

```python
from agent_sandbox import GoalSpec

efficient = GoalSpec({"forward": 1.0, "effort": -0.5}, name="walk cheaply")
hop = GoalSpec({"peak_height": 1.0, "travel": -1.0}, name="hop in place")
```

**Physics** is a frozen `Physics` record you pass per run — gravity,
stiffness, damping, ground friction, bounce, timestep:

```python
from agent_sandbox import Physics, rollout
rollout(tripod, ctrl, physics=Physics(gravity=1.6))   # lunar
```

An **`Experiment`** bundles body, goal, physics and controller, and
round-trips through one JSON file that the Gait Lab page also reads and
writes:

```python
from agent_sandbox import Experiment, save_experiment, load_experiment

exp = Experiment(morphology=tripod, goal=efficient, physics=Physics(gravity=6.0))
report = exp.evolve(generations=30, seed=0)
exp.controller = report.best
save_experiment(exp, "tripod.json")
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
