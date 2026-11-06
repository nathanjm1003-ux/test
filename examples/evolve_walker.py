"""Evolve muscle parameters for a goal, then save the trained creature.

    python examples/evolve_walker.py --morphology quadruped --goal walk
"""

import argparse

from agent_sandbox import evolve, make_goal, make_morphology, rollout, save_agent
from agent_sandbox.creature import MORPHOLOGIES, MuscleController


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--morphology", default="quadruped", choices=sorted(MORPHOLOGIES))
    p.add_argument("--goal", default="walk",
                   help="walk, jump, stand, or reach:X,Z")
    p.add_argument("--generations", type=int, default=30)
    p.add_argument("--population", type=int, default=20)
    p.add_argument("--duration", type=float, default=6.0, help="episode seconds")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--save", help="write the trained controller to this JSON file")
    args = p.parse_args()

    morph = make_morphology(args.morphology)
    goal = make_goal(args.goal)
    print(f"{morph.name}: {len(morph.positions)} nodes, {len(morph.springs)} springs, "
          f"{morph.num_muscles} muscles -> goal {args.goal!r}")

    def show(gen: int, best: float, _ctrl: MuscleController) -> None:
        bar = "#" * max(0, min(40, int(best * 5)))
        print(f"  gen {gen:3d}  best {best:8.3f}  {bar}")

    report = evolve(morph, goal, generations=args.generations,
                    population=args.population, duration=args.duration,
                    seed=args.seed, on_generation=show)

    traj = rollout(morph, report.best, duration=args.duration)
    print("\n" + report.summary())
    print(f"travelled dx={traj.final[0] - traj.start[0]:+.2f} m  "
          f"dz={traj.final[2] - traj.start[2]:+.2f} m  peak height={traj.max_height:.2f} m")
    print(f"freq={report.best.freq:.2f} Hz  amps="
          f"{[round(a, 2) for a in report.best.amps]}")

    if args.save:
        save_agent(report.best, args.save)
        print(f"saved controller to {args.save}")


if __name__ == "__main__":
    main()
