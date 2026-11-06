"""Built-in environments. Importing this package registers them."""

from agent_sandbox.environment import register
from agent_sandbox.environments.bandit import BernoulliBandit
from agent_sandbox.environments.grid_world import GridWorld
from agent_sandbox.environments.guess_number import GuessNumber

register("grid_world", GridWorld)
register("bandit", BernoulliBandit)
register("guess_number", GuessNumber)

__all__ = ["GridWorld", "BernoulliBandit", "GuessNumber"]
