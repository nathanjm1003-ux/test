import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

from grand_strategy.core import Engine, GameState, ModuleManager
from grand_strategy.modules.economy import Economy
from grand_strategy.modules.population import Population


def test_run_game_simple():
    manager = ModuleManager()
    manager.register(Population(growth_rate=0.5))
    manager.register(Economy(production_per_pop=2))
    state = GameState(population=10)
    engine = Engine(manager, state)

    for _ in range(3):
        engine.run_turn()

    assert state.turn == 3
    assert state.population > 10
    assert state.resources["gold"] > 0
