/**
 * SceneManager.js
 * Section 2 — multi-model scene graph. No single-model assumptions anywhere:
 * every model is an isolated ModelInstance with its own skeleton, bone
 * matrices, and vertex buffers, driven sequentially each frame.
 */

import { mat4Identity, Vec3, Quat } from './MathUtils.js';

let _nextId = 1;

export class Bone {
  constructor(name, parentIndex = -1) {
    this.name = name;
    this.parentIndex = parentIndex;
    this.localTranslation = new Vec3();
    this.localRotation = new Quat();
    this.localScale = new Vec3(1, 1, 1);      // non-uniform for squash & stretch (section 5)
    this.worldMatrix = mat4Identity();
    this.ikEnabled = true;                     // per-bone IK toggle, gated globally by PerformanceController
  }
}

export class Skeleton {
  constructor(bones = []) {
    /** @type {Bone[]} flat array, parentIndex references earlier siblings */
    this.bones = bones;
  }

  findBone(name) {
    return this.bones.find(b => b.name === name) || null;
  }

  /** Evaluate local TRS -> world matrices in hierarchy order (parents precede children). */
  evaluateWorldMatrices(composeTRS, mat4Multiply) {
    for (let i = 0; i < this.bones.length; i++) {
      const bone = this.bones[i];
      const local = composeTRS(bone.localTranslation, bone.localRotation, bone.localScale);
      if (bone.parentIndex >= 0) {
        mat4Multiply(this.bones[bone.parentIndex].worldMatrix, local, bone.worldMatrix);
      } else {
        bone.worldMatrix.set(local);
      }
    }
  }
}

export class ModelInstance {
  /**
   * @param {object} params
   * @param {string} params.name
   * @param {Skeleton} params.skeleton
   * @param {object} params.mesh  -- { vertices, normals, uvs, indices, boneWeights, boneIndices, materials }
   */
  constructor({ name, skeleton, mesh }) {
    this.id = _nextId++;
    this.name = name;
    this.skeleton = skeleton;
    this.mesh = mesh;

    this.transform = {
      translation: new Vec3(),
      rotation: new Quat(),
      scale: new Vec3(1, 1, 1),
    };

    /** Pre-sized output buffer for the skinned vertex pass (filled in-place, no per-frame alloc). */
    this.skinnedPositions = new Float32Array(mesh.vertices.length);
    this.visible = true;
    this.timelineTrackId = null; // links to Timeline's per-model keyframe track
  }

  /** Vertex skinning: standard linear blend skinning against bone.worldMatrix. */
  updateSkinning() {
    const { vertices, boneWeights, boneIndices } = this.mesh;
    const bones = this.skeleton.bones;
    const out = this.skinnedPositions;

    for (let v = 0; v < vertices.length; v += 3) {
      let x = 0, y = 0, z = 0;
      const wBase = (v / 3) * 4; // up to 4 influences/vertex (standard MMD convention)

      for (let k = 0; k < 4; k++) {
        const w = boneWeights[wBase + k];
        if (w === 0) continue;
        const m = bones[boneIndices[wBase + k]].worldMatrix;
        const vx = vertices[v], vy = vertices[v + 1], vz = vertices[v + 2];
        x += w * (m[0] * vx + m[4] * vy + m[8] * vz + m[12]);
        y += w * (m[1] * vx + m[5] * vy + m[9] * vz + m[13]);
        z += w * (m[2] * vx + m[6] * vy + m[10] * vz + m[14]);
      }
      out[v] = x; out[v + 1] = y; out[v + 2] = z;
    }
  }
}

export class CameraRig {
  constructor() {
    this.position = new Vec3(0, 10, -30);
    this.target = new Vec3(0, 10, 0);
    this.fovDeg = 30;
    this.timelineTrackId = null; // camera also gets diamond keyframes (section 3)
  }
}

export class SceneManager {
  constructor() {
    /** @type {ModelInstance[]} do NOT assume models[0] is "the" model anywhere downstream */
    this.models = [];
    this.camera = new CameraRig();
  }

  addModel(instance) {
    this.models.push(instance);
    return instance;
  }

  removeModel(id) {
    this.models = this.models.filter(m => m.id !== id);
  }

  getModel(id) {
    return this.models.find(m => m.id === id) || null;
  }

  /** Central per-frame execution loop step for every model, in isolation. */
  stepAll({ composeTRS, mat4Multiply, stretchRig, perf }) {
    for (const model of this.models) {
      if (!model.visible) continue;

      model.skeleton.evaluateWorldMatrices(composeTRS, mat4Multiply);

      if (stretchRig) stretchRig.applyToSkeleton(model.skeleton); // section 5 non-uniform bone pass

      if (!perf || perf.flags.ik) {
        // IK solver pass would run here per-model, gated by the global toggle (section 6)
      }

      model.updateSkinning();
    }
  }
}

export const sceneManager = new SceneManager();
