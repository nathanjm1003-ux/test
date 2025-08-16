from __future__ import annotations

from dataclasses import dataclass

from ..core import GameState, Module, ModuleManager


@dataclass
class Economy(Module):
    name: str = "economy"
    production_per_pop: int = 1

    def on_turn_end(self, state: GameState, manager: ModuleManager) -> None:
        income = state.population * self.production_per_pop
        state.resources["gold"] = state.resources.get("gold", 0) + income
