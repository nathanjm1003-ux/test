"""A number-guessing task with higher/lower feedback.

Good for smoke-testing LLM-style agents: the optimal policy (binary
search) is easy to state in natural language and to verify.
"""

from __future__ import annotations

from typing import Any, List

from agent_sandbox.environment import Environment, StepResult


class GuessNumber(Environment):
    """Guess a hidden integer in [1, high]. Feedback: "higher"/"lower".

    Reward: +1.0 for a correct guess, -0.01 per wrong guess. The episode
    ends on a correct guess or after ``max_guesses`` attempts.
    """

    def __init__(self, high: int = 100, max_guesses: int = 20) -> None:
        super().__init__()
        self.high = high
        self.max_guesses = max_guesses
        self.secret = 1
        self.guesses = 0

    def reset(self, seed: int = 0) -> Any:
        self._rng.seed(seed)
        self.secret = self._rng.randint(1, self.high)
        self.guesses = 0
        return {"feedback": "start", "low": 1, "high": self.high}

    def step(self, action: Any) -> StepResult:
        if not isinstance(action, int) or not 1 <= action <= self.high:
            raise ValueError(f"invalid guess {action!r}; expected int in [1, {self.high}]")
        self.guesses += 1
        if action == self.secret:
            return StepResult({"feedback": "correct"}, 1.0, True, {"guesses": self.guesses})
        feedback = "higher" if action < self.secret else "lower"
        done = self.guesses >= self.max_guesses
        return StepResult({"feedback": feedback}, -0.01, done, {"guesses": self.guesses})

    @property
    def action_space(self) -> List[Any]:
        return list(range(1, self.high + 1))
