import math

import pytest

from agent_sandbox import load_agent, save_agent
from agent_sandbox.creature import (
    AMP_LIMIT,
    DIVERGED_FITNESS,
    FREQ_LIMITS,
    CreatureSim,
    MuscleController,
    evolve,
    fitness,
    jump_high,
    make_goal,
    make_morphology,
    rollout,
    walk_forward,
)

MORPHS = ["blob", "quadruped", "worm"]


@pytest.mark.parametrize("name", MORPHS)
def test_morphology_geometry(name):
    m = make_morphology(name)
    assert m.num_muscles > 0
    for s in m.springs:
        assert s.a != s.b
        assert s.rest > 0
        assert 0 <= s.a < len(m.positions) and 0 <= s.b < len(m.positions)
    assert all(y >= 0 for _, y, _ in m.positions)  # starts on/above the ground


def test_unknown_morphology_and_goal():
    with pytest.raises(KeyError, match="unknown morphology"):
        make_morphology("dragon")
    with pytest.raises(KeyError, match="unknown goal"):
        make_goal("fly")


@pytest.mark.parametrize("name", MORPHS)
def test_inert_creature_settles_and_stays_put(name):
    m = make_morphology(name)
    traj = rollout(m, MuscleController(m.num_muscles), duration=4.0)
    assert not traj.diverged
    horizontal = math.dist((traj.start[0], traj.start[2]), (traj.final[0], traj.final[2]))
    assert horizontal < 0.05  # no muscle activity, no locomotion
    assert traj.final[1] >= 0.0  # never sinks through the floor


@pytest.mark.parametrize("name", MORPHS)
def test_never_penetrates_ground(name):
    m = make_morphology(name)
    ctrl = MuscleController.random(m, seed=4)
    sim = CreatureSim(m)
    for _ in range(600):
        sim.step(ctrl.freq, ctrl.amps, ctrl.phases)
        if sim.diverged:
            break
        assert all(p[1] >= -1e-9 for p in sim.pos)


def test_simulation_is_deterministic():
    m = make_morphology("quadruped")
    ctrl = MuscleController.random(m, seed=1)
    a = rollout(m, ctrl, duration=3.0)
    b = rollout(m, ctrl, duration=3.0)
    assert a.final == b.final and a.max_height == b.max_height


def horizontal_travel(morph, ctrl, duration=4.0):
    traj = rollout(morph, ctrl, duration=duration)
    return math.dist((traj.start[0], traj.start[2]), (traj.final[0], traj.final[2]))


def test_muscles_drive_movement():
    """The only difference between these two runs is muscle amplitude.

    Half the muscles pull while the other half push, which breaks the
    body's symmetry and produces net travel; the direction that emerges
    from the physics is not what's under test, only that it moves.
    """
    m = make_morphology("blob")
    n = m.num_muscles
    phases = [0.0 if i < n // 2 else math.pi for i in range(n)]
    still = MuscleController(n, freq=1.5)
    active = MuscleController(n, freq=1.5, amps=[0.3] * n, phases=phases)
    assert horizontal_travel(m, active) > horizontal_travel(m, still) + 0.5


def test_amplitude_scales_movement():
    """Bigger contractions, more travel — with everything else held fixed."""
    m = make_morphology("blob")
    n = m.num_muscles
    phases = [0.0 if i < n // 2 else math.pi for i in range(n)]

    def travel(amp):
        return horizontal_travel(m, MuscleController(n, freq=1.5, amps=[amp] * n,
                                                     phases=phases))

    assert travel(0.30) > travel(0.10) > travel(0.0)


def test_controller_clamps_parameters():
    m = make_morphology("blob")
    ctrl = MuscleController(m.num_muscles, freq=99.0, amps=[5.0] * m.num_muscles)
    assert ctrl.freq == FREQ_LIMITS[1]
    assert all(a == AMP_LIMIT for a in ctrl.amps)
    ctrl.load_vector([-3.0] + [-9.0] * m.num_muscles + [7.0] * m.num_muscles)
    assert ctrl.freq == FREQ_LIMITS[0]
    assert all(a == -AMP_LIMIT for a in ctrl.amps)
    assert all(0 <= p < 2 * math.pi for p in ctrl.phases)


def test_act_returns_rest_length_multipliers():
    m = make_morphology("blob")
    ctrl = MuscleController(m.num_muscles, freq=1.0, amps=[0.25] * m.num_muscles,
                            phases=[0.0] * m.num_muscles)
    assert ctrl.act({"t": 0.0}) == pytest.approx([1.0] * m.num_muscles)
    quarter = ctrl.act({"t": 0.25})  # a quarter period in: fully contracted
    assert quarter == pytest.approx([1.25] * m.num_muscles)


def test_diverged_run_scores_below_any_real_run():
    m = make_morphology("blob")
    assert fitness(m, MuscleController(m.num_muscles), walk_forward) > DIVERGED_FITNESS


@pytest.mark.parametrize("goal_name", ["walk", "jump"])
def test_evolution_improves_fitness(goal_name):
    m = make_morphology("blob")
    rep = evolve(m, make_goal(goal_name), generations=10, population=12,
                 duration=3.0, seed=5)
    assert rep.best_fitness >= rep.history[0]
    assert rep.best_fitness > rep.mean_history[0]
    assert len(rep.history) == 10
    assert rep.history == sorted(rep.history)  # best-so-far never regresses


def test_evolved_walker_travels_further_than_its_seed():
    m = make_morphology("blob")
    rep = evolve(m, walk_forward, generations=12, population=12, duration=3.0, seed=5)
    naive = MuscleController.random(m, seed=5)
    assert fitness(m, rep.best, walk_forward, 3.0) > fitness(m, naive, walk_forward, 3.0)


def test_evolution_is_deterministic():
    m = make_morphology("worm")
    kwargs = dict(generations=5, population=8, duration=2.0, seed=11)
    a = evolve(m, jump_high, **kwargs)
    b = evolve(m, jump_high, **kwargs)
    assert a.history == b.history
    assert a.best.to_vector() == b.best.to_vector()


def test_evolution_can_resume_from_a_controller():
    m = make_morphology("blob")
    first = evolve(m, walk_forward, generations=6, population=10, duration=2.0, seed=3)
    second = evolve(m, walk_forward, generations=6, population=10, duration=2.0,
                    seed=4, start_from=first.best)
    assert second.best_fitness >= first.best_fitness
    assert second.best.generations_trained > first.best.generations_trained


def test_on_generation_callback_receives_progress():
    m = make_morphology("blob")
    seen = []
    evolve(m, walk_forward, generations=4, population=8, duration=2.0, seed=1,
           on_generation=lambda g, f, c: seen.append((g, f)))
    assert [g for g, _ in seen] == [0, 1, 2, 3]


def test_trained_creature_saves_and_loads(tmp_path):
    m = make_morphology("blob")
    rep = evolve(m, walk_forward, generations=6, population=10, duration=2.0, seed=8)
    path = tmp_path / "walker.json"
    save_agent(rep.best, path)

    restored = load_agent(path, factory=lambda: MuscleController(m.num_muscles))
    assert restored.morphology == "blob"
    assert restored.amps == rep.best.amps
    assert restored.phases == rep.best.phases
    assert restored.freq == rep.best.freq
    # The restored controller reproduces the trajectory exactly.
    a, b = rollout(m, rep.best, duration=3.0), rollout(m, restored, duration=3.0)
    assert a.final == b.final


def test_rollout_can_record_frames():
    m = make_morphology("worm")
    traj = rollout(m, MuscleController.random(m, seed=2), duration=1.0, record_every=20)
    assert len(traj.frames) == pytest.approx(1.0 / 0.005 / 20, abs=1)
    assert all(len(f) == len(m.positions) for f in traj.frames)
