"""A small deterministic grid world with random walls and a goal."""

from __future__ import annotations

from typing import Any, Dict, List, Set, Tuple

from agent_sandbox.environment import Environment, StepResult

Position = Tuple[int, int]

MOVES: Dict[str, Position] = {
    "up": (0, -1),
    "down": (0, 1),
    "left": (-1, 0),
    "right": (1, 0),
}


class GridWorld(Environment):
    """Navigate from the top-left corner to the goal on an N x N grid.

    Observation: dict with the agent's position, the goal position, and
    the set of wall cells (the map is fully observable).
    Reward: -0.01 per step, -0.05 for walking into a wall or edge,
    +1.0 for reaching the goal. Episodes end at the goal.
    """

    def __init__(self, size: int = 6, wall_density: float = 0.15) -> None:
        super().__init__()
        self.size = size
        self.wall_density = wall_density
        self.pos: Position = (0, 0)
        self.goal: Position = (size - 1, size - 1)
        self.walls: Set[Position] = set()

    def reset(self, seed: int = 0) -> Any:
        self._rng.seed(seed)
        self.pos = (0, 0)
        self.goal = (self.size - 1, self.size - 1)
        self.walls = set()
        for x in range(self.size):
            for y in range(self.size):
                cell = (x, y)
                if cell in (self.pos, self.goal):
                    continue
                if self._rng.random() < self.wall_density:
                    self.walls.add(cell)
        return self._observation()

    def step(self, action: Any) -> StepResult:
        if action not in MOVES:
            raise ValueError(f"invalid action {action!r}; expected one of {sorted(MOVES)}")
        dx, dy = MOVES[action]
        nx, ny = self.pos[0] + dx, self.pos[1] + dy
        target = (nx, ny)

        blocked = not (0 <= nx < self.size and 0 <= ny < self.size) or target in self.walls
        if blocked:
            return StepResult(self._observation(), -0.05, False, {"blocked": True})

        self.pos = target
        if self.pos == self.goal:
            return StepResult(self._observation(), 1.0, True, {"reached_goal": True})
        return StepResult(self._observation(), -0.01, False, {})

    @property
    def action_space(self) -> List[Any]:
        return sorted(MOVES)

    def _observation(self) -> Dict[str, Any]:
        return {"position": self.pos, "goal": self.goal, "walls": frozenset(self.walls)}
