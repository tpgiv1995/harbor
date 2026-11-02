'use strict';

// Where the team chart's lines go (2026-11-02). Cards are laid out by CSS
// (a wrapping tree), then this turns their measured boxes into SVG paths, so
// the lines always meet the cards wherever the layout put them.
//
// Reporting lines: from the parent's bottom edge down to a bus in the gap
// above each row of children, then down into each child with an arrowhead.
// Children that wrap onto several rows share a trunk in the left margin, so
// no line ever crosses a card. Other relations (keeps alive, reviews) are
// curves between the nearest edges.
//
// Deeper than one level (Pat, 2026-11-02: "ensure that the draw arrows work
// properly beyond just 1 level"): a child's own children hang below it and can
// stick out further left than the child's card. So each rect may carry `node`,
// the box of that card's whole subtree, and the trunk runs left of the
// subtrees, not just left of the cards; otherwise the trunk down to a second
// row would cut through a first-row child's grandchildren.

const ROW_TOLERANCE = 6;

function center(rect) { return (rect.left + rect.right) / 2; }

function rowsOf(childRects) {
  const rows = [];
  for (const item of [...childRects].sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)) {
    const row = rows.find((r) => Math.abs(r.top - item.rect.top) <= ROW_TOLERANCE);
    if (row) row.items.push(item); else rows.push({ top: item.rect.top, items: [item] });
  }
  return rows;
}

// rects: { [id]: { left, top, right, bottom, node? } } relative to the canvas;
// node is the { left, top, right, bottom } of the card's whole subtree.
// tree: [{ parent, children: [{ id, kind }] }]
// cross: [{ from, to, kind }]
function connectorPaths(rects, tree, cross = [], { gap = 36, trunkInset = 14, crossMargin = 8, crossBend = 30 } = {}) {
  const paths = [];
  for (const node of tree) {
    const parent = rects[node.parent];
    const kids = node.children.filter((child) => rects[child.id]).map((child) => ({ ...child, rect: rects[child.id] }));
    if (!parent || !kids.length) continue;
    const rows = rowsOf(kids);
    const px = center(parent);
    const busFor = (row) => row.top - gap / 2;
    const multi = rows.length > 1;
    const trunkX = Math.min(...kids.map((k) => (k.rect.node || k.rect).left)) - trunkInset;
    const firstBus = busFor(rows[0]);
    const shared = [`M${px} ${parent.bottom}V${firstBus}`];
    rows.forEach((row, index) => {
      const bus = busFor(row);
      const xs = row.items.map((item) => center(item.rect));
      if (index === 0) xs.push(px);
      if (multi) xs.push(trunkX);
      const min = Math.min(...xs);
      const max = Math.max(...xs);
      if (max - min > 0.5) shared.push(`M${min} ${bus}H${max}`);
    });
    if (multi) shared.push(`M${trunkX} ${firstBus}V${busFor(rows.at(-1))}`);
    paths.push({ key: `bus:${node.parent}`, d: shared.join(''), kind: 'bus', from: node.parent });
    for (const row of rows) {
      const bus = busFor(row);
      for (const item of row.items) {
        const x = center(item.rect);
        paths.push({ key: `drop:${node.parent}>${item.id}`, d: `M${x} ${bus}V${item.rect.top - 1}`, kind: item.kind || 'directs', from: node.parent, to: item.id, arrow: true });
      }
    }
  }
  for (const edge of cross) {
    const a = rects[edge.from];
    const b = rects[edge.to];
    if (!a || !b) continue;
    const routed = routeAround(rects, edge.from, edge.to, { margin: crossMargin, bend: crossBend });
    const d = routed || curveBetween(a, b);
    paths.push({ key: `cross:${edge.kind}:${edge.from}>${edge.to}`, d, kind: edge.kind, from: edge.from, to: edge.to, arrow: true });
  }
  return paths;
}

// The old curve, kept only as the fallback when no route exists.
function curveBetween(a, b) {
  let start; let end; let c1; let c2;
  if (b.top >= a.bottom - 4) {
    start = [center(a) + 18, a.bottom];
    end = [center(b) + 18, b.top - 1];
    const dy = Math.max(30, (end[1] - start[1]) / 2);
    c1 = [start[0], start[1] + dy]; c2 = [end[0], end[1] - dy];
  } else {
    const leftToRight = center(a) <= center(b);
    start = [leftToRight ? a.right : a.left, (a.top + a.bottom) / 2];
    end = [leftToRight ? b.left - 1 : b.right + 1, (b.top + b.bottom) / 2];
    const dx = Math.max(30, Math.abs(end[0] - start[0]) / 2) * (leftToRight ? 1 : -1);
    c1 = [start[0] + dx, start[1]]; c2 = [end[0] - dx, end[1]];
  }
  return `M${start[0]} ${start[1]}C${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${end[0]} ${end[1]}`;
}

// Cross-level lines (reviews, runs inside its pane) through the GAPS between
// cards (2026-11-02). A curve between nearest edges ducked behind whatever
// cards lay in between and could come out on top of a reporting arrow, which
// read as a wrong line. This is an orthogonal router: candidate channels run
// just outside every card edge, a path may only travel where no card is, each
// turn costs extra so routes stay simple, and the line always leaves and
// enters a card from its SIDE (reporting lines own the top and bottom), so the
// two kinds never look alike. null when no route exists.
function routeAround(rects, fromId, toId, { margin = 8, bend = 30, radius = 6 } = {}) {
  const a = rects[fromId];
  const b = rects[toId];
  const cards = Object.values(rects);
  const blocked = (x1, y1, x2, y2) => cards.some((c) => Math.min(x1, x2) < c.right - 0.5 && Math.max(x1, x2) > c.left + 0.5
    && Math.min(y1, y2) < c.bottom - 0.5 && Math.max(y1, y2) > c.top + 0.5);
  const midA = (a.top + a.bottom) / 2;
  const midB = (b.top + b.bottom) / 2;
  const ports = (card, mid) => [
    { x: card.right, y: mid, stub: card.right + margin },
    { x: card.left, y: mid, stub: card.left - margin },
  ];
  const xsSet = new Set();
  const ysSet = new Set([midA, midB]);
  for (const c of cards) { xsSet.add(c.left - margin); xsSet.add(c.right + margin); ysSet.add(c.top - margin); ysSet.add(c.bottom + margin); }
  const xs = [...xsSet].sort((p, q) => p - q);
  const ys = [...ysSet].sort((p, q) => p - q);
  const W = xs.length;
  const id = (xi, yi) => yi * W + xi;
  const inside = (x, y) => cards.some((c) => x > c.left + 0.5 && x < c.right - 0.5 && y > c.top + 0.5 && y < c.bottom - 0.5);
  const valid = new Uint8Array(W * ys.length);
  for (let yi = 0; yi < ys.length; yi += 1) for (let xi = 0; xi < W; xi += 1) valid[id(xi, yi)] = inside(xs[xi], ys[yi]) ? 0 : 1;
  const neighbours = (node) => {
    const xi = node % W; const yi = (node - xi) / W; const out = [];
    for (const [dx, dy, dir] of [[1, 0, 0], [-1, 0, 0], [0, 1, 1], [0, -1, 1]]) {
      const nx = xi + dx; const ny = yi + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= ys.length || !valid[id(nx, ny)]) continue;
      if (blocked(xs[xi], ys[yi], xs[nx], ys[ny])) continue;
      out.push({ node: id(nx, ny), dir, len: Math.abs(xs[nx] - xs[xi]) + Math.abs(ys[ny] - ys[yi]) });
    }
    return out;
  };
  // Dijkstra over (node, direction) with a small binary heap.
  const search = (startNode, endNode) => {
    const best = new Map();
    const prev = new Map();
    const heap = [];
    const push = (item) => { heap.push(item); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p].cost <= heap[i].cost) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0]; const last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1; const r = l + 1; let m = i; if (l < heap.length && heap[l].cost < heap[m].cost) m = l; if (r < heap.length && heap[r].cost < heap[m].cost) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    const startKey = `${startNode}:0`;
    best.set(startKey, 0);
    push({ cost: 0, node: startNode, dir: 0 });
    while (heap.length) {
      const { cost, node, dir } = pop();
      const key = `${node}:${dir}`;
      if (cost > (best.get(key) ?? Infinity)) continue;
      if (node === endNode) return { cost: cost + (dir === 0 ? 0 : bend), key, prev };
      for (const step of neighbours(node)) {
        const next = cost + step.len + (step.dir === dir ? 0 : bend);
        const nextKey = `${step.node}:${step.dir}`;
        if (next < (best.get(nextKey) ?? Infinity)) { best.set(nextKey, next); prev.set(nextKey, key); push({ cost: next, node: step.node, dir: step.dir }); }
      }
    }
    return null;
  };
  let winner = null;
  for (const from of ports(a, midA)) for (const to of ports(b, midB)) {
    const sx = xs.indexOf(from.stub); const sy = ys.indexOf(midA);
    const ex = xs.indexOf(to.stub); const ey = ys.indexOf(midB);
    if (sx < 0 || sy < 0 || ex < 0 || ey < 0) continue;
    const s = id(sx, sy); const e = id(ex, ey);
    if (!valid[s] || !valid[e]) continue;
    const found = search(s, e);
    if (!found || (winner && found.cost >= winner.cost)) continue;
    const nodes = [];
    for (let key = found.key; key; key = found.prev.get(key)) nodes.unshift(Number(key.split(':')[0]));
    const points = [[from.x, from.y], ...nodes.map((n) => [xs[n % W], ys[(n - (n % W)) / W]]), [to.x + (to.stub > to.x ? 1 : -1), to.y]];
    winner = { cost: found.cost, points };
  }
  if (!winner) return null;
  // Drop points in the middle of a straight run, then round each corner.
  const pts = winner.points.filter((p, i, all) => {
    if (i === 0 || i === all.length - 1) return true;
    const [px, py] = all[i - 1]; const [nx, ny] = all[i + 1];
    return !((px === p[0] && p[0] === nx) || (py === p[1] && p[1] === ny));
  });
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length; i += 1) {
    const p = pts[i];
    if (i === pts.length - 1) { d += p[0] === pts[i - 1][0] ? `V${p[1]}` : `H${p[0]}`; break; }
    const prevPt = pts[i - 1]; const nextPt = pts[i + 1];
    const r = Math.min(radius, Math.hypot(p[0] - prevPt[0], p[1] - prevPt[1]) / 2, Math.hypot(nextPt[0] - p[0], nextPt[1] - p[1]) / 2);
    const inX = Math.sign(p[0] - prevPt[0]); const inY = Math.sign(p[1] - prevPt[1]);
    const outX = Math.sign(nextPt[0] - p[0]); const outY = Math.sign(nextPt[1] - p[1]);
    const before = [p[0] - inX * r, p[1] - inY * r];
    const after = [p[0] + outX * r, p[1] + outY * r];
    d += inY === 0 ? `H${before[0]}` : `V${before[1]}`;
    d += `Q${p[0]} ${p[1]} ${after[0]} ${after[1]}`;
  }
  return d;
}

module.exports = { connectorPaths, rowsOf, routeAround };
