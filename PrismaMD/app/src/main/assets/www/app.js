import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MMDLoader } from 'three/addons/loaders/MMDLoader.js';
import { MMDAnimationHelper } from 'three/addons/animation/MMDAnimationHelper.js';
import { OutlineEffect } from 'three/addons/effects/OutlineEffect.js';

const LIBS = window.__LIBS;
const VFS = 'https://appassets.androidplatform.net/vfs/';
const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ *
 *  Default shader presets
 *  MMDLoader builds every material with three's MMD toon shader
 *  (toon ramp, sphere maps, per-material edge colour); OutlineEffect
 *  adds the classic MMD edge pass. "MMD Default" is on at first launch.
 * ------------------------------------------------------------------ */
const PRESETS = {
  mmd:   { label: 'MMD Default (toon + edge)', ambient: 3.0, key: 3.0, outline: true,  edgeScale: 1.0, shadow: true },
  soft:  { label: 'Soft Studio',               ambient: 4.2, key: 1.8, outline: true,  edgeScale: 0.6, shadow: true },
  bold:  { label: 'Bold Outline',              ambient: 3.0, key: 3.4, outline: true,  edgeScale: 1.9, shadow: true },
  clean: { label: 'Clean (no edge)',           ambient: 3.4, key: 2.6, outline: false, edgeScale: 1.0, shadow: true },
};

/* ------------------------------------------------------------------ *
 *  Renderer / scene
 * ------------------------------------------------------------------ */
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
const stageSize = () => ({
  w: Math.max(1, canvas.clientWidth || window.innerWidth),
  h: Math.max(1, canvas.clientHeight || window.innerHeight),
});
renderer.setSize(stageSize().w, stageSize().h, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const effect = new OutlineEffect(renderer, { defaultThickness: 0.003 });

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2a2c31);

const camera = new THREE.PerspectiveCamera(45, stageSize().w / stageSize().h, 1, 2000);
const listener = new THREE.AudioListener();
camera.add(listener);

const ambient = new THREE.AmbientLight(0xaaaaaa, PRESETS.mmd.ambient);
scene.add(ambient);

const keyLight = new THREE.DirectionalLight(0xffffff, PRESETS.mmd.key);
keyLight.position.set(-20, 40, 30);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
keyLight.shadow.camera.left = -30;
keyLight.shadow.camera.right = 30;
keyLight.shadow.camera.top = 40;
keyLight.shadow.camera.bottom = -10;
keyLight.shadow.camera.near = 1;
keyLight.shadow.camera.far = 140;
keyLight.shadow.bias = -0.0006;
scene.add(keyLight);

const floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.ShadowMaterial({ opacity: 0.35 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

const grid = new THREE.GridHelper(200, 40, 0x5a5d66, 0x3a3d44);
grid.material.transparent = true;
grid.material.opacity = 0.7;
scene.add(grid);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = true;
controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
controls.minDistance = 3;
controls.maxDistance = 300;

function fitCamera() {
  let height = 20;
  let center = new THREE.Vector3(0, 10, 0);
  if (state.mesh) {
    const box = new THREE.Box3().setFromObject(state.mesh);
    if (isFinite(box.min.y) && box.max.y - box.min.y > 0.01) {
      height = box.max.y - box.min.y;
      box.getCenter(center);
    }
  }
  const dist = (height / 2) / Math.tan(THREE.MathUtils.degToRad(22.5)) * 1.6;
  camera.fov = 45;
  camera.near = Math.max(0.1, height / 100);
  camera.far = Math.max(2000, height * 100);
  camera.up.set(0, 1, 0);
  camera.updateProjectionMatrix();
  camera.position.set(center.x, center.y + height * 0.05, center.z + dist);
  controls.target.copy(center);
  controls.update();
}

/* ------------------------------------------------------------------ *
 *  State
 * ------------------------------------------------------------------ */
const state = {
  mesh: null,
  vmdModel: null,     // parsed (merged) VMD data for the model
  vmdCamera: null,    // parsed (merged) VMD data for the camera
  modelClip: null,
  cameraClip: null,
  audio: null,
  playing: false,
  physicsReady: false,
};

const manager = new THREE.LoadingManager();
const loader = new MMDLoader(manager);
let helper = new MMDAnimationHelper({ afterglow: 2.0 });

// Virtual file system: ZIP contents and picked motion files, looked up by a normalised path.
const modelFiles = new Map();
const baseNames = new Map();
const motionFiles = new Map();
let blobUrls = [];

function norm(p) {
  let s = p;
  try { s = decodeURIComponent(p); } catch (_) { /* keep raw */ }
  s = s.replace(/\\/g, '/').normalize('NFC');
  const out = [];
  for (const part of s.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { out.pop(); continue; }
    out.push(part);
  }
  return out.join('/').toLowerCase();
}

manager.setURLModifier((url) => {
  if (!url.startsWith(VFS)) return url;
  const key = norm(url.slice(VFS.length).split('?')[0]);
  return modelFiles.get(key)
    || motionFiles.get(key)
    || baseNames.get(key.split('/').pop())
    || url;
});

/* ------------------------------------------------------------------ *
 *  UI helpers
 * ------------------------------------------------------------------ */
// Status text lives in the transport bar (like a DAW status line).
function toast(msg, isError = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = isError ? 'err' : '';
}

function setPlayButton() {
  $('icoPlay').style.display = state.playing ? 'none' : '';
  $('icoPause').style.display = state.playing ? '' : 'none';
}

// Time readout
state.elapsed = 0;
function getDuration() {
  return Math.max(
    state.modelClip ? state.modelClip.duration : 0,
    state.cameraClip ? state.cameraClip.duration : 0,
    state.audio && state.audio.buffer ? state.audio.buffer.duration : 0,
  );
}
function fmt(t) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return String(m).padStart(2, '0') + ':' + s.toFixed(1).padStart(4, '0');
}
let lastTime = '';
function updateTimeUi() {
  const dur = getDuration();
  const txt = fmt(Math.min(state.elapsed, dur || state.elapsed)) + ' / ' + fmt(dur);
  if (txt !== lastTime) {
    lastTime = txt;
    $('time').textContent = txt;
    $('progress').firstElementChild.style.width = dur > 0 ? Math.min(100, state.elapsed / dur * 100) + '%' : '0%';
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.appendChild(s);
  });
}

/* ------------------------------------------------------------------ *
 *  Optional engines: JSZip (required for model ZIPs) and ammo.js (physics)
 * ------------------------------------------------------------------ */
const zipReady = loadScript(LIBS.jszip).catch((e) => {
  toast('ZIP support failed to load: ' + e.message, true);
});

const physicsInit = (async () => {
  try {
    await loadScript(LIBS.three + 'examples/jsm/libs/ammo.wasm.js');
    // eslint-disable-next-line no-undef
    window.Ammo = await Ammo({ locateFile: (f) => LIBS.three + 'examples/jsm/libs/' + f });
    state.physicsReady = true;
  } catch (e) {
    console.warn('Physics unavailable:', e);
    state.physicsReady = false;
    $('optPhysics').checked = false;
    $('optPhysics').disabled = true;
  }
})();

/* ------------------------------------------------------------------ *
 *  Animation graph
 * ------------------------------------------------------------------ */
function rebuildAnimation() {
  const mesh = state.mesh;
  if (mesh && helper.meshes.includes(mesh)) helper.remove(mesh);
  if (helper.camera === camera) helper.remove(camera);
  if (state.audio && state.audio.isPlaying) state.audio.stop();
  state.elapsed = 0;

  if (mesh) {
    const params = { physics: state.physicsReady && $('optPhysics').checked };
    if (state.modelClip) params.animation = state.modelClip;
    helper.add(mesh, params);
  }
  if (state.cameraClip) {
    helper.add(camera, { animation: state.cameraClip });
    helper.enable('cameraAnimation', $('optCam').checked);
  }
  syncCameraMode();
}

function cameraMotionActive() {
  return !!state.cameraClip && $('optCam').checked;
}

function syncCameraMode() {
  const active = cameraMotionActive();
  controls.enabled = !active;
  if (helper.camera === camera) helper.enable('cameraAnimation', $('optCam').checked);
}

function buildClips() {
  state.modelClip = (state.mesh && state.vmdModel)
    ? loader.animationBuilder.build(state.vmdModel, state.mesh) : null;
  state.cameraClip = state.vmdCamera
    ? loader.animationBuilder.buildCameraAnimation(state.vmdCamera) : null;
}

/* ------------------------------------------------------------------ *
 *  Loading: model ZIP
 * ------------------------------------------------------------------ */
function disposeMesh(mesh) {
  scene.remove(mesh);
  mesh.geometry?.dispose();
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const m of mats) {
    if (!m) continue;
    for (const k of Object.keys(m)) {
      const v = m[k];
      if (v && v.isTexture) v.dispose();
    }
    if (m.uniforms) {
      for (const u of Object.values(m.uniforms)) if (u.value && u.value.isTexture) u.value.dispose();
    }
    m.dispose();
  }
}

function clearModelFiles() {
  for (const u of blobUrls) URL.revokeObjectURL(u);
  blobUrls = [];
  modelFiles.clear();
  baseNames.clear();
}

async function loadModelZip(file) {
  await zipReady;
  if (typeof JSZip === 'undefined') { toast('ZIP support is not available.', true); return; }
  toast('Reading ZIP…', false, true);

  const zip = await JSZip.loadAsync(await file.arrayBuffer(), {
    // Windows-made MMD ZIPs usually store Shift-JIS names without the UTF-8 flag.
    decodeFileName: (bytes) => {
      const u8 = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
      try { return new TextDecoder('shift_jis', { fatal: true }).decode(u8); }
      catch (_) { return new TextDecoder('utf-8').decode(u8); }
    },
  });

  clearModelFiles();
  let pmx = null, pmd = null;
  const entries = [];
  zip.forEach((path, entry) => {
    if (!entry.dir && !/(^|\/)__MACOSX\//.test(path) && !/(^|\/)\.DS_Store$/.test(path)) entries.push([path, entry]);
  });
  if (!entries.length) throw new Error('The ZIP is empty.');

  let done = 0;
  for (const [path, entry] of entries) {
    const blob = await entry.async('blob');
    const url = URL.createObjectURL(blob);
    blobUrls.push(url);
    const key = norm(path);
    modelFiles.set(key, url);
    const base = key.split('/').pop();
    if (!baseNames.has(base)) baseNames.set(base, url);
    if (!pmx && /\.pmx$/i.test(path)) pmx = path;
    if (!pmd && /\.pmd$/i.test(path)) pmd = path;
    if (++done % 10 === 0) toast(`Unpacking ${done}/${entries.length}…`, false, true);
  }

  const modelPath = pmx || pmd;
  if (!modelPath) throw new Error('No .pmx or .pmd file found in the ZIP.');

  toast('Loading model…', false, true);
  const url = VFS + modelPath.split('/').map(encodeURIComponent).join('/');
  const mesh = await new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject));

  if (state.mesh) {
    if (helper.meshes.includes(state.mesh)) helper.remove(state.mesh);
    disposeMesh(state.mesh);
  }
  state.mesh = mesh;
  mesh.castShadow = true;
  mesh.frustumCulled = false;
  scene.add(mesh);
  captureMaterials(mesh);

  await physicsInit;
  buildClips();
  rebuildAnimation();
  applyPreset($('preset').value, false);
  fitCamera();
  $('empty').classList.add('hidden');
  state.playing = false;
  setPlayButton();
  buildOutliner(modelPath.split('/').pop());
  toast('Model loaded: ' + modelPath.split('/').pop());
}

/* ------------------------------------------------------------------ *
 *  Loading: VMD (motion / camera) and VPD (pose)
 * ------------------------------------------------------------------ */
const loadVmd = (urls) => new Promise((resolve, reject) => loader.loadVMD(urls, resolve, undefined, reject));
const loadVpd = (url) => new Promise((resolve, reject) => loader.loadVPD(url, false, resolve, undefined, reject));

async function loadMotionFiles(files) {
  const vmdFiles = files.filter((f) => /\.vmd$/i.test(f.name));
  const vpdFiles = files.filter((f) => /\.vpd$/i.test(f.name));
  if (!vmdFiles.length && !vpdFiles.length) { toast('Pick .vmd or .vpd files.', true); return; }

  if (vpdFiles.length) {
    if (!state.mesh) { toast('Load a model first, then apply the pose.', true); }
    else {
      const f = vpdFiles[0];
      const key = 'pose/' + norm(f.name);
      const u = URL.createObjectURL(f);
      blobUrls.push(u);
      motionFiles.set(key, u);
      const vpd = await loadVpd(VFS + 'pose/' + encodeURIComponent(f.name));
      state.playing = false;
      setPlayButton();
      if (helper.meshes.includes(state.mesh)) helper.remove(state.mesh);
      state.modelClip = null;
      state.vmdModel = null;
      helper.add(state.mesh, { physics: false });
      helper.pose(state.mesh, vpd, { resetPose: true });
      toast('Pose applied: ' + f.name);
    }
  }
  if (!vmdFiles.length) return;

  toast('Reading motion…', false, true);
  const modelUrls = [];
  const cameraUrls = [];
  let i = 0;
  for (const f of vmdFiles) {
    const name = `motion/${Date.now()}_${i++}_${f.name}`;
    const blobUrl = URL.createObjectURL(f);
    blobUrls.push(blobUrl);
    motionFiles.set(norm(name), blobUrl);
    const vfsUrl = VFS + name.split('/').map(encodeURIComponent).join('/');
    const vmd = await loadVmd([vfsUrl]);
    const m = vmd.metadata || {};
    const isCameraOnly = (m.cameraCount || 0) > 0 && !(m.motionCount > 0) && !(m.morphCount > 0);
    (isCameraOnly ? cameraUrls : modelUrls).push(vfsUrl);
  }

  if (modelUrls.length) state.vmdModel = await loadVmd(modelUrls);
  if (cameraUrls.length) state.vmdCamera = await loadVmd(cameraUrls);

  buildClips();
  rebuildAnimation();
  state.playing = false;
  setPlayButton();

  const parts = [];
  if (modelUrls.length) parts.push(state.mesh ? 'model motion' : 'model motion (waiting for a model)');
  if (cameraUrls.length) parts.push('camera motion');
  toast('Loaded ' + parts.join(' + ') + '. Press Play.');
}

/* ------------------------------------------------------------------ *
 *  Loading: audio
 * ------------------------------------------------------------------ */
async function loadAudioFile(file) {
  toast('Decoding audio…', false, true);
  const url = URL.createObjectURL(file);
  blobUrls.push(url);
  const buffer = await new Promise((resolve, reject) => new THREE.AudioLoader().load(url, resolve, undefined, reject));
  if (state.audio) { if (state.audio.isPlaying) state.audio.stop(); }
  const audio = new THREE.Audio(listener);
  audio.setBuffer(buffer);
  audio.setLoop(false);
  audio.setVolume(1.0);
  state.audio = audio;
  toast('Audio ready: ' + file.name);
}

/* ------------------------------------------------------------------ *
 *  Shader preset / options
 * ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ *
 *  Materials: outliner, visibility and editing
 * ------------------------------------------------------------------ */
const matMeta = { selected: -1 };

const EYE_PATH = 'M12 5C7 5 2.7 8.1 1 12c1.7 3.9 6 7 11 7s9.3-3.1 11-7c-1.7-3.9-6-7-11-7zm0 11a4 4 0 110-8 4 4 0 010 8zm0-6a2 2 0 100 4 2 2 0 000-4z';
const EYE_ON = `<svg class="i" viewBox="0 0 24 24"><path d="${EYE_PATH}"/></svg>`;
const EYE_OFF = `<svg class="i" viewBox="0 0 24 24"><path opacity=".45" d="${EYE_PATH}"/><path d="M4 4l16 16" stroke="currentColor" stroke-width="2" fill="none"/></svg>`;

const getMats = () => {
  const m = state.mesh && state.mesh.material;
  return Array.isArray(m) ? m : (m ? [m] : []);
};
const matColorObj = (m) => m.color || (m.uniforms && m.uniforms.diffuse && m.uniforms.diffuse.value) || null;
const matOpacityGet = (m) => (m.uniforms && m.uniforms.opacity ? m.uniforms.opacity.value : m.opacity);
const matLabel = (m, i) => (m.name && m.name.trim() ? m.name.trim() : `Material ${i + 1}`);
const matOutlineParams = (m) => (m.userData && m.userData.outlineParameters) || null;

function matOpacitySet(m, v) {
  m.opacity = v;
  if (m.uniforms && m.uniforms.opacity) m.uniforms.opacity.value = v;
  const wantTransparent = v < 1 || m.userData._orig.transparent;
  if (m.transparent !== wantTransparent) { m.transparent = wantTransparent; m.needsUpdate = true; }
}

// Edge lines follow both the material's visibility and its own outline switch.
function syncOutline(m) {
  const op = matOutlineParams(m);
  if (op) op.visible = !!(m.visible && m.userData._outline);
}

function captureMaterials(mesh) {
  matMeta.selected = -1;
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const m of mats) {
    const op = matOutlineParams(m);
    const col = matColorObj(m);
    m.userData._orig = {
      hex: col ? col.getHex() : 0xffffff,
      opacity: matOpacityGet(m),
      transparent: m.transparent,
      side: m.side,
      visible: m.visible,
    };
    if (op) {
      op._base = op.thickness > 0 ? op.thickness : 0.003;
      op._origVisible = op.visible !== false;
      m.userData._outline = op._origVisible;
    } else {
      m.userData._outline = false;
    }
    m.userData._edgeMul = 1;
  }
}

function applyEdgeScale(scale) {
  for (const m of getMats()) {
    const op = matOutlineParams(m);
    if (op && op._base !== undefined) op.thickness = op._base * scale * (m.userData._edgeMul || 1);
  }
}

function renderMatList() {
  const list = $('matList');
  const keepScroll = list.scrollTop;
  list.textContent = '';
  const mats = getMats();
  $('matEmpty').style.display = mats.length ? 'none' : '';
  const f = $('matFilter').value.trim().toLowerCase();
  mats.forEach((m, i) => {
    const label = matLabel(m, i);
    if (f && !label.toLowerCase().includes(f)) return;
    const li = document.createElement('li');
    li.dataset.i = String(i);
    li.className = (i === matMeta.selected ? 'sel ' : '') + (m.visible ? '' : 'off');

    const eye = document.createElement('button');
    eye.className = 'eye' + (m.visible ? '' : ' off');
    eye.setAttribute('aria-label', (m.visible ? 'Hide ' : 'Show ') + label);
    eye.innerHTML = m.visible ? EYE_ON : EYE_OFF;
    eye.onclick = (e) => { e.stopPropagation(); setMaterialVisible(i, !m.visible); };

    const sw = document.createElement('span');
    sw.className = 'swatch';
    const c = matColorObj(m);
    sw.style.background = c ? '#' + c.getHexString() : '#888';

    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = label;

    li.append(eye, sw, nm);
    li.onclick = () => selectMaterial(i);
    list.appendChild(li);
  });
  list.scrollTop = keepScroll;
}

function loadPropsUi() {
  const mats = getMats();
  const i = matMeta.selected;
  const m = mats[i];
  $('propsEmpty').style.display = m ? 'none' : '';
  $('propsBody').style.display = m ? '' : 'none';
  $('propsTitle').textContent = m ? matLabel(m, i) : 'Material';
  if (!m) return;
  const c = matColorObj(m);
  $('matVisible').checked = m.visible;
  $('matColor').value = c ? '#' + c.getHexString() : '#ffffff';
  $('matColor').disabled = !c;
  const o = matOpacityGet(m);
  $('matOpacity').value = String(o);
  $('matOpacityVal').textContent = Math.round(o * 100) + '%';
  $('matOutline').checked = !!m.userData._outline;
  $('matOutline').disabled = !matOutlineParams(m);
  $('matEdge').value = String(m.userData._edgeMul);
  $('matEdge').disabled = !matOutlineParams(m);
  $('matEdgeVal').textContent = m.userData._edgeMul.toFixed(1) + '×';
  $('matDouble').checked = m.side === THREE.DoubleSide;
}

function selectMaterial(i) {
  matMeta.selected = i;
  renderMatList();
  loadPropsUi();
  const row = $('matList').querySelector('li.sel');
  if (row) row.scrollIntoView({ block: 'nearest' });
}

function buildOutliner(name) {
  $('modelName').textContent = name || 'Materials';
  $('matFilter').value = '';
  renderMatList();
  loadPropsUi();
}

function setMaterialVisible(i, visible) {
  const m = getMats()[i];
  if (!m) return;
  m.visible = visible;
  syncOutline(m);
  renderMatList();
  if (i === matMeta.selected) $('matVisible').checked = visible;
}

function setAllVisible(visible) {
  for (const m of getMats()) { m.visible = visible; syncOutline(m); }
  renderMatList();
  loadPropsUi();
}

function soloSelected() {
  const mats = getMats();
  if (matMeta.selected < 0) { toast('Select a material first.', true); return; }
  mats.forEach((m, i) => { m.visible = i === matMeta.selected; syncOutline(m); });
  renderMatList();
  loadPropsUi();
}

function resetSelectedMaterial() {
  const m = getMats()[matMeta.selected];
  if (!m) return;
  const o = m.userData._orig;
  const c = matColorObj(m);
  if (c) c.setHex(o.hex);
  matOpacitySet(m, o.opacity);
  m.transparent = o.transparent;
  m.side = o.side;
  m.visible = o.visible;
  const op = matOutlineParams(m);
  m.userData._outline = op ? op._origVisible : false;
  m.userData._edgeMul = 1;
  m.needsUpdate = true;
  syncOutline(m);
  applyEdgeScale(currentEdgeScale);
  renderMatList();
  loadPropsUi();
}

function pickMaterialAt(clientX, clientY) {
  if (!state.mesh) return;
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -(((clientY - rect.top) / rect.height) * 2 - 1),
  );
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, camera);
  let hits = [];
  try { hits = ray.intersectObject(state.mesh, false); } catch (e) { console.warn('pick failed', e); return; }
  const mats = getMats();
  for (const h of hits) {
    const idx = h.face ? h.face.materialIndex : 0;
    const m = mats[idx];
    if (m && m.visible) { selectMaterial(idx); return; }
  }
  selectMaterial(-1);
}

function applyPreset(name, updateControls = true) {
  const p = PRESETS[name] || PRESETS.mmd;
  ambient.intensity = p.ambient;
  keyLight.intensity = p.key;
  if (updateControls) {
    $('optOutline').checked = p.outline;
    $('optShadow').checked = p.shadow;
  }
  currentEdgeScale = p.edgeScale;
  applyOptions();
}

let currentEdgeScale = 1.0;
function applyOptions() {
  effect.enabled = $('optOutline').checked;
  applyEdgeScale(currentEdgeScale);
  const shadows = $('optShadow').checked;
  keyLight.castShadow = shadows;
  floor.visible = shadows;
  grid.visible = $('optGrid').checked;
  if (state.mesh) state.mesh.castShadow = shadows;
}

/* ------------------------------------------------------------------ *
 *  Playback
 * ------------------------------------------------------------------ */
async function play() {
  if (!state.mesh && !state.cameraClip) { toast('Load a model first.', true); return; }
  try { await listener.context.resume(); } catch (_) { /* ignore */ }
  state.playing = true;
  if (state.audio && !state.audio.isPlaying) state.audio.play();
  setPlayButton();
}

function pause() {
  state.playing = false;
  if (state.audio && state.audio.isPlaying) state.audio.pause();
  setPlayButton();
}

async function restart() {
  if (!state.mesh) return;
  rebuildAnimation();
  await play();
}

/* ------------------------------------------------------------------ *
 *  Wiring
 * ------------------------------------------------------------------ */
function guard(fn) {
  return async (...args) => {
    try { await fn(...args); }
    catch (e) { console.error(e); toast(String(e && e.message ? e.message : e), true); }
  };
}

for (const [key, p] of Object.entries(PRESETS)) {
  const o = document.createElement('option');
  o.value = key;
  o.textContent = p.label;
  $('preset').appendChild(o);
}

$('btnModel').onclick = () => $('inModel').click();
$('btnMotion').onclick = () => $('inMotion').click();
$('btnAudio').onclick = () => $('inAudio').click();

$('inModel').onchange = guard(async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) await loadModelZip(f); });
$('inMotion').onchange = guard(async (e) => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) await loadMotionFiles(fs); });
$('inAudio').onchange = guard(async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) await loadAudioFile(f); });

$('btnPlay').onclick = guard(async () => { if (state.playing) pause(); else await play(); });
$('btnRestart').onclick = guard(restart);
$('btnFit').onclick = () => { $('optCam').checked = false; syncCameraMode(); fitCamera(); };
$('gear').onclick = () => {
  const hidden = $('dock').classList.toggle('hidden');
  $('gear').setAttribute('aria-pressed', String(!hidden));
};

// Dock tabs
for (const b of document.querySelectorAll('.tabs button')) {
  b.onclick = () => {
    for (const x of document.querySelectorAll('.tabs button')) x.setAttribute('aria-selected', String(x === b));
    $('tab-scene').classList.toggle('on', b.dataset.tab === 'scene');
    $('tab-render').classList.toggle('on', b.dataset.tab === 'render');
  };
}

// Outliner + material editor
$('matFilter').oninput = renderMatList;
$('btnShowAll').onclick = () => setAllVisible(true);
$('btnHideAll').onclick = () => setAllVisible(false);
$('btnSolo').onclick = soloSelected;
$('matReset').onclick = resetSelectedMaterial;

const selMat = () => getMats()[matMeta.selected];

$('matVisible').onchange = () => setMaterialVisible(matMeta.selected, $('matVisible').checked);
$('matColor').oninput = () => {
  const m = selMat(); const c = m && matColorObj(m);
  if (!c) return;
  c.set($('matColor').value);
  const sw = $('matList').querySelector('li.sel .swatch');
  if (sw) sw.style.background = $('matColor').value;
};
$('matOpacity').oninput = () => {
  const m = selMat(); if (!m) return;
  const v = parseFloat($('matOpacity').value);
  matOpacitySet(m, v);
  $('matOpacityVal').textContent = Math.round(v * 100) + '%';
};
$('matOutline').onchange = () => {
  const m = selMat(); if (!m) return;
  m.userData._outline = $('matOutline').checked;
  syncOutline(m);
  applyEdgeScale(currentEdgeScale);
};
$('matEdge').oninput = () => {
  const m = selMat(); if (!m) return;
  m.userData._edgeMul = parseFloat($('matEdge').value);
  $('matEdgeVal').textContent = m.userData._edgeMul.toFixed(1) + '×';
  applyEdgeScale(currentEdgeScale);
};
$('matDouble').onchange = () => {
  const m = selMat(); if (!m) return;
  m.side = $('matDouble').checked ? THREE.DoubleSide : m.userData._orig.side;
  m.needsUpdate = true;
};

// Tap (not drag, not multi-touch) on the model selects the material under the finger.
{
  let down = null, pointers = 0, maxPointers = 0;
  const finish = (e, canTap) => {
    pointers = Math.max(0, pointers - 1);
    if (pointers > 0) return;
    if (canTap && down && maxPointers === 1
        && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 8
        && performance.now() - down.t < 350) {
      pickMaterialAt(e.clientX, e.clientY);
    }
    down = null; maxPointers = 0;
  };
  canvas.addEventListener('pointerdown', (e) => {
    pointers++; maxPointers = Math.max(maxPointers, pointers);
    if (pointers === 1) down = { x: e.clientX, y: e.clientY, t: performance.now() };
  });
  canvas.addEventListener('pointerup', (e) => finish(e, true));
  canvas.addEventListener('pointercancel', (e) => finish(e, false));
}

$('preset').onchange = () => applyPreset($('preset').value, true);
$('optOutline').onchange = applyOptions;
$('optShadow').onchange = applyOptions;
$('optGrid').onchange = applyOptions;
$('optPhysics').onchange = guard(async () => { if (state.mesh) { const was = state.playing; rebuildAnimation(); state.playing = was; } });
$('optCam').onchange = () => { syncCameraMode(); if (!$('optCam').checked) fitCamera(); };

function onResize() {
  const { w, h } = stageSize();
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
  effect.setSize(w, h);
}
window.addEventListener('resize', onResize);
new ResizeObserver(onResize).observe(canvas.parentElement);
onResize();

document.addEventListener('visibilitychange', () => { if (document.hidden && state.playing) pause(); });

/* ------------------------------------------------------------------ *
 *  Main loop
 * ------------------------------------------------------------------ */
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (state.playing) { helper.update(dt); state.elapsed += dt; }
  updateTimeUi();
  if (!cameraMotionActive()) controls.update();
  effect.render(scene, camera);
});

applyPreset('mmd', true);
fitCamera();
window.__prismamd = { state, scene, camera, renderer, loader, helper };
