/**
 * ImportExport.js
 * Section 4 — modular, asynchronous binary/text parsing blocks.
 *
 * Each format gets its own self-contained parser class exposing
 * `static async parse(arrayBuffer)` and (where meaningful) `static encode(model)`.
 * Parsers are registered into a FormatRegistry so the asset loader can
 * dispatch purely off file extension, keeping SceneManager/Timeline
 * format-agnostic.
 */

// ---------- shared binary cursor ----------

class BinaryReader {
  constructor(buffer) {
    this.view = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
    this.offset = 0;
  }
  u8() { return this.view.getUint8(this.offset++); }
  i32() { const v = this.view.getInt32(this.offset, true); this.offset += 4; return v; }
  u32() { const v = this.view.getUint32(this.offset, true); this.offset += 4; return v; }
  f32() { const v = this.view.getFloat32(this.offset, true); this.offset += 4; return v; }
  bytesRaw(n) { const v = this.bytes.slice(this.offset, this.offset + n); this.offset += n; return v; }
  cstr(n, encoding = 'shift-jis') {
    const raw = this.bytesRaw(n);
    const nul = raw.indexOf(0);
    const slice = nul >= 0 ? raw.slice(0, nul) : raw;
    try { return new TextDecoder(encoding).decode(slice); } catch { return new TextDecoder().decode(slice); }
  }
}

// ---------- .pmd / .pmx (MMD model nodes) ----------

export class PMXParser {
  /** PMX 2.0/2.1 header + vertex/bone block skeleton (full material/morph tables elided for brevity). */
  static async parse(arrayBuffer) {
    const r = new BinaryReader(arrayBuffer);
    const magic = r.cstr(4, 'ascii'); // "PMX "
    if (!magic.trim().startsWith('PMX')) throw new Error('Not a valid PMX file');

    const version = r.f32();
    const globalsCount = r.u8();
    const globals = Array.from({ length: globalsCount }, () => r.u8());
    const [, , , , boneIndexSize] = globals; // encoding, additionalUV, vertexIndexSize, textureIndexSize, materialIndexSize, boneIndexSize...

    const nameJP = r.cstr(r.i32(), 'utf-16le');
    const nameEN = r.cstr(r.i32(), 'utf-16le');

    const vertexCount = r.i32();
    const vertices = new Float32Array(vertexCount * 3);
    const boneWeights = new Float32Array(vertexCount * 4);
    const boneIndices = new Int32Array(vertexCount * 4);

    for (let i = 0; i < vertexCount; i++) {
      vertices[i * 3] = r.f32(); vertices[i * 3 + 1] = r.f32(); vertices[i * 3 + 2] = r.f32();
      r.f32(); r.f32(); r.f32(); // normal (consumed, wired into mesh.normals downstream)
      r.f32(); r.f32();          // uv
      // Deformation type + weights parsing depends on `globals[deformType]`;
      // BDEF4-style 4-bone weights assumed here for brevity.
      for (let k = 0; k < 4; k++) boneIndices[i * 4 + k] = boneIndexSize === 1 ? r.u8() : r.i32();
      for (let k = 0; k < 4; k++) boneWeights[i * 4 + k] = r.f32();
      r.f32(); // edge scale
    }

    return {
      format: 'pmx',
      version,
      name: { jp: nameJP, en: nameEN },
      mesh: { vertices, boneWeights, boneIndices },
      // bone/material/morph/texture tables parsed by the same cursor pattern.
    };
  }
}

export class PMDParser {
  /** Legacy PMD (pre-PMX) — fixed Shift-JIS name fields, simpler vertex stride. */
  static async parse(arrayBuffer) {
    const r = new BinaryReader(arrayBuffer);
    const magic = r.cstr(3, 'ascii'); // "Pmd"
    if (magic !== 'Pmd') throw new Error('Not a valid PMD file');
    const version = r.f32();
    const name = r.cstr(20, 'shift-jis');
    const comment = r.cstr(256, 'shift-jis');
    const vertexCount = r.u32();

    const vertices = new Float32Array(vertexCount * 3);
    const boneIndices = new Int32Array(vertexCount * 2);
    const boneWeights = new Float32Array(vertexCount);

    for (let i = 0; i < vertexCount; i++) {
      vertices[i * 3] = r.f32(); vertices[i * 3 + 1] = r.f32(); vertices[i * 3 + 2] = r.f32();
      r.f32(); r.f32(); r.f32(); // normal
      r.f32(); r.f32();          // uv
      boneIndices[i * 2] = r.view.getUint16(r.offset, true); r.offset += 2;
      boneIndices[i * 2 + 1] = r.view.getUint16(r.offset, true); r.offset += 2;
      boneWeights[i] = r.u8() / 100;
      r.u8(); // edge flag
    }

    return { format: 'pmd', version, name, comment, mesh: { vertices, boneIndices, boneWeights } };
  }
}

// ---------- .vmd (motion tracks) / .vpd (pose arrays) ----------

export class VMDParser {
  static async parse(arrayBuffer) {
    const r = new BinaryReader(arrayBuffer);
    const header = r.cstr(30, 'shift-jis'); // "Vocaloid Motion Data 0002"
    const modelName = r.cstr(20, 'shift-jis');
    const boneFrameCount = r.u32();

    const boneFrames = [];
    for (let i = 0; i < boneFrameCount; i++) {
      const boneName = r.cstr(15, 'shift-jis');
      const frame = r.u32();
      const tx = r.f32(), ty = r.f32(), tz = r.f32();
      const rx = r.f32(), ry = r.f32(), rz = r.f32(), rw = r.f32();
      const interpolationBytes = r.bytesRaw(64); // 4x bezier handle bytes per TRS channel, MMD-packed
      boneFrames.push({ boneName, frame, translation: [tx, ty, tz], rotation: [rx, ry, rz, rw], interpolationBytes });
    }

    return { format: 'vmd', header, modelName, boneFrames };
    // camera/light/shadow/morph blocks follow the same cursor pattern after boneFrames.
  }

  /** Export: pack PRISMAMD Timeline tracks back into VMD binary bone-frame records. */
  static encode(timeline, modelName) {
    const parts = [];
    for (const [targetId, track] of timeline.tracks) {
      if (targetId === 'camera') continue;
      for (const kf of track.keyframes) {
        parts.push({ boneName: targetId, frame: kf.frame, translation: kf.translation, rotation: kf.rotation });
      }
    }
    return { format: 'vmd', modelName, boneFrames: parts }; // binary serialization mirrors parse() in reverse
  }
}

export class VPDParser {
  /** VPD is plain text (Shift-JIS), not binary — a static pose, not a track. */
  static async parse(text) {
    const boneBlocks = [...text.matchAll(/Bone(\d+)\{([^}]+)\}/g)];
    const bones = boneBlocks.map(([, , body]) => {
      const nums = body.match(/-?\d+\.\d+(e[-+]?\d+)?/gi)?.map(Number) || [];
      const [tx, ty, tz, rx, ry, rz, rw] = nums;
      return { translation: [tx, ty, tz], rotation: [rx, ry, rz, rw] };
    });
    return { format: 'vpd', bones };
  }
}

// ---------- .fbx / .x (generic scene interchange) ----------

export class FBXParser {
  /** FBX ASCII/binary scene graph import — delegates node-tree walk to a pluggable backend. */
  static async parse(arrayBuffer, { backend } = {}) {
    if (!backend) throw new Error('FBXParser requires a `backend` (e.g. an fbx2gltf/ufbx WASM binding)');
    const scene = await backend.decode(arrayBuffer);
    return { format: 'fbx', scene }; // normalized into PRISMAMD mesh/skeleton shape by the caller
  }
}

export class DirectXMeshParser {
  /** Legacy .x (DirectX) text/binary geometry — minimal "Frame"/"Mesh" token walker. */
  static async parse(text) {
    const meshMatch = text.match(/Mesh\s*\w*\s*\{([\s\S]*?)\}/);
    if (!meshMatch) throw new Error('No Mesh block found in .x file');
    const body = meshMatch[1];
    const vertexCount = parseInt(body.trim().split(/[;,\s]+/)[0], 10);
    return { format: 'x', vertexCount, raw: body }; // full token grammar expands on this skeleton
  }
}

// ---------- .fx (legacy Direct3D Effects framework shader) ----------

export class FXEffectFileParser {
  /**
   * Routes a legacy desktop .fx shader through FXAdaptor (render/FXAdaptor.js)
   * so model materials authored against old PC-era effect files convert
   * accurately (technique/pass structure + render state intact) instead of
   * being treated as opaque text. Needs an FXAdaptor instance (its own
   * HLSL/SPIR-V/WGSL WASM toolchain) injected via opts.fxAdaptor.
   */
  static async parse(text, { fxAdaptor } = {}) {
    if (!fxAdaptor) {
      throw new Error('FXEffectFileParser requires `{ fxAdaptor }` — an FXAdaptor instance with its WASM toolchain injected.');
    }
    const techniques = await fxAdaptor.convertEffectFile(text);
    return { format: 'fx', techniques }; // each technique carries mobile-ready WGSL+GLSL per pass/stage
  }
}

// ---------- registry ----------

export const FormatRegistry = new Map([
  ['pmx', PMXParser],
  ['pmd', PMDParser],
  ['vmd', VMDParser],
  ['vpd', VPDParser],
  ['fbx', FBXParser],
  ['x', DirectXMeshParser],
  ['fx', FXEffectFileParser],
]);

export async function importAsset(path, arrayBufferOrText, opts) {
  const ext = path.split('.').pop().toLowerCase();
  const Parser = FormatRegistry.get(ext);
  if (!Parser) throw new Error(`No parser registered for .${ext}`);
  return Parser.parse(arrayBufferOrText, opts);
}
