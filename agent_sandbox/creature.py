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

Everything is deterministic: the same parameters and morphology always
produce the same trajectory, and :func:`evolve` is reproducible per seed.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Sequence, Tuple

from agent_sandbox.agent import Agent

# --- physical constants (SI-ish; tuned for stable dt=0.005 integration) ---
GRAVITY = 9.81
NODE_MASS = 1.0
STIFFNESS = 1400.0
SPRING_DAMPING = 18.0
AIR_DRAG = 0.15
GROUND_FRICTION = 0.90  # horizontal velocity retained per contact step
GROUND_BOUNCE = 0.15
DT = 0.005
MAX_SPEED = 40.0  # clamp, so a bad controller diverges gracefully

AMP_LIMIT = 0.5
FREQ_LIMITS = (0.2, 3.5)
MIN_REST_FACTOR = 0.25


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


def _build(name: str, positions, edges) -> Morphology:
    """``edges`` is a list of ``(a, b, is_muscle)``; rest lengths from geometry."""
    springs = []
    for a, b, muscle in edges:
        ax, ay, az = positions[a]
        bx, by, bz = positions[b]
        rest = math.dist((ax, ay, az), (bx, by, bz))
        springs.append(Spring(a=a, b=b, rest=rest, muscle=muscle))
    return Morphology(name=name, positions=[tuple(p) for p in positions], springs=springs)


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
    diverged: bool = False
    frames: List[List[Tuple[float, float, float]]] = field(default_factory=list)


class CreatureSim:
    """Semi-implicit Euler mass-spring simulator with a friction ground plane."""

    def __init__(self, morphology: Morphology) -> None:
        self.morphology = morphology
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
        """Advance one ``DT`` tick under the given muscle parameters.

        ``amps``/``phases`` are indexed by *muscle number*, not spring index.
        """
        if self.diverged:
            return
        pos, vel = self.pos, self.vel
        springs = self.morphology.springs
        force = [[0.0, -GRAVITY * NODE_MASS, 0.0] for _ in pos]

        omega = 2.0 * math.pi * freq * self.t
        muscle_no = 0
        for si, s in enumerate(springs):
            rest = s.rest
            if s.muscle:
                amp = amps[muscle_no] if muscle_no < len(amps) else 0.0
                phase = phases[muscle_no] if muscle_no < len(phases) else 0.0
                rest = s.rest * (1.0 + amp * math.sin(omega + phase))
                if rest < s.rest * MIN_REST_FACTOR:
                    rest = s.rest * MIN_REST_FACTOR
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
            mag = STIFFNESS * (length - rest) + SPRING_DAMPING * closing
            fa, fb = force[s.a], force[s.b]
            fa[0] += mag * ux; fa[1] += mag * uy; fa[2] += mag * uz
            fb[0] -= mag * ux; fb[1] -= mag * uy; fb[2] -= mag * uz

        drag = 1.0 - AIR_DRAG * DT
        for i, p in enumerate(pos):
            v, f = vel[i], force[i]
            v[0] = (v[0] + f[0] / NODE_MASS * DT) * drag
            v[1] = (v[1] + f[1] / NODE_MASS * DT) * drag
            v[2] = (v[2] + f[2] / NODE_MASS * DT) * drag
            p[0] += v[0] * DT
            p[1] += v[1] * DT
            p[2] += v[2] * DT
            if p[1] < 0.0:  # ground contact: no penetration, bounce, friction
                p[1] = 0.0
                if v[1] < 0.0:
                    v[1] = -GROUND_BOUNCE * v[1]
                v[0] *= GROUND_FRICTION
                v[2] *= GROUND_FRICTION
            speed = abs(v[0]) + abs(v[1]) + abs(v[2])
            if speed > MAX_SPEED or not math.isfinite(speed):
                self.diverged = True
                return
        self.t += DT


def rollout(
    morphology: Morphology,
    controller: "MuscleController",
    duration: float = 6.0,
    record_every: int = 0,
) -> Trajectory:
    """Simulate ``duration`` seconds and summarise the centre-of-mass path."""
    sim = CreatureSim(morphology)
    start = sim.centre_of_mass()
    steps = int(duration / DT)
    freq, amps, phases = controller.freq, controller.amps, controller.phases
    max_h, height_sum = start[1], 0.0
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
        if record_every and i % record_every == 0:
            frames.append([tuple(p) for p in sim.pos])
    return Trajectory(
        start=start,
        final=sim.centre_of_mass(),
        max_height=max_h,
        mean_height=height_sum / done if done else start[1],
        steps=done,
        diverged=sim.diverged,
        frames=frames,
    )


# --------------------------------------------------------------------------
# Goals
# --------------------------------------------------------------------------

Goal = Callable[[Trajectory], float]


def walk_forward(traj: Trajectory) -> float:
    """Distance travelled along +x, penalising sideways drift."""
    return (traj.final[0] - traj.start[0]) - 0.3 * abs(traj.final[2] - traj.start[2])


def jump_high(traj: Trajectory) -> float:
    """Peak centre-of-mass height above where it started."""
    return traj.max_height - traj.start[1]


def stand_tall(traj: Trajectory) -> float:
    """Stay tall and stay put."""
    drift = math.dist((traj.final[0], traj.final[2]), (traj.start[0], traj.start[2]))
    return traj.mean_height - 0.5 * drift


def reach_target(x: float, z: float) -> Goal:
    """Close the horizontal distance to ``(x, z)``."""

    def goal(traj: Trajectory) -> float:
        d0 = math.dist((traj.start[0], traj.start[2]), (x, z))
        d1 = math.dist((traj.final[0], traj.final[2]), (x, z))
        return d0 - d1

    return goal


GOALS: Dict[str, Goal] = {
    "walk": walk_forward,
    "jump": jump_high,
    "stand": stand_tall,
}


def make_goal(name: str) -> Goal:
    if name.startswith("reach:"):
        _, coords = name.split(":", 1)
        x, z = (float(v) for v in coords.split(","))
        return reach_target(x, z)
    try:
        return GOALS[name]
    except KeyError:
        known = ", ".join(sorted(GOALS)) + ", reach:X,Z"
        raise KeyError(f"unknown goal {name!r}; known: {known}") from None


DIVERGED_FITNESS = -1000.0


def fitness(morphology: Morphology, controller: "MuscleController",
            goal: Goal, duration: float = 6.0) -> float:
    """Score a controller on ``goal``; a diverged sim scores far below any real run."""
    traj = rollout(morphology, controller, duration=duration)
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
    mean = base.to_vector()
    template = MuscleController(morphology.num_muscles, morphology=morphology.name)

    best = base.copy()
    best_fit = fitness(morphology, best, goal, duration)
    history: List[float] = []
    mean_history: List[float] = []
    s = sigma

    for gen in range(generations):
        scored: List[Tuple[float, List[float]]] = []
        for _ in range(population):
            cand = [m + rng.gauss(0.0, s) for m in mean]
            ctrl = template.copy().load_vector(cand)
            scored.append((fitness(morphology, ctrl, goal, duration), ctrl.to_vector()))
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
