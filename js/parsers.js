"use strict";

// Minimal Gerber (RS-274X) parser — handles the subset KiCad emits.
function parseGerber(text) {
  const out = { traces: [], pads: [], regions: [], units: 'mm', bbox:{minX:Infinity,minY:Infinity,maxX:-Infinity,maxY:-Infinity} };
  const apertures = {};
  let fmt = { xInt:4, xDec:6, yInt:4, yDec:6, lz:true };
  let unitScale = 1;
  let curAp = null;
  let curX = 0, curY = 0;
  let mode = 'G01';
  let inRegion = false;
  let regionPts = [];

  text = text.replace(/\r/g,'');

  function parseCoord(s, isY) {
    if (s == null) return isY ? curY : curX;
    const neg = s.startsWith('-');
    if (neg || s.startsWith('+')) s = s.slice(1);
    const dec = isY ? fmt.yDec : fmt.xDec;
    const intd = isY ? fmt.yInt : fmt.xInt;
    let str = fmt.lz ? s.padStart(intd+dec,'0') : s.padEnd(intd+dec,'0');
    const i = str.length - dec;
    const whole = str.slice(0,i) || '0';
    const frac = str.slice(i);
    let v = parseFloat(whole + '.' + frac);
    if (neg) v = -v;
    return v * unitScale;
  }
  function bb(x,y) {
    if (x<out.bbox.minX) out.bbox.minX=x;
    if (y<out.bbox.minY) out.bbox.minY=y;
    if (x>out.bbox.maxX) out.bbox.maxX=x;
    if (y>out.bbox.maxY) out.bbox.maxY=y;
  }

  // Tokenize
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '%') {
      const end = text.indexOf('%', i+1);
      if (end < 0) break;
      const block = text.slice(i+1, end);
      block.split('*').forEach(p => { if (p.trim()) tokens.push({param:true, v:p.trim()}); });
      i = end + 1;
    } else if (text[i] === '*' || text[i] === '\n' || text[i] === ' ' || text[i] === '\t') {
      i++;
    } else {
      const end = text.indexOf('*', i);
      if (end < 0) break;
      const cmd = text.slice(i, end).trim();
      if (cmd) tokens.push({param:false, v:cmd});
      i = end + 1;
    }
  }

  for (const t of tokens) {
    const v = t.v;
    if (t.param) {
      if (v.startsWith('FS')) {
        const m = v.match(/FS([LT])([AI])X(\d)(\d)Y(\d)(\d)/);
        if (m) { fmt.lz = m[1] === 'L'; fmt.xInt=+m[3]; fmt.xDec=+m[4]; fmt.yInt=+m[5]; fmt.yDec=+m[6]; }
      } else if (v.startsWith('MO')) {
        if (v.includes('MOIN')) { unitScale = 25.4; out.units='in'; } else { unitScale = 1; out.units='mm'; }
      } else if (v.startsWith('AD')) {
        const m = v.match(/ADD(\d+)([A-Za-z_][A-Za-z0-9_]*)(?:,(.*))?/);
        if (m) {
          const id = +m[1], tmpl = m[2], pstr = m[3]||'';
          const params = pstr ? pstr.split('X').map(parseFloat) : [];
          apertures[id] = { tmpl, params };
        }
      }
      continue;
    }
    if (/^G0?1\b/.test(v)) mode = 'G01';
    else if (/^G0?2\b/.test(v)) mode = 'G02';
    else if (/^G0?3\b/.test(v)) mode = 'G03';
    else if (/^G36\b/.test(v)) { inRegion = true; regionPts = []; }
    else if (/^G37\b/.test(v)) {
      if (regionPts.length >= 3) out.regions.push(regionPts);
      inRegion = false; regionPts = [];
    }
    else if (/^G54?D(\d+)/.test(v) || /^D(\d+)$/.test(v)) {
      const m = v.match(/D(\d+)/);
      if (m) curAp = +m[1];
    }

    const mc = v.match(/^(?:G0?[123])?(?:X(-?\d+))?(?:Y(-?\d+))?(?:I(-?\d+))?(?:J(-?\d+))?D0?([123])/);
    if (mc) {
      const nx = mc[1] != null ? parseCoord(mc[1], false) : curX;
      const ny = mc[2] != null ? parseCoord(mc[2], true) : curY;
      const iOff = mc[3] != null ? parseCoord(mc[3], false) : 0;
      const jOff = mc[4] != null ? parseCoord(mc[4], true) : 0;
      const op = +mc[5];
      if (op === 2) {
        curX = nx; curY = ny;
        if (inRegion) regionPts = [[curX,curY]];
      } else if (op === 1) {
        let pts;
        if (mode === 'G02' || mode === 'G03') {
          const cxA = curX + iOff, cyA = curY + jOff;
          const r0 = Math.hypot(curX-cxA, curY-cyA);
          let a0 = Math.atan2(curY-cyA, curX-cxA);
          let a1 = Math.atan2(ny-cyA, nx-cxA);
          const cw = (mode === 'G02');
          if (cw) { if (a1 >= a0) a1 -= Math.PI*2; }
          else    { if (a1 <= a0) a1 += Math.PI*2; }
          if (Math.abs(curX-nx) < 1e-9 && Math.abs(curY-ny) < 1e-9) {
            a1 = a0 + (cw ? -Math.PI*2 : Math.PI*2);
          }
          const sweep = a1 - a0;
          const steps = Math.max(6, Math.ceil(Math.abs(sweep) * r0 / 0.1));
          pts = [];
          for (let s=1; s<=steps; s++) {
            const a = a0 + sweep * (s/steps);
            pts.push([cxA + Math.cos(a)*r0, cyA + Math.sin(a)*r0]);
          }
        } else {
          pts = [[nx, ny]];
        }
        if (inRegion) {
          for (const [px,py] of pts) { regionPts.push([px,py]); bb(px,py); }
        } else {
          const ap = apertures[curAp];
          const w = ap && ap.tmpl === 'C' ? ap.params[0] : (ap && ap.params[0]) || 0.1;
          let px = curX, py = curY;
          for (const [qx,qy] of pts) {
            out.traces.push({ x1:px, y1:py, x2:qx, y2:qy, w });
            bb(px-w/2, py-w/2); bb(px+w/2, py+w/2);
            bb(qx-w/2, qy-w/2); bb(qx+w/2, qy+w/2);
            px = qx; py = qy;
          }
        }
        curX = nx; curY = ny;
      } else if (op === 3) {
        const ap = apertures[curAp];
        if (ap) {
          out.pads.push({ x:nx, y:ny, ap });
          const r = (ap.params[0] || 0.1) / 2;
          bb(nx-r, ny-r); bb(nx+r, ny+r);
        }
        curX = nx; curY = ny;
      }
    }
  }
  return out;
}

// Excellon drill parser
function parseExcellon(text) {
  const out = { holes: [] };
  const tools = {};
  let curTool = null;
  let unitScale = 1;
  text = text.replace(/\r/g,'');
  for (let raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith(';')) continue;
    if (line === 'M30' || line === 'M00') break;
    if (line.startsWith('METRIC')) { unitScale = 1; continue; }
    if (line.startsWith('INCH')) { unitScale = 25.4; continue; }
    let m = line.match(/^T(\d+)C([\d.]+)/);
    if (m) { tools[+m[1]] = parseFloat(m[2]) * unitScale; continue; }
    m = line.match(/^T(\d+)$/);
    if (m) { curTool = +m[1]; continue; }
    m = line.match(/X(-?[\d.]+)Y(-?[\d.]+)/);
    if (m) {
      const x = parseFloat(m[1]) * unitScale;
      const y = parseFloat(m[2]) * unitScale;
      out.holes.push({ x, y, d: tools[curTool] || 0.8 });
    }
  }
  return out;
}
