import statistics

import pytest

from agent_sandbox import (
    QLearningAgent,
    RandomAgent,
    load_agent,
    run_episode,
    save_agent,
    train,
)
from agent_sandbox.environments import GridWorld


def grid_agent(**kwargs):
    return QLearningAgent(state_fn=lambda obs: obs["position"], **kwargs)


def trained_agent(episodes=300, seed=3):
    env = GridWorld(size=5, wall_density=0.1)
    agent = grid_agent()
    rewards = train(agent, env, episodes=episodes, seed=seed)
    return agent, env, rewards


def test_training_improves_reward():
    _, _, rewards = trained_agent()
    early = statistics.fmean(rewards[:50])
    late = statistics.fmean(rewards[-50:])
    assert late > early
    assert late > 0.5  # near-optimal on a 5x5 map is ~0.9


def test_trained_greedy_policy_solves_its_map():
    agent, env, _ = trained_agent()
    agent.epsilon = 0.0
    result = run_episode(agent, env, seed=3, max_steps=100)
    assert result.solved
    assert result.total_reward > 0.7


def test_training_is_deterministic():
    a1, _, r1 = trained_agent(episodes=50)
    a2, _, r2 = trained_agent(episodes=50)
    assert r1 == r2
    assert a1.q == a2.q


def test_episodes_trained_counter():
    agent, _, _ = trained_agent(episodes=50)
    assert agent.episodes_trained == 50


def test_save_load_roundtrip(tmp_path):
    agent, env, _ = trained_agent(episodes=100)
    path = tmp_path / "agent.json"
    save_agent(agent, path)

    restored = load_agent(path, factory=grid_agent)
    assert restored.q == agent.q
    assert restored.episodes_trained == agent.episodes_trained

    agent.epsilon = restored.epsilon = 0.0
    a = run_episode(agent, env, seed=3, max_steps=100)
    b = run_episode(restored, env, seed=3, max_steps=100)
    assert (a.total_reward, a.steps, a.done) == (b.total_reward, b.steps, b.done)


def test_load_without_factory_uses_builtin_registry(tmp_path):
    agent = QLearningAgent()
    agent.q = {"(0, 0)": {"right": 0.5}}
    path = tmp_path / "agent.json"
    save_agent(agent, path)
    restored = load_agent(path)
    assert isinstance(restored, QLearningAgent)
    assert restored.q == agent.q


def test_save_unsupported_agent_raises(tmp_path):
    with pytest.raises(TypeError, match="does not support persistence"):
        save_agent(RandomAgent(), tmp_path / "nope.json")


def test_load_rejects_foreign_file(tmp_path):
    path = tmp_path / "junk.json"
    path.write_text('{"hello": "world"}')
    with pytest.raises(ValueError, match="not an agent-sandbox agent file"):
        load_agent(path)
