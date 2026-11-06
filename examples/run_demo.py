"""Demo: evaluate baseline agents across the built-in environments.

Run with:  python examples/run_demo.py
"""

from agent_sandbox import Agent, RandomAgent, ToolSandbox, evaluate


class EpsilonGreedyBandit(Agent):
    """Simple epsilon-greedy learner for the bandit environment."""

    def __init__(self, num_arms: int = 5, epsilon: float = 0.1) -> None:
        self.num_arms = num_arms
        self.epsilon = epsilon

    def reset(self, seed: int = 0) -> None:
        import random

        self._rng = random.Random(seed)
        self.counts = [0] * self.num_arms
        self.values = [0.0] * self.num_arms
        self.last_arm = 0

    def act(self, observation, action_space):
        if self._rng.random() < self.epsilon:
            self.last_arm = self._rng.choice(action_space)
        else:
            self.last_arm = max(action_space, key=lambda a: self.values[a])
        return self.last_arm

    def observe(self, observation, reward, done):
        arm = self.last_arm
        self.counts[arm] += 1
        self.values[arm] += (reward - self.values[arm]) / self.counts[arm]


def main() -> None:
    print("== Random agent across all environments ==")
    for env_name in ["grid_world", "bandit", "guess_number"]:
        report = evaluate(RandomAgent(), env_name, num_episodes=20, max_steps=200)
        print(f"{env_name:14s} {report.summary()}")

    print("\n== Epsilon-greedy vs random on the bandit ==")
    for label, agent in [("random", RandomAgent()), ("eps-greedy", EpsilonGreedyBandit())]:
        report = evaluate(agent, "bandit", num_episodes=20, max_steps=200)
        print(f"{label:14s} {report.summary()}")

    print("\n== Tool sandbox transcript ==")
    sandbox = ToolSandbox(max_total_calls=5)
    sandbox.register("search", lambda q: f"3 results for {q!r}")
    sandbox.register("calculator", lambda expr: eval(expr, {"__builtins__": {}}))
    sandbox.call("search", "agent evaluation")
    sandbox.call("calculator", "2 + 2 * 10")
    for call in sandbox.transcript:
        print(f"{call.tool}({', '.join(map(repr, call.args))}) -> {call.result!r}")


if __name__ == "__main__":
    main()
