import pytest

from agent_sandbox import Agent, RandomAgent, evaluate, make, run_episode


class CrashingAgent(Agent):
    def act(self, observation, action_space):
        raise RuntimeError("boom")


class IllegalActionAgent(Agent):
    def act(self, observation, action_space):
        return "definitely-not-an-action"


class BinarySearchAgent(Agent):
    """Optimal GuessNumber policy, used to test solve-rate accounting."""

    def reset(self, seed: int = 0) -> None:
        self.low, self.high = 1, 100

    def act(self, observation, action_space):
        feedback = observation["feedback"]
        if feedback == "higher":
            self.low = self.last + 1
        elif feedback == "lower":
            self.high = self.last - 1
        self.last = (self.low + self.high) // 2
        return self.last


def test_run_episode_random_agent_terminates():
    result = run_episode(RandomAgent(), make("bandit"), seed=1, max_steps=500)
    assert result.done
    assert result.steps == 100  # bandit horizon
    assert result.error is None


def test_run_episode_enforces_step_budget():
    result = run_episode(RandomAgent(), make("guess_number"), seed=1, max_steps=2)
    assert result.truncated
    assert result.steps == 2
    assert not result.done


def test_run_episode_contains_agent_crash():
    result = run_episode(CrashingAgent(), make("grid_world"), seed=0)
    assert result.error == "RuntimeError: boom"
    assert not result.solved


def test_run_episode_contains_illegal_action():
    result = run_episode(IllegalActionAgent(), make("grid_world"), seed=0)
    assert result.error is not None
    assert result.error.startswith("ValueError")


def test_run_episode_is_reproducible():
    a = run_episode(RandomAgent(), make("grid_world"), seed=5, max_steps=50)
    b = run_episode(RandomAgent(), make("grid_world"), seed=5, max_steps=50)
    assert (a.total_reward, a.steps, a.done) == (b.total_reward, b.steps, b.done)


def test_evaluate_accepts_env_name_and_aggregates():
    report = evaluate(BinarySearchAgent(), "guess_number", num_episodes=5, max_steps=20)
    assert len(report.episodes) == 5
    assert report.solve_rate == 1.0
    assert report.error_rate == 0.0
    assert report.mean_steps <= 7
    assert "solve_rate=1.00" in report.summary()


def test_evaluate_error_rate_counts_crashes():
    report = evaluate(CrashingAgent(), "grid_world", num_episodes=4)
    assert report.error_rate == 1.0
    assert report.solve_rate == 0.0


def test_keep_infos_collects_step_infos():
    result = run_episode(
        RandomAgent(), make("bandit"), seed=0, max_steps=200, keep_infos=True
    )
    assert len(result.infos) == result.steps
    assert "best_arm" in result.infos[-1]


def test_episode_reward_matches_env_math():
    result = run_episode(BinarySearchAgent(), make("guess_number"), seed=9, max_steps=20)
    assert result.solved
    wrong_guesses = result.steps - 1
    assert result.total_reward == pytest.approx(1.0 - 0.01 * wrong_guesses)
