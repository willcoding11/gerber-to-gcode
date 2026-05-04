"use strict";

// Geometry primitives + Clipper helpers shared by converter and PCB exporter.
const SCALE = 100000;
function toClipperPath(pts) { return pts.map(p => ({X: Math.round(p[0]*SCALE), Y: Math.round(p[1]*SCALE)})); }
function fromClipperPath(path) { return path.map(p => [p.X/SCALE, p.Y/SCALE]); }

function circlePoly(cx, cy, r, seg=32) {
  const pts = [];
  for (let i=0;i<seg;i++) {
    const a = (i/seg)*Math.PI*2;
    pts.push([cx + Math.cos(a)*r, cy + Math.sin(a)*r]);
  }
  return pts;
}
function rectPoly(cx, cy, w, h) {
  return [[cx-w/2,cy-h/2],[cx+w/2,cy-h/2],[cx+w/2,cy+h/2],[cx-w/2,cy+h/2]];
}
function segmentPoly(x1,y1,x2,y2,w) {
  const dx = x2-x1, dy = y2-y1, L = Math.hypot(dx,dy) || 1;
  const nx = -dy/L * w/2, ny = dx/L * w/2;
  return [[x1+nx,y1+ny],[x2+nx,y2+ny],[x2-nx,y2-ny],[x1-nx,y1-ny]];
}
function apertureToPoly(ap, cx, cy) {
  const [p0=0.1, p1=p0, p2=0] = ap.params;
  if (ap.tmpl === 'C') return circlePoly(cx, cy, p0/2);
  if (ap.tmpl === 'R') return rectPoly(cx, cy, p0, p1);
  if (ap.tmpl === 'O') {
    const w=p0, h=p1, r=Math.min(w,h)/2, seg=16, poly=[];
    if (w >= h) {
      const cx1=cx+(w/2-r), cx2=cx-(w/2-r);
      for (let i=0;i<=seg;i++){ const a=-Math.PI/2 + Math.PI*(i/seg); poly.push([cx1+Math.cos(a)*r, cy+Math.sin(a)*r]); }
      for (let i=0;i<=seg;i++){ const a= Math.PI/2 + Math.PI*(i/seg); poly.push([cx2+Math.cos(a)*r, cy+Math.sin(a)*r]); }
    } else {
      const cy1=cy+(h/2-r), cy2=cy-(h/2-r);
      for (let i=0;i<=seg;i++){ const a=0       + Math.PI*(i/seg); poly.push([cx+Math.cos(a)*r, cy1+Math.sin(a)*r]); }
      for (let i=0;i<=seg;i++){ const a=Math.PI + Math.PI*(i/seg); poly.push([cx+Math.cos(a)*r, cy2+Math.sin(a)*r]); }
    }
    return poly;
  }
  if (ap.tmpl === 'P') {
    const d = p0, n = p1 || 6, rot = (p2||0)*Math.PI/180;
    const pts = [];
    for (let i=0;i<n;i++) {
      const a = rot + i/n*Math.PI*2;
      pts.push([cx+Math.cos(a)*d/2, cy+Math.sin(a)*d/2]);
    }
    return pts;
  }
  return circlePoly(cx, cy, p0/2);
}

function buildCopperUnion(gerber) {
  const paths = [];
  for (const t of gerber.traces) paths.push(toClipperPath(segmentPoly(t.x1,t.y1,t.x2,t.y2,t.w)));
  for (const p of gerber.pads) paths.push(toClipperPath(apertureToPoly(p.ap, p.x, p.y)));
  for (const r of gerber.regions) paths.push(toClipperPath(r));
  return clipUnion(paths);
}

function clipUnion(paths) {
  const c = new ClipperLib.Clipper();
  c.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
  const sol = new ClipperLib.Paths();
  c.Execute(ClipperLib.ClipType.ctUnion, sol, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return sol;
}
function clipDifferenceTree(subject, clip) {
  const c = new ClipperLib.Clipper();
  c.AddPaths(subject, ClipperLib.PolyType.ptSubject, true);
  c.AddPaths(clip, ClipperLib.PolyType.ptClip, true);
  const tree = new ClipperLib.PolyTree();
  c.Execute(ClipperLib.ClipType.ctDifference, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return tree;
}
function polyTreeGroups(tree) {
  const groups = [];
  function visit(node) {
    for (const child of node.Childs()) {
      if (!child.IsHole()) {
        const outer = fromClipperPath(child.Contour());
        const holes = [];
        for (const grand of child.Childs()) {
          if (grand.IsHole()) holes.push(fromClipperPath(grand.Contour()));
          visit(grand);
        }
        groups.push({outer, holes});
      } else { visit(child); }
    }
  }
  visit(tree);
  return groups;
}
function offsetPaths(paths, delta) {
  const co = new ClipperLib.ClipperOffset(2, 0.25);
  co.AddPaths(paths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const out = new ClipperLib.Paths();
  co.Execute(out, delta * SCALE);
  return out;
}
// Chain edge-cut line segments into closed loops.
function chainSegments(traces, eps=0.01) {
  const segs = traces.map(t => [[t.x1,t.y1],[t.x2,t.y2]]);
  const used = new Array(segs.length).fill(false);
  const loops = [];
  for (let i=0;i<segs.length;i++) {
    if (used[i]) continue;
    used[i] = true;
    const loop = [segs[i][0].slice(), segs[i][1].slice()];
    let changed = true;
    while (changed) {
      changed = false;
      const tail = loop[loop.length-1];
      for (let j=0;j<segs.length;j++) {
        if (used[j]) continue;
        const [a,b] = segs[j];
        if (Math.hypot(tail[0]-a[0],tail[1]-a[1]) < eps) { loop.push(b.slice()); used[j]=true; changed=true; break; }
        if (Math.hypot(tail[0]-b[0],tail[1]-b[1]) < eps) { loop.push(a.slice()); used[j]=true; changed=true; break; }
      }
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}
