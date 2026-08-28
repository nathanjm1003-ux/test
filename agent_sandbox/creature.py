"""A small 3D mass-spring creature simulator with muscle-driven movement.

A creature is a set of point masses ("nodes") connected by springs. Some
springs are *muscles*: their rest length oscillates over time, driven by
control parameters you supply. Rhythmic contraction against ground
friction is what produces locomotion.

Muscle ``i`` has rest length::

    L_i(t) = L0_i * (1 + amp_i * sin(2*pi*freq*t + phase_i))

so a controller is just ``freq`` plus a per-muscle ``amp`` and ``phase``
(see :class:`MuscleController`). Set them by hand, or hand a goal to
:func:`evolve` and let an evolution strategy search for them.

Everything about the experiment is data you can edit:

- the **body** is a :class:`Morphology` — node positions plus the springs
  joining them, each flagged as a muscle or not (:func:`custom_morphology`)
- the **goal** is a :class:`GoalSpec` — weights over measured terms of the
  trajectory, so a new objective is a new set of weights, not new code
- the **physics** is a :class:`Physics` — gravity, stiffness, friction and
  the rest, all overridable per run

A whole experiment (body, goal, physics, controller) round-trips through
JSON with :func:`save_experiment` / :func:`load_experiment`.

Everything is deterministic: the same parameters and morphology always
produce the same trajectory, and :func:`evolve` is reproducible per seed.
"""

from __future__ import annotations

import json
import math
import random
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple, Union

from agent_sandbox.agent import Agent

AMP_LIMIT = 0.5
FREQ_LIMITS = (0.2, 3.5)


@dataclass(frozen=True)
class Physics:
    """Simulation constants. Defaults are tuned for stable dt=0.005 steps.

    Raising ``stiffness`` or ``dt`` far past the defaults will make the
    integrator diverge; :class:`CreatureSim` detects that and stops rather
    than producing garbage.
    """

    gravity: float = 9.81
    node_mass: float = 1.0
    stiffness: float = 1400.0
    spring_damping: float = 18.0
    air_drag: float = 0.15
    ground_friction: float = 0.90  # horizontal velocity kept per contact step
    ground_bounce: float = 0.15
    dt: float = 0.005
    max_speed: float = 40.0  # divergence guard
    min_rest_factor: float = 0.25  # a muscle can't collapse below this

    def to_dict(self) -> dict:
        return {
            "gravity": self.gravity,
            "node_mass": self.node_mass,
            "stiffness": self.stiffness,
            "spring_damping": self.spring_damping,
            "air_drag": self.air_drag,
            "ground_friction": self.ground_friction,
            "ground_bounce": self.ground_bounce,
            "dt": self.dt,
            "max_speed": self.max_speed,
            "min_rest_factor": self.min_rest_factor,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Physics":
        known = {f: d[f] for f in cls.__dataclass_fields__ if f in d}
        return cls(**known)


DEFAULT_PHYSICS = Physics()

# Module-level aliases kept for readability at call sites and for code
# written against the original constant-based API.
GRAVITY = DEFAULT_PHYSICS.gravity
NODE_MASS = DEFAULT_PHYSICS.node_mass
STIFFNESS = DEFAULT_PHYSICS.stiffness
SPRING_DAMPING = DEFAULT_PHYSICS.spring_damping
AIR_DRAG = DEFAULT_PHYSICS.air_drag
GROUND_FRICTION = DEFAULT_PHYSICS.ground_friction
GROUND_BOUNCE = DEFAULT_PHYSICS.ground_bounce
DT = DEFAULT_PHYSICS.dt
MAX_SPEED = DEFAULT_PHYSICS.max_speed
MIN_REST_FACTOR = DEFAULT_PHYSICS.min_rest_factor


@dataclass
class Spring:
    """A spring between two nodes; ``muscle`` springs oscillate."""

    a: int
    b: int
    rest: float
    muscle: bool = False


@dataclass
class Morphology:
    """A creature body: node positions plus the springs joining them."""

    name: str
    positions: List[Tuple[float, float, float]]
    springs: List[Spring]

    @property
    def muscle_indices(self) -> List[int]:
        return [i for i, s in enumerate(self.springs) if s.muscle]

    @property
    def num_muscles(self) -> int:
        return len(self.muscle_indices)

    def to_dict(self) -> dict:
        """Serialise to node positions and edges; rest lengths are geometric."""
        return {
            "name": self.name,
            "positions": [list(p) for p in self.positions],
            "springs": [{"a": s.a, "b": s.b, "muscle": s.muscle} for s in self.springs],
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Morphology":
        edges = [(s["a"], s["b"], bool(s.get("muscle", False))) for s in d["springs"]]
        return custom_morphology(d.get("name", "custom"), d["positions"], edges)


class MorphologyError(ValueError):
    """A body definition that could not be simulated."""


def custom_morphology(
    name: str,
    positions: Sequence[Sequence[float]],
    edges: Sequence[Sequence[Any]],
) -> Morphology:
    """Build a body from node positions and ``(a, b, is_muscle)`` edges.

    Rest lengths come from the geometry you pass, so a spring starts
    relaxed. Raises :class:`MorphologyError` on a definition the simulator
    could not run: a self-loop, an out-of-range node, a duplicated spring,
    a zero-length spring, or a node below the ground plane.
    """
    pos = [tuple(float(v) for v in p) for p in positions]
    if len(pos) < 2:
        raise MorphologyError("a body needs at least 2 nodes")
    if any(len(p) != 3 for p in pos):
        raise MorphologyError("every node needs exactly 3 coordinates")
    if any(p[1] < 0 for p in pos):
        raise MorphologyError("nodes cannot start below the ground plane (y >= 0)")

    springs: List[Spring] = []
    seen = set()
    for edge in edges:
        a, b = int(edge[0]), int(edge[1])
        muscle = bool(edge[2]) if len(edge) > 2 else False
        if a == b:
            raise MorphologyError(f"spring {a}-{b} joins a node to itself")
        if not (0 <= a < len(pos) and 0 <= b < len(pos)):
            raise MorphologyError(f"spring {a}-{b} refers to a node that doesn't exist")
        key = (min(a, b), max(a, b))
        if key in seen:
            raise MorphologyError(f"spring {a}-{b} is defined twice")
        seen.add(key)
        rest = math.dist(pos[a], pos[b])
        if rest < 1e-6:
            raise MorphologyError(f"spring {a}-{b} has zero length")
        springs.append(Spring(a=a, b=b, rest=rest, muscle=muscle))

    if not springs:
        raise MorphologyError("a body needs at least one spring")
    return Morphology(name=name, positions=pos, springs=springs)


def _build(name, positions, edges) -> Morphology:
    return custom_morphology(name, positions, edges)


def blob() -> Morphology:
    """Tetrahedron: 4 nodes, 6 springs, every one a muscle."""
    positions = [
        (0.50, 0.05, 0.00),
        (-0.25, 0.05, 0.433),
        (-0.25, 0.05, -0.433),
        (0.00, 0.75, 0.00),
    ]
    edges = [(a, b, True) for a in range(4) for b in range(a + 1, 4)]
    return _build("blob", positions, edges)


def quadruped() -> Morphology:
    """Rigid-ish body on four muscle legs with diagonal braces."""
    positions = [
        (0.35, 0.65, 0.25), (0.35, 0.65, -0.25),
        (-0.35, 0.65, -0.25), (-0.35, 0.65, 0.25),
        (0.45, 0.06, 0.35), (0.45, 0.06, -0.35),
        (-0.45, 0.06, -0.35), (-0.45, 0.06, 0.35),
    ]
    edges = [
        # body frame: structural, never actuated
        (0, 1, False), (1, 2, False), (2, 3, False), (3, 0, False),
        (0, 2, False), (1, 3, False),
        # one muscle per leg
        (0, 4, True), (1, 5, True), (2, 6, True), (3, 7, True),
        # braces that let each leg swing fore/aft and sideways
        (4, 1, True), (4, 3, True), (5, 0, True), (5, 2, True),
        (6, 1, True), (6, 3, True), (7, 0, True), (7, 2, True),
    ]
    return _build("quadruped", positions, edges)


def worm() -> Morphology:
    """Zig-zag chain that inches along by arching: 6 nodes, 9 muscles."""
    positions = []
    for i in range(6):
        positions.append((i * 0.28 - 0.7, 0.05 if i % 2 == 0 else 0.42, 0.0))
    edges = [(i, i + 1, True) for i in range(5)]
    edges += [(i, i + 2, True) for i in range(4)]
    return _build("worm", positions, edges)


MORPHOLOGIES: Dict[str, Callable[[], Morphology]] = {
    "blob": blob,
    "quadruped": quadruped,
    "worm": worm,
}


def register_morphology(name: str, factory: Callable[[], Morphology]) -> None:
    """Add a body plan to the registry so ``make_morphology`` can build it."""
    if name in MORPHOLOGIES:
        raise ValueError(f"morphology {name!r} is already registered")
    MORPHOLOGIES[name] = factory


def make_morphology(name: str) -> Morphology:
    try:
        return MORPHOLOGIES[name]()
    except KeyError:
        known = ", ".join(sorted(MORPHOLOGIES))
        raise KeyError(f"unknown morphology {name!r}; known: {known}") from None


@dataclass
class Trajectory:
    """What a rollout recorded about the creature's centre of mass."""

    start: Tuple[float, float, float]
    final: Tuple[float, float, float]
    max_height: float
    mean_height: float
    steps: int
    effort: float = 0.0  # mean |muscle strain| over the episode
    diverged: bool = False
    frames: List[List[Tuple[float, float, float]]] = field(default_factory=list)


class CreatureSim:
    """Semi-implicit Euler mass-spring simulator with a friction ground plane."""

    def __init__(self, morphology: Morphology,
                 physics: Physics = DEFAULT_PHYSICS) -> None:
        self.morphology = morphology
        self.physics = physics
        self.reset()

    def reset(self) -> None:
        self.t = 0.0
        self.pos = [list(p) for p in self.morphology.positions]
        self.vel = [[0.0, 0.0, 0.0] for _ in self.pos]
        self.diverged = False
        # Per-spring current rest length, exposed for rendering/inspection.
        self.rest = [s.rest for s in self.morphology.springs]

    def centre_of_mass(self) -> Tuple[float, float, float]:
        n = len(self.pos)
        return (
            sum(p[0] for p in self.pos) / n,
            sum(p[1] for p in self.pos) / n,
            sum(p[2] for p in self.pos) / n,
        )

    def step(self, freq: float, amps: Sequence[float], phases: Sequence[float]) -> None:
        """Advance one ``physics.dt`` tick under the given muscle parameters.

        ``amps``/``phases`` are indexed by *muscle number*, not spring index.
        """
        if self.diverged:
            return
        ph = self.physics
        dt, mass = ph.dt, ph.node_mass
        pos, vel = self.pos, self.vel
        springs = self.morphology.springs
        force = [[0.0, -ph.gravity * mass, 0.0] for _ in pos]

        omega = 2.0 * math.pi * freq * self.t
        muscle_no = 0
        for si, s in enumerate(springs):
            rest = s.rest
            if s.muscle:
                amp = amps[muscle_no] if muscle_no < len(amps) else 0.0
                phase = phases[muscle_no] if muscle_no < len(phases) else 0.0
                rest = s.rest * (1.0 + amp * math.sin(omega + phase))
                floor = s.rest * ph.min_rest_factor
                if rest < floor:
                    rest = floor
                muscle_no += 1
            self.rest[si] = rest

            pa, pb = pos[s.a], pos[s.b]
            dx, dy, dz = pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]
            length = math.sqrt(dx * dx + dy * dy + dz * dz)
            if length < 1e-9:
                continue
            ux, uy, uz = dx / length, dy / length, dz / length
            va, vb = vel[s.a], vel[s.b]
            closing = (vb[0] - va[0]) * ux + (vb[1] - va[1]) * uy + (vb[2] - va[2]) * uz
            mag = ph.stiffness * (length - rest) + ph.spring_damping * closing
            fa, fb = force[s.a], force[s.b]
            fa[0] += mag * ux; fa[1] += mag * uy; fa[2] += mag * uz
            fb[0] -= mag * ux; fb[1] -= mag * uy; fb[2] -= mag * uz

        drag = 1.0 - ph.air_drag * dt
        for i, p in enumerate(pos):
            v, f = vel[i], force[i]
            v[0] = (v[0] + f[0] / mass * dt) * drag
            v[1] = (v[1] + f[1] / mass * dt) * drag
            v[2] = (v[2] + f[2] / mass * dt) * drag
            p[0] += v[0] * dt
            p[1] += v[1] * dt
            p[2] += v[2] * dt
            if p[1] < 0.0:  # ground contact: no penetration, bounce, friction
                p[1] = 0.0
                if v[1] < 0.0:
                    v[1] = -ph.ground_bounce * v[1]
                v[0] *= ph.ground_friction
                v[2] *= ph.ground_friction
            speed = abs(v[0]) + abs(v[1]) + abs(v[2])
            if speed > ph.max_speed or not math.isfinite(speed):
                self.diverged = True
                return
        self.t += dt


def rollout(
    morphology: Morphology,
    controller: "MuscleController",
    duration: float = 6.0,
    record_every: int = 0,
    physics: Physics = DEFAULT_PHYSICS,
) -> Trajectory:
    """Simulate ``duration`` seconds and summarise the centre-of-mass path."""
    sim = CreatureSim(morphology, physics)
    start = sim.centre_of_mass()
    steps = int(duration / physics.dt)
    freq, amps, phases = controller.freq, controller.amps, controller.phases
    muscles = morphology.muscle_indices
    springs = morphology.springs
    max_h, height_sum, effort_sum = start[1], 0.0, 0.0
    frames: List[List[Tuple[float, float, float]]] = []
    done = 0
    for i in range(steps):
        sim.step(freq, amps, phases)
        if sim.diverged:
            break
        done = i + 1
        com = sim.centre_of_mass()
        height_sum += com[1]
        max_h = max(max_h, com[1])
        if muscles:
            effort_sum += sum(
                abs(sim.rest[si] / springs[si].rest - 1.0) for si in muscles
            ) / len(muscles)
        if record_every and i % record_every == 0:
            frames.append([tuple(p) for p in sim.pos])
    return Trajectory(
        start=start,
        final=sim.centre_of_mass(),
        max_height=max_h,
        mean_height=height_sum / done if done else start[1],
        steps=done,
        effort=effort_sum / done if done else 0.0,
        diverged=sim.diverged,
        frames=frames,
    )


# --------------------------------------------------------------------------
# Goals: measured terms of a trajectory, combined by weights
# --------------------------------------------------------------------------

Goal = Callable[[Trajectory], float]

#: Every term a goal can weigh, as a function of the recorded trajectory.
#: Weights carry the sign, so a penalty is just a negative weight.
GOAL_TERMS: Dict[str, Callable[[Trajectory, Tuple[float, float]], float]] = {
    "forward": lambda t, _: t.final[0] - t.start[0],
    "lateral": lambda t, _: t.final[2] - t.start[2],
    "sideways": lambda t, _: abs(t.final[2] - t.start[2]),
    "travel": lambda t, _: math.dist((t.start[0], t.start[2]), (t.final[0], t.final[2])),
    "peak_height": lambda t, _: t.max_height - t.start[1],
    "mean_height": lambda t, _: t.mean_height,
    "final_height": lambda t, _: t.final[1],
    "to_target": lambda t, g: (math.dist((t.start[0], t.start[2]), g)
                               - math.dist((t.final[0], t.final[2]), g)),
    "effort": lambda t, _: t.effort,
}


@dataclass
class GoalSpec:
    """A goal as weights over :data:`GOAL_TERMS`.

    ``score(traj)`` is ``sum(weight * term(traj))``. Because weights carry
    the sign, a penalty is a negative weight — walking is ``forward=1``
    with ``sideways=-0.3``. Instances are callable, so a ``GoalSpec`` can
    be passed anywhere a goal function is expected.
    """

    weights: Dict[str, float] = field(default_factory=dict)
    target: Tuple[float, float] = (0.0, 0.0)
    name: str = "custom"

    def __post_init__(self) -> None:
        unknown = set(self.weights) - set(GOAL_TERMS)
        if unknown:
            known = ", ".join(sorted(GOAL_TERMS))
            raise KeyError(
                f"unknown goal term(s) {sorted(unknown)}; known terms: {known}"
            )
        self.target = (float(self.target[0]), float(self.target[1]))

    def score(self, traj: Trajectory) -> float:
        return sum(w * GOAL_TERMS[term](traj, self.target)
                   for term, w in self.weights.items() if w)

    def __call__(self, traj: Trajectory) -> float:
        return self.score(traj)

    def describe(self) -> str:
        """The goal as a readable formula, e.g. ``1·forward - 0.3·sideways``."""
        parts = [f"{w:+g}·{term}" for term, w in self.weights.items() if w]
        return " ".join(parts) if parts else "0 (no terms weighted)"

    def to_dict(self) -> dict:
        return {"name": self.name, "weights": dict(self.weights),
                "target": list(self.target)}

    @classmethod
    def from_dict(cls, d: dict) -> "GoalSpec":
        return cls(weights=dict(d.get("weights", {})),
                   target=tuple(d.get("target", (0.0, 0.0))),
                   name=d.get("name", "custom"))


#: The built-in goals, expressed in the same weights any custom goal uses.
GOAL_PRESETS: Dict[str, GoalSpec] = {
    "walk": GoalSpec({"forward": 1.0, "sideways": -0.3}, name="walk"),
    "jump": GoalSpec({"peak_height": 1.0}, name="jump"),
    "stand": GoalSpec({"mean_height": 1.0, "travel": -0.5}, name="stand"),
    "reach": GoalSpec({"to_target": 1.0}, target=(3.0, 3.0), name="reach"),
}

# Plain functions, kept for direct use and for readable imports.
walk_forward = GOAL_PRESETS["walk"]
jump_high = GOAL_PRESETS["jump"]
stand_tall = GOAL_PRESETS["stand"]


def reach_target(x: float, z: float) -> GoalSpec:
    """Close the horizontal distance to ``(x, z)``."""
    return GoalSpec({"to_target": 1.0}, target=(x, z), name=f"reach:{x},{z}")


GOALS: Dict[str, GoalSpec] = {
    "walk": walk_forward,
    "jump": jump_high,
    "stand": stand_tall,
}


def make_goal(spec: Union[str, dict, GoalSpec]) -> GoalSpec:
    """Build a goal from a preset name, a ``reach:X,Z`` string, or weights."""
    if isinstance(spec, GoalSpec):
        return spec
    if isinstance(spec, dict):
        return GoalSpec.from_dict(spec)
    if spec.startswith("reach:"):
        _, coords = spec.split(":", 1)
        x, z = (float(v) for v in coords.split(","))
        return reach_target(x, z)
    try:
        return GOAL_PRESETS[spec]
    except KeyError:
        known = ", ".join(sorted(GOAL_PRESETS)) + ", reach:X,Z"
        raise KeyError(f"unknown goal {spec!r}; known: {known}") from None


DIVERGED_FITNESS = -1000.0


def fitness(morphology: Morphology, controller: "MuscleController",
            goal: Goal, duration: float = 6.0,
            physics: Physics = DEFAULT_PHYSICS) -> float:
    """Score a controller on ``goal``; a diverged sim scores far below any real run."""
    traj = rollout(morphology, controller, duration=duration, physics=physics)
    if traj.diverged:
        return DIVERGED_FITNESS
    return goal(traj)


# --------------------------------------------------------------------------
# Controller
# --------------------------------------------------------------------------


class MuscleController(Agent):
    """The muscle control parameters: a global ``freq`` plus per-muscle amp/phase.

    Persistable through :func:`agent_sandbox.save_agent`, so a trained
    creature can be written to a file and loaded back later.
    """

    def __init__(self, num_muscles: int, freq: float = 1.2,
                 amps: Optional[Sequence[float]] = None,
                 phases: Optional[Sequence[float]] = None,
                 morphology: str = "") -> None:
        super().__init__()
        self.num_muscles = num_muscles
        self.morphology = morphology
        self.freq = _clamp(freq, *FREQ_LIMITS)
        self.amps = [0.0] * num_muscles if amps is None else [
            _clamp(a, -AMP_LIMIT, AMP_LIMIT) for a in amps]
        self.phases = [0.0] * num_muscles if phases is None else [
            float(p) % (2 * math.pi) for p in phases]
        self.generations_trained = 0

    @classmethod
    def random(cls, morphology: Morphology, seed: int = 0) -> "MuscleController":
        rng = random.Random(f"MuscleController:{seed}")
        n = morphology.num_muscles
        return cls(
            n,
            freq=rng.uniform(0.6, 2.0),
            amps=[rng.uniform(-0.3, 0.3) for _ in range(n)],
            phases=[rng.uniform(0, 2 * math.pi) for _ in range(n)],
            morphology=morphology.name,
        )

    def resized(self, num_muscles: int) -> "MuscleController":
        """Fit this controller to a body with a different muscle count.

        Parameters for muscles that still exist are kept; new muscles start
        slack. Used when a body plan is edited under a live controller.
        """
        amps = (self.amps + [0.0] * num_muscles)[:num_muscles]
        phases = (self.phases + [0.0] * num_muscles)[:num_muscles]
        out = MuscleController(num_muscles, self.freq, amps, phases, self.morphology)
        out.generations_trained = self.generations_trained
        return out

    # The Agent interface: an "action" here is the muscle rest-length
    # multipliers at the current time, which the sim applies directly.
    def act(self, observation, action_space=None):
        t = observation.get("t", 0.0) if isinstance(observation, dict) else 0.0
        omega = 2 * math.pi * self.freq * t
        return [1.0 + self.amps[i] * math.sin(omega + self.phases[i])
                for i in range(self.num_muscles)]

    def to_vector(self) -> List[float]:
        return [self.freq] + list(self.amps) + list(self.phases)

    def load_vector(self, vec: Sequence[float]) -> "MuscleController":
        n = self.num_muscles
        self.freq = _clamp(vec[0], *FREQ_LIMITS)
        self.amps = [_clamp(v, -AMP_LIMIT, AMP_LIMIT) for v in vec[1:1 + n]]
        self.phases = [v % (2 * math.pi) for v in vec[1 + n:1 + 2 * n]]
        return self

    def copy(self) -> "MuscleController":
        return MuscleController(self.num_muscles, self.freq, self.amps,
                                self.phases, self.morphology)

    def get_state(self) -> dict:
        return {
            "num_muscles": self.num_muscles,
            "morphology": self.morphology,
            "freq": self.freq,
            "amps": list(self.amps),
            "phases": list(self.phases),
            "generations_trained": self.generations_trained,
        }

    def set_state(self, state: dict) -> None:
        self.num_muscles = state["num_muscles"]
        self.morphology = state.get("morphology", "")
        self.freq = state["freq"]
        self.amps = list(state["amps"])
        self.phases = list(state["phases"])
        self.generations_trained = state.get("generations_trained", 0)


def _clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else hi if v > hi else v


# --------------------------------------------------------------------------
# Training: (mu, lambda) evolution strategy
# --------------------------------------------------------------------------


@dataclass
class EvolutionReport:
    """Best controller found plus per-generation fitness history."""

    best: MuscleController
    best_fitness: float
    history: List[float]  # best-so-far fitness per generation
    mean_history: List[float]

    def summary(self) -> str:
        return (
            f"generations={len(self.history)} "
            f"best_fitness={self.best_fitness:.3f} "
            f"start={self.history[0]:.3f}"
        )


def evolve(
    morphology: Morphology,
    goal: Goal,
    generations: int = 30,
    population: int = 20,
    elite_frac: float = 0.25,
    sigma: float = 0.25,
    sigma_decay: float = 0.94,
    duration: float = 6.0,
    seed: int = 0,
    start_from: Optional[MuscleController] = None,
    on_generation: Optional[Callable[[int, float, MuscleController], None]] = None,
    physics: Physics = DEFAULT_PHYSICS,
) -> EvolutionReport:
    """Search muscle parameters for ``goal`` with a (mu, lambda) strategy.

    Each generation samples ``population`` controllers around the current
    mean, keeps the top ``elite_frac``, and recentres the mean on them.
    ``sigma`` shrinks by ``sigma_decay`` each generation so the search
    refines. Deterministic given ``seed``.
    """
    rng = random.Random(f"evolve:{seed}")
    n_elite = max(2, int(population * elite_frac))
    base = (start_from.copy() if start_from
            else MuscleController.random(morphology, seed=seed))
    if base.num_muscles != morphology.num_muscles:
        base = base.resized(morphology.num_muscles)
    mean = base.to_vector()
    template = MuscleController(morphology.num_muscles, morphology=morphology.name)

    best = base.copy()
    best_fit = fitness(morphology, best, goal, duration, physics)
    history: List[float] = []
    mean_history: List[float] = []
    s = sigma

    for gen in range(generations):
        scored: List[Tuple[float, List[float]]] = []
        for _ in range(population):
            cand = [m + rng.gauss(0.0, s) for m in mean]
            ctrl = template.copy().load_vector(cand)
            scored.append((fitness(morphology, ctrl, goal, duration, physics),
                           ctrl.to_vector()))
        scored.sort(key=lambda pair: pair[0], reverse=True)
        elite = [vec for _, vec in scored[:n_elite]]
        mean = [sum(vec[i] for vec in elite) / len(elite) for i in range(len(mean))]

        if scored[0][0] > best_fit:
            best_fit = scored[0][0]
            best = template.copy().load_vector(scored[0][1])
        best.generations_trained += 1
        history.append(best_fit)
        mean_history.append(sum(f for f, _ in scored) / len(scored))
        s *= sigma_decay
        if on_generation:
            on_generation(gen, best_fit, best)

    return EvolutionReport(best=best, best_fitness=best_fit,
                           history=history, mean_history=mean_history)


# --------------------------------------------------------------------------
# Experiments: body + goal + physics + controller, as one file
# --------------------------------------------------------------------------

EXPERIMENT_FORMAT = "gait-lab-experiment"
EXPERIMENT_VERSION = 1


@dataclass
class Experiment:
    """A complete, reproducible setup: what body, what goal, what physics."""

    morphology: Morphology
    goal: GoalSpec = field(default_factory=lambda: GOAL_PRESETS["walk"])
    physics: Physics = DEFAULT_PHYSICS
    controller: Optional[MuscleController] = None
    duration: float = 6.0

    def to_dict(self) -> dict:
        return {
            "format": EXPERIMENT_FORMAT,
            "version": EXPERIMENT_VERSION,
            "duration": self.duration,
            "body": self.morphology.to_dict(),
            "goal": self.goal.to_dict(),
            "physics": self.physics.to_dict(),
            "controller": self.controller.get_state() if self.controller else None,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Experiment":
        if d.get("format") != EXPERIMENT_FORMAT:
            raise ValueError("not a gait-lab experiment file")
        morph = Morphology.from_dict(d["body"])
        ctrl = None
        if d.get("controller"):
            ctrl = MuscleController(morph.num_muscles)
            ctrl.set_state(d["controller"])
            if ctrl.num_muscles != morph.num_muscles:
                raise ValueError(
                    f"controller drives {ctrl.num_muscles} muscles but the body "
                    f"has {morph.num_muscles}"
                )
        return cls(
            morphology=morph,
            goal=GoalSpec.from_dict(d.get("goal", {})),
            physics=Physics.from_dict(d.get("physics", {})),
            controller=ctrl,
            duration=float(d.get("duration", 6.0)),
        )

    def run(self, record_every: int = 0) -> Trajectory:
        """Roll out this experiment's controller under its own physics."""
        ctrl = self.controller or MuscleController(self.morphology.num_muscles)
        return rollout(self.morphology, ctrl, duration=self.duration,
                       record_every=record_every, physics=self.physics)

    def evolve(self, **kwargs) -> EvolutionReport:
        """Train on this experiment's goal, body and physics."""
        kwargs.setdefault("duration", self.duration)
        kwargs.setdefault("start_from", self.controller)
        return evolve(self.morphology, self.goal, physics=self.physics, **kwargs)


def save_experiment(experiment: Experiment, path: Union[str, Path]) -> None:
    """Write a whole experiment to JSON."""
    Path(path).write_text(json.dumps(experiment.to_dict(), indent=2))


def load_experiment(path: Union[str, Path]) -> Experiment:
    """Read an experiment written by :func:`save_experiment` or the Gait Lab page."""
    return Experiment.from_dict(json.loads(Path(path).read_text()))
