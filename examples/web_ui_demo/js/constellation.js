// Constellation view: the whole project corpus as division "solar systems".
// Each division's umbrella section (NN 00 00) is the sun everything orbits —
// or a BLACK HOLE when the project defines no umbrella (an instant audit cue).
// Sections are planets sized by how many project sections cite them; citation
// sightlines run between planets; a citation whose target is missing ends in a
// red ✕ (or an amber ghost when the target sits in a source library, one click
// from being added). Hover a planet to light its sightlines; click a sightline
// to open the citing paragraph in the Editor tab.
//
// The map reads the same client state as the Reference Web (the specs Map), so
// edits, flags, additions, and removals reshape it immediately.

import { divisionOf, divisionName, umbrellaSection, isUmbrella } from './divisions.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const VIEW_W = 1200;
const ALL_COLS = 3;
const CELL_W = 400;
const ORBIT_R = 80;
const PER_RING_ALL = 10;
const FOCUS_CX = 600;
const FOCUS_CY = 385;
const FOCUS_H = 780;

function svgEl(tag, attrs, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ctx contract (wired in app.js):
//   getSpecs()             -> Map<specId, { tree, references }>
//   displaySection(s)      -> section formatted per project setting
//   isFlagged(section)     -> editor review-queue state (amber planets)
//   findInMasters(section) -> library spec { section, title } | null
//   addSection(section)    -> async add-from-masters (throws w/ .status)
//   openInEditor(section)  -> switch to the Editor tab on this section
//   openCitation(from, to) -> Editor tab, citing paragraph located
//   isActive()             -> true when the constellation view is visible
//   toast(msg, kind)
export function initConstellation(ctx) {
  const canvas = document.getElementById('const-canvas');
  const toolbar = document.getElementById('const-toolbar');
  const panelHost = document.getElementById('const-panel');

  let focusDiv = null; // division code when a single system is focused
  let lane = 'all'; // 'all' | 'cross' | 'broken'
  let sel = null; // { type: 'star'|'hole'|'ghost', section } | null

  // ── model ─────────────────────────────────────────────────────────────────

  // nodes: section -> { title }
  // edges: [{ from, to, status: 'live'|'library'|'broken' }] deduped per pair
  // inbound: section -> live-inbound count · touched: section -> true
  function buildModel() {
    const specs = ctx.getSpecs();
    const nodes = new Map();
    for (const spec of specs.values()) {
      if (!nodes.has(spec.tree.section)) {
        nodes.set(spec.tree.section, { title: spec.tree.title || 'Untitled Section' });
      }
    }
    const pairSeen = new Set();
    const edges = [];
    for (const spec of specs.values()) {
      const from = spec.tree.section;
      for (const ref of spec.references) {
        if (!ref.targetSection || ref.targetSection === from) continue;
        const to = ref.targetSection;
        const key = `${from}>${to}`;
        if (pairSeen.has(key)) continue;
        pairSeen.add(key);
        let status;
        if (ref.isBroken || !nodes.has(to)) {
          status = !nodes.has(to) && ref.targetSpecId ? 'library' : 'broken';
        } else {
          status = 'live';
        }
        edges.push({ from, to, status });
      }
    }
    const inbound = new Map();
    const touched = new Set();
    for (const edge of edges) {
      touched.add(edge.from);
      if (edge.status === 'live') {
        inbound.set(edge.to, (inbound.get(edge.to) ?? 0) + 1);
        touched.add(edge.to);
      }
    }
    return { nodes, edges, inbound, touched };
  }

  function groupByDivision(nodes) {
    const byDiv = new Map();
    for (const section of nodes.keys()) {
      const division = divisionOf(section);
      byDiv.set(division, [...(byDiv.get(division) ?? []), section]);
    }
    for (const members of byDiv.values()) members.sort();
    return byDiv;
  }

  // Unique cross-division citations landing in each division — powers sun glow.
  function crossInboundByDivision(edges) {
    const counts = new Map();
    for (const edge of edges) {
      if (edge.status !== 'live') continue;
      const fromDiv = divisionOf(edge.from);
      const toDiv = divisionOf(edge.to);
      if (fromDiv === toDiv) continue;
      counts.set(toDiv, (counts.get(toDiv) ?? 0) + 1);
    }
    return counts;
  }

  // ── layout: all systems ───────────────────────────────────────────────────

  // Outer ring radius for an n-member system (empty systems keep a tight hull).
  function systemRadius(memberCount) {
    if (memberCount === 0) return 34;
    return ORBIT_R + Math.floor((memberCount - 1) / PER_RING_ALL) * 26;
  }

  function layoutAll(model) {
    const byDiv = groupByDivision(model.nodes);
    const divisions = [...byDiv.keys()].sort();
    const pos = new Map();
    const systems = [];
    // Rows are sized by their tallest system so dense divisions never clip
    // their header off-canvas or overlap the row below. 44px covers the
    // header (-30) / sun-label (+26) offsets plus text height.
    const ROW_PAD = 44;
    let rowTop = 20;
    for (let row = 0; row * ALL_COLS < divisions.length; row += 1) {
      const rowDivs = divisions.slice(row * ALL_COLS, (row + 1) * ALL_COLS);
      const rowRad = Math.max(
        ...rowDivs.map((d) => systemRadius(byDiv.get(d).filter((s) => !isUmbrella(s)).length))
      );
      const cy = rowTop + ROW_PAD + rowRad;
      rowDivs.forEach((division, col) => {
        const index = row * ALL_COLS + col;
        const cx = 200 + col * CELL_W;
        const umbrella = umbrellaSection(division);
        const members = byDiv.get(division).filter((section) => !isUmbrella(section));
        members.forEach((section, i) => {
          const ring = Math.floor(i / PER_RING_ALL);
          const rad = ORBIT_R + ring * 26;
          const perRing = Math.min(PER_RING_ALL, members.length - ring * PER_RING_ALL);
          const angle =
            (i % PER_RING_ALL) * ((Math.PI * 2) / perRing) + index * 0.9 + ring * 0.6 + 0.5;
          pos.set(section, [cx + Math.cos(angle) * rad, cy + Math.sin(angle) * rad]);
        });
        pos.set(umbrella, [cx, cy]);
        const orbitRadii = [];
        for (let ring = 0; ring * PER_RING_ALL < members.length; ring += 1) {
          orbitRadii.push(ORBIT_R + ring * 26);
        }
        systems.push({
          division,
          cx,
          cy,
          maxRad: systemRadius(members.length),
          orbitRadii,
          members,
        });
      });
      rowTop = cy + rowRad + ROW_PAD;
    }
    return { pos, systems, height: rowTop + 20 };
  }

  // ── layout: one focused system ────────────────────────────────────────────

  function layoutFocused(model, division) {
    const byDiv = groupByDivision(model.nodes);
    const members = (byDiv.get(division) ?? []).filter((section) => !isUmbrella(section));
    const pos = new Map();
    const perRing = 10;
    members.forEach((section, i) => {
      const ring = Math.floor(i / perRing);
      const rad = 185 + ring * 55;
      const count = Math.min(perRing, members.length - ring * perRing);
      const angle = (i % perRing) * ((Math.PI * 2) / count) + 0.35 + ring * 0.5;
      pos.set(section, [FOCUS_CX + Math.cos(angle) * rad, FOCUS_CY + Math.sin(angle) * rad]);
    });
    pos.set(umbrellaSection(division), [FOCUS_CX, FOCUS_CY]);
    const orbitRadii = [];
    for (let ring = 0; ring < Math.max(1, Math.ceil(members.length / perRing)); ring += 1) {
      if (members.length > 0) orbitRadii.push(185 + ring * 55);
    }
    return { pos, members, orbitRadii, height: FOCUS_H };
  }

  // ── drawing helpers ───────────────────────────────────────────────────────

  function starRadius(inboundCount) {
    return Math.min(14, 5.5 + inboundCount * 1.3);
  }

  function drawEdge(group, [x1, y1], [x2, y2], { cls, from, to, dash }) {
    const line = svgEl('line', {
      x1: Math.round(x1),
      y1: Math.round(y1),
      x2: Math.round(x2),
      y2: Math.round(y2),
      class: cls,
    });
    if (dash) line.setAttribute('stroke-dasharray', dash);
    if (from) line.dataset.from = from;
    if (to) line.dataset.to = to;
    group.appendChild(line);
    return line;
  }

  function drawHitLane(group, [x1, y1], [x2, y2], tip, onClick) {
    const hit = svgEl('line', {
      x1: Math.round(x1),
      y1: Math.round(y1),
      x2: Math.round(x2),
      y2: Math.round(y2),
      class: 'cst-hit',
    });
    hit.appendChild(svgEl('title', {}, tip));
    hit.addEventListener('click', onClick);
    group.appendChild(hit);
  }

  function drawSun(group, cx, cy, division, crossIn) {
    const sun = svgEl('g', { class: 'cst-sun' });
    const glowR = Math.round(26 + Math.min(20, crossIn * 3.5));
    const midR = Math.round(17 + Math.min(9, crossIn * 1.6));
    sun.appendChild(
      svgEl('circle', {
        cx,
        cy,
        r: glowR,
        class: 'cst-sun-glow',
        opacity: (0.08 + Math.min(0.22, crossIn * 0.045)).toFixed(2),
      })
    );
    sun.appendChild(
      svgEl('circle', {
        cx,
        cy,
        r: midR,
        class: 'cst-sun-glow',
        opacity: (0.16 + Math.min(0.3, crossIn * 0.055)).toFixed(2),
      })
    );
    const core = svgEl('circle', {
      cx,
      cy,
      r: 10,
      class: `cst-sun-core${crossIn >= 3 ? ' is-bright' : ''}`,
    });
    const umbrella = umbrellaSection(division);
    core.appendChild(
      svgEl(
        'title',
        {},
        `DIV ${division} umbrella — ${crossIn} citation${crossIn === 1 ? '' : 's'} into this division from other divisions`
      )
    );
    core.addEventListener('click', () => select({ type: 'star', section: umbrella }));
    sun.appendChild(core);
    group.appendChild(sun);
  }

  function drawHole(group, cx, cy, division) {
    const hole = svgEl('g', { class: 'cst-hole' });
    hole.appendChild(svgEl('circle', { cx, cy, r: 14, class: 'cst-hole-ring' }));
    const core = svgEl('circle', { cx, cy, r: 9, class: 'cst-hole-core' });
    core.appendChild(
      svgEl('title', {}, `DIV ${division} has no umbrella section — click to add one from your masters`)
    );
    core.addEventListener('click', () => select({ type: 'hole', section: umbrellaSection(division) }));
    hole.appendChild(core);
    group.appendChild(hole);
  }

  function drawStar(group, section, [x, y], model) {
    const inboundCount = model.inbound.get(section) ?? 0;
    const orphan = !model.touched.has(section);
    const flagged = ctx.isFlagged(section);
    const hub = inboundCount >= 3;
    const r = starRadius(inboundCount);
    const star = svgEl('g', { class: 'cst-star' });
    star.dataset.section = section;
    if (hub) star.classList.add('is-hub');
    if (orphan && !flagged) star.classList.add('is-orphan');
    if (flagged) star.classList.add('is-flagged');
    if (sel && sel.type === 'star' && sel.section === section) {
      star.appendChild(svgEl('circle', { cx: x, cy: y, r: (r * 1.9).toFixed(1), class: 'cst-sel-pulse' }));
    }
    star.appendChild(svgEl('circle', { cx: x, cy: y, r: (r * 2).toFixed(1), class: 'cst-star-glow' }));
    const body = svgEl('circle', { cx: x, cy: y, r: r.toFixed(1), class: 'cst-star-body' });
    const title = model.nodes.get(section)?.title ?? '';
    body.appendChild(svgEl('title', {}, `${ctx.displaySection(section)} — ${title}`));
    body.addEventListener('mouseenter', () => setHover(section));
    body.addEventListener('mouseleave', () => setHover(null));
    body.addEventListener('click', () => select({ type: 'star', section }));
    star.appendChild(body);
    group.appendChild(star);
    return r;
  }

  function label(group, x, y, text, cls, anchorSection) {
    const node = svgEl('text', { x: Math.round(x), y: Math.round(y), class: cls, 'text-anchor': 'middle' }, text);
    if (anchorSection) node.dataset.section = anchorSection;
    group.appendChild(node);
  }

  // Where a lane to a missing target ends: pushed outward from the system
  // center so phantoms sit past the orbit rim.
  function phantomPoint([x, y], [cx, cy], distance, maxY) {
    let dx = x - cx;
    let dy = y - cy;
    const d = Math.max(1, Math.hypot(dx, dy));
    dx /= d;
    dy /= d;
    return [
      Math.min(VIEW_W - 40, Math.max(40, x + dx * distance)),
      Math.min(maxY - 30, Math.max(40, y + dy * distance)),
    ];
  }

  function laneAllows(edge) {
    if (lane === 'broken') return edge.status !== 'live';
    if (lane === 'cross') return divisionOf(edge.from) !== divisionOf(edge.to);
    return true;
  }

  // ── render: all systems ───────────────────────────────────────────────────

  function renderAll(model) {
    const { pos, systems, height } = layoutAll(model);
    const svg = svgEl('svg', {
      viewBox: `0 0 ${VIEW_W} ${height}`,
      class: 'cst-svg',
      role: 'img',
      'aria-label': 'Constellation map of project spec sections and their citations',
    });
    const orbits = svgEl('g', {});
    const lanes = svgEl('g', {});
    const bodies = svgEl('g', {});
    const labels = svgEl('g', {});
    const hits = svgEl('g', {});
    svg.append(orbits, lanes, hits, bodies, labels);

    const crossIn = crossInboundByDivision(model.edges);
    const centers = new Map();
    for (const system of systems) {
      centers.set(system.division, [system.cx, system.cy]);
      for (const radius of system.orbitRadii) {
        orbits.appendChild(
          svgEl('circle', { cx: system.cx, cy: system.cy, r: radius, class: 'cst-orbit' })
        );
      }
      label(
        labels,
        system.cx,
        system.cy - system.maxRad - 30,
        `DIV ${system.division} · ${divisionName(system.division)}`,
        'cst-lbl-div'
      );
      const umbrella = umbrellaSection(system.division);
      if (model.nodes.has(umbrella)) {
        drawSun(bodies, system.cx, system.cy, system.division, crossIn.get(system.division) ?? 0);
        label(labels, system.cx, system.cy + system.maxRad + 26, `☀ ${ctx.displaySection(umbrella)}`, 'cst-lbl-sun');
      } else {
        drawHole(bodies, system.cx, system.cy, system.division);
        label(
          labels,
          system.cx,
          system.cy + system.maxRad + 26,
          `● ${ctx.displaySection(umbrella)} · NOT DEFINED`,
          'cst-lbl-hole'
        );
      }
      // faint spokes: members implicitly fall under a defined umbrella
      if (lane === 'all' && model.nodes.has(umbrella)) {
        for (const section of system.members) {
          drawEdge(lanes, pos.get(section), [system.cx, system.cy], {
            cls: 'cst-edge is-spoke',
            from: section,
            to: umbrella,
          });
        }
      }
    }

    drawCitationLanes(model, pos, centers, {
      lanes,
      bodies,
      labels,
      hits,
      phantomDistance: 88,
      maxY: height,
    });

    for (const [section] of model.nodes) {
      if (isUmbrella(section)) continue;
      const p = pos.get(section);
      const r = drawStar(bodies, section, p, model);
      label(labels, p[0], p[1] + r + 13, ctx.displaySection(section), starLabelClass(section, model), section);
    }
    return svg;
  }

  function starLabelClass(section, model) {
    if (ctx.isFlagged(section)) return 'cst-lbl-star is-flagged';
    if (!model.touched.has(section)) return 'cst-lbl-star is-orphan';
    if ((model.inbound.get(section) ?? 0) >= 3) return 'cst-lbl-star is-hub';
    return 'cst-lbl-star';
  }

  // Citation sightlines shared by both layouts. For a live edge both ends are
  // planets; for a missing target the lane runs to a phantom point (red ✕) or
  // an amber library ghost. In the focused layout `portalPos` supplies the
  // entry/exit point for lanes that cross into another system.
  function drawCitationLanes(
    model,
    pos,
    centers,
    { lanes, bodies, labels, hits, phantomDistance, maxY, portalPos = null }
  ) {
    for (const edge of model.edges) {
      if (!laneAllows(edge)) continue;
      let fromP = pos.get(edge.from);
      let fromPortal = false;
      if (!fromP && portalPos) {
        fromP = portalPos(divisionOf(edge.from));
        fromPortal = true;
      }
      if (!fromP) continue;
      if (edge.status === 'live') {
        let toP = pos.get(edge.to);
        let exit = false;
        if (!toP && portalPos) {
          toP = portalPos(divisionOf(edge.to));
          exit = true;
        }
        if (!toP) continue;
        drawEdge(lanes, fromP, toP, {
          cls: 'cst-edge is-lane',
          from: edge.from,
          to: edge.to,
          dash: exit || fromPortal ? '6 5' : '',
        });
        drawHitLane(
          hits,
          fromP,
          toP,
          `${ctx.displaySection(edge.from)} cites ${ctx.displaySection(edge.to)} — click to open the citing paragraph`,
          () => ctx.openCitation(edge.from, edge.to)
        );
        continue;
      }
      const ghost = edge.status === 'library';
      // A citation the server marked broken can still point at a planet on the
      // board (the sheet is loaded but out of the project): draw the severed
      // lane planet-to-planet instead of inventing a phantom.
      const presentTarget = pos.get(edge.to);
      if (presentTarget) {
        drawEdge(lanes, fromP, presentTarget, {
          cls: `cst-edge ${ghost ? 'is-ghostlane' : 'is-brokenlane'}`,
          from: edge.from,
          to: edge.to,
          dash: '5 4',
        });
        drawHitLane(
          hits,
          fromP,
          presentTarget,
          `BROKEN — ${ctx.displaySection(edge.from)} cites ${ctx.displaySection(edge.to)}, which is out of the project. Click to open the citing paragraph.`,
          () => ctx.openCitation(edge.from, edge.to)
        );
        continue;
      }
      // missing target: phantom endpoint past the rim (or at the portal ring)
      const center = centers.get(divisionOf(edge.from)) ?? [FOCUS_CX, FOCUS_CY];
      let toP = portalPos ? portalPos(divisionOf(edge.to)) : null;
      if (!toP) toP = phantomPoint(fromP, center, phantomDistance, maxY);
      drawEdge(lanes, fromP, toP, {
        cls: `cst-edge ${ghost ? 'is-ghostlane' : 'is-brokenlane'}`,
        from: edge.from,
        to: edge.to,
        dash: '5 4',
      });
      const mx = fromP[0] + (toP[0] - fromP[0]) * 0.78;
      const my = fromP[1] + (toP[1] - fromP[1]) * 0.78;
      if (ghost) {
        const marker = svgEl('circle', { cx: Math.round(mx), cy: Math.round(my), r: 6, class: 'cst-ghost-dot' });
        marker.appendChild(
          svgEl('title', {}, `${ctx.displaySection(edge.to)} is in a source library — click to review and add it`)
        );
        marker.addEventListener('click', () => select({ type: 'ghost', section: edge.to }));
        bodies.appendChild(marker);
        label(labels, mx, my + 18, ctx.displaySection(edge.to), 'cst-lbl-ghost');
      } else {
        label(labels, mx, my + 4, '✕', 'cst-mark');
        label(labels, mx, my + 16, ctx.displaySection(edge.to), 'cst-lbl-broken');
      }
      drawHitLane(
        hits,
        fromP,
        toP,
        `${ghost ? 'IN LIBRARY' : 'BROKEN'} — ${ctx.displaySection(edge.from)} cites ${ctx.displaySection(edge.to)}, which is not in the project. Click to open the citing paragraph.`,
        () => ctx.openCitation(edge.from, edge.to)
      );
    }
  }

  // ── render: focused system ────────────────────────────────────────────────

  function renderFocused(model, division) {
    const { pos, members, orbitRadii, height } = layoutFocused(model, division);
    const svg = svgEl('svg', {
      viewBox: `0 0 ${VIEW_W} ${height}`,
      class: 'cst-svg',
      role: 'img',
      'aria-label': `Division ${division} star system`,
    });
    const orbits = svgEl('g', {});
    const lanes = svgEl('g', {});
    const bodies = svgEl('g', {});
    const labels = svgEl('g', {});
    const hits = svgEl('g', {});
    svg.append(orbits, lanes, hits, bodies, labels);

    for (const radius of orbitRadii) {
      orbits.appendChild(svgEl('circle', { cx: FOCUS_CX, cy: FOCUS_CY, r: radius, class: 'cst-orbit' }));
    }
    label(labels, FOCUS_CX, 34, `DIV ${division} · ${divisionName(division)} — STAR SYSTEM VIEW`, 'cst-lbl-div');

    const inSystem = (section) => divisionOf(section) === division;
    // Lanes that touch this system. A citation from outside toward a target
    // that is missing here has no drawable endpoints — skip it (the all-systems
    // view still shows it at its source).
    const systemEdges = model.edges.filter(
      (e) => inSystem(e.from) || (e.status === 'live' && inSystem(e.to))
    );
    const focusModel = { ...model, edges: systemEdges };

    // portals: every other division this system trades citations with
    const portalDivs = [
      ...new Set(
        systemEdges
          .flatMap((e) => [divisionOf(e.from), divisionOf(e.to)])
          .filter((d) => d !== division)
      ),
    ].sort();
    const liveDivs = new Set([...model.nodes.keys()].map(divisionOf));
    const portalPoints = new Map();
    portalDivs.forEach((d, i) => {
      const angle = (i * (Math.PI * 2)) / portalDivs.length - Math.PI / 2;
      const px = Math.round(FOCUS_CX + Math.cos(angle) * 455);
      const py = Math.round(FOCUS_CY + Math.sin(angle) * 315);
      portalPoints.set(d, [px, py]);
      const inProject = liveDivs.has(d);
      const hasBroken = systemEdges.some((e) => e.status !== 'live' && divisionOf(e.to) === d);
      const portal = svgEl('g', {
        class: `cst-portal${inProject ? '' : ' is-void'}${hasBroken ? ' is-broken' : ''}`,
      });
      portal.appendChild(svgEl('circle', { cx: px, cy: py, r: 19, class: 'cst-portal-halo' }));
      const core = svgEl('circle', { cx: px, cy: py, r: 12, class: 'cst-portal-core' });
      core.appendChild(
        svgEl(
          'title',
          {},
          inProject
            ? `DIV ${d} · ${divisionName(d)} — click to travel to this system`
            : `DIV ${d} — no sections in this project`
        )
      );
      if (inProject) {
        core.addEventListener('click', () => {
          focusDiv = d;
          sel = null;
          render();
        });
      }
      portal.appendChild(core);
      bodies.appendChild(portal);
      label(labels, px, py + 34, `DIV ${d}`, `cst-lbl-portal${hasBroken ? ' is-broken' : ''}`);
      if (!inProject) label(labels, px, py + 46, 'NOT IN PROJECT', 'cst-lbl-hole is-small');
    });

    const umbrella = umbrellaSection(division);
    const crossIn = crossInboundByDivision(model.edges).get(division) ?? 0;
    if (model.nodes.has(umbrella)) {
      drawSun(bodies, FOCUS_CX, FOCUS_CY, division, crossIn);
      label(labels, FOCUS_CX, FOCUS_CY + 28, `☀ ${ctx.displaySection(umbrella)}`, 'cst-lbl-sun');
      if (lane === 'all') {
        for (const section of members) {
          drawEdge(lanes, pos.get(section), [FOCUS_CX, FOCUS_CY], {
            cls: 'cst-edge is-spoke',
            from: section,
            to: umbrella,
          });
        }
      }
    } else {
      drawHole(bodies, FOCUS_CX, FOCUS_CY, division);
      label(labels, FOCUS_CX, FOCUS_CY + 30, `● ${ctx.displaySection(umbrella)} · NOT DEFINED`, 'cst-lbl-hole');
    }

    drawCitationLanes(focusModel, pos, new Map([[division, [FOCUS_CX, FOCUS_CY]]]), {
      lanes,
      bodies,
      labels,
      hits,
      phantomDistance: 78,
      maxY: height,
      portalPos: (d) => portalPoints.get(d) ?? null,
    });

    for (const section of members) {
      const p = pos.get(section);
      const r = drawStar(bodies, section, p, model);
      label(labels, p[0], p[1] + r + 13, ctx.displaySection(section), starLabelClass(section, model), section);
      const title = model.nodes.get(section)?.title ?? '';
      const short = title.length > 26 ? `${title.slice(0, 25)}…` : title;
      label(labels, p[0], p[1] + r + 25, short, 'cst-lbl-title', section);
    }
    return svg;
  }

  // ── hover (class toggles only — no rebuild) ───────────────────────────────

  function setHover(section) {
    const svg = canvas.querySelector('svg');
    if (!svg) return;
    svg.classList.toggle('has-hover', Boolean(section));
    for (const edge of svg.querySelectorAll('.cst-edge')) {
      // Umbrella spokes stay dim under hover — only citation lanes light up.
      const lit =
        Boolean(section) &&
        !edge.classList.contains('is-spoke') &&
        (edge.dataset.from === section || edge.dataset.to === section);
      edge.classList.toggle('is-lit', lit);
    }
    if (!section) {
      for (const node of svg.querySelectorAll('.is-near')) node.classList.remove('is-near');
      return;
    }
    const near = new Set([section]);
    for (const edge of svg.querySelectorAll('.cst-edge.is-lit')) {
      if (edge.dataset.from) near.add(edge.dataset.from);
      if (edge.dataset.to) near.add(edge.dataset.to);
    }
    for (const star of svg.querySelectorAll('.cst-star')) {
      star.classList.toggle('is-near', near.has(star.dataset.section));
    }
    for (const text of svg.querySelectorAll('text[data-section]')) {
      text.classList.toggle('is-near', near.has(text.dataset.section));
    }
  }

  // ── toolbar ───────────────────────────────────────────────────────────────

  function renderToolbar(model) {
    toolbar.replaceChildren();
    if (focusDiv && !groupByDivision(model.nodes).has(focusDiv)) focusDiv = null;

    if (focusDiv) {
      const back = el('button', 'cst-back', '◂ ALL SYSTEMS');
      back.type = 'button';
      back.addEventListener('click', () => {
        focusDiv = null;
        sel = null;
        render();
      });
      toolbar.appendChild(back);
    }

    const sysLabel = el('span', 'cst-tool-cap', 'SYSTEM');
    toolbar.appendChild(sysLabel);
    const select = el('select', 'cst-sys-select');
    select.setAttribute('aria-label', 'Focus one division system');
    const allOpt = el('option', null, 'ALL SYSTEMS');
    allOpt.value = '';
    select.appendChild(allOpt);
    for (const division of [...groupByDivision(model.nodes).keys()].sort()) {
      const opt = el('option', null, `DIV ${division} — ${divisionName(division)}`);
      opt.value = division;
      select.appendChild(opt);
    }
    select.value = focusDiv ?? '';
    select.addEventListener('change', () => {
      focusDiv = select.value || null;
      sel = null;
      render();
    });
    toolbar.appendChild(select);

    const spacer = el('span', 'cst-tool-spacer');
    toolbar.appendChild(spacer);
    toolbar.appendChild(el('span', 'cst-tool-cap', 'TRAVEL LANES'));
    const chips = el('span', 'cst-lane-chips');
    for (const [id, text] of [
      ['all', 'ALL LANES'],
      ['cross', 'CROSS-SYSTEM'],
      ['broken', 'BROKEN ONLY'],
    ]) {
      const chip = el('button', `cst-lane-chip${lane === id ? ' is-active' : ''}`, text);
      chip.type = 'button';
      chip.addEventListener('click', () => {
        lane = id;
        render();
      });
      chips.appendChild(chip);
    }
    toolbar.appendChild(chips);
  }

  // ── detail panel ──────────────────────────────────────────────────────────

  function select(next) {
    sel = next;
    render();
  }

  function panelAction(text, cls, onClick, { disabled = false } = {}) {
    const btn = el('button', `cst-panel-action ${cls}`, text);
    btn.type = 'button';
    btn.disabled = disabled;
    if (!disabled) btn.addEventListener('click', onClick);
    return btn;
  }

  function panelRefList(host, caption, items) {
    if (items.length === 0) return;
    host.appendChild(el('div', 'cst-panel-cap', caption));
    const list = el('div', 'cst-panel-list');
    for (const item of items) {
      const row = el('button', `cst-panel-ref${item.broken ? ' is-broken' : ''}`);
      row.type = 'button';
      row.appendChild(el('span', 'cst-panel-dot'));
      row.appendChild(el('span', 'cst-panel-num', ctx.displaySection(item.section)));
      row.appendChild(el('span', 'cst-panel-reftitle', item.title));
      if (item.onGo) row.addEventListener('click', item.onGo);
      else row.disabled = true;
      list.appendChild(row);
    }
    host.appendChild(list);
  }

  function renderPanel(model) {
    panelHost.replaceChildren();
    if (!sel) {
      panelHost.appendChild(el('div', 'cst-panel-head', 'PROJECT SPEC MAP'));
      const body = el('div', 'cst-panel-body');
      body.appendChild(
        el(
          'p',
          null,
          'Each division is a solar system. Its umbrella section is the sun; project sections orbit it, sized by how many sections cite them.'
        )
      );
      body.appendChild(
        el(
          'p',
          null,
          'Hover a planet to trace its sightlines. Click a planet or sun for details, a sightline to open the citing paragraph, a black hole to add the missing umbrella from your masters.'
        )
      );
      body.appendChild(
        el('p', null, 'This map is live — edits, flags, and removals in the Editor tab reshape it immediately.')
      );
      panelHost.appendChild(body);
      return;
    }

    const head = el('div', 'cst-panel-head is-selected');
    head.appendChild(el('span', `cst-panel-secnum${sel.type === 'star' ? '' : ' is-amber'}`, ctx.displaySection(sel.section)));
    const close = el('button', 'cst-panel-close', '×');
    close.type = 'button';
    close.addEventListener('click', () => select(null));
    head.appendChild(close);
    panelHost.appendChild(head);

    if (sel.type === 'star' && model.nodes.has(sel.section)) {
      renderStarPanel(model, sel.section);
    } else if (sel.type === 'hole') {
      renderMissingPanel(sel.section, {
        title: `${divisionName(divisionOf(sel.section))} — umbrella not defined`,
        status: 'BLACK HOLE · NOTHING WRITTEN AT DIVISION LEVEL',
        bodyInMasters: `Division ${divisionOf(sel.section)} has no umbrella section in this project. Your source libraries have one ready to bring in.`,
        bodyMissing: `Division ${divisionOf(sel.section)} has no umbrella section in this project, and none exists in your source libraries yet — it would need to be authored.`,
      });
    } else {
      renderMissingPanel(sel.section, {
        title: ctx.findInMasters(sel.section)?.title ?? 'Not in this project',
        status: 'CITED BUT NOT IN PROJECT',
        bodyInMasters:
          'Project sections cite this number but it is not in the project. Your source libraries hold it — add it to resolve the ghost lanes.',
        bodyMissing:
          'Project sections cite this number but it is not in the project or your source libraries — importing or authoring it would resolve the lanes.',
      });
    }
  }

  function renderStarPanel(model, section) {
    const node = model.nodes.get(section);
    panelHost.appendChild(el('h3', 'cst-panel-title', node.title));
    const cites = model.edges.filter((e) => e.from === section);
    const inboundList = model.edges.filter((e) => e.to === section && e.status === 'live');
    const brokenOut = cites.filter((e) => e.status !== 'live');
    const orphan = !model.touched.has(section);
    const flagged = ctx.isFlagged(section);
    const status = flagged
      ? 'FLAGGED FOR REMOVAL'
      : brokenOut.length > 0
        ? `${brokenOut.length} CITATION${brokenOut.length > 1 ? 'S' : ''} MISSING A TARGET`
        : orphan
          ? 'ORPHAN — NO CITATIONS EITHER WAY'
          : 'ALL REFERENCES RESOLVE';
    const statusClass = flagged || orphan ? 'is-amber' : brokenOut.length > 0 ? 'is-broken' : 'is-ok';
    panelHost.appendChild(el('p', `cst-panel-status ${statusClass}`, status));
    panelHost.appendChild(
      el(
        'p',
        'cst-panel-body',
        isUmbrella(section)
          ? 'Division umbrella section — every section in this division implicitly falls under its requirements.'
          : 'Planet size reflects how many project sections cite it.'
      )
    );
    panelRefList(
      panelHost,
      `CITES (${cites.length})`,
      cites.map((edge) => ({
        section: edge.to,
        title:
          edge.status === 'live'
            ? (model.nodes.get(edge.to)?.title ?? '')
            : edge.status === 'library'
              ? 'in a source library — not in project'
              : 'not in project — broken',
        broken: edge.status === 'broken',
        onGo:
          edge.status === 'live'
            ? () => select({ type: 'star', section: edge.to })
            : edge.status === 'library'
              ? () => select({ type: 'ghost', section: edge.to })
              : null,
      }))
    );
    panelRefList(
      panelHost,
      `CITED BY (${inboundList.length})`,
      inboundList.map((edge) => ({
        section: edge.from,
        title: model.nodes.get(edge.from)?.title ?? '',
        onGo: () => select({ type: 'star', section: edge.from }),
      }))
    );
    panelHost.appendChild(
      panelAction('OPEN IN EDITOR', 'is-primary', () => ctx.openInEditor(section))
    );
  }

  function renderMissingPanel(section, copy) {
    const inMasters = ctx.findInMasters(section) !== null;
    panelHost.appendChild(el('h3', 'cst-panel-title', copy.title));
    panelHost.appendChild(el('p', 'cst-panel-status is-amber', copy.status));
    panelHost.appendChild(el('p', 'cst-panel-body', inMasters ? copy.bodyInMasters : copy.bodyMissing));
    const btn = panelAction(
      inMasters ? `ADD ${ctx.displaySection(section)} FROM MASTERS` : 'NOT IN YOUR SOURCE LIBRARIES',
      'is-amber',
      () => void addFromMasters(section),
      { disabled: !inMasters }
    );
    panelHost.appendChild(btn);
  }

  async function addFromMasters(section) {
    try {
      await ctx.addSection(section);
      sel = { type: 'star', section };
      render();
    } catch (err) {
      ctx.toast(`add failed: ${err.message}`, 'err');
    }
  }

  // ── controller ────────────────────────────────────────────────────────────

  function render() {
    const model = buildModel();
    renderToolbar(model);
    renderPanel(model);
    canvas.replaceChildren();
    if (model.nodes.size === 0) {
      canvas.appendChild(
        el('p', 'cst-empty', 'NO SECTIONS IN THIS PROJECT — ADD SPECS AND THE SKY FILLS IN')
      );
      return;
    }
    canvas.appendChild(focusDiv ? renderFocused(model, focusDiv) : renderAll(model));
  }

  return {
    refresh() {
      render();
    },
    onDataChanged() {
      if (ctx.isActive()) render();
    },
  };
}
