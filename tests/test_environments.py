import pytest

from agent_sandbox import make
from agent_sandbox.environment import registered_names
from agent_sandbox.environments import BernoulliBandit, GridWorld, GuessNumber


def test_registry_contains_builtins():
    assert {"grid_world", "bandit", "guess_number"} <= set(registered_names())


def test_make_unknown_environment_raises():
    with pytest.raises(KeyError, match="unknown environment"):
        make("nope")


@pytest.mark.parametrize("name", ["grid_world", "bandit", "guess_number"])
def test_reset_is_deterministic_per_seed(name):
    env_a, env_b = make(name), make(name)
    assert env_a.reset(seed=42) == env_b.reset(seed=42)


def test_grid_world_reaches_goal_on_open_grid():
    env = GridWorld(size=3, wall_density=0.0)
    env.reset(seed=0)
    total = 0.0
    for action in ["right", "right", "down", "down"]:
        result = env.step(action)
        total += result.reward
    assert result.done
    assert result.info == {"reached_goal": True}
    assert total == pytest.approx(1.0 - 0.01 * 3)


def test_grid_world_blocks_edge_moves():
    env = GridWorld(size=3, wall_density=0.0)
    env.reset(seed=0)
    result = env.step("up")
    assert result.info == {"blocked": True}
    assert result.reward == pytest.approx(-0.05)
    assert result.observation["position"] == (0, 0)


def test_grid_world_rejects_invalid_action():
    env = GridWorld()
    env.reset(seed=0)
    with pytest.raises(ValueError, match="invalid action"):
        env.step("teleport")


def test_bandit_horizon_and_best_arm_info():
    env = BernoulliBandit(num_arms=3, horizon=5)
    env.reset(seed=7)
    for i in range(5):
        result = env.step(0)
    assert result.done
    assert result.info["best_arm"] in range(3)
    assert 0.0 <= result.info["best_prob"] <= 1.0
    assert result.observation == {"pulls": 5}


def test_bandit_rejects_out_of_range_arm():
    env = BernoulliBandit(num_arms=3)
    env.reset(seed=0)
    with pytest.raises(ValueError, match="invalid arm"):
        env.step(3)


def test_guess_number_binary_search_solves():
    env = GuessNumber(high=100, max_guesses=20)
    obs = env.reset(seed=3)
    low, high = obs["low"], obs["high"]
    for _ in range(20):
        guess = (low + high) // 2
        result = env.step(guess)
        if result.observation["feedback"] == "correct":
            break
        if result.observation["feedback"] == "higher":
            low = guess + 1
        else:
            high = guess - 1
    assert result.done
    assert result.reward == pytest.approx(1.0)
    assert result.info["guesses"] <= 7  # ceil(log2(100)) = 7


def test_guess_number_truncates_after_max_guesses():
    env = GuessNumber(high=100, max_guesses=3)
    env.reset(seed=0)
    wrong = env.secret + 1 if env.secret < 100 else env.secret - 1
    for _ in range(3):
        result = env.step(wrong)
    assert result.done
