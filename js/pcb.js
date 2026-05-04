"use strict";

// PCB layout — pulls components/nets from Schematic, lets you place them on a board
// outline, auto-routes traces, and either exports Gerber files or hands off to the
// Convert tab for direct G-code generation.
const PCB = (() => {
  const log = UI.log;
  const SCH_TO_MM = 0.25; // 1 schematic px ≈ 0.25 mm (LED 60→15 mm wide)
  const PAD_D = 1.6, DRILL_D = 0.8;

  const state = {
    components: [],   // {id, type, x, y, label}  positions in mm, board-local
    nets: [],         // {id, from:{compId,pinIdx}, to:{...}, segs:[[x,y]...], routed:bool}
    outline: { w: 50, h: 40 },
    traceW: 0.4,
    minSep: 0.3,
    view: { tx: 60, ty: 60, scale: 6 }, // mm → screen px
    dragging: null,
    hover: null,
  };

  let cv, ctx;

  function fit() {
    const r = cv.getBoundingClientRect();
    const w = Math.max(100, r.width) * devicePixelRatio;
    const h = Math.max(100, r.height) * devicePixelRatio;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  }
  function w2s(x,y) { return [(x*state.view.scale + state.view.tx)*devicePixelRatio, (y*state.view.scale + state.view.ty)*devicePixelRatio]; }
  function s2w(sx,sy) { return [(sx/devicePixelRatio - state.view.tx)/state.view.scale, (sy/devicePixelRatio - state.view.ty)/state.view.scale]; }

  // Pad positions in mm (board-local) for a placed component
  function padsOf(comp) {
    const def = Schematic.COMPONENTS[comp.type];
    return def.pins.map((p, idx) => ({
      x: comp.x + p.x * SCH_TO_MM,
      y: comp.y + p.y * SCH_TO_MM,
      pinIdx: idx,
      side: p.side,
      name: p.name,
    }));
  }

  // -------- Import from schematic --------
  function importFromSchematic() {
    if (!Schematic.state.components.length) {
      log('No schematic to import. Build one in the Schematic tab first.', 'warn');
      return;
    }
    // map schematic coords (centered around 0) into the board
    const xs = Schematic.state.components.map(c => c.x);
    const ys = Schematic.state.components.map(c => c.y);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    state.components = Schematic.state.components.map(c => ({
      id: c.id, type: c.type, label: c.label,
      x: (c.x - minX) * SCH_TO_MM + 5,
      y: (c.y - minY) * SCH_TO_MM + 5,
    }));
    // grow outline to fit
    let needW = 0, needH = 0;
    for (const c of state.components) {
      const def = Schematic.COMPONENTS[c.type];
      needW = Math.max(needW, c.x + def.w*SCH_TO_MM/2 + 5);
      needH = Math.max(needH, c.y + def.h*SCH_TO_MM/2 + 5);
    }
    state.outline.w = Math.max(state.outline.w, Math.ceil(needW));
    state.outline.h = Math.max(state.outline.h, Math.ceil(needH));
    UI.el('pcbW').value = state.outline.w;
    UI.el('pcbH').value = state.outline.h;

    state.nets = Schematic.state.wires.map(w => ({
      id: w.id, from: w.from, to: w.to, segs: [], routed: false,
    }));
    log(`imported ${state.components.length} components, ${state.nets.length} nets`, 'ok');
    render();
  }

  // -------- A* router --------
  // Cells are 0=free, 1=blocked. Start/end pads are exempted from blocking.
  function autoRoute() {
    if (!state.components.length) { log('Place components first', 'warn'); return; }
    const grid = 0.4; // mm per cell — must be > traceW + minSep
    const cellSize = Math.max(grid, state.traceW + state.minSep);
    const W = Math.ceil(state.outline.w / cellSize);
    const H = Math.ceil(state.outline.h / cellSize);
    const cells = new Uint8Array(W*H);
    const idx = (i,j) => j*W + i;
    function blockCircle(cx, cy, r) {
      const r2 = r*r;
      const i0 = Math.max(0, Math.floor((cx-r)/cellSize));
      const i1 = Math.min(W-1, Math.ceil((cx+r)/cellSize));
      const j0 = Math.max(0, Math.floor((cy-r)/cellSize));
      const j1 = Math.min(H-1, Math.ceil((cy+r)/cellSize));
      for (let j=j0;j<=j1;j++) for (let i=i0;i<=i1;i++) {
        const dx = i*cellSize-cx, dy = j*cellSize-cy;
        if (dx*dx+dy*dy <= r2) cells[idx(i,j)] = 1;
      }
    }
    // block all pads with pad radius + minSep
    const allPads = [];
    for (const c of state.components) for (const p of padsOf(c)) {
      allPads.push({...p, compId:c.id});
      blockCircle(p.x, p.y, PAD_D/2 + state.minSep);
    }

    function aStar(sxw, syw, exw, eyw, exemptPads) {
      // unblock exempt pads temporarily
      const toRestore = [];
      for (const p of exemptPads) {
        const r = PAD_D/2 + state.minSep;
        const r2 = r*r;
        const i0 = Math.max(0, Math.floor((p.x-r)/cellSize));
        const i1 = Math.min(W-1, Math.ceil((p.x+r)/cellSize));
        const j0 = Math.max(0, Math.floor((p.y-r)/cellSize));
        const j1 = Math.min(H-1, Math.ceil((p.y+r)/cellSize));
        for (let j=j0;j<=j1;j++) for (let i=i0;i<=i1;i++) {
          const dx = i*cellSize-p.x, dy = j*cellSize-p.y;
          if (dx*dx+dy*dy <= r2 && cells[idx(i,j)] === 1) { cells[idx(i,j)] = 0; toRestore.push([i,j]); }
        }
      }

      const si = Math.round(sxw/cellSize), sj = Math.round(syw/cellSize);
      const ei = Math.round(exw/cellSize), ej = Math.round(eyw/cellSize);
      if (si<0||si>=W||sj<0||sj>=H||ei<0||ei>=W||ej<0||ej>=H) {
        for (const [i,j] of toRestore) cells[idx(i,j)] = 1;
        return null;
      }
      const open = new Map();
      const came = new Map();
      const gScore = new Map();
      const startKey = sj*W+si;
      gScore.set(startKey, 0);
      open.set(startKey, Math.abs(ei-si)+Math.abs(ej-sj));
      const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
      let result = null;
      let count = 0, MAX = W*H*4;
      while (open.size && count++ < MAX) {
        // pick lowest f
        let best = null, bestF = Infinity;
        for (const [k,f] of open) if (f < bestF) { bestF = f; best = k; }
        if (best === null) break;
        open.delete(best);
        const ci = best % W, cj = (best - ci) / W;
        if (ci === ei && cj === ej) {
          // reconstruct
          const path = [[ci,cj]];
          let k = best;
          while (came.has(k)) { k = came.get(k); const i = k%W, j = (k-i)/W; path.unshift([i,j]); }
          result = path;
          break;
        }
        const g = gScore.get(best);
        for (const [di,dj] of dirs) {
          const ni = ci+di, nj = cj+dj;
          if (ni<0||ni>=W||nj<0||nj>=H) continue;
          const nk = nj*W+ni;
          if (cells[nk] === 1 && !(ni===ei && nj===ej)) continue;
          const tentative = g + 1 + (came.get(best) !== undefined && (came.get(best) % W !== ci - di || (came.get(best)-ci+di)/W !== cj-dj) ? 0.5 : 0); // tiny turn penalty
          if (!gScore.has(nk) || tentative < gScore.get(nk)) {
            came.set(nk, best);
            gScore.set(nk, tentative);
            open.set(nk, tentative + Math.abs(ei-ni)+Math.abs(ej-nj));
          }
        }
      }
      for (const [i,j] of toRestore) cells[idx(i,j)] = 1;
      return result;
    }

    let routed = 0, failed = 0;
    // sort nets by manhattan distance (shorter first — easier wins early)
    const compById = id => state.components.find(c => c.id === id);
    const netOrder = state.nets.map((n,i) => {
      const c1 = compById(n.from.compId), c2 = compById(n.to.compId);
      if (!c1 || !c2) return {i, d:Infinity};
      const p1 = padsOf(c1)[n.from.pinIdx], p2 = padsOf(c2)[n.to.pinIdx];
      return { i, d: Math.abs(p1.x-p2.x)+Math.abs(p1.y-p2.y) };
    }).sort((a,b) => a.d-b.d);

    for (const {i: ni} of netOrder) {
      const net = state.nets[ni];
      const c1 = compById(net.from.compId), c2 = compById(net.to.compId);
      if (!c1 || !c2) { net.routed=false; failed++; continue; }
      const p1 = padsOf(c1)[net.from.pinIdx], p2 = padsOf(c2)[net.to.pinIdx];
      const path = aStar(p1.x, p1.y, p2.x, p2.y, [p1, p2]);
      if (path) {
        // simplify: remove collinear points
        const simp = [path[0]];
        for (let k=1;k<path.length-1;k++) {
          const a=path[k-1], b=path[k], c=path[k+1];
          if ((a[0]===b[0]&&b[0]===c[0]) || (a[1]===b[1]&&b[1]===c[1])) continue;
          simp.push(b);
        }
        simp.push(path[path.length-1]);
        net.segs = simp.map(([i,j]) => [i*cellSize, j*cellSize]);
        // splice in exact pad positions at endpoints for clean termination
        net.segs[0] = [p1.x, p1.y];
        net.segs[net.segs.length-1] = [p2.x, p2.y];
        net.routed = true;
        // block this trace + minSep for subsequent nets
        for (let k=0;k<path.length;k++) {
          blockCircle(path[k][0]*cellSize, path[k][1]*cellSize, state.traceW/2 + state.minSep);
        }
        routed++;
      } else {
        net.routed = false;
        failed++;
      }
    }
    log(`auto-route: ${routed} ok, ${failed} failed`, failed ? 'warn' : 'ok');
    render();
  }

  // -------- Render --------
  function render() {
    fit();
    ctx.fillStyle = '#0a0c10';
    ctx.fillRect(0,0,cv.width,cv.height);

    // grid (1mm)
    ctx.strokeStyle = '#1a1f2c';
    ctx.lineWidth = 1;
    const v = state.view;
    const stepPx = v.scale * devicePixelRatio;
    if (stepPx > 4) {
      ctx.beginPath();
      const offX = (v.tx*devicePixelRatio) % stepPx;
      const offY = (v.ty*devicePixelRatio) % stepPx;
      for (let x=offX; x<cv.width; x+=stepPx) { ctx.moveTo(x,0); ctx.lineTo(x,cv.height); }
      for (let y=offY; y<cv.height; y+=stepPx) { ctx.moveTo(0,y); ctx.lineTo(cv.width,y); }
      ctx.stroke();
    }

    // outline
    const [ox,oy] = w2s(0,0);
    const [ex,ey] = w2s(state.outline.w, state.outline.h);
    ctx.fillStyle = '#0e1a14';
    ctx.fillRect(ox, oy, ex-ox, ey-oy);
    ctx.strokeStyle = '#ff6b6b'; ctx.lineWidth = 2*devicePixelRatio;
    ctx.strokeRect(ox, oy, ex-ox, ey-oy);

    // nets
    for (const net of state.nets) {
      ctx.strokeStyle = net.routed ? '#ffcf5c' : '#ff6b6b88';
      ctx.lineWidth = Math.max(2, state.traceW * v.scale) * devicePixelRatio;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      if (net.segs.length >= 2) {
        ctx.beginPath();
        net.segs.forEach((p,i) => { const [sx,sy] = w2s(p[0],p[1]); if (i===0) ctx.moveTo(sx,sy); else ctx.lineTo(sx,sy); });
        ctx.stroke();
      } else {
        // draw a hint line straight from pin to pin
        const c1 = state.components.find(c => c.id === net.from.compId);
        const c2 = state.components.find(c => c.id === net.to.compId);
        if (c1 && c2) {
          const p1 = padsOf(c1)[net.from.pinIdx], p2 = padsOf(c2)[net.to.pinIdx];
          ctx.setLineDash([4*devicePixelRatio,4*devicePixelRatio]);
          ctx.strokeStyle = '#888c'; ctx.lineWidth = 1*devicePixelRatio;
          ctx.beginPath();
          const [a1,a2]=w2s(p1.x,p1.y), [b1,b2]=w2s(p2.x,p2.y);
          ctx.moveTo(a1,a2); ctx.lineTo(b1,b2); ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }

    // components: pads + body outline + label
    for (const c of state.components) {
      const def = Schematic.COMPONENTS[c.type];
      const w = def.w * SCH_TO_MM, h = def.h * SCH_TO_MM;
      const [tlx,tly] = w2s(c.x - w/2, c.y - h/2);
      const [brx,bry] = w2s(c.x + w/2, c.y + h/2);
      ctx.fillStyle = '#1a2030cc';
      ctx.strokeStyle = state.dragging?.compId === c.id ? '#ffcf5c' : '#4ea1ff';
      ctx.lineWidth = 1.5*devicePixelRatio;
      ctx.fillRect(tlx, tly, brx-tlx, bry-tly);
      ctx.strokeRect(tlx, tly, brx-tlx, bry-tly);
      // pads
      for (const p of padsOf(c)) {
        const [px,py] = w2s(p.x, p.y);
        ctx.fillStyle = '#ffcf5c';
        ctx.beginPath(); ctx.arc(px, py, PAD_D/2*v.scale*devicePixelRatio, 0, Math.PI*2); ctx.fill();
        ctx.fillStyle = '#0a0c10';
        ctx.beginPath(); ctx.arc(px, py, DRILL_D/2*v.scale*devicePixelRatio, 0, Math.PI*2); ctx.fill();
      }
      // label
      ctx.fillStyle = '#aab';
      ctx.font = (10*devicePixelRatio)+'px ui-sans-serif, system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(c.label || def.name, (tlx+brx)/2, bry + 12*devicePixelRatio);
    }
  }

  // -------- Mouse --------
  const SNAP = 0.5; // mm — components snap to 0.5 mm grid
  function snap(v) { return Math.round(v / SNAP) * SNAP; }

  function bind() {
    let panning = null;

    cv.addEventListener('mousemove', e => {
      const rect = cv.getBoundingClientRect();
      const sx = (e.clientX - rect.left) * devicePixelRatio;
      const sy = (e.clientY - rect.top) * devicePixelRatio;
      state.hover = [sx, sy];
      if (panning) {
        state.view.tx = panning.tx + (e.clientX - panning.cx);
        state.view.ty = panning.ty + (e.clientY - panning.cy);
      } else if (state.dragging) {
        const [wx, wy] = s2w(sx, sy);
        const c = state.components.find(x => x.id === state.dragging.compId);
        if (c) {
          c.x = snap(Math.max(2, Math.min(state.outline.w-2, wx + state.dragging.dx)));
          c.y = snap(Math.max(2, Math.min(state.outline.h-2, wy + state.dragging.dy)));
          // invalidate routes touching this component
          for (const n of state.nets) if (n.from.compId === c.id || n.to.compId === c.id) { n.segs=[]; n.routed=false; }
        }
      }
      render();
    });
    cv.addEventListener('mousedown', e => {
      const rect = cv.getBoundingClientRect();
      const sx = (e.clientX - rect.left) * devicePixelRatio;
      const sy = (e.clientY - rect.top) * devicePixelRatio;
      // pan with middle-click or alt-drag — same as Schematic
      if (e.button === 1 || (e.button === 0 && e.altKey)) {
        panning = { tx: state.view.tx, ty: state.view.ty, cx: e.clientX, cy: e.clientY };
        e.preventDefault(); return;
      }
      if (e.button !== 0) return;
      const [wx, wy] = s2w(sx, sy);
      for (let i=state.components.length-1;i>=0;i--) {
        const c = state.components[i];
        const def = Schematic.COMPONENTS[c.type];
        if (Math.abs(wx-c.x) <= def.w*SCH_TO_MM/2 && Math.abs(wy-c.y) <= def.h*SCH_TO_MM/2) {
          state.dragging = { compId: c.id, dx: c.x - wx, dy: c.y - wy };
          render(); return;
        }
      }
    });
    cv.addEventListener('mouseup', () => { state.dragging = null; panning = null; });
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('wheel', e => {
      e.preventDefault();
      const rect = cv.getBoundingClientRect();
      const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.15 : 1/1.15;
      const before = s2w(cx*devicePixelRatio, cy*devicePixelRatio);
      state.view.scale = Math.max(2, Math.min(40, state.view.scale * factor));
      const after = s2w(cx*devicePixelRatio, cy*devicePixelRatio);
      state.view.tx += (after[0]-before[0]) * state.view.scale;
      state.view.ty += (after[1]-before[1]) * state.view.scale;
      render();
    }, {passive:false});
  }

  // -------- Build geometry that the Convert tab understands --------
  function buildGerberLikeState() {
    // copper traces from routed nets + circular pads
    const traces = [];
    for (const net of state.nets) {
      if (!net.routed || net.segs.length < 2) continue;
      for (let i=1;i<net.segs.length;i++) {
        const a = net.segs[i-1], b = net.segs[i];
        traces.push({ x1:a[0], y1:a[1], x2:b[0], y2:b[1], w: state.traceW });
      }
    }
    const pads = [];
    const ap = { tmpl:'C', params:[PAD_D] };
    const holes = [];
    for (const c of state.components) for (const p of padsOf(c)) {
      pads.push({ x: p.x, y: p.y, ap });
      holes.push({ x: p.x, y: p.y, d: DRILL_D });
    }
    const bbox = { minX: 0, minY: 0, maxX: state.outline.w, maxY: state.outline.h };
    const gerber = { traces, pads, regions: [], units:'mm', bbox };
    const drill = { holes };
    // outline: 4 segments forming a rectangle
    const W = state.outline.w, H = state.outline.h;
    const outlineTraces = [
      {x1:0,y1:0,x2:W,y2:0,w:0.1},
      {x1:W,y1:0,x2:W,y2:H,w:0.1},
      {x1:W,y1:H,x2:0,y2:H,w:0.1},
      {x1:0,y1:H,x2:0,y2:0,w:0.1},
    ];
    const outline = { traces: outlineTraces, pads: [], regions: [], units:'mm', bbox };
    return { gerber, drill, outline };
  }

  // -------- Gerber export (RS-274X) --------
  function emitGerber(geom, pad=true) {
    const lines = [];
    lines.push('%FSLAX46Y46*%');
    lines.push('%MOMM*%');
    lines.push('G75*');
    lines.push('G01*');
    // aperture defs
    const apMap = new Map();
    let nextAp = 10;
    function getAp(tmpl, params) {
      const k = tmpl+':'+params.join(',');
      if (apMap.has(k)) return apMap.get(k);
      const id = nextAp++;
      apMap.set(k, id);
      lines.push(`%ADD${id}${tmpl},${params.join('X')}*%`);
      return id;
    }
    function coord(v) { return Math.round(v * 1e6); } // 4.6 format

    // emit traces
    const traces = geom.gerber.traces || geom.traces || [];
    for (const t of traces) {
      const id = getAp('C', [t.w]);
      lines.push(`D${id}*`);
      lines.push(`X${coord(t.x1)}Y${coord(t.y1)}D02*`);
      lines.push(`X${coord(t.x2)}Y${coord(t.y2)}D01*`);
    }
    // emit pads
    if (pad) {
      const pads = geom.gerber?.pads || geom.pads || [];
      for (const p of pads) {
        const tmpl = p.ap.tmpl, params = p.ap.params;
        const id = getAp(tmpl, params);
        lines.push(`D${id}*`);
        lines.push(`X${coord(p.x)}Y${coord(p.y)}D03*`);
      }
    }
    lines.push('M02*');
    return lines.join('\n');
  }
  function emitOutlineGerber(outlineGeom) {
    const lines = ['%FSLAX46Y46*%','%MOMM*%','G75*','G01*'];
    const id = 10;
    lines.push(`%ADD${id}C,0.10*%`);
    lines.push(`D${id}*`);
    let first = true;
    for (const t of outlineGeom.traces) {
      const c = v => Math.round(v*1e6);
      if (first) { lines.push(`X${c(t.x1)}Y${c(t.y1)}D02*`); first = false; }
      lines.push(`X${c(t.x2)}Y${c(t.y2)}D01*`);
    }
    lines.push('M02*');
    return lines.join('\n');
  }
  function emitExcellon(drill) {
    const lines = ['M48','METRIC','T1C0.800','%','G05','G90','T1'];
    for (const h of drill.holes) lines.push('X'+h.x.toFixed(3)+'Y'+h.y.toFixed(3));
    lines.push('M30');
    return lines.join('\n');
  }

  function downloadFile(name, content) {
    const blob = new Blob([content], {type:'text/plain'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
  }

  // -------- Init --------
  function init() {
    cv = UI.el('cv-pcb');
    if (!cv) return;
    ctx = cv.getContext('2d');
    bind();

    UI.el('btn-import').addEventListener('click', importFromSchematic);
    UI.el('btn-route').addEventListener('click', autoRoute);
    UI.el('btn-clear-routes').addEventListener('click', () => {
      for (const n of state.nets) { n.segs=[]; n.routed=false; }
      render();
    });
    UI.el('pcbW').addEventListener('input', e => { state.outline.w = +e.target.value; render(); });
    UI.el('pcbH').addEventListener('input', e => { state.outline.h = +e.target.value; render(); });
    UI.el('pcbTW').addEventListener('input', e => { state.traceW = +e.target.value; render(); });
    UI.el('pcbSep').addEventListener('input', e => { state.minSep = +e.target.value; });

    UI.el('btn-send-convert').addEventListener('click', () => {
      if (!state.components.length) { log('Import schematic + auto-route first', 'warn'); return; }
      const { gerber, drill, outline } = buildGerberLikeState();
      Converter.state.gerber = gerber;
      Converter.state.drill = drill;
      Converter.state.outline = outline;
      Converter.state.isoPaths = null;
      log('PCB sent to Convert tab — switch tabs and hit Generate G-code', 'ok');
      UI.switchTab('convert');
      Converter.render();
    });

    UI.el('btn-export-gerber').addEventListener('click', () => {
      if (!state.components.length) { log('Place components first', 'warn'); return; }
      const { gerber, drill, outline } = buildGerberLikeState();
      downloadFile('pcb-F_Cu.gbr', emitGerber({gerber}));
      downloadFile('pcb-Edge_Cuts.gm1', emitOutlineGerber(outline));
      downloadFile('pcb.drl', emitExcellon(drill));
      log('exported pcb-F_Cu.gbr, pcb-Edge_Cuts.gm1, pcb.drl', 'ok');
    });

    window.addEventListener('resize', () => { fit(); render(); });
    window.addEventListener('tabchange', e => { if (e.detail.name === 'pcb') requestAnimationFrame(()=>{ fit(); render(); }); });
    requestAnimationFrame(()=>{ fit(); render(); });
  }

  return { init, state, importFromSchematic };
})();
