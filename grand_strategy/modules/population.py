from __future__ import annotations

from dataclasses import dataclass

from ..core import GameState, Module, ModuleManager


@dataclass
class Population(Module):
    name: str = "population"
    growth_rate: float = 0.1

    def on_turn_end(self, state: GameState, manager: ModuleManager) -> None:
        growth = int(state.population * self.growth_rate)
        state.population += growth
        if state.population == 0:
            state.population = 1
