// The reference web: an SVG arc diagram of loaded sections and the
// cross-references between them. Loaded sections are solid nodes on a
// baseline; sections that are cited but not loaded appear as ghost nodes
// (dashed = unknown, amber = present in the SpecR library, just not loaded).

const SVG_NS = 'http://www.w3.org/2000/svg';

const NODE_SPACING = 130;
const BASELINE_PAD = 46;
const SIDE_PAD = 70;
const MIN_ARC = 26;

function svgEl(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    node.setAttribute(key, value);
  }
  return node;
}

// specs: Map<specId, { tree, references }>
// Returns { nodes: [{section, status, refCount}], edges: [{from, to, count, status}] }
export function buildWebModel(specs) {
  const loaded = new Map(); // section -> specId
  for (const spec of specs.values()) {
    loaded.set(spec.tree.section, spec.tree.id);
  }

  const ghosts = new Map(); // section -> 'library' | 'unresolved'
  const edgeMap = new Map(); // "from→to" -> { from, to, count, status }

  for (const spec of specs.values()) {
    const from = spec.tree.section;
    for (const ref of spec.references) {
      if (!ref.targetSection) continue; // standards refs stay off the web
      const to = ref.targetSection;
      if (to === from) continue; // a section citing itself is header noise
      let status;
      if (loaded.has(to)) {
        status = 'loaded';
      } else if (ref.targetSpecId) {
        status = 'library';
        if (ghosts.get(to) !== 'library') ghosts.set(to, 'library');
      } else {
        status = 'unresolved';
        if (!ghosts.has(to)) ghosts.set(to, 'unresolved');
      }
      // A server-marked broken citation overrides the arc colour regardless of
      // whether the target is still a ghost on the baseline.
      if (ref.isBroken) status = 'broken';
      const key = `${from}→${to}`;
      const existing = edgeMap.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        edgeMap.set(key, { from, to, count: 1, status });
      }
    }
  }

  const nodes = [
    ...[...loaded.keys()].map((section) => ({ section, status: 'loaded' })),
    ...[...ghosts.entries()].map(([section, status]) => ({ section, status })),
  ].sort((a, b) => a.section.localeCompare(b.section));

  return { nodes, edges: [...edgeMap.values()] };
}

export function renderWeb(canvas, model, callbacks) {
  canvas.replaceChildren();

  if (model.nodes.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'web-empty';
    empty.textContent = 'NO SECTIONS LOADED — THE WEB DRAWS ITSELF AS SHEETS ARRIVE';
    canvas.appendChild(empty);
    return;
  }

  const positions = new Map();
  model.nodes.forEach((node, i) => {
    positions.set(node.section, SIDE_PAD + i * NODE_SPACING);
  });

  const width = SIDE_PAD * 2 + Math.max(0, model.nodes.length - 1) * NODE_SPACING;
  const maxSpan = model.edges.reduce((max, edge) => {
    const x1 = positions.get(edge.from);
    const x2 = positions.get(edge.to);
    return Math.max(max, Math.abs(x2 - x1));
  }, 0);
  const arcCeiling = MIN_ARC + maxSpan * 0.16;
  const height = arcCeiling + BASELINE_PAD + 34;
  const baseline = arcCeiling + 8;

  const svg = svgEl('svg', {
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': 'Cross-reference web between loaded spec sections',
  });

  // arcs first (under the nodes)
  for (const edge of model.edges) {
    const x1 = positions.get(edge.from);
    const x2 = positions.get(edge.to);
    if (x1 === undefined || x2 === undefined) continue;
    const span = Math.abs(x2 - x1);
    const lift = MIN_ARC + span * 0.16;
    const mid = (x1 + x2) / 2;

    const path = svgEl('path', {
      d: `M ${x1} ${baseline - 9} Q ${mid} ${baseline - lift - 9} ${x2} ${baseline - 9}`,
      class: `web-arc is-${edge.status}`,
    });
    const label =
      edge.count > 1
        ? `${edge.from} cites ${edge.to} (${edge.count} references)`
        : `${edge.from} cites ${edge.to}`;
    path.appendChild(svgEl('title', {})).textContent = label;
    path.addEventListener('click', () => {
      if (edge.status === 'loaded' && callbacks.onNavigate) callbacks.onNavigate(edge.to);
    });
    path.addEventListener('mouseenter', () => callbacks.onEdgeHover?.(edge, true));
    path.addEventListener('mouseleave', () => callbacks.onEdgeHover?.(edge, false));
    svg.appendChild(path);

    // direction tick: small arrowhead at the target end of the arc
    const dir = x2 > x1 ? -1 : 1;
    const arrow = svgEl('path', {
      d: `M ${x2} ${baseline - 10} l ${7 * dir} -7 l ${2 * dir} 5 z`,
      class: 'web-arrow',
    });
    svg.appendChild(arrow);
  }

  for (const node of model.nodes) {
    const x = positions.get(node.section);
    const group = svgEl('g', { class: `web-node is-${node.status}` });
    if (node.status === 'loaded') group.classList.remove('is-loaded');
    if (node.status !== 'loaded') group.classList.add('is-ghost');
    if (node.status === 'library') group.classList.add('is-library');

    group.appendChild(svgEl('circle', { cx: x, cy: baseline, r: 8 }));
    const label = svgEl('text', { x, y: baseline + 24 });
    label.textContent = node.section;
    group.appendChild(label);

    if (node.status !== 'loaded') {
      const tag = svgEl('text', { x, y: baseline + 38, class: 'node-count' });
      tag.textContent = node.status === 'library' ? 'IN LIBRARY' : 'UNRESOLVED';
      group.appendChild(tag);
    }

    if (node.status === 'loaded' && callbacks.onNavigate) {
      group.addEventListener('click', () => callbacks.onNavigate(node.section));
    }
    svg.appendChild(group);
  }

  canvas.appendChild(svg);
}
