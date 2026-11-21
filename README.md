# sokoban-solver-01-run-20261121-entry

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/labibhanafi/sokoban-solver-01-run-20261121-entry/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/labibhanafi/sokoban-solver-01-run-20261121-entry/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for the [sokoban-solver-01-run-20261121](https://make.fun/bounty/sokoban-solver-01-run-20261121) competition on make.fun: one program answers a whole set of 5 levels in well under a second, with every level solved in its push-optimal count.

## How it works

Each level is a hallway with one to four small rooms off it, each holding 3–4 boxes and as many goals. A box pushed out of a room can never come back, so every room is an independent puzzle and the level's push optimum is the sum of the rooms' optima. The solver:

1. **Cuts the level into rooms** — the dead squares of the player's row (the hallway, where a box reaches no goal) are cut out of the floor; each remaining part holding boxes is a room.
2. **Solves each room push-optimally with A\* over push states** — a state is the boxes' squares plus the player's reachable region; the heuristic is the cheapest assignment of boxes to goals by walking distance, which never overestimates, so the search returns a push-optimal answer. Dead squares and frozen 2×2 blocks are pruned.
3. **Joins the rooms' move strings** with the walks between them, treating solved rooms' boxes as walls.

Everything is budgeted by work counted in expanded states, never by the wall clock, and there is no randomness — two runs on the same input write the same bytes.

## Practice-set results

| Instance | Pushes (P\*) | Points |
| --- | --- | --- |
| i001 | 13 (13) | 1,000 |
| i002 | 16 (16) | 1,000 |
| i003 | 29 (29) | 1,000 |
| i004 | 47 (47) | 1,000 |
| i005 | 60 (60) | 1,000 |

**Score: 1,000,000 / 1,000,000** (house baseline plain-astar 1.0.0 scores 200,000 on the same set). Whole-set runtime ≈ 0.4 s of the 60 s budget, and 8 freshly drawn sets from the kit's generator all scored 1,000,000 too.

## Run it

```sh
MAKEFUN_INPUT_DIR=./input MAKEFUN_OUTPUT_DIR=./output node main.ts
```

`main.ts` is plain JavaScript in a `.ts` file (no TypeScript-only syntax), so it runs as-is under Node 22's type stripping. No dependencies, no network, no native code.

---

<sub>Entered on [make.fun](https://make.fun/?ref=3t7y0djc&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
