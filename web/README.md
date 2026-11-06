# Gait Lab

`gait-lab.html` is a self-contained browser front-end for
`agent_sandbox.creature`: a 3D stage where you drive each muscle by hand,
or hand the lab a goal and watch an evolution strategy search for a gait.

Open the file directly in a browser, or publish it as an Artifact. It has
no build step and no runtime dependencies beyond a webfont.

## Why it matches the Python package

The physics in the page is a line-by-line port of `agent_sandbox.creature`
— same constants, same integration order, same morphologies in the same
spring order. Rollouts agree with Python to six decimal places, so a
controller trained in one runs identically in the other.

Controllers save in the `agent-sandbox-agent` JSON format, which means a
gait evolved in the browser loads straight into Python:

```python
from agent_sandbox import load_agent
from agent_sandbox.creature import MuscleController, make_morphology, rollout

ctrl = load_agent("quadruped-walk.json", factory=lambda: MuscleController(12))
traj = rollout(make_morphology(ctrl.morphology), ctrl, duration=5.0)
```

and a controller saved by `save_agent()` loads back into the page.

## Note on the save button

Saving a file from a published Artifact requires the `downloads` runtime
capability (`capabilities: {downloads: true}` at publish time) — a plain
`<a download>` link is inert inside the artifact viewer. The page detects
whether the capability is available and disables the button if not.

## Editing the experiment

The page's left rail has three editors, all of which round-trip through the
same `Experiment` JSON the Python package reads:

- **Body** — the node and spring tables. Edit coordinates, add or delete
  nodes and springs, and toggle any spring into a muscle. Definitions that
  couldn't be simulated are rejected with the reason, and the stage keeps
  showing the last body that worked. Hovering a row highlights that node or
  muscle on the stage.
- **Goal** — weights over nine measured terms of the trajectory. The four
  built-in goals are just weight sets you can load and then change; the
  live formula at the bottom shows what is being optimised.
- **World** — gravity, stiffness, damping, node mass, ground grip,
  bounciness and air drag, plus episode length and the search settings.

Bodies edited away from a shipped starting point are renamed (for example
`quadruped-edited`), and the trained example gaits are hidden for them,
since those controllers were evolved against the original geometry.
