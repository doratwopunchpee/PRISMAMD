/**
 * main.js
 * Mobile app bootstrap: installs the Capacitor filesystem bridge, then
 * brings up the core subsystems in dependency order. This is the entry
 * point the www/index.html shell loads.
 */

import { installCapacitorFSBridge } from './platform/CapacitorFSBridge.js';
import { fileSystem } from './core/FileSystemManager.js';
import { sceneManager } from './core/SceneManager.js';
import { timeline } from './core/Timeline.js';
import { performanceController } from './perf/PerformanceController.js';

async function bootstrap() {
  installCapacitorFSBridge();

  // Section 1: request permission + create /PRISMAMD/Models, /Motions, etc.,
  // then start the live asset watchers the UI's model/motion pickers subscribe to.
  await fileSystem.initialize();

  fileSystem.onAssetsChanged((dir, entries) => {
    // UI layer hooks in here to repopulate pickers the instant a file lands.
    console.log(`[PRISMAMD] ${dir} changed:`, entries.map(e => e.name));
  });

  timeline.setFps(30);
  performanceController.setExportResolution('1080p');

  // Render loop — the actual WebGL2/WebGPU context setup lives in a
  // separate render bootstrap module once a canvas is wired up in index.html.
  let last = performance.now();
  function frame(now) {
    const dt = (now - last) / 1000;
    last = now;

    timeline.advance(dt);
    sceneManager.stepAll({
      composeTRS: (t, r, s) => r.toMat4 ? composeTRSPlaceholder(t, r, s) : null,
      mat4Multiply: () => {},
      stretchRig: null,
      perf: performanceController,
    });

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// Placeholder kept local to main.js until the renderer module supplies the
// real composeTRS/mat4Multiply wiring from core/MathUtils.js.
function composeTRSPlaceholder() { return null; }

bootstrap().catch(err => {
  console.error('[PRISMAMD] bootstrap failed:', err);
});
