/*
 * Keyframe animation for PrismaMD: tracks, cubic-bezier easing, timeline, easing graph editor.
 *
 * Every keyframe stores the easing of the segment that STARTS at that key (ease to the next key),
 * either a cubic-bezier [x1, y1, x2, y2] (y may leave 0..1 for overshoot) or 'hold' (step).
 */

const DEG = 180 / Math.PI;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
const GROUP_ORDER = ['Model', 'Camera', 'Material'];

// c is a cubic-bezier [x1, y1, x2, y2] (editable), or a named curve: 'hold', 'elastic', 'bounce'.
const EASES = {
  linear:  { label: 'Linear',            c: [0, 0, 1, 1] },
  easeIn:  { label: 'Ease in',           c: [0.42, 0, 1, 1] },
  easeOut: { label: 'Ease out',          c: [0, 0, 0.58, 1] },
  sCurve:  { label: 'S-curve (in & out)', c: [0.42, 0, 0.58, 1] },
  elastic: { label: 'Elastic',           c: 'elastic' },
  bounce:  { label: 'Bounce',            c: 'bounce' },
  hold:    { label: 'Hold (step)',       c: 'hold' },
};

function easeName(c) {
  if (typeof c === 'string') return c;
  for (const k of Object.keys(EASES)) {
    const p = EASES[k].c;
    if (Array.isArray(p) && p.every((v, i) => Math.abs(v - c[i]) < 1e-3)) return k;
  }
  return 'custom';
}

function easeOutElastic(u) {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  return Math.pow(2, -10 * u) * Math.sin((u * 10 - 0.75) * (2 * Math.PI / 3)) + 1;
}

function easeOutBounce(u) {
  const n = 7.5625, d = 2.75;
  if (u < 1 / d) return n * u * u;
  if (u < 2 / d) { u -= 1.5 / d; return n * u * u + 0.75; }
  if (u < 2.5 / d) { u -= 2.25 / d; return n * u * u + 0.9375; }
  u -= 2.625 / d; return n * u * u + 0.984375;
}

// Eased progress (0..1 in, ~0..1 out) for any easing definition.
function ease(c, u) {
  if (c === 'elastic') return easeOutElastic(u);
  if (c === 'bounce') return easeOutBounce(u);
  if (c === 'hold') return u >= 1 ? 1 : 0;
  return bezier(c[0], c[1], c[2], c[3], u);
}

// Cubic bezier easing: progress u (0..1) -> eased value.
function bezier(x1, y1, x2, y2, u) {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  let lo = 0, hi = 1, t = u;
  for (let i = 0; i < 28; i++) {
    const w = 1 - t;
    const x = 3 * w * w * t * x1 + 3 * w * t * t * x2 + t * t * t;
    if (Math.abs(x - u) < 1e-5) break;
    if (x < u) lo = t; else hi = t;
    t = (lo + hi) / 2;
  }
  const w = 1 - t;
  return 3 * w * w * t * y1 + 3 * w * t * t * y2 + t * t * t;
}

function sample(keys, t) {
  const n = keys.length;
  if (!n) return null;
  if (t <= keys[0].t) return keys[0].v;
  if (t >= keys[n - 1].t) return keys[n - 1].v;
  let i = 0;
  while (i < n - 1 && keys[i + 1].t <= t) i++;
  const a = keys[i], b = keys[i + 1];
  if (a.e === 'hold') return a.v;
  return a.v + (b.v - a.v) * ease(a.e, (t - a.t) / (b.t - a.t));
}

// m:ss, or m:ss.s when the ruler is zoomed in far enough for sub-second ticks.
function fmtT(t, decimals) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return m + ':' + (decimals ? s.toFixed(1).padStart(4, '0') : String(Math.round(s)).padStart(2, '0'));
}

// Size a canvas to its CSS box (retina aware). Returns null while hidden.
function fit(c) {
  const w = Math.round(c.clientWidth), h = Math.round(c.clientHeight);
  if (w < 2 || h < 2) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w, h };
}

function diamond(g, x, y, r, fill, stroke) {
  g.beginPath();
  g.moveTo(x, y - r); g.lineTo(x + r, y); g.lineTo(x, y + r); g.lineTo(x - r, y);
  g.closePath();
  g.fillStyle = fill; g.fill();
  if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1.5; g.stroke(); }
}

export function createKeyframes(ctx) {
  const { $, camera, controls, state } = ctx;
  const css = getComputedStyle(document.documentElement);
  const C = (n) => css.getPropertyValue(n).trim() || '#888';

  const tracks = new Map();          // id -> { keys: [{ t, v, e }] }
  let sel = null;                    // { id, key }
  let dirty = true;                  // sampled values must be re-applied
  let needsDraw = true;
  const tl = { pps: 60, scrollX: 0, scrollY: 0 };

  const LABEL_W = 150, RULER_H = 28, ROW_H = 32;
  const LANE_PAD = 16;   // keeps a key at 0s fully visible next to the label column
  const xOf = (t) => LABEL_W + LANE_PAD + (t - tl.scrollX) * tl.pps;
  const tOf = (x) => tl.scrollX + (x - LABEL_W - LANE_PAD) / tl.pps;

  /* ---------------- property definitions ---------------- */
  const AX = ['x', 'y', 'z'];
  const mesh = () => ctx.getMesh();
  const staticDefs = [];
  for (const a of AX) staticDefs.push({
    id: 'm.p' + a, group: 'Model', label: 'Position ' + a.toUpperCase(), step: 0.1,
    ok: () => !!mesh(), get: () => mesh().position[a], set: (v) => { mesh().position[a] = v; },
  });
  for (const a of AX) staticDefs.push({
    id: 'm.r' + a, group: 'Model', label: 'Rotation ' + a.toUpperCase() + ' (°)', step: 1,
    ok: () => !!mesh(), get: () => mesh().rotation[a] * DEG, set: (v) => { mesh().rotation[a] = v / DEG; },
  });
  staticDefs.push({
    id: 'm.s', group: 'Model', label: 'Scale', step: 0.01,
    ok: () => !!mesh(), get: () => mesh().scale.x, set: (v) => mesh().scale.setScalar(Math.max(0.001, v)),
  });
  for (const a of AX) staticDefs.push({
    id: 'c.p' + a, group: 'Camera', label: 'Camera position ' + a.toUpperCase(), step: 0.5,
    ok: () => true, get: () => camera.position[a], set: (v) => { camera.position[a] = v; },
  });
  for (const a of AX) staticDefs.push({
    id: 'c.t' + a, group: 'Camera', label: 'Camera target ' + a.toUpperCase(), step: 0.5,
    ok: () => true, get: () => controls.target[a], set: (v) => { controls.target[a] = v; },
  });
  staticDefs.push({
    id: 'c.fov', group: 'Camera', label: 'Camera FOV (°)', step: 1,
    ok: () => true, get: () => camera.fov, set: (v) => { camera.fov = clamp(v, 5, 120); },
  });
  const byId = new Map(staticDefs.map((d) => [d.id, d]));

  function matDef(i) {
    const m = () => ctx.getMats()[i];
    const mm = m();
    return {
      id: `mat:${i}:o`, group: 'Material', step: 0.05,
      label: (mm ? ctx.matLabel(mm, i) : 'Material ' + (i + 1)) + ' · Opacity',
      ok: () => !!m(),
      get: () => ctx.matOpacityGet(m()),
      set: (v) => ctx.matOpacitySet(m(), clamp(v, 0, 1)),
    };
  }
  function findDef(id) {
    if (byId.has(id)) return byId.get(id);
    const mm = /^mat:(\d+):o$/.exec(id);
    return mm ? matDef(+mm[1]) : null;
  }
  const fixCamera = (d) => {
    if (d.group !== 'Camera') return;
    camera.lookAt(controls.target);
    camera.updateProjectionMatrix();
  };

  /* ---------------- track data ---------------- */
  const getTrack = (id) => { let t = tracks.get(id); if (!t) { t = { keys: [] }; tracks.set(id, t); } return t; };
  const sortKeys = (tr) => tr.keys.sort((a, b) => a.t - b.t);
  const prune = () => { for (const [id, tr] of tracks) if (!tr.keys.length) tracks.delete(id); };
  const hasKeys = () => { for (const tr of tracks.values()) if (tr.keys.length) return true; return false; };
  const endTime = () => { let e = 0; for (const tr of tracks.values()) for (const k of tr.keys) e = Math.max(e, k.t); return e; };
  const isCameraDriven = () => { for (const [id, tr] of tracks) if (id.startsWith('c.') && tr.keys.length) return true; return false; };
  const total = () => Math.max(ctx.getDuration(), endTime(), 5);

  function rows() {
    const out = [];
    for (const [id, tr] of tracks) {
      if (!tr.keys.length) continue;
      const def = findDef(id);
      if (def) out.push({ id, tr, def });
    }
    out.sort((a, b) => GROUP_ORDER.indexOf(a.def.group) - GROUP_ORDER.indexOf(b.def.group) || a.def.label.localeCompare(b.def.label));
    return out;
  }

  // Apply every track's value at time t. Returns true when camera tracks were applied.
  function applyAt(t) {
    dirty = false;
    let cam = false;
    for (const [id, tr] of tracks) {
      if (!tr.keys.length) continue;
      const def = findDef(id);
      if (!def || !def.ok()) continue;
      def.set(sample(tr.keys, t));
      if (def.group === 'Camera') cam = true;
    }
    if (cam) { camera.lookAt(controls.target); camera.updateProjectionMatrix(); }
    return cam;
  }

  function putKey(id, v, t = state.elapsed) {
    t = Math.max(0, r3(t));
    const tr = getTrack(id);
    let k = tr.keys.find((x) => Math.abs(x.t - t) < 0.004);
    if (k) k.v = v;
    else { k = { t, v, e: [0, 0, 1, 1] }; tr.keys.push(k); sortKeys(tr); }
    sel = { id, key: k };
    afterEdit();
    return k;
  }

  function afterEdit() {
    prune();
    dirty = true;
    needsDraw = true;
    refreshProps();
    refreshKeyBox();
  }

  /* ---------------- Animate tab UI ---------------- */
  function refreshProps() {
    const el = $('kfProp');
    const prev = el.value;
    el.textContent = '';
    const groups = { Model: [], Camera: [], Material: [] };
    for (const d of staticDefs) groups[d.group].push(d);
    const idx = new Set();
    const si = ctx.getSelectedMat();
    if (si >= 0 && ctx.getMats()[si]) idx.add(si);
    for (const id of tracks.keys()) { const mm = /^mat:(\d+):o$/.exec(id); if (mm) idx.add(+mm[1]); }
    [...idx].sort((a, b) => a - b).forEach((i) => groups.Material.push(matDef(i)));
    for (const g of GROUP_ORDER) {
      const og = document.createElement('optgroup');
      og.label = g;
      if (!groups[g].length) {
        const o = document.createElement('option');
        o.disabled = true; o.textContent = 'Select a material first'; og.appendChild(o);
      }
      for (const d of groups[g]) {
        const o = document.createElement('option');
        o.value = d.id; o.textContent = d.label; og.appendChild(o);
      }
      el.appendChild(og);
    }
    if ([...el.options].some((o) => o.value === prev && !o.disabled)) el.value = prev;
    if (si >= 0 && prev.startsWith('mat:') && ctx.getMats()[si]) el.value = `mat:${si}:o`;
    loadValue();
    needsDraw = true;
  }

  function loadValue() {
    const d = findDef($('kfProp').value);
    const inp = $('kfValue');
    if (!d || !d.ok()) { inp.value = ''; inp.disabled = true; return; }
    inp.disabled = false;
    inp.step = String(d.step);
    inp.value = String(r3(d.get()));
  }

  function setKeyFromUi() {
    const d = findDef($('kfProp').value);
    if (!d) return;
    if (!d.ok()) { ctx.toast('Load a model first.', true); return; }
    const v = parseFloat($('kfValue').value);
    if (!isFinite(v)) { ctx.toast('Enter a value first.', true); return; }
    d.set(v); fixCamera(d);
    putKey(d.id, v);
  }

  function keyGroup(group) {
    if (group === 'Model' && !mesh()) { ctx.toast('Load a model first.', true); return; }
    const t = state.elapsed;
    for (const d of staticDefs) if (d.group === group && d.ok()) putKey(d.id, d.get(), t);
    ctx.toast(group === 'Camera' ? 'Keyed camera view.' : 'Keyed model transform.');
  }

  function refreshKeyBox() {
    const tr = sel && tracks.get(sel.id);
    if (!tr || !tr.keys.includes(sel.key)) sel = null;
    $('kfNone').style.display = sel ? 'none' : '';
    $('kfKeyBox').style.display = sel ? '' : 'none';
    if (sel) {
      const d = findDef(sel.id);
      $('kfKeyTitle').textContent = d ? d.label : sel.id;
      $('kfKeyTime').value = String(r3(sel.key.t));
      $('kfKeyVal').value = String(r3(sel.key.v));
      $('kfEase').value = easeName(sel.key.e);
    }
    drawEase();
    needsDraw = true;
  }

  function selectKey(id, key) {
    sel = { id, key };
    if ([...$('kfProp').options].some((o) => o.value === id)) $('kfProp').value = id;
    else refreshProps();
    loadValue();
    refreshKeyBox();
  }

  // ease preset list
  for (const k of Object.keys(EASES)) {
    const o = document.createElement('option');
    o.value = k; o.textContent = EASES[k].label; $('kfEase').appendChild(o);
  }
  { const o = document.createElement('option'); o.value = 'custom'; o.textContent = 'Custom'; $('kfEase').appendChild(o); }

  $('kfProp').onchange = () => { loadValue(); needsDraw = true; };
  $('kfSet').onclick = setKeyFromUi;
  $('kfKeyCam').onclick = () => keyGroup('Camera');
  $('kfKeyModel').onclick = () => keyGroup('Model');

  $('kfKeyTime').onchange = () => {
    if (!sel) return;
    const v = parseFloat($('kfKeyTime').value);
    if (!isFinite(v)) { refreshKeyBox(); return; }
    sel.key.t = Math.max(0, r3(v));
    sortKeys(tracks.get(sel.id));
    afterEdit();
  };
  $('kfKeyVal').onchange = () => {
    if (!sel) return;
    const v = parseFloat($('kfKeyVal').value);
    if (!isFinite(v)) { refreshKeyBox(); return; }
    sel.key.v = v;
    afterEdit();
  };
  $('kfEase').onchange = () => {
    if (!sel) return;
    const v = $('kfEase').value;
    if (v === 'custom') return;
    const c = EASES[v].c;
    sel.key.e = Array.isArray(c) ? [...c] : c;
    dirty = true; needsDraw = true;
    drawEase();
  };
  const setView = (v) => {
    easeView = v;
    $('kfViewValue').setAttribute('aria-pressed', String(v === 'value'));
    $('kfViewVel').setAttribute('aria-pressed', String(v === 'velocity'));
    drawEase();
  };
  $('kfViewValue').onclick = () => setView('value');
  $('kfViewVel').onclick = () => setView('velocity');
  $('kfDel').onclick = () => {
    if (!sel) return;
    const tr = tracks.get(sel.id);
    if (tr) tr.keys.splice(tr.keys.indexOf(sel.key), 1);
    sel = null;
    afterEdit();
  };

  /* ---------------- easing graph editor ---------------- */
  let easeView = 'value';            // 'value' = easing curve (editable) | 'velocity' = its speed (read-only)
  const EY0 = -0.75, EY1 = 1.75, EPAD = 22;
  const em = (w, h) => ({
    px: (x) => EPAD + x * (w - 2 * EPAD),
    py: (y) => EPAD + (EY1 - y) / (EY1 - EY0) * (h - 2 * EPAD),
    ix: (px) => (px - EPAD) / (w - 2 * EPAD),
    iy: (py) => EY1 - (py - EPAD) / (h - 2 * EPAD) * (EY1 - EY0),
  });

  function drawEase() {
    const c = $('kfEaseCanvas');
    const f = fit(c);
    if (!f) return;
    const { g, w, h } = f;
    const m = em(w, h);
    g.fillStyle = C('--panel-2'); g.fillRect(0, 0, w, h);
    g.lineWidth = 1; g.strokeStyle = C('--line');
    g.strokeRect(m.px(0), m.py(1), m.px(1) - m.px(0), m.py(0) - m.py(1));
    g.setLineDash([4, 4]);
    g.beginPath(); g.moveTo(m.px(0), m.py(0)); g.lineTo(m.px(1), m.py(1)); g.stroke();
    g.setLineDash([]);
    g.fillStyle = C('--muted'); g.font = '11px system-ui, sans-serif';
    g.fillText('time →', w - 48, h - 6);
    g.fillText(easeView === 'velocity' ? 'speed' : 'value', 6, 14);
    if (!sel) return;
    const e = sel.key.e;
    g.lineWidth = 2.5; g.strokeStyle = C('--accent'); g.beginPath();
    if (easeView === 'velocity') {
      // Speed of the eased value (slope of the curve), scaled to fit the box. Linear = flat line.
      const N = 96, hh = 0.004, sp = [];
      let peak = 1;
      for (let i = 0; i <= N; i++) {
        const u = i / N;
        const s = (ease(e, Math.min(1, u + hh)) - ease(e, Math.max(0, u - hh))) / (Math.min(1, u + hh) - Math.max(0, u - hh));
        sp.push(e === 'hold' ? 0 : s);
        peak = Math.max(peak, Math.abs(sp[i]));
      }
      peak = Math.min(peak, 12);
      const vy = (s) => m.py(clamp(s / peak, -0.5, 1) * 1.5);   // zero speed = bottom edge of the box
      g.strokeStyle = C('--line'); g.lineWidth = 1; g.setLineDash([3, 4]);
      g.beginPath(); g.moveTo(m.px(0), vy(0)); g.lineTo(m.px(1), vy(0)); g.stroke(); g.setLineDash([]);
      g.strokeStyle = C('--accent'); g.lineWidth = 2.5; g.beginPath();
      sp.forEach((s, i) => { const x = m.px(i / N), y = vy(s); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
      g.stroke();
      g.fillStyle = C('--muted'); g.font = '11px system-ui, sans-serif';
      g.fillText('fast ↑   slow ↓   (read-only)', EPAD, h - 6);
      return;
    }
    if (e === 'hold') {
      g.moveTo(m.px(0), m.py(0)); g.lineTo(m.px(1), m.py(0)); g.lineTo(m.px(1), m.py(1));
    } else {
      for (let i = 0; i <= 96; i++) {
        const u = i / 96;
        const y = ease(e, u);
        if (i) g.lineTo(m.px(u), m.py(y)); else g.moveTo(m.px(u), m.py(y));
      }
    }
    g.stroke();
    if (Array.isArray(e)) {
      g.lineWidth = 1.5; g.strokeStyle = C('--muted'); g.beginPath();
      g.moveTo(m.px(0), m.py(0)); g.lineTo(m.px(e[0]), m.py(e[1]));
      g.moveTo(m.px(1), m.py(1)); g.lineTo(m.px(e[2]), m.py(e[3]));
      g.stroke();
      for (const [x, y] of [[e[0], e[1]], [e[2], e[3]]]) {
        g.beginPath(); g.arc(m.px(x), m.py(y), 9, 0, Math.PI * 2);
        g.fillStyle = C('--text'); g.fill();
        g.lineWidth = 2; g.strokeStyle = C('--accent'); g.stroke();
      }
    }
  }

  {
    const ec = $('kfEaseCanvas');
    let drag = -1;
    const local = (e) => { const r = ec.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height }; };
    ec.addEventListener('pointerdown', (e) => {
      if (!sel || !Array.isArray(sel.key.e) || easeView !== 'value') return;
      const { x, y, w, h } = local(e);
      const m = em(w, h), c = sel.key.e;
      const d1 = Math.hypot(x - m.px(c[0]), y - m.py(c[1]));
      const d2 = Math.hypot(x - m.px(c[2]), y - m.py(c[3]));
      if (Math.min(d1, d2) > 30) return;
      drag = d1 <= d2 ? 0 : 1;
      ec.setPointerCapture(e.pointerId);
    });
    ec.addEventListener('pointermove', (e) => {
      if (drag < 0 || !sel) return;
      const { x, y, w, h } = local(e);
      const m = em(w, h), c = sel.key.e;
      c[drag * 2] = r2(clamp(m.ix(x), 0, 1));
      c[drag * 2 + 1] = r2(clamp(m.iy(y), EY0, EY1));
      $('kfEase').value = easeName(c);
      dirty = true; needsDraw = true;
      drawEase();
    });
    const end = () => { drag = -1; };
    ec.addEventListener('pointerup', end);
    ec.addEventListener('pointercancel', end);
  }

  /* ---------------- value-over-time graph ---------------- */
  function drawCurve() {
    const c = $('kfCurve');
    const f = fit(c);
    if (!f) return false;
    const { g, w, h } = f;
    g.fillStyle = C('--panel-2'); g.fillRect(0, 0, w, h);
    const id = sel ? sel.id : $('kfProp').value;
    const tr = tracks.get(id);
    g.font = '12px system-ui, sans-serif';
    if (!tr || !tr.keys.length) {
      g.fillStyle = C('--muted'); g.fillText('No keys on this property yet.', 10, h / 2 + 4);
      return true;
    }
    const T = total();
    const N = Math.max(2, Math.floor(w / 3));
    const vals = [];
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i <= N; i++) {
      const v = sample(tr.keys, i / N * T);
      vals.push(v); lo = Math.min(lo, v); hi = Math.max(hi, v);
    }
    if (hi - lo < 1e-6) { lo -= 1; hi += 1; } else { const p = (hi - lo) * 0.12; lo -= p; hi += p; }
    const px = (t) => 8 + (t / T) * (w - 16);
    const py = (v) => h - 10 - (v - lo) / (hi - lo) * (h - 20);
    g.strokeStyle = C('--accent'); g.lineWidth = 2; g.beginPath();
    vals.forEach((v, i) => { const x = px(i / N * T), y = py(v); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
    g.stroke();
    for (const k of tr.keys) diamond(g, px(k.t), py(k.v), 5, sel && sel.key === k ? C('--accent') : C('--text'));
    g.strokeStyle = C('--danger'); g.lineWidth = 1;
    const ph = px(clamp(state.elapsed, 0, T));
    g.beginPath(); g.moveTo(ph + .5, 0); g.lineTo(ph + .5, h); g.stroke();
    g.fillStyle = C('--muted');
    g.fillText(r3(hi).toString(), 10, 14);
    g.fillText(r3(lo).toString(), 10, h - 12);
    return true;
  }

  /* ---------------- timeline ---------------- */
  function drawTimeline() {
    const c = $('tlCanvas');
    const f = fit(c);
    if (!f) return false;
    const { g, w, h } = f;
    const rs = rows();
    const contentH = rs.length * ROW_H;
    tl.scrollY = clamp(tl.scrollY, 0, Math.max(0, contentH - (h - RULER_H)));
    if (state.playing) {
      const x = xOf(state.elapsed);
      if (x > w - 30 || x < LABEL_W + LANE_PAD) tl.scrollX = Math.max(0, state.elapsed - (w - LABEL_W) * 0.1 / tl.pps);
    }
    g.fillStyle = C('--panel-2'); g.fillRect(0, 0, w, h);

    // lanes
    g.save();
    g.beginPath(); g.rect(LABEL_W, RULER_H, w - LABEL_W, h - RULER_H); g.clip();
    if (!rs.length) {
      g.fillStyle = C('--muted'); g.font = '13px system-ui, sans-serif';
      g.fillText('No keyframes yet. Open the Animate tab, pick a property and press “Set key”.', LABEL_W + 14, RULER_H + 30);
    }
    rs.forEach((r, i) => {
      const y = RULER_H + i * ROW_H - tl.scrollY;
      if (y + ROW_H < RULER_H || y > h) return;
      const isSel = sel && sel.id === r.id;
      g.fillStyle = isSel ? 'rgba(74,143,217,.12)' : (i % 2 ? C('--panel') : C('--panel-2'));
      g.fillRect(LABEL_W, y, w - LABEL_W, ROW_H);
      g.strokeStyle = C('--line'); g.lineWidth = 1;
      g.beginPath(); g.moveTo(LABEL_W, y + ROW_H - .5); g.lineTo(w, y + ROW_H - .5); g.stroke();
      const cy = y + ROW_H / 2;
      const ks = r.tr.keys;
      for (let j = 0; j < ks.length - 1; j++) {
        g.strokeStyle = C('--muted'); g.lineWidth = 2;
        g.setLineDash(ks[j].e === 'hold' ? [4, 4] : []);
        g.beginPath(); g.moveTo(xOf(ks[j].t), cy); g.lineTo(xOf(ks[j + 1].t), cy); g.stroke();
      }
      g.setLineDash([]);
      for (const k of ks) {
        const x = xOf(k.t);
        if (x < LABEL_W - 12 || x > w + 12) continue;
        const on = sel && sel.key === k;
        diamond(g, x, cy, on ? 10 : 8, on ? C('--accent') : C('--text'), on ? C('--text') : C('--panel'));
      }
    });
    const md = ctx.getDuration();
    if (md > 0) {
      g.strokeStyle = C('--muted'); g.setLineDash([3, 5]); g.lineWidth = 1;
      const x = xOf(md);
      g.beginPath(); g.moveTo(x + .5, RULER_H); g.lineTo(x + .5, h); g.stroke();
      g.setLineDash([]);
    }
    g.restore();

    // ruler
    g.fillStyle = C('--panel'); g.fillRect(LABEL_W, 0, w - LABEL_W, RULER_H);
    g.strokeStyle = C('--line'); g.lineWidth = 1;
    g.beginPath(); g.moveTo(LABEL_W, RULER_H - .5); g.lineTo(w, RULER_H - .5); g.stroke();
    g.save();
    g.beginPath(); g.rect(LABEL_W, 0, w - LABEL_W, RULER_H); g.clip();
    const steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    const step = steps.find((s) => s * tl.pps >= 72) || 300;
    g.font = '11px system-ui, sans-serif'; g.fillStyle = C('--muted'); g.strokeStyle = C('--muted');
    for (let t = Math.floor(tl.scrollX / step) * step; xOf(t) < w; t += step) {
      const x = xOf(t);
      g.beginPath(); g.moveTo(x + .5, RULER_H - 9); g.lineTo(x + .5, RULER_H - 1); g.stroke();
      g.fillText(fmtT(Math.max(0, t), step < 1), x + 4, RULER_H - 12);
    }
    g.restore();

    // track labels
    g.save();
    g.beginPath(); g.rect(0, RULER_H, LABEL_W, h - RULER_H); g.clip();
    g.fillStyle = C('--panel'); g.fillRect(0, RULER_H, LABEL_W, h - RULER_H);
    g.font = '12px system-ui, sans-serif';
    rs.forEach((r, i) => {
      const y = RULER_H + i * ROW_H - tl.scrollY;
      if (y + ROW_H < RULER_H || y > h) return;
      const isSel = sel && sel.id === r.id;
      if (isSel) { g.fillStyle = 'rgba(74,143,217,.18)'; g.fillRect(0, y, LABEL_W, ROW_H); }
      g.fillStyle = isSel ? C('--text') : C('--muted');
      let label = r.def.label;
      while (label.length > 3 && g.measureText(label).width > LABEL_W - 16) label = label.slice(0, -2) + '…';
      g.fillText(label, 10, y + ROW_H / 2 + 4);
      g.strokeStyle = C('--line');
      g.beginPath(); g.moveTo(0, y + ROW_H - .5); g.lineTo(LABEL_W, y + ROW_H - .5); g.stroke();
    });
    g.restore();
    g.fillStyle = C('--panel'); g.fillRect(0, 0, LABEL_W, RULER_H);
    g.fillStyle = C('--muted'); g.font = '11px system-ui, sans-serif';
    g.fillText('Tracks', 10, RULER_H - 10);
    g.strokeStyle = C('--line'); g.lineWidth = 1;
    g.beginPath(); g.moveTo(LABEL_W - .5, 0); g.lineTo(LABEL_W - .5, h); g.stroke();

    // playhead
    const px = xOf(state.elapsed);
    if (px >= LABEL_W) {
      g.strokeStyle = C('--danger'); g.fillStyle = C('--danger'); g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(px, 0); g.lineTo(px, h); g.stroke();
      g.beginPath(); g.moveTo(px - 7, 0); g.lineTo(px + 7, 0); g.lineTo(px, 10); g.closePath(); g.fill();
    }
    return true;
  }

  // timeline interaction
  {
    const cv = $('tlCanvas');
    let drag = null;
    const local = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const rowAt = (y) => Math.floor((y - RULER_H + tl.scrollY) / ROW_H);
    const hitKey = (x, y) => {
      const rs = rows();
      const i = rowAt(y);
      if (i < 0 || i >= rs.length) return null;
      let best = null, bd = 18;
      for (const k of rs[i].tr.keys) {
        const d = Math.abs(xOf(k.t) - x);
        if (d <= bd) { bd = d; best = { id: rs[i].id, key: k }; }
      }
      return best;
    };
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      const { x, y } = local(e);
      if (y < RULER_H && x >= LABEL_W) {
        drag = { type: 'scrub' };
        ctx.scrubStart();
        ctx.scrubTo(Math.max(0, tOf(x)));
      } else if (x < LABEL_W) {
        const rs = rows(), i = rowAt(y);
        drag = { type: 'vpan', y0: y, s0: tl.scrollY, moved: false, row: i >= 0 && i < rs.length ? rs[i].id : null };
      } else {
        const hit = hitKey(x, y);
        if (hit) { drag = { type: 'key', hit, x0: x, moved: false }; selectKey(hit.id, hit.key); }
        else drag = { type: 'hpan', x0: x, s0: tl.scrollX, moved: false };
      }
      needsDraw = true;
    });
    cv.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const { x, y } = local(e);
      if (drag.type === 'scrub') ctx.scrubTo(Math.max(0, tOf(x)));
      else if (drag.type === 'vpan') {
        if (Math.abs(y - drag.y0) > 6) drag.moved = true;
        if (drag.moved) tl.scrollY = Math.max(0, drag.s0 - (y - drag.y0));
      } else if (drag.type === 'hpan') {
        if (Math.abs(x - drag.x0) > 6) drag.moved = true;
        if (drag.moved) tl.scrollX = Math.max(0, drag.s0 - (x - drag.x0) / tl.pps);
      } else if (drag.type === 'key') {
        if (Math.abs(x - drag.x0) > 5) drag.moved = true;
        if (drag.moved) {
          drag.hit.key.t = Math.max(0, r3(tOf(x)));
          sortKeys(tracks.get(drag.hit.id));
          dirty = true;
          $('kfKeyTime').value = String(r3(drag.hit.key.t));
        }
      }
      needsDraw = true;
    });
    const finish = (e, cancelled) => {
      if (!drag) return;
      const d = drag; drag = null;
      if (d.type === 'scrub') ctx.scrubEnd();
      else if (d.type === 'vpan' && !d.moved && d.row && !cancelled) {
        if ([...$('kfProp').options].some((o) => o.value === d.row)) { $('kfProp').value = d.row; loadValue(); }
      } else if (d.type === 'hpan' && !d.moved && !cancelled) { sel = null; refreshKeyBox(); }
      else if (d.type === 'key' && d.moved) afterEdit();
      needsDraw = true;
    };
    cv.addEventListener('pointerup', (e) => finish(e, false));
    cv.addEventListener('pointercancel', (e) => finish(e, true));
  }

  const keyTimes = () => {
    const s = new Set();
    for (const tr of tracks.values()) for (const k of tr.keys) s.add(r3(k.t));
    return [...s].sort((a, b) => a - b);
  };
  $('tlPrev').onclick = () => {
    const p = keyTimes().filter((t) => t < state.elapsed - 0.002).pop();
    ctx.seekTo(p === undefined ? 0 : p);
  };
  $('tlNext').onclick = () => {
    const n = keyTimes().find((t) => t > state.elapsed + 0.002);
    if (n !== undefined) ctx.seekTo(n);
  };
  $('tlZoomIn').onclick = () => { tl.pps = clamp(tl.pps * 1.5, 8, 900); needsDraw = true; };
  $('tlZoomOut').onclick = () => { tl.pps = clamp(tl.pps / 1.5, 8, 900); needsDraw = true; };
  $('tlFit').onclick = () => {
    const w = $('tlCanvas').clientWidth;
    tl.pps = clamp((w - LABEL_W - LANE_PAD - 30) / total(), 8, 900);
    tl.scrollX = 0; needsDraw = true;
  };
  $('btnTimeline').onclick = () => {
    const on = $('timeline').classList.toggle('on');
    $('btnTimeline').setAttribute('aria-pressed', String(on));
    needsDraw = true;
  };

  const ro = new ResizeObserver(() => { needsDraw = true; drawEase(); });
  ro.observe($('tlWrap'));
  ro.observe($('kfEaseCanvas'));
  ro.observe($('kfCurve'));

  /* ---------------- public API ---------------- */
  return {
    hasKeys, endTime, isCameraDriven, applyAt,
    isDirty: () => dirty,
    markDirty: () => { dirty = true; needsDraw = true; },
    refreshProps,
    onShow: () => { needsDraw = true; drawEase(); },
    clearForNewModel() {
      for (const id of [...tracks.keys()]) if (id.startsWith('m.') || id.startsWith('mat:')) tracks.delete(id);
      sel = null;
      afterEdit();
    },
    // call every frame: redraws when playing or when something changed
    tick() {
      if (!state.playing && !needsDraw) return;
      needsDraw = false;
      const a = drawTimeline();
      const b = drawCurve();
      if (!a && !b) needsDraw = false;
    },
  };
}
