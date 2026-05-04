"use strict";

// Schematic editor — drag components onto a grid, click pins to wire them.
const Schematic = (() => {
  const log = UI.log;

  // -------- Component definitions --------
  // Pins are positioned in a [-w/2..w/2, -h/2..h/2] local box around the component origin.
  // Each pin: {name, x, y, side: 'L'|'R'|'T'|'B'}
  const COMPONENTS = {
    led: {
      name: 'LED', w: 60, h: 30,
      pins: [{name:'A', x:-30, y:0, side:'L'}, {name:'K', x:30, y:0, side:'R'}],
      draw(ctx) {
        ctx.strokeStyle = '#ffcf5c'; ctx.fillStyle = '#1a1a0a'; ctx.lineWidth = 2;
        // body: triangle + bar (LED symbol)
        ctx.beginPath();
        ctx.moveTo(-12,-12); ctx.lineTo(12,0); ctx.lineTo(-12,12); ctx.closePath();
        ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(12,-12); ctx.lineTo(12,12); ctx.stroke();
        // leads
        ctx.beginPath(); ctx.moveTo(-30,0); ctx.lineTo(-12,0); ctx.moveTo(12,0); ctx.lineTo(30,0); ctx.stroke();
      }
    },
    resistor: {
      name: 'Resistor', w: 60, h: 20,
      pins: [{name:'1', x:-30, y:0, side:'L'}, {name:'2', x:30, y:0, side:'R'}],
      draw(ctx) {
        ctx.strokeStyle = '#e6e8ef'; ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-30,0); ctx.lineTo(-18,0);
        // zigzag
        for (let i=0;i<6;i++) {
          const x = -18 + i*6;
          ctx.lineTo(x+3, i%2 ? 6 : -6);
        }
        ctx.lineTo(18,0); ctx.lineTo(30,0);
        ctx.stroke();
      }
    },
    capacitor: {
      name: 'Capacitor', w: 50, h: 30,
      pins: [{name:'1', x:-25, y:0, side:'L'}, {name:'2', x:25, y:0, side:'R'}],
      draw(ctx) {
        ctx.strokeStyle = '#e6e8ef'; ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-25,0); ctx.lineTo(-4,0);
        ctx.moveTo(-4,-12); ctx.lineTo(-4,12);
        ctx.moveTo(4,-12); ctx.lineTo(4,12);
        ctx.moveTo(4,0); ctx.lineTo(25,0);
        ctx.stroke();
      }
    },
    pin: {
      name: 'Pin/Header', w: 30, h: 20,
      pins: [{name:'1', x:-15, y:0, side:'L'}],
      draw(ctx) {
        ctx.strokeStyle = '#5ad18b'; ctx.fillStyle = '#0e1118'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(0, 0, 6, 0, Math.PI*2); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(-15,0); ctx.lineTo(-6,0); ctx.stroke();
      }
    },
    ic8: makeDIP(8, 'IC-8'),
    ic14: makeDIP(14, 'IC-14'),
    ic16: makeDIP(16, 'IC-16'),
  };

  function makeDIP(n, label) {
    const half = n/2;
    const pinSpace = 20;
    const w = 80, h = pinSpace*half + 20;
    const pins = [];
    for (let i=0;i<half;i++) {
      pins.push({name: String(i+1), x: -w/2, y: -h/2 + 20 + i*pinSpace - (h-20)/2 + pinSpace/2, side:'L'});
    }
    for (let i=0;i<half;i++) {
      pins.push({name: String(n-i), x: w/2, y: -h/2 + 20 + i*pinSpace - (h-20)/2 + pinSpace/2, side:'R'});
    }
    // Re-center pin Y around 0
    const minY = Math.min(...pins.map(p=>p.y)), maxY = Math.max(...pins.map(p=>p.y));
    const dy = -(minY+maxY)/2;
    for (const p of pins) p.y += dy;
    return {
      name: label, w, h, pins,
      draw(ctx) {
        ctx.strokeStyle = '#4ea1ff'; ctx.fillStyle = '#0a1830'; ctx.lineWidth = 2;
        ctx.fillRect(-w/2+8, -h/2, w-16, h);
        ctx.strokeRect(-w/2+8, -h/2, w-16, h);
        // notch on top
        ctx.beginPath(); ctx.arc(0, -h/2, 4, 0, Math.PI); ctx.stroke();
        // pin leads
        ctx.beginPath();
        for (const p of pins) {
          if (p.side === 'L') { ctx.moveTo(-w/2, p.y); ctx.lineTo(-w/2+8, p.y); }
          else { ctx.moveTo(w/2-8, p.y); ctx.lineTo(w/2, p.y); }
        }
        ctx.stroke();
      }
    };
  }

  // -------- State --------
  const state = {
    components: [],   // {id, type, x, y, label}
    wires: [],        // {id, from:{compId,pinIdx}, to:{compId,pinIdx}, segs:[[x,y],...]}
    nextId: 1,
    view: { tx:0, ty:0, scale:1 },
    placing: null,    // pending component type when click-to-place
    wireFrom: null,   // {compId, pinIdx} when starting a wire
    selected: null,   // {kind:'comp'|'wire', id}
    hover: null,
  };

  let cv, ctx;
  const GRID = 20;

  // Persistence
  function save() { try { localStorage.setItem('schematic', JSON.stringify({components:state.components, wires:state.wires, nextId:state.nextId})); } catch(e){} }
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem('schematic')||'null');
      if (s) { Object.assign(state, s); }
    } catch(e){}
  }

  function fit() {
    const r = cv.getBoundingClientRect();
    const w = Math.max(100, r.width) * devicePixelRatio;
    const h = Math.max(100, r.height) * devicePixelRatio;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  }

  // World ↔ screen
  function w2s(x,y) { return [(x*state.view.scale + state.view.tx) * devicePixelRatio, (y*state.view.scale + state.view.ty) * devicePixelRatio]; }
  function s2w(sx,sy) { return [(sx/devicePixelRatio - state.view.tx)/state.view.scale, (sy/devicePixelRatio - state.view.ty)/state.view.scale]; }
  function snap(v) { return Math.round(v / GRID) * GRID; }

  function pinWorld(comp, pinIdx) {
    const def = COMPONENTS[comp.type];
    const p = def.pins[pinIdx];
    return [comp.x + p.x, comp.y + p.y];
  }

  function compAtScreen(sx, sy) {
    const [wx, wy] = s2w(sx, sy);
    for (let i=state.components.length-1;i>=0;i--) {
      const c = state.components[i], def = COMPONENTS[c.type];
      if (Math.abs(wx-c.x) <= def.w/2 && Math.abs(wy-c.y) <= def.h/2) return c;
    }
    return null;
  }
  function pinAtScreen(sx, sy, tol=10) {
    const [wx, wy] = s2w(sx, sy);
    for (const c of state.components) {
      const def = COMPONENTS[c.type];
      for (let i=0;i<def.pins.length;i++) {
        const [px,py] = pinWorld(c, i);
        if (Math.hypot(wx-px, wy-py) < tol/state.view.scale) return {comp:c, pinIdx:i};
      }
    }
    return null;
  }

  // Manhattan path between two pins, leaving the pin in its facing direction first
  function routeWire(c1, p1, c2, p2) {
    const def1 = COMPONENTS[c1.type], def2 = COMPONENTS[c2.type];
    const a = pinWorld(c1, p1), b = pinWorld(c2, p2);
    const s1 = def1.pins[p1].side, s2 = def2.pins[p2].side;
    const out1 = leaveOffset(s1), out2 = leaveOffset(s2);
    const aOut = [a[0]+out1[0], a[1]+out1[1]];
    const bOut = [b[0]+out2[0], b[1]+out2[1]];
    // simple L-shape
    const mid = [aOut[0], bOut[1]];
    return [a, aOut, mid, bOut, b];
  }
  function leaveOffset(side, d=GRID) {
    return side === 'L' ? [-d,0] : side === 'R' ? [d,0] : side === 'T' ? [0,-d] : [0,d];
  }

  function reroute(wire) {
    const c1 = state.components.find(c => c.id === wire.from.compId);
    const c2 = state.components.find(c => c.id === wire.to.compId);
    if (c1 && c2) wire.segs = routeWire(c1, wire.from.pinIdx, c2, wire.to.pinIdx);
  }

  // -------- Render --------
  function render() {
    fit();
    const W = cv.width, H = cv.height;
    ctx.fillStyle = '#0a0c10';
    ctx.fillRect(0,0,W,H);

    // grid
    ctx.strokeStyle = '#1a1f2c'; ctx.lineWidth = 1;
    const v = state.view;
    const gridScreen = GRID * v.scale * devicePixelRatio;
    if (gridScreen > 4) {
      const offX = (v.tx * devicePixelRatio) % gridScreen;
      const offY = (v.ty * devicePixelRatio) % gridScreen;
      ctx.beginPath();
      for (let x=offX; x<W; x+=gridScreen) { ctx.moveTo(x,0); ctx.lineTo(x,H); }
      for (let y=offY; y<H; y+=gridScreen) { ctx.moveTo(0,y); ctx.lineTo(W,y); }
      ctx.stroke();
    }
    // origin
    const [ox,oy] = w2s(0,0);
    ctx.fillStyle = '#2a3148'; ctx.beginPath(); ctx.arc(ox,oy,3*devicePixelRatio,0,Math.PI*2); ctx.fill();

    // wires
    for (const w of state.wires) {
      ctx.strokeStyle = state.selected?.kind === 'wire' && state.selected.id === w.id ? '#ffcf5c' : '#5ad18b';
      ctx.lineWidth = 2 * devicePixelRatio;
      ctx.beginPath();
      w.segs.forEach((p,i) => {
        const [sx,sy] = w2s(p[0], p[1]);
        if (i===0) ctx.moveTo(sx,sy); else ctx.lineTo(sx,sy);
      });
      ctx.stroke();
    }

    // components
    for (const c of state.components) {
      const def = COMPONENTS[c.type];
      const [sx, sy] = w2s(c.x, c.y);
      ctx.save();
      ctx.translate(sx, sy);
      ctx.scale(v.scale * devicePixelRatio, v.scale * devicePixelRatio);
      def.draw(ctx);
      // pins (dots)
      ctx.fillStyle = '#ffcf5c';
      for (const p of def.pins) {
        ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI*2); ctx.fill();
      }
      // label
      ctx.fillStyle = '#8a93a6';
      ctx.font = '10px ui-sans-serif, system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(c.label || def.name, 0, def.h/2 + 12);
      ctx.restore();

      // selection box
      if (state.selected?.kind === 'comp' && state.selected.id === c.id) {
        ctx.strokeStyle = '#ffcf5c'; ctx.lineWidth = 1.5 * devicePixelRatio;
        const [tlx,tly] = w2s(c.x-def.w/2, c.y-def.h/2);
        const [brx,bry] = w2s(c.x+def.w/2, c.y+def.h/2);
        ctx.strokeRect(tlx-3, tly-3, brx-tlx+6, bry-tly+6);
      }
    }

    // pending wire preview
    if (state.wireFrom) {
      const c = state.components.find(x => x.id === state.wireFrom.compId);
      if (c) {
        const [a] = [pinWorld(c, state.wireFrom.pinIdx)];
        const [ax,ay] = w2s(a[0],a[1]);
        ctx.strokeStyle = '#5ad18b88'; ctx.lineWidth = 2 * devicePixelRatio;
        ctx.setLineDash([6,4]);
        ctx.beginPath(); ctx.moveTo(ax,ay);
        if (state.hover) { ctx.lineTo(state.hover[0], state.hover[1]); }
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // placing ghost
    if (state.placing && state.hover) {
      const def = COMPONENTS[state.placing];
      const [wx,wy] = s2w(state.hover[0], state.hover[1]);
      const sx = snap(wx), sy = snap(wy);
      const [px,py] = w2s(sx, sy);
      ctx.save();
      ctx.translate(px, py);
      ctx.scale(v.scale * devicePixelRatio, v.scale * devicePixelRatio);
      ctx.globalAlpha = 0.6;
      def.draw(ctx);
      ctx.restore();
    }
  }

  // -------- Input --------
  function bind() {
    // palette drag/click
    document.querySelectorAll('.palette-item').forEach(item => {
      item.addEventListener('click', () => {
        state.placing = item.dataset.type;
        log('Click on grid to place '+COMPONENTS[item.dataset.type].name+' (Esc to cancel)');
      });
    });

    let dragging = null; // {compId, dx, dy}
    let panning = null;

    cv.addEventListener('mousemove', e => {
      const rect = cv.getBoundingClientRect();
      const sx = (e.clientX - rect.left) * devicePixelRatio;
      const sy = (e.clientY - rect.top) * devicePixelRatio;
      state.hover = [sx, sy];
      if (panning) {
        state.view.tx = panning.tx + (e.clientX - panning.cx);
        state.view.ty = panning.ty + (e.clientY - panning.cy);
      } else if (dragging) {
        const [wx, wy] = s2w(sx, sy);
        const c = state.components.find(x => x.id === dragging.compId);
        if (c) { c.x = snap(wx + dragging.dx); c.y = snap(wy + dragging.dy); for (const w of state.wires) if (w.from.compId === c.id || w.to.compId === c.id) reroute(w); }
      }
      render();
    });

    cv.addEventListener('mousedown', e => {
      const rect = cv.getBoundingClientRect();
      const sx = (e.clientX - rect.left) * devicePixelRatio;
      const sy = (e.clientY - rect.top) * devicePixelRatio;
      if (e.button === 1 || (e.button === 0 && e.altKey)) {
        panning = { tx: state.view.tx, ty: state.view.ty, cx: e.clientX, cy: e.clientY };
        e.preventDefault(); return;
      }
      if (e.button !== 0) return;

      // place mode
      if (state.placing) {
        const [wx, wy] = s2w(sx, sy);
        const id = state.nextId++;
        state.components.push({ id, type: state.placing, x: snap(wx), y: snap(wy), label: '' });
        state.placing = null;
        save(); render();
        return;
      }
      // wire start/finish
      const pinHit = pinAtScreen(sx, sy);
      if (pinHit) {
        if (state.wireFrom) {
          if (state.wireFrom.compId !== pinHit.comp.id || state.wireFrom.pinIdx !== pinHit.pinIdx) {
            const c1 = state.components.find(c => c.id === state.wireFrom.compId);
            const c2 = pinHit.comp;
            const segs = routeWire(c1, state.wireFrom.pinIdx, c2, pinHit.pinIdx);
            state.wires.push({
              id: state.nextId++,
              from: { compId: c1.id, pinIdx: state.wireFrom.pinIdx },
              to: { compId: c2.id, pinIdx: pinHit.pinIdx },
              segs
            });
            log('wire connected', 'ok');
          }
          state.wireFrom = null;
        } else {
          state.wireFrom = { compId: pinHit.comp.id, pinIdx: pinHit.pinIdx };
          log('wiring from '+COMPONENTS[pinHit.comp.type].name+' pin '+COMPONENTS[pinHit.comp.type].pins[pinHit.pinIdx].name);
        }
        save(); render();
        return;
      }
      // component select / drag
      const c = compAtScreen(sx, sy);
      if (c) {
        const [wx,wy] = s2w(sx, sy);
        dragging = { compId: c.id, dx: c.x - wx, dy: c.y - wy };
        state.selected = { kind:'comp', id: c.id };
        render();
        return;
      }
      // background — clear selection / cancel wire
      state.selected = null; state.wireFrom = null;
      render();
    });

    cv.addEventListener('mouseup', () => { dragging = null; panning = null; save(); });
    cv.addEventListener('contextmenu', e => e.preventDefault());

    cv.addEventListener('wheel', e => {
      e.preventDefault();
      const rect = cv.getBoundingClientRect();
      const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.15 : 1/1.15;
      const before = s2w(cx*devicePixelRatio, cy*devicePixelRatio);
      state.view.scale = Math.max(0.25, Math.min(4, state.view.scale * factor));
      const after = s2w(cx*devicePixelRatio, cy*devicePixelRatio);
      state.view.tx += (after[0]-before[0]) * state.view.scale;
      state.view.ty += (after[1]-before[1]) * state.view.scale;
      render();
    }, {passive:false});

    window.addEventListener('keydown', e => {
      if (!UI.el('tab-schematic').classList.contains('active')) return;
      if (e.key === 'Escape') { state.placing = null; state.wireFrom = null; render(); }
      if ((e.key === 'Backspace' || e.key === 'Delete') && state.selected) {
        if (state.selected.kind === 'comp') {
          state.wires = state.wires.filter(w => w.from.compId !== state.selected.id && w.to.compId !== state.selected.id);
          state.components = state.components.filter(c => c.id !== state.selected.id);
        } else if (state.selected.kind === 'wire') {
          state.wires = state.wires.filter(w => w.id !== state.selected.id);
        }
        state.selected = null; save(); render();
      }
    });

    UI.el('btn-clear').addEventListener('click', () => {
      if (!confirm('Clear schematic?')) return;
      state.components = []; state.wires = []; state.nextId = 1;
      save(); render();
    });
    UI.el('btn-export-json').addEventListener('click', () => {
      const data = JSON.stringify({components:state.components, wires:state.wires}, null, 2);
      const blob = new Blob([data], {type:'application/json'});
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'schematic.json'; a.click();
    });
  }

  function init() {
    cv = UI.el('cv-schematic');
    if (!cv) return;
    ctx = cv.getContext('2d');
    state.view.tx = cv.clientWidth/2;
    state.view.ty = cv.clientHeight/2;
    load();
    bind();
    window.addEventListener('resize', () => { fit(); render(); });
    window.addEventListener('tabchange', e => { if (e.detail.name === 'schematic') requestAnimationFrame(()=>{ fit(); render(); }); });
    requestAnimationFrame(() => { fit(); render(); });
  }

  return { init, state, COMPONENTS };
})();
