# PrismaMD — MikuMikuDance-style player for Android tablets

A landscape tablet app that plays MMD content: **PMX/PMD models, VMD dance + camera motions, VPD poses, and music**, with MMD's default look (toon shading, sphere maps, per-material edge lines, soft shadows) enabled from the first launch.

It is a re-implementation built on three.js's MMD stack (`MMDLoader`, `MMDAnimationHelper`, IK/grant solvers, ammo.js rigid-body physics) hosted in a native Kotlin shell. It is not the original MMD program (a closed-source Windows application), so editing tools such as the timeline editor and model/motion authoring are not included.

## Build

1. Open this folder in **Android Studio** (Koala or newer) and let Gradle sync, or run `gradle assembleDebug` with `ANDROID_HOME` set.
2. Run on a tablet (Android 8.0 / API 26 or newer; a GPU with OpenGL ES 3 / WebGL2 is recommended).

The APK is at `app/build/outputs/apk/debug/app-debug.apk`.

### Offline use (optional)

By default the 3D engine (three.js 0.160.0, JSZip 3.10.1, ammo.js) is fetched from the jsDelivr CDN at first launch and cached by the WebView. To bundle it into the APK instead:

```sh
sh tools/vendor-libs.sh   # needs Node/npm; then rebuild
```

## Using it

| Button | Does |
| --- | --- |
| **Model** | Pick a `.zip` containing a `.pmx`/`.pmd` and its textures (Shift-JIS file names are handled). |
| **Motion** | Pick one or more `.vmd` files (dance, facial, and camera motions are sorted automatically) or a `.vpd` pose. |
| **Audio** | Pick a music file; it starts and pauses with playback. |
| Transport | Return to start, play/pause, reset view; the readout shows elapsed and total time. |
| **Panels** | Show or hide the right-hand dock. |
| Dock → **Scene** | Material outliner: eye icon hides/shows a material, plus Show all / Hide all / Solo and a filter box. Tap a row (or tap the model) to edit its colour, opacity, outline on/off and edge width, double-sided, or reset it. |
| Dock → **Render** | Shader preset (**MMD Default**, Soft Studio, Bold Outline, Clean) and toggles for outline, shadows, grid, physics and camera motion. |

Touch camera: one finger orbits, two fingers pinch-zoom and pan. Camera VMDs take over the camera until you switch **Camera motion** off or tap **Reset view**.

Material edits last for the current session (they are not written back to the model file).

Models, motions and music are not included; use content whose licence allows your use.

## Layout

```
app/src/main/java/com/example/prismamd/MainActivity.kt   WebView host, file picker, immersive landscape
app/src/main/assets/www/index.html                      UI + library resolver (local lib/ or CDN)
app/src/main/assets/www/app.js                          MMD engine glue, shaders, playback
tools/vendor-libs.sh                                    optional offline bundling
```
