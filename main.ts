// Room-by-room push-optimal Sokoban solver.
//
// A level in this competition is a hallway one square wide with one to four
// small rooms off it, each holding 3-4 boxes and as many goals. A box pushed
// out of a room through its door can never be pushed back, so every room is
// an independent puzzle and the level's push optimum is the sum of the rooms'
// optima. This program cuts the level into rooms, solves each room
// push-optimally with A* over push states, and joins the rooms' move strings
// with the walks between them.
//
// The search state is the boxes' squares plus the player's reachable region
// (named by its lowest square); a push moves one box one square and costs 1.
// The heuristic is the cheapest assignment of boxes to goals by walking
// distance over floor alone, which never overestimates: every push moves one
// box one square, so the true remaining pushes are at least the assigned
// distances summed. Two prunings keep dead states out of the search: a box on
// a square from which no sequence of pushes reaches a goal (dead square), and
// a box frozen in a 2x2 block of walls and boxes with a box off its goal.
// A* with an admissible, consistent heuristic returns a push-optimal answer.
//
// Everything is budgeted by work counted in expanded states, never by the
// wall clock, and there is no randomness anywhere, so two runs on the same
// input write the same bytes.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Work budgets, counted in expanded states. A room the reference search
// solves inside 250,000 states is guaranteed solvable by construction, and
// the assignment heuristic expands far fewer than a plain breadth-first
// search, so these caps are headroom, not the plan.
const ROOM_ASTAR_CAP = 250000;
const ROOM_BFS_CAP = 250000;
const ROOM_STATE_CAP = 400000;
const GLOBAL_EXPANSION_CAP = 2000000;

const DIRS = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

/** A level in XSB text: width, height, walls, goals, boxes (sorted) and player. */
function parseLevel(text) {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals = [];
  const boxes = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outermost frame is wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * The squares from which a box alone can be pushed onto some goal, found by
 * pulling boxes back from the goals: a box on y can be pushed in direction d
 * onto a live square x when the player can stand on y - d.
 */
function liveSquares(w, wall, goals) {
  const live = new Uint8Array(wall.length);
  const queue = [];
  for (const g of goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (let k = 0; k < 4; k++) {
      const d = k === 0 ? -w : k === 1 ? w : k === 2 ? -1 : 1;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** Walking distance from `from` to every square, over floor alone (-1 unreached). */
function walkDistances(w, wall, from) {
  const dist = new Int32Array(wall.length).fill(-1);
  const queue = [from];
  dist[from] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (!wall[q] && dist[q] < 0) {
        dist[q] = dist[p] + 1;
        queue.push(q);
      }
    }
  }
  return dist;
}

/** All orderings of 0..n-1, built once, in lexicographic order. */
function permutations(n) {
  const out = [];
  const used = new Array(n).fill(false);
  const cur = [];
  const build = () => {
    if (cur.length === n) {
      out.push(cur.slice());
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      cur.push(i);
      build();
      cur.pop();
      used[i] = false;
    }
  };
  build();
  return out;
}

/**
 * Whether the box just pushed to `t` sits in a frozen 2x2 block: four squares
 * of walls and boxes, holding a box off its goal. Such a box never moves again.
 */
function frozenBlock(w, wall, occupied, goal, t) {
  for (let k = 0; k < 4; k++) {
    const a = k === 0 ? t : k === 1 ? t - 1 : k === 2 ? t - w : t - w - 1;
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b])) continue;
    if (!(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b])) return true;
    if ((occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD. */
function walkTo(w, wall, occupied, from, to) {
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = DIRS[k][2];
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('no walk to the push square');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/** A binary heap on [f, g, sequence, state], smallest f first, deepest first on ties. */
function makeHeap() {
  const a = [];
  const less = (x, y) =>
    x[0] < y[0] ||
    (x[0] === y[0] && (x[1] > y[1] || (x[1] === y[1] && x[2] < y[2])));
  const swap = (i, j) => {
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  };
  return {
    size: () => a.length,
    push(e) {
      let i = a.length;
      a.push(e);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (!less(a[i], a[p])) break;
        swap(i, p);
        i = p;
      }
    },
    pop() {
      const top = a[0];
      const last = a.pop();
      if (a.length > 0) {
        a[0] = last;
        for (let i = 0; ; ) {
          let c = 2 * i + 1;
          if (c >= a.length) break;
          if (c + 1 < a.length && less(a[c + 1], a[c])) c++;
          if (!less(a[c], a[i])) break;
          swap(i, c);
          i = c;
        }
      }
      return top;
    },
  };
}

/**
 * Push-optimal solution of one small level (a room, or the whole level as a
 * fallback): {pushes, moves}, or null when the search gives up inside its
 * budget. With useHeuristic off the search is plain breadth-first over pushes.
 * `budget` counts expansions across the whole run and caps them.
 */
function solvePush(sub, maxExpansions, useHeuristic, budget) {
  const { w, wall, goals } = sub;
  const size = wall.length;
  const n = sub.boxes.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(w, wall, goals);
  for (const b of sub.boxes) if (!live[b]) return null;

  // Walking distance from every square to each goal, over floor alone.
  const distTo = goals.map((g) => walkDistances(w, wall, g));
  const perms = n <= 5 ? permutations(n) : null;
  const heuristic = (boxes) => {
    if (perms !== null) {
      let best = Infinity;
      for (const p of perms) {
        let s = 0;
        for (let i = 0; i < n; i++) {
          const d = distTo[p[i]][boxes[i]];
          if (d < 0) {
            s = Infinity;
            break;
          }
          s += d;
        }
        if (s < best) best = s;
      }
      return best;
    }
    let s = 0;
    for (let i = 0; i < n; i++) {
      let m = Infinity;
      for (let j = 0; j < n; j++) {
        const d = distTo[j][boxes[i]];
        if (d >= 0 && d < m) m = d;
      }
      if (m === Infinity) return Infinity;
      s += m;
    }
    return s;
  };
  const solved = (boxes) => {
    for (let i = 0; i < n; i++) if (!goal[boxes[i]]) return false;
    return true;
  };

  // State keys: boxes plus the player's region, named by its lowest square.
  // Numeric while the key fits exactly in a double (rooms of up to 5 boxes),
  // a string otherwise.
  const keyOf =
    n <= 5
      ? (boxes, low) => {
          let k = low;
          for (const b of boxes) k = k * size + b;
          return k;
        }
      : (boxes, low) => low + ':' + boxes.join(',');

  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  // The lowest square the player reaches from `from` around walls and boxes,
  // marking the region with `stamp` in `seenArr`.
  const regionLow = (occupied, from, seenArr, st) => {
    let low = from;
    let sp = 0;
    stack[sp++] = from;
    seenArr[from] = st;
    while (sp > 0) {
      const p = stack[--sp];
      if (p < low) low = p;
      for (let k = 0; k < 4; k++) {
        const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
        if (!wall[q] && !occupied[q] && seenArr[q] !== st) {
          seenArr[q] = st;
          stack[sp++] = q;
        }
      }
    }
    return low;
  };

  const occupied = new Uint8Array(size);
  for (const b of sub.boxes) occupied[b] = 1;
  const startLow = regionLow(occupied, sub.player, seen, ++stamp);
  for (const b of sub.boxes) occupied[b] = 0;

  const sBoxes = [sub.boxes.slice()];
  const sPlayer = [sub.player];
  const sParent = [-1];
  const sPush = [null];
  const sKey = [keyOf(sub.boxes, startLow)];
  const best = new Map();
  best.set(sKey[0], 0);

  const heap = makeHeap();
  let seq = 0;
  const h0 = useHeuristic ? heuristic(sub.boxes) : 0;
  if (h0 === Infinity) return null;
  heap.push([h0, 0, seq++, 0]);

  let expanded = 0;
  let found = -1;
  while (heap.size() > 0) {
    const entry = heap.pop();
    const g = entry[1];
    const s = entry[3];
    if (best.get(sKey[s]) !== g) continue;
    if (solved(sBoxes[s])) {
      found = s;
      break;
    }
    expanded++;
    budget.used++;
    if (expanded > maxExpansions || budget.used > GLOBAL_EXPANSION_CAP) return null;
    const boxes = sBoxes[s];
    for (const b of boxes) occupied[b] = 1;
    const here = ++stamp;
    regionLow(occupied, sPlayer[s], seen, here);
    for (let bi = 0; bi < n; bi++) {
      const b = boxes[bi];
      for (let k = 0; k < 4; k++) {
        const d = k === 0 ? -w : k === 1 ? w : k === 2 ? -1 : 1;
        const t = b + d;
        if (wall[t] || occupied[t] || !live[t]) continue;
        if (seen[b - d] !== here) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        if (frozenBlock(w, wall, occupied, goal, t)) {
          occupied[t] = 0;
          occupied[b] = 1;
          continue;
        }
        const next = boxes.slice();
        next[bi] = t;
        next.sort((x, y) => x - y);
        const low = regionLow(occupied, b, mark, ++stamp);
        const key = keyOf(next, low);
        const g2 = g + 1;
        const prevBest = best.get(key);
        if (prevBest !== undefined && prevBest <= g2) {
          occupied[t] = 0;
          occupied[b] = 1;
          continue;
        }
        const h = useHeuristic ? heuristic(next) : 0;
        if (h === Infinity) {
          occupied[t] = 0;
          occupied[b] = 1;
          continue;
        }
        if (sBoxes.length >= ROOM_STATE_CAP) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        best.set(key, g2);
        sBoxes.push(next);
        sPlayer.push(b);
        sParent.push(s);
        sPush.push([b, t, k]);
        sKey.push(key);
        heap.push([g2 + h, g2, seq++, sBoxes.length - 1]);
        occupied[t] = 0;
        occupied[b] = 1;
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;

  // The path of pushes, then the moves: walk to each push's square, then push.
  const path = [];
  for (let s = found; s > 0; s = sParent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = sub.player;
  let boxes = sub.boxes.slice();
  const occ = new Uint8Array(size);
  for (const s of path) {
    const push = sPush[s];
    const from = push[0];
    const to = push[1];
    const k = push[2];
    const d = k === 0 ? -w : k === 1 ? w : k === 2 ? -1 : 1;
    for (const b of boxes) occ[b] = 1;
    moves += walkTo(w, wall, occ, player, from - d);
    for (const b of boxes) occ[b] = 0;
    moves += DIRS[k][3];
    player = from;
    boxes = sBoxes[s];
  }
  return { pushes: path.length, moves };
}

/** The square the player stands on after `moves` (LURD, case aside) from `from`. */
function endPosition(w, from, moves) {
  let p = from;
  for (const ch of moves) {
    const c = ch.toLowerCase();
    p += c === 'u' ? -w : c === 'd' ? w : c === 'l' ? -1 : 1;
  }
  return p;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway:
 * a box there reaches no goal) out of the floor, and each part left that
 * holds a box is a room, its squares, boxes and goals. Null when the level is
 * no set of rooms (a box starts in the hallway, a goal is cut off, or some
 * part holds more boxes than goals).
 */
function roomsOf(level) {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(w, wall, goals);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  for (const b of boxes) if (cut[b]) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      const p = squares[i];
      for (let k = 0; k < 4; k++) {
        const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) rooms[part[b]].boxes.push(b);
  for (const g of goals) {
    if (part[g] < 0) return null;
    rooms[part[g]].goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** The level's moves: each room solved in turn, the other rooms' boxes as walls. */
function solveLevel(text, budget) {
  const level = parseLevel(text);
  const rooms = roomsOf(level);
  if (rooms === null) {
    const whole = solvePush(
      { w: level.w, wall: level.wall, goals: level.goals, boxes: level.boxes, player: level.player },
      500000,
      true,
      budget,
    );
    return whole === null ? '' : whole.moves;
  }
  let player = level.player;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.boxes) wall[b] = 1;
    }
    const sub = {
      w: level.w,
      wall,
      goals: room.goals.slice(),
      boxes: room.boxes.slice(),
      player,
    };
    let solved = solvePush(sub, ROOM_ASTAR_CAP, true, budget);
    if (solved === null) solved = solvePush(sub, ROOM_BFS_CAP, false, budget);
    if (solved === null) return '';
    moves += solved.moves;
    player = endPosition(level.w, player, solved.moves);
    room.boxes = room.goals.slice();
  }
  return moves;
}

const budget = { used: 0 };
for (const id of readdirSync(INPUT_DIR).sort()) {
  let moves = '';
  try {
    moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'), budget);
  } catch {
    moves = '';
  }
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
