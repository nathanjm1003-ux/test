"""Custom bodies, custom goals, custom physics, and whole experiments."""

import math

import pytest

from agent_sandbox.creature import (
    DEFAULT_PHYSICS,
    GOAL_PRESETS,
    GOAL_TERMS,
    Experiment,
    GoalSpec,
    Morphology,
    MorphologyError,
    MuscleController,
    Physics,
    custom_morphology,
    evolve,
    load_experiment,
    make_goal,
    make_morphology,
    rollout,
    save_experiment,
)

# A tripod the tests build by hand, to prove a body is just data.
TRIPOD_NODES = [(0.4, 0.05, 0.0), (-0.2, 0.05, 0.35), (-0.2, 0.05, -0.35), (0.0, 0.6, 0.0)]
TRIPOD_EDGES = [(0, 3, True), (1, 3, True), (2, 3, True),
                (0, 1, False), (1, 2, False), (2, 0, False)]


def tripod():
    return custom_morphology("tripod", TRIPOD_NODES, TRIPOD_EDGES)


# --------------------------------------------------------------------------
# Custom bodies
# --------------------------------------------------------------------------


def test_custom_body_simulates():
    m = tripod()
    assert m.num_muscles == 3
    assert len(m.springs) == 6
    traj = rollout(m, MuscleController(3, freq=1.5, amps=[0.3, -0.3, 0.2],
                                       phases=[0.0, 1.5, 3.0]), duration=3.0)
    assert not traj.diverged
    assert traj.final[1] >= 0.0


def test_rest_lengths_come_from_geometry():
    m = custom_morphology("pair", [(0, 0.1, 0), (3, 0.1, 4)], [(0, 1, True)])
    assert m.springs[0].rest == pytest.approx(5.0)


@pytest.mark.parametrize("positions,edges,msg", [
    ([(0, 0, 0)], [], "at least 2 nodes"),
    ([(0, 0, 0), (1, 0, 0)], [(0, 0, True)], "joins a node to itself"),
    ([(0, 0, 0), (1, 0, 0)], [(0, 5, True)], "doesn't exist"),
    ([(0, 0, 0), (1, 0, 0)], [(0, 1, True), (1, 0, True)], "defined twice"),
    ([(0, 0, 0), (0, 0, 0)], [(0, 1, True)], "zero length"),
    ([(0, -1, 0), (1, 0, 0)], [(0, 1, True)], "below the ground"),
    ([(0, 0, 0), (1, 0, 0)], [], "at least one spring"),
])
def test_invalid_bodies_are_rejected(positions, edges, msg):
    with pytest.raises(MorphologyError, match=msg):
        custom_morphology("bad", positions, edges)


def test_body_round_trips_through_dict():
    m = tripod()
    back = Morphology.from_dict(m.to_dict())
    assert back.name == m.name
    assert back.positions == m.positions
    assert [(s.a, s.b, s.muscle, s.rest) for s in back.springs] == \
           [(s.a, s.b, s.muscle, s.rest) for s in m.springs]


@pytest.mark.parametrize("name", ["blob", "quadruped", "worm"])
def test_builtin_bodies_round_trip(name):
    m = make_morphology(name)
    back = Morphology.from_dict(m.to_dict())
    ctrl = MuscleController.random(m, seed=2)
    assert rollout(m, ctrl, duration=2.0).final == rollout(back, ctrl, duration=2.0).final


def test_controller_resizes_with_the_body():
    ctrl = MuscleController(6, freq=1.4, amps=[0.1] * 6, phases=[0.5] * 6)
    grown = ctrl.resized(9)
    assert grown.amps[:6] == [0.1] * 6
    assert grown.amps[6:] == [0.0, 0.0, 0.0]   # new muscles start slack
    assert grown.freq == 1.4
    shrunk = ctrl.resized(3)
    assert shrunk.amps == [0.1, 0.1, 0.1]


def test_evolve_accepts_a_controller_sized_for_another_body():
    m = tripod()
    stale = MuscleController(12, freq=1.5)  # from the quadruped
    rep = evolve(m, GOAL_PRESETS["walk"], generations=3, population=8,
                 duration=1.5, seed=1, start_from=stale)
    assert rep.best.num_muscles == m.num_muscles


# --------------------------------------------------------------------------
# Custom goals
# --------------------------------------------------------------------------


def test_goal_is_a_weighted_sum_of_terms():
    m = make_morphology("blob")
    traj = rollout(m, MuscleController.random(m, seed=3), duration=3.0)
    spec = GoalSpec({"forward": 2.0, "peak_height": -0.5})
    expected = (2.0 * (traj.final[0] - traj.start[0])
                - 0.5 * (traj.max_height - traj.start[1]))
    assert spec.score(traj) == pytest.approx(expected)


def test_zero_weight_terms_are_ignored():
    m = make_morphology("blob")
    traj = rollout(m, MuscleController.random(m, seed=3), duration=2.0)
    assert GoalSpec({"forward": 1.0, "effort": 0.0}).score(traj) == \
           pytest.approx(GoalSpec({"forward": 1.0}).score(traj))


def test_unknown_goal_term_is_rejected():
    with pytest.raises(KeyError, match="unknown goal term"):
        GoalSpec({"teleport": 1.0})


def test_every_declared_term_is_computable():
    m = make_morphology("worm")
    traj = rollout(m, MuscleController.random(m, seed=1), duration=2.0)
    for term in GOAL_TERMS:
        value = GoalSpec({term: 1.0}, target=(2.0, 2.0)).score(traj)
        assert math.isfinite(value), term


def test_goal_round_trips_through_dict():
    spec = GoalSpec({"to_target": 1.0, "effort": -0.2}, target=(4.0, -1.5), name="fetch")
    back = GoalSpec.from_dict(spec.to_dict())
    assert back.weights == spec.weights
    assert back.target == spec.target
    assert back.name == spec.name


def test_make_goal_accepts_names_strings_and_weights():
    assert make_goal("walk").weights == {"forward": 1.0, "sideways": -0.3}
    assert make_goal("reach:2,-3").target == (2.0, -3.0)
    assert make_goal({"weights": {"forward": 1.0}}).weights == {"forward": 1.0}
    spec = GoalSpec({"forward": 1.0})
    assert make_goal(spec) is spec
    with pytest.raises(KeyError, match="unknown goal"):
        make_goal("fly")


def test_describe_reads_as_a_formula():
    assert GOAL_PRESETS["walk"].describe() == "+1·forward -0.3·sideways"


def test_effort_term_grows_with_amplitude():
    m = make_morphology("blob")
    n = m.num_muscles
    quiet = rollout(m, MuscleController(n, freq=1.5, amps=[0.05] * n), duration=3.0)
    loud = rollout(m, MuscleController(n, freq=1.5, amps=[0.45] * n), duration=3.0)
    assert loud.effort > quiet.effort


def test_a_custom_goal_trains():
    """Reward height while penalising travel — a deliberate 'hop in place'."""
    m = make_morphology("blob")
    spec = GoalSpec({"peak_height": 1.0, "travel": -1.0}, name="hop in place")
    rep = evolve(m, spec, generations=10, population=12, duration=3.0, seed=4)
    assert rep.best_fitness > rep.history[0] or rep.best_fitness == rep.history[0]
    assert rep.history == sorted(rep.history)


# --------------------------------------------------------------------------
# Custom physics
# --------------------------------------------------------------------------


def test_physics_changes_the_trajectory():
    """Weaker gravity holds the body higher over the episode.

    Measured on mean height, not peak: this controller never lifts the
    blob above where it started, so peak height stays pinned at the
    starting value under both settings and can't tell them apart.
    """
    m = make_morphology("blob")
    ctrl = MuscleController.random(m, seed=5)
    moon = Physics(gravity=1.6)
    assert rollout(m, ctrl, duration=3.0, physics=moon).mean_height > \
           rollout(m, ctrl, duration=3.0).mean_height


def test_zero_gravity_creature_does_not_fall():
    m = make_morphology("blob")
    space = Physics(gravity=0.0)
    traj = rollout(m, MuscleController(m.num_muscles), duration=2.0, physics=space)
    assert traj.final[1] == pytest.approx(traj.start[1], abs=1e-9)


def test_frictionless_ground_gives_less_grip():
    m = make_morphology("worm")
    n = m.num_muscles
    ctrl = MuscleController(n, freq=1.6, amps=[0.35] * n,
                            phases=[i * 0.7 for i in range(n)])
    def travel(physics):
        t = rollout(m, ctrl, duration=4.0, physics=physics)
        return math.dist((t.start[0], t.start[2]), (t.final[0], t.final[2]))
    assert travel(Physics(ground_friction=1.0)) < travel(DEFAULT_PHYSICS)


def test_physics_round_trips_and_ignores_unknown_keys():
    p = Physics(gravity=3.7, stiffness=900.0)
    back = Physics.from_dict({**p.to_dict(), "unknown_future_field": 1})
    assert back == p


def test_unstable_physics_is_caught_not_crashed():
    m = make_morphology("quadruped")
    ctrl = MuscleController.random(m, seed=1)
    wild = Physics(stiffness=500_000.0)  # far past what dt=0.005 can integrate
    traj = rollout(m, ctrl, duration=2.0, physics=wild)
    assert traj.diverged
    assert all(math.isfinite(v) for v in traj.final)


# --------------------------------------------------------------------------
# Whole experiments
# --------------------------------------------------------------------------


def test_experiment_round_trips_through_a_file(tmp_path):
    m = tripod()
    exp = Experiment(
        morphology=m,
        goal=GoalSpec({"forward": 1.0, "effort": -0.4}, name="efficient walk"),
        physics=Physics(gravity=6.0, ground_friction=0.85),
        controller=MuscleController(3, freq=1.7, amps=[0.2, -0.3, 0.4],
                                    phases=[0.0, 2.0, 4.0], morphology="tripod"),
        duration=4.0,
    )
    path = tmp_path / "exp.json"
    save_experiment(exp, path)
    back = load_experiment(path)

    assert back.morphology.positions == m.positions
    assert back.goal.weights == exp.goal.weights
    assert back.physics == exp.physics
    assert back.duration == 4.0
    # and it reproduces the same run
    assert back.run().final == exp.run().final


def test_experiment_runs_and_evolves_under_its_own_settings():
    exp = Experiment(morphology=tripod(), goal=make_goal("jump"),
                     physics=Physics(gravity=4.0), duration=2.5)
    assert not exp.run().diverged
    rep = exp.evolve(generations=5, population=8, seed=2)
    assert rep.history == sorted(rep.history)


def test_experiment_rejects_a_mismatched_controller(tmp_path):
    exp = Experiment(morphology=tripod(),
                     controller=MuscleController(3, morphology="tripod"))
    d = exp.to_dict()
    d["controller"]["num_muscles"] = 12
    d["controller"]["amps"] = [0.0] * 12
    d["controller"]["phases"] = [0.0] * 12
    with pytest.raises(ValueError, match="drives 12 muscles but the body has 3"):
        Experiment.from_dict(d)


def test_experiment_rejects_a_foreign_file(tmp_path):
    path = tmp_path / "junk.json"
    path.write_text('{"format": "something-else"}')
    with pytest.raises(ValueError, match="not a gait-lab experiment"):
        load_experiment(path)
