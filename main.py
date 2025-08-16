from grand_strategy.core import Engine, GameState, ModuleManager
from grand_strategy.modules.economy import Economy
from grand_strategy.modules.population import Population


def build_game() -> Engine:
    manager = ModuleManager()
    manager.register(Population())
    manager.register(Economy())
    state = GameState(population=10)
    return Engine(manager, state)


def run_game(turns: int = 5) -> GameState:
    engine = build_game()
    for _ in range(turns):
        engine.run_turn()
    return engine.state


if __name__ == "__main__":
    state = run_game()
    print(f"After {state.turn} turns: population={state.population}, resources={state.resources}")
