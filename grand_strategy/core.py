from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Protocol


class Module(Protocol):
    """Interface for game modules.

    Modules can hook into the game loop by implementing these optional
    methods. Only the hooks they define will be called by the engine.
    """

    name: str

    def on_turn_start(self, state: "GameState", manager: "ModuleManager") -> None:
        ...

    def on_turn_end(self, state: "GameState", manager: "ModuleManager") -> None:
        ...


@dataclass
class GameState:
    """Holds shared state for the game."""

    turn: int = 0
    resources: Dict[str, int] = field(default_factory=dict)
    population: int = 0


class ModuleManager:
    """Loads and orchestrates modules."""

    def __init__(self) -> None:
        self.modules: List[Module] = []

    def register(self, module: Module) -> None:
        self.modules.append(module)

    def on_turn_start(self, state: GameState) -> None:
        for module in self.modules:
            if hasattr(module, "on_turn_start"):
                module.on_turn_start(state, self)

    def on_turn_end(self, state: GameState) -> None:
        for module in self.modules:
            if hasattr(module, "on_turn_end"):
                module.on_turn_end(state, self)


class Engine:
    """Very small demonstration engine."""

    def __init__(self, manager: ModuleManager, state: GameState | None = None) -> None:
        self.manager = manager
        self.state = state or GameState()

    def run_turn(self) -> None:
        self.manager.on_turn_start(self.state)
        # Game logic would go here
        self.manager.on_turn_end(self.state)
        self.state.turn += 1
