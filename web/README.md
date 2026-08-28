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
