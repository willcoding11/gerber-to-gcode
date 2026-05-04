"use strict";

// Convert tab — Gerber/drill/outline → G-code + STL
const Converter = (() => {
  const state = { gerber:null, drill:null, outline:null, isoPaths:null };
  let cv, ctx;
  const log = UI.log, fmt = UI.fmt;

  function fit() {
    const r = cv.getBoundingClientRect();
    const w = Math.max(100, r.width) * devicePixelRatio;
    const h = Math.max(100, r.height) * devicePixelRatio;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  }

  function render() {
    fit();
    ctx.fillStyle = '#0a0c10';
    ctx.fillRect(0,0,cv.width,cv.height);
    const { gerber, drill, outline, isoPaths } = state;
    if (!gerber && !drill && !outline) return;

    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    function upd(x,y){ if(x<minX)minX=x; if(y<minY)minY=y; if(x>maxX)maxX=x; if(y>maxY)maxY=y; }
    if (gerber) { upd(gerber.bbox.minX,gerber.bbox.minY); upd(gerber.bbox.maxX,gerber.bbox.maxY); }
    if (outline) { upd(outline.bbox.minX,outline.bbox.minY); upd(outline.bbox.maxX,outline.bbox.maxY); }
    if (drill) for (const h of drill.holes) { upd(h.x-h.d/2,h.y-h.d/2); upd(h.x+h.d/2,h.y+h.d/2); }
    if (!isFinite(minX)) return;
    const bw = maxX-minX, bh = maxY-minY;
    const pad = 30 * devicePixelRatio;
    const scale = Math.min((cv.width-pad*2)/bw, (cv.height-pad*2)/bh);
    const ox = pad - minX*scale;
    const oy = cv.height - pad + minY*scale;
    const X = x => ox + x*scale, Y = y => oy - y*scale;

    if (gerber) {
      ctx.fillStyle = '#ffcf5c'; ctx.strokeStyle = '#ffcf5c';
      for (const t of gerber.traces) {
        ctx.lineWidth = Math.max(1, t.w*scale); ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(X(t.x1),Y(t.y1)); ctx.lineTo(X(t.x2),Y(t.y2)); ctx.stroke();
      }
      for (const p of gerber.pads) {
        const poly = apertureToPoly(p.ap, p.x, p.y);
        ctx.beginPath();
        poly.forEach((pt,i) => { if (i===0) ctx.moveTo(X(pt[0]),Y(pt[1])); else ctx.lineTo(X(pt[0]),Y(pt[1])); });
        ctx.closePath(); ctx.fill();
      }
      for (const r of gerber.regions) {
        ctx.beginPath();
        r.forEach((pt,i) => { if (i===0) ctx.moveTo(X(pt[0]),Y(pt[1])); else ctx.lineTo(X(pt[0]),Y(pt[1])); });
        ctx.closePath(); ctx.fill();
      }
    }
    if (isoPaths) {
      ctx.strokeStyle = '#4ea1ff'; ctx.lineWidth = 1.5 * devicePixelRatio;
      for (const path of isoPaths) {
        ctx.beginPath();
        path.forEach((pt,i) => { if (i===0) ctx.moveTo(X(pt.X/SCALE),Y(pt.Y/SCALE)); else ctx.lineTo(X(pt.X/SCALE),Y(pt.Y/SCALE)); });
        ctx.closePath(); ctx.stroke();
      }
    }
    if (drill) {
      ctx.strokeStyle = '#5ad18b'; ctx.lineWidth = 1.5 * devicePixelRatio;
      for (const h of drill.holes) {
        ctx.beginPath(); ctx.arc(X(h.x), Y(h.y), Math.max(3, h.d/2*scale), 0, Math.PI*2); ctx.stroke();
      }
    }
    if (outline) {
      ctx.strokeStyle = '#ff6b6b'; ctx.lineWidth = 2 * devicePixelRatio;
      for (const t of outline.traces) {
        ctx.beginPath(); ctx.moveTo(X(t.x1),Y(t.y1)); ctx.lineTo(X(t.x2),Y(t.y2)); ctx.stroke();
      }
    }
  }

  async function readFile(inputId) {
    const f = UI.el(inputId).files[0];
    return f ? await f.text() : null;
  }

  function bindFileInputs() {
    UI.el('fTop').addEventListener('change', async () => {
      const t = await readFile('fTop'); if (!t) return;
      try {
        state.gerber = parseGerber(t);
        const b = state.gerber.bbox;
        log('loaded copper: '+state.gerber.traces.length+' traces, '+state.gerber.pads.length+' pads, '+state.gerber.regions.length+' regions', 'ok');
        if (isFinite(b.minX)) log('  bbox: '+b.minX.toFixed(2)+','+b.minY.toFixed(2)+' → '+b.maxX.toFixed(2)+','+b.maxY.toFixed(2)+' mm');
        else log('  WARNING: no geometry parsed', 'warn');
      } catch(e) { log('copper parse error: '+e.message, 'err'); }
      render();
    });
    UI.el('fDrl').addEventListener('change', async (ev) => {
      const files = [...ev.target.files]; if (!files.length) return;
      const merged = { holes: [] };
      for (const f of files) {
        try {
          const parsed = parseExcellon(await f.text());
          merged.holes.push(...parsed.holes);
          log('loaded '+f.name+': '+parsed.holes.length+' holes', 'ok');
        } catch(e) { log(f.name+' parse error: '+e.message, 'err'); }
      }
      state.drill = merged;
      log('total drill holes: '+merged.holes.length, 'ok');
      render();
    });
    UI.el('fOut').addEventListener('change', async () => {
      const t = await readFile('fOut'); if (!t) return;
      try { state.outline = parseGerber(t); log('loaded outline: '+state.outline.traces.length+' segments', 'ok'); }
      catch(e) { log('outline parse error: '+e.message, 'err'); }
      render();
    });
    UI.el('bType').addEventListener('change', e => {
      UI.el('rowVangle').style.display = e.target.value === 'vbit' ? '' : 'none';
    });
  }

  function generateGcode() {
    if (!state.gerber && !state.drill && !state.outline) { log('load at least one file first', 'err'); return null; }
    const cfg = {
      model: UI.el('mModel').value,
      bType: UI.el('bType').value, bAngle: +UI.el('bAngle').value,
      bDia: +UI.el('bDia').value, bDrill: +UI.el('bDrill').value, bCutout: +UI.el('bCutout').value,
      dTrace: +UI.el('dTrace').value, dIso: +UI.el('dIso').value, dBoard: +UI.el('dBoard').value,
      dMargin: +UI.el('dMargin').value, dStep: +UI.el('dStep').value, dSafe: +UI.el('dSafe').value,
      nTabs: +UI.el('nTabs').value,
      sFeed: +UI.el('sFeed').value, sPlunge: +UI.el('sPlunge').value, sTravel: +UI.el('sTravel').value, sRPM: +UI.el('sRPM').value,
      origin: UI.el('mOrigin').value, mirror: UI.el('mMirror').value === '1',
    };

    let effW = cfg.bDia;
    if (cfg.bType === 'vbit') effW = cfg.bDia + 2 * cfg.dTrace * Math.tan(cfg.bAngle*Math.PI/360);

    let bbox = state.gerber?.bbox || state.outline?.bbox || {minX:0,minY:0,maxX:50,maxY:50};
    let dx = 0, dy = 0;
    if (cfg.origin === 'bl') { dx = -bbox.minX; dy = -bbox.minY; }
    else if (cfg.origin === 'center') { dx = -(bbox.minX+bbox.maxX)/2; dy = -(bbox.minY+bbox.maxY)/2; }
    const mirrorX = cfg.mirror ? -1 : 1;
    const width = bbox.maxX - bbox.minX;
    const tx = x => mirrorX*(x+dx) + (cfg.mirror?width:0), ty = y => y+dy;

    const bedSize = { A150:[160,160], A250:[230,250], A350:[320,350], Artisan:[400,400] }[cfg.model];
    if (bedSize) {
      const w = bbox.maxX-bbox.minX, h = bbox.maxY-bbox.minY;
      if (w > bedSize[0] || h > bedSize[1]) log(`warning: board ${w.toFixed(1)}×${h.toFixed(1)} mm exceeds ${cfg.model} bed ${bedSize[0]}×${bedSize[1]} mm`,'warn');
    }

    const g = [];
    g.push(';Header Start');
    g.push(';header_type: cnc');
    g.push(';tool_head: standardCNCToolheadForSM2');
    g.push(';machine: '+cfg.model);
    g.push(';file_total_lines: PLACEHOLDER');
    g.push(';estimated_time(s): 0');
    g.push(';max_x(mm): '+fmt((bbox.maxX-bbox.minX)));
    g.push(';max_y(mm): '+fmt((bbox.maxY-bbox.minY)));
    g.push(';max_z(mm): '+fmt(cfg.dBoard+cfg.dMargin));
    g.push(';work_speed(mm/minute): '+cfg.sFeed);
    g.push(';jog_speed(mm/minute): '+cfg.sTravel);
    g.push(';power(%): 100');
    g.push(';Header End');
    g.push('');
    g.push('G90 ; absolute');
    g.push('G21 ; mm');
    g.push('M3 S'+cfg.sRPM+' ; spindle on');
    g.push('G4 P2');
    g.push('G0 Z'+fmt(cfg.dSafe)+' F'+cfg.sTravel);
    g.push('');

    if (state.gerber) {
      g.push('; ===== ISOLATION ROUTING =====');
      const copper = buildCopperUnion(state.gerber);
      const offsetDist = effW/2 + cfg.dIso/2;
      const iso = offsetPaths(copper, offsetDist);
      state.isoPaths = iso;
      log('isolation: '+iso.length+' loops');
      if (copper.length > 1 && iso.length < copper.length) {
        let lo = 0, hi = offsetDist;
        for (let k=0;k<14;k++) {
          const mid = (lo+hi)/2;
          if (offsetPaths(copper, mid).length < copper.length) hi = mid; else lo = mid;
        }
        const maxSafeOff = lo, maxSafeIso = Math.max(0, 2*(maxSafeOff - effW/2));
        log('WARNING: '+(copper.length - iso.length)+' copper islands merge — traces will fuse', 'err');
        let suggestion;
        if (maxSafeIso >= 0.05) suggestion = 'Lower "Isolation width" to '+maxSafeIso.toFixed(2)+' mm or less.';
        else if (cfg.bType === 'vbit' && cfg.bAngle) {
          const targetEffW = Math.max(0.02, 2*maxSafeOff - 0.05);
          const newDepth = (targetEffW - cfg.bDia) / (2*Math.tan(cfg.bAngle*Math.PI/360));
          if (newDepth >= 0.02) suggestion = 'Lower "Trace cut depth" to '+newDepth.toFixed(2)+' mm and "Isolation width" to 0.05 mm.';
        }
        if (!suggestion) suggestion = 'Trace spacing too tight for any V-bit settings — increase Design Rules → Clearance in KiCad to '+(2*offsetDist).toFixed(2)+' mm.';
        log('Suggestion: '+suggestion, 'warn');
      }
      for (const loop of iso) {
        if (loop.length < 2) continue;
        const first = loop[0];
        g.push('G0 Z'+fmt(cfg.dSafe));
        g.push('G0 X'+fmt(tx(first.X/SCALE))+' Y'+fmt(ty(first.Y/SCALE))+' F'+cfg.sTravel);
        g.push('G1 Z'+fmt(-cfg.dTrace)+' F'+cfg.sPlunge);
        for (let i=1;i<loop.length;i++) {
          const p = loop[i];
          g.push('G1 X'+fmt(tx(p.X/SCALE))+' Y'+fmt(ty(p.Y/SCALE))+' F'+cfg.sFeed);
        }
        g.push('G1 X'+fmt(tx(first.X/SCALE))+' Y'+fmt(ty(first.Y/SCALE))+' F'+cfg.sFeed);
      }
      g.push('G0 Z'+fmt(cfg.dSafe));
      g.push('');
    }

    if (state.drill) {
      g.push('; ===== DRILLING =====');
      g.push('; PAUSE: change to drill bit '+cfg.bDrill+' mm, then resume');
      g.push('M76');
      g.push('M3 S'+cfg.sRPM);
      const drillZ = -(cfg.dBoard + cfg.dMargin);
      for (const h of state.drill.holes) {
        const X = tx(h.x), Y = ty(h.y);
        if (h.d <= cfg.bDrill * 1.2) {
          g.push('G0 Z'+fmt(cfg.dSafe));
          g.push('G0 X'+fmt(X)+' Y'+fmt(Y)+' F'+cfg.sTravel);
          g.push('G1 Z'+fmt(drillZ/2)+' F'+cfg.sPlunge);
          g.push('G0 Z'+fmt(cfg.dSafe));
          g.push('G0 X'+fmt(X)+' Y'+fmt(Y));
          g.push('G1 Z'+fmt(drillZ)+' F'+cfg.sPlunge);
          g.push('G0 Z'+fmt(cfg.dSafe));
        } else {
          const r = (h.d - cfg.bDrill)/2;
          g.push('G0 Z'+fmt(cfg.dSafe));
          g.push('G0 X'+fmt(X+r)+' Y'+fmt(Y)+' F'+cfg.sTravel);
          g.push('G1 Z0 F'+cfg.sPlunge);
          const passes = Math.max(1, Math.ceil(cfg.dBoard / cfg.dStep));
          for (let p=1;p<=passes;p++) {
            const z = -Math.min(cfg.dBoard+cfg.dMargin, p*cfg.dStep);
            g.push('G1 Z'+fmt(z)+' F'+cfg.sPlunge);
            const seg = 32;
            for (let i=1;i<=seg;i++) {
              const a = i/seg*Math.PI*2;
              g.push('G1 X'+fmt(X+Math.cos(a)*r)+' Y'+fmt(Y+Math.sin(a)*r)+' F'+cfg.sFeed);
            }
          }
          g.push('G0 Z'+fmt(cfg.dSafe));
        }
      }
      g.push('');
    }

    if (state.outline) {
      g.push('; ===== OUTLINE CUTOUT =====');
      g.push('; PAUSE: change to '+cfg.bCutout+' mm flat end mill, then resume');
      g.push('M76');
      g.push('M3 S'+cfg.sRPM);
      const segs = state.outline.traces.map(t => [[t.x1,t.y1],[t.x2,t.y2]]);
      const totalLen = segs.reduce((s,[a,b]) => s + Math.hypot(b[0]-a[0], b[1]-a[1]), 0);
      const cutD = cfg.dBoard + cfg.dMargin;
      const passes = Math.max(1, Math.ceil(cutD / cfg.dStep));
      const tabLocs = [];
      if (cfg.nTabs > 0) for (let i=0;i<cfg.nTabs;i++) tabLocs.push(totalLen * (i+0.5) / cfg.nTabs);
      const tabWidth = 2, tabHeight = 0.5;

      for (let pass=1; pass<=passes; pass++) {
        const z = -Math.min(cutD, pass*cfg.dStep);
        const tabZ = -Math.max(0, cutD - tabHeight);
        const isTabPass = pass === passes && cfg.nTabs > 0;
        let cum = 0, prev = null;
        const EPS = 0.005;
        for (const [a,b] of segs) {
          const needsJump = !prev || Math.hypot(a[0]-prev[0], a[1]-prev[1]) > EPS;
          if (needsJump) {
            g.push('G0 Z'+fmt(cfg.dSafe));
            g.push('G0 X'+fmt(tx(a[0]))+' Y'+fmt(ty(a[1]))+' F'+cfg.sTravel);
            g.push('G1 Z'+fmt(z)+' F'+cfg.sPlunge);
          }
          const sx=a[0], sy=a[1], ex=b[0], ey=b[1];
          const L = Math.hypot(ex-sx, ey-sy);
          const cuts = [];
          if (isTabPass) {
            for (const loc of tabLocs) {
              if (loc >= cum && loc <= cum+L) {
                const t0 = (loc - tabWidth/2 - cum)/L, t1 = (loc + tabWidth/2 - cum)/L;
                cuts.push([Math.max(0,t0), Math.min(1,t1)]);
              }
            }
          }
          cuts.sort((a,b)=>a[0]-b[0]);
          let tcur = 0;
          for (const [t0,t1] of cuts) {
            if (t0 > tcur) {
              const px = sx + (ex-sx)*t0, py = sy + (ey-sy)*t0;
              g.push('G1 X'+fmt(tx(px))+' Y'+fmt(ty(py))+' Z'+fmt(z)+' F'+cfg.sFeed);
            }
            const ax = sx + (ex-sx)*t0, ay = sy + (ey-sy)*t0;
            const bx = sx + (ex-sx)*t1, by = sy + (ey-sy)*t1;
            g.push('G1 X'+fmt(tx(ax))+' Y'+fmt(ty(ay))+' Z'+fmt(tabZ));
            g.push('G1 X'+fmt(tx(bx))+' Y'+fmt(ty(by))+' Z'+fmt(tabZ));
            g.push('G1 Z'+fmt(z));
            tcur = t1;
          }
          g.push('G1 X'+fmt(tx(ex))+' Y'+fmt(ty(ey))+' F'+cfg.sFeed);
          cum += L;
          prev = b;
        }
        g.push('G0 Z'+fmt(cfg.dSafe));
      }
      g.push('');
    }

    g.push('; ===== END =====');
    g.push('G0 Z'+fmt(cfg.dSafe+5));
    g.push('G0 X0 Y0 F'+cfg.sTravel);
    g.push('M5');
    g.push('M30');
    const lines = g.length;
    for (let i=0;i<g.length;i++) if (g[i].includes('file_total_lines: PLACEHOLDER')) g[i] = ';file_total_lines: '+lines;
    return g.join('\n');
  }

  function generateStl() {
    if (!state.gerber && !state.outline && !state.drill) { log('load a file first', 'err'); return null; }
    const BASE_H = 0.5, FEAT_H = 1.0, EDGE_W = 0.6;
    const Z_BASE = 0, Z_TOP_BASE = BASE_H, Z_TOP_FEAT = BASE_H + FEAT_H;
    const out = ['solid pcb'];
    function tri(a,b,c) {
      out.push('facet normal 0 0 0',' outer loop',
        '  vertex '+a[0]+' '+a[1]+' '+a[2],
        '  vertex '+b[0]+' '+b[1]+' '+b[2],
        '  vertex '+c[0]+' '+c[1]+' '+c[2],
        ' endloop','endfacet');
    }
    function extrudeWithHoles(outer, holes, z0, z1) {
      if (!outer || outer.length < 3) return;
      const flat = [], holeIdx = [];
      for (const p of outer) flat.push(p[0], p[1]);
      for (const hole of holes) {
        if (hole.length < 3) continue;
        holeIdx.push(flat.length / 2);
        for (const p of hole) flat.push(p[0], p[1]);
      }
      const tris = earcut(flat, holeIdx);
      const V = i => [flat[i*2], flat[i*2+1]];
      for (let i=0;i<tris.length;i+=3) {
        const a=V(tris[i]), b=V(tris[i+1]), c=V(tris[i+2]);
        tri([a[0],a[1],z1],[b[0],b[1],z1],[c[0],c[1],z1]);
        tri([a[0],a[1],z0],[c[0],c[1],z0],[b[0],b[1],z0]);
      }
      function walls(ring) {
        for (let i=0;i<ring.length;i++) {
          const a=ring[i], b=ring[(i+1)%ring.length];
          tri([a[0],a[1],z0],[b[0],b[1],z0],[b[0],b[1],z1]);
          tri([a[0],a[1],z0],[b[0],b[1],z1],[a[0],a[1],z1]);
        }
      }
      walls(outer);
      for (const h of holes) walls(h);
    }
    const drillPaths = (state.drill && state.drill.holes.length)
      ? state.drill.holes.map(h => toClipperPath(circlePoly(h.x, h.y, h.d/2, 24))) : [];

    if (state.outline && state.outline.traces.length) {
      const loops = chainSegments(state.outline.traces);
      if (loops.length) {
        const baseUnion = clipUnion(loops.map(toClipperPath));
        let groups;
        if (drillPaths.length) groups = polyTreeGroups(clipDifferenceTree(baseUnion, drillPaths));
        else groups = baseUnion.map(p => ({outer: fromClipperPath(p), holes: []}));
        for (const g of groups) extrudeWithHoles(g.outer, g.holes, Z_BASE, Z_TOP_BASE);
      }
    }
    if (state.gerber) {
      const paths = [];
      for (const t of state.gerber.traces) paths.push(toClipperPath(segmentPoly(t.x1,t.y1,t.x2,t.y2,t.w)));
      for (const p of state.gerber.pads) paths.push(toClipperPath(apertureToPoly(p.ap, p.x, p.y)));
      for (const r of state.gerber.regions) paths.push(toClipperPath(r));
      const copper = clipUnion(paths);
      let groups;
      if (drillPaths.length) groups = polyTreeGroups(clipDifferenceTree(copper, drillPaths));
      else groups = copper.map(p => ({outer: fromClipperPath(p), holes: []}));
      for (const g of groups) extrudeWithHoles(g.outer, g.holes, Z_TOP_BASE, Z_TOP_FEAT);
    }
    if (state.outline && state.outline.traces.length) {
      const paths = state.outline.traces.map(t => toClipperPath(segmentPoly(t.x1,t.y1,t.x2,t.y2,EDGE_W)));
      const edge = clipUnion(paths);
      for (const p of edge) extrudeWithHoles(fromClipperPath(p), [], Z_TOP_BASE, Z_TOP_FEAT);
    }
    out.push('endsolid pcb');
    return out.join('\n');
  }

  function init() {
    cv = UI.el('cv-convert');
    if (!cv) return;
    ctx = cv.getContext('2d');
    bindFileInputs();

    UI.el('btnGen').addEventListener('click', async () => {
      UI.clearLog(); UI.setStatus('generating…','busy'); UI.setProgress(5);
      await new Promise(r => setTimeout(r, 10));
      try {
        UI.setProgress(30);
        const gcode = generateGcode();
        UI.setProgress(90);
        if (!gcode) { UI.setStatus('ready'); UI.setProgress(0); return; }
        window._gcode = gcode;
        UI.el('btnDl').disabled = false;
        log('G-code generated: '+gcode.split('\n').length+' lines','ok');
        UI.setStatus('done','done'); UI.setProgress(100);
        render();
        setTimeout(()=>UI.setProgress(0), 1200);
      } catch(e) { log('error: '+e.message,'err'); console.error(e); UI.setStatus('error','err'); UI.setProgress(0); }
    });
    UI.el('btnStl').addEventListener('click', () => {
      UI.setStatus('building STL…','busy'); UI.setProgress(30);
      try {
        const stl = generateStl();
        if (!stl) { UI.setStatus('ready'); UI.setProgress(0); return; }
        const blob = new Blob([stl], {type:'model/stl'});
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = 'pcb.stl'; a.click();
        log('STL exported: '+Math.round(stl.length/1024)+' KB','ok');
        UI.setStatus('done','done'); UI.setProgress(100);
        setTimeout(()=>UI.setProgress(0), 1200);
      } catch(e) { log('stl error: '+e.message,'err'); UI.setStatus('error','err'); UI.setProgress(0); console.error(e); }
    });
    UI.el('btnDl').addEventListener('click', () => {
      if (!window._gcode) return;
      const blob = new Blob([window._gcode], {type:'text/plain'});
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'pcb.cnc.gcode'; a.click();
    });

    window.addEventListener('resize', () => { fit(); render(); });
    window.addEventListener('tabchange', e => { if (e.detail.name === 'convert') requestAnimationFrame(()=>{ fit(); render(); }); });
    requestAnimationFrame(() => { fit(); render(); });
  }

  return { init, render, state };
})();
