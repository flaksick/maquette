# Maquette feature specification

_Generated from `spec.yaml` by `scripts/gen-spec.mjs`. Do not hand-edit._

**134 features** @ spec.yaml: 65 daily, 58 regular, 11 niche.
First-ship phase counts @ spec.yaml: P0 1, P1a 30, P1b 16, P2 19, P3 18, P4 14, P5 14, P6 13, P7 9.
Status is computed from tagged test results and device reports (`npm run verify`), never written here.

**Universal gates:** undoable and journaled (once UND-1 and PRJ-3 exist); symmetric where meaningful (SYM-1); mask-respecting (from P2, when MSK-1 lands); mesh validator passes after every operation in tests.

**Brush gates:** golden profile on a reference plane or sphere; mask immunity (from P2); mirror exactness 1e-6; no NaN or degenerate triangles; ms per dab at the reference mesh on the reference device.

## PLT · Platform, install, offline, lifecycle

| ID | Feature | Tier | Phase | Done when | Test |
|---|---|---|---|---|---|
| PLT-1 | Home Screen install | D | P1a | Add to Home Screen, open once online; 'Ready offline' only after every file is SHA-verified; standalone in both orientations | manifest lint; device checklist |
| PLT-2 | Offline cold launch | D | P1a | Airplane-mode cold launch reopens the last project in <= 3 s (1M tris); every feature works offline; only network use is the own-file update check, with a Settings toggle (off -> manual button) | WebKit offline e2e runs the full suite offline; e2e network log: non-own-origin requests = 0; bundle audit |
| PLT-3 | Safe updates | D | P1a (basic in P1a, full in P1b) | Downloads silently; activates on a clean cold launch; immutable versions; two failed boots revert; migrations copy-on-write until the version is marked good | e2e v1 -> v2 -> bad v3 -> auto-revert |
| PLT-4 | Persistent storage | D | P1b | persist() requested at first save; usage and quota shown | diagnostics numbers |
| PLT-5 | Lifecycle safety | D | P1a | Durability never relies on lifecycle events; a killed or silently reloaded app reopens to the same project; on resume, GL context loss or a blank canvas (1-pixel readback) rebuilds the GPU mirror in <= 1 s | device: 20 background/resume cycles; balloon-kill loop |
| PLT-6 | Browser-gesture suppression | D | P1b | No page zoom, scroll, selection, callout, magnifier or back-swipe while sculpting | counts of viewport-scale changes, scrolls, selections, contextmenu, pointercancel = 0 over a scripted checklist |
| PLT-7 | Engine crash containment | D | P1a | A WASM trap leaves the UI alive and reports it; the engine restarts in-session if re-instantiation is safe (S1), otherwise 'Saved. Swipe-close and reopen' | injected trap -> recovered hash = last journaled |
| PLT-8 | Device budgets | D | P1b | Lab-measured class prior + speed benchmark + adaptive learning; every limit shown with its source; over-budget operations refused before they run | diagnostics; pre-flight refusal tests |
| PLT-9 | Diagnostics | R | P0 | Capabilities, benchmarks, storage, memory ledger, crash log; JSON shared via the share sheet or AirDrop, never auto-posted | itself |
| PLT-10 | Idle is free | D | P1a | Nothing changing -> no frames rendered and no engine work | frame counter over a 10 s idle window = 0 |
| PLT-11 | Disk-full policy | D | P1b | Low quota or disk blocks growth-causing edits with a banner and offers backup or purge; never a half-written project | quota-fill e2e |
| PLT-12 | On-device crash log | D | P1a | Unclean exits, context losses and memory high-water at exit are recorded and shown in Diagnostics | balloon kill -> log entry present |
| PLT-13 | Storage-unavailable mode | D | P1a | If OPFS is unavailable (private browsing, ephemeral contexts), the app says so before any work starts and never pretends to save | WebKit ephemeral context e2e: warning shown, no silent save |

## PRJ · Projects and persistence

| ID | Feature | Tier | Phase | Done when | Test |
|---|---|---|---|---|---|
| PRJ-1 | Gallery | D | P1b (basic in P1b, full in P2) | Thumbnails, name, date, size, polys; new, open, rename, duplicate, delete (+30-day Recently Deleted) | e2e |
| PRJ-2 | Project format | D | P1a | Node-chunked binary + JSON manifest, per-chunk checksums, schema version and migrations | round-trip hash; migration fixtures |
| PRJ-3 | Journal and incremental checkpoints | D | P1a | Stroke after-state durable p99 <= 100 ms after stroke end; undo/redo journaled; dirty-node checkpoint when idle >= 2 s or journal > max(64 MB, compressed mesh); no save-caused frame > 20 ms | device trace |
| PRJ-4 | Crash recovery | D | P1a | Checkpoint + journal; stops at the first bad record and reports 'recovered to stroke N' | 200 native + 20 WebKit (SIGKILL) + 10 device balloon kills: recovered = last acknowledged |
| PRJ-5 | Project file in/out | D | P1b | .maquette file via share sheet <-> Files; re-import hash-identical | e2e |
| PRJ-6 | Back up all + reminder | D | P1b | One zip of all projects; gallery shows days since last backup (the iPad holds the only copy) | e2e |
| PRJ-7 | Named versions | R | P6 | Save a version; restore as a new project | e2e |
| PRJ-8 | Storage manager | R | P5 | Per-project size; purge spill and journals | e2e |
| PRJ-9 | Units and import-scale detection | D | P1b | Project units (mm/cm/m); import guesses units from the bounding box and asks; drives STL mm | fixtures |
| PRJ-10 | View and tool state | D | P1a | Camera, active tool and brush settings saved separately from the mesh journal | relaunch e2e |
| PRJ-11 | Preferences and presets file | R | P1b | Global settings and brush presets survive projects and updates | e2e |

## SCN · Scene and objects

| ID | Feature | Tier | Phase | Done when | Test |
|---|---|---|---|---|---|
| SCN-1 | Multiple objects | D | P2 | Add, tap-select, hide, rename, duplicate, delete, outliner; only the active object sculpts | e2e |
| SCN-2 | Merge / separate loose parts | R | P3 | Counts conserved; attributes carried | unit |
| SCN-3 | Instances, hierarchy, repeaters, lattice | N | P7 | Deferred: kitbashing and stylized work, not single-piece sculpting | - |
| SCN-4 | Live link to Blender | N | P7 | Deferred: the share sheet covers the hand-off | - |

## PRM · Primitives and creation

| ID | Feature | Tier | Phase | Done when | Test |
|---|---|---|---|---|---|
| PRM-1 | Quad sphere | D | P1a | All-quad cube-sphere; resolution slider shows polys; radius error < 0.5% | unit |
| PRM-2 | Other primitives | D | P2 | Cube, cylinder, cone, torus, plane, capsule, icosphere; parametric until first sculpt; watertight (plane: boundary) | unit per primitive |
| PRM-3 | Tube / Lathe from a curve | R | P6 | Radius profile along a drawn curve; lathe revolve | unit + e2e |
| PRM-4 | Extract shell from mask | R | P6 | Watertight; thickness slider | unit |

## IMP · Import

| ID | Feature | Tier | Phase | Done when | Test |
|---|---|---|---|---|---|
| IMP-0 | Import cleanup | D | P1b | Orient each component, split non-manifold edges/verts, drop duplicate and degenerate faces, report counts | defect fixtures |
| IMP-1 | OBJ import | D | P1b (groups merged in P1b; groups -> objects in P2) | Picker without an accept filter (extension checked in JS), drag-and-drop; tris/quads/n-gons kept as polygon runs; vertex colors | Blender-made fixtures: counts exact |
| IMP-2 | STL import | D | P1b | Binary and ASCII; tolerance weld | fixtures: weld count exact |
| IMP-3 | PLY import | R | P4 | Binary and ASCII with colors | fixtures |
| IMP-4 | glTF / GLB import | R | P4 | Meshes, node transforms, vertex colors | fixtures |
| IMP-5 | Large streaming import | R | P4 | Sliced parse, no UI freeze; 2M-tri OBJ <= 8 s on the reference device; over budget -> offer decimate-to-budget | device perf |
| IMP-6 | Import report and repair | R | P4 | Holes, scale, one-tap fixes, voxel rebuild | defect fixtures |
| IMP-7 | Reference images | D | P3 | Photo plane: opacity, lock, snap to front/side/top | e2e |
| IMP-8 | FBX, USDZ import | N | P7 | Deferred: OBJ/GLB cover Blender and ZBrush round-trips | - |

## NAV · Navigation and input

| ID | Feature | Tier | Phase | Done when | Test |
|---|---|---|---|---|---|
| NAV-1 | Orbit / pan / zoom | D | P1a | Turntable orbit (1 finger), pan (2), pinch zoom about the touch point, pivot on the surface; 60 fps at the measured comfortable polycount | frame-barcode harness |
| NAV-2 | Undo / redo gestures and buttons | D | P1a (buttons in P1a, taps in P1b) | 2-finger tap = undo (< 250 ms, < 10 px, never inside a pinch); buttons always shown; 3-finger redo only if S6 shows the system Undo bar stays away | 0 false fires on 50 recorded pinch traces |
| NAV-3 | Pencil sculpts | D | P1a | Touches ignored while the pen is down; 'finger sculpts' option | e2e |
| NAV-4 | View tools | D | P1a (frame/reset in P1a; view cube, ortho, FOV in P3) | Frame, reset, view-cube snaps, ortho/persp, FOV | e2e |
| NAV-5 | Hold modifiers | D | P2 | Smooth / Invert / Mask hold-buttons (Pencil double-tap, squeeze and barrel roll are not exposed to the web) | e2e |
| NAV-6 | Radius and strength sliders | D | P1a | Edge sliders with live cursor preview | e2e |
| NAV-7 | Hardware keyboard | R | P3 | Smooth/invert modifiers, undo/redo, radius, brush hotkeys | e2e |
| NAV-8 | Pencil hover cursor | R | P7 | Deferred: cannot be verified on the reference device | - |
| NAV-9 | Left-handed layout | R | P5 | Mirrored layout and UI scale persist | e2e |
| NAV-10 | Gesture card | D | P1b | Shown on first run; re-openable | e2e |
| NAV-11 | Adaptive render scale | R | P2 | Lower resolution while interacting if under 60 fps; full when idle | frame harness |

## STK · Stroke engine

| ID | Feature | Tier | Phase | Done when | Test |
|---|---|---|---|---|---|
| STK-1 | Spacing and interpolation | D | P1a | Dab spacing error <= 5% at any speed using coalesced Pencil samples | replayed device recordings |
| STK-2 | Pressure mapping | D | P1a | Pressure -> radius and/or strength, editable curve, smoothing | unit |
| STK-3 | Stabilizer | D | P2 | Lazy radius + smoothing, catch-up on lift; jitter RMS -70% (also absorbs pre-26.2 integer coordinates) | jittered trace |
| STK-4 | Falloff curves and hardness | D | P2 | Presets + custom curve; hardness remap | golden profiles |
| STK-5 | Screen / world radius | R | P2 | Both modes behave per definition | unit |
| STK-6 | Front faces only | D | P3 | Thin plate: back untouched; overlapping shells: only the hit shell moves | unit |
| STK-7 | Alphas / stamps | R | P4 | Grayscale alpha in the tangent frame; fixed/follow/random rotation; PNG import | golden height image |
| STK-8 | Brush presets | R | P2 | Saved per tool, duplicate, reset | e2e |
| STK-9 | Drag-dot, roll, line, anchored | R | P4 | Each stroke method behaves per definition | unit |
| STK-10 | Brush cursor | D | P1a | Surface-aligned ring with radius/strength preview | visual snapshot |
| STK-11 | Plane sampling | D | P2 | Area normal/plane from verts in radius (front-facing wins); per-brush accumulate flag; auto-smooth factor | golden |
| STK-12 | Curve strokes | R | P6 | Re-applying an edited curve = same result as drawing it | unit |

## BRS · Brushes

| ID | Feature | Tier | Phase | Done when | Test |
|---|---|---|---|---|---|
| BRS-1 | Draw (Standard) | D | P1a | Offset along area normal x falloff x strength | brush_gates |
| BRS-2 | Smooth (+ preserve volume) | D | P1a | <= 1% sphere volume loss over 50 dabs | brush_gates |
| BRS-3 | Move / Grab (+ Move Topological) | D | P1a | Center moves exactly by the stroke delta | brush_gates |
| BRS-4 | Inflate | D | P1b | Sphere stays round (radial sigma < 1%) | brush_gates |
| BRS-5 | Flatten | D | P1b | Converges to the plane | brush_gates |
| BRS-6 | Clay (Buildup), Clay Strips (Clay Tubes) | D | P2 | Offset-plane build; square tangent falloff | brush_gates |
| BRS-7 | Crease (Dam Standard) | D | P2 | V-profile + pinch to line | brush_gates |
| BRS-8 | Pinch | D | P2 | 0 normal motion on a plane | brush_gates |
| BRS-9 | Snake Hook | D | P2 | Follows the path (adds geometry once TOP-3 lands in P3) | brush_gates |
| BRS-10 | Layer | D | P2 | Height capped regardless of dab count | brush_gates |
| BRS-11 | Fill, Scrape, Planar | R | P2 | One Plane primitive with one-sided limits | brush_gates |
| BRS-12 | Blob, Draw Sharp, Thumb/Nudge | R | P3 | Each per definition | brush_gates |
| BRS-13 | Relax / Slide-relax | R | P3 | Edge-length variance falls; Hausdorff <= 0.1% | brush_gates |
| BRS-14 | Elastic Grab (Kelvinlets) | R | P6 | Matches the closed form within 1e-4 | brush_gates |
| BRS-15 | Pose | R | P6 | Flood-fill segments, forward IK, smooth seam | brush_gates |
| BRS-16 | Clay Thumb, Boundary, Multiplane Scrape, Rotate | N | P6 | Each per definition | brush_gates |
| BRS-17 | Cloth | N | P7 | Deferred: needs a stable cloth solver; occasional use | - |
| BRS-18 | Morph / erase-layer | R | P4 | Full strength restores the stored state exactly | brush_gates |

## SYM · Symmetry

| ID | Feature | Tier | Phase | Done when | Test |
|---|---|---|---|---|---|
| SYM-1 | Mirror symmetry | D | P1a (X in P1a; any X/Y/Z combination in P2) | Local space, plane indicator, feathered at the plane; mirror exact for sculpt, mask, paint; no double strength at the plane | mirror tests |
| SYM-2 | Radial symmetry | R | P3 | 2-64 repeats; n-fold invariance <= 1e-6 | unit |
| SYM-3 | Symmetrize | R | P3 | +X -> -X; symmetric, welded, manifold | unit |
| SYM-4 | Topological symmetry | N | P7 | Deferred: only for asymmetrically posed meshes | - |

## TOP · Topology and detail

| ID | Feature | Tier | Phase | Done when | Test |
|---|---|---|---|---|---|
| TOP-1 | Voxel remesh | D | P2 | Target-polycount slider + voxel checker preview; watertight with 0 non-manifold across 1,000 fuzz shapes; Hausdorff <= 1 voxel; fills holes and merges self-intersections; keep-sharp reproject; mask/color reprojected; 500k-quad output <= 4 s on the reference device; sliced, cancellable, view stays live | fuzz + device perf |
| TOP-2 | Voxel union / subtract | R | P2 (union in P2; subtract in P6) | SDF min/max; watertight | unit |
| TOP-3 | Dynamic topology | D | P3 | Constant/screen/brush detail; refine/collapse toggles; flood fill; mask/color interpolated; no slot moves mid-stroke; 'detail capped' at budget; <= 8 ms/dab at 1M; 10k-op fuzz with undo/redo/kills -> 0 validator failures | fuzz + device perf |
| TOP-4 | Multires levels | D | P4 | Catmull-Clark; per-base-face displacement grids; add/step/delete levels; detail carried in tangent space (correlation >= 0.99 after a 45-degree bend); level switch <= 1 s at 2M | unit + device perf |
| TOP-5 | Reverse subdivision | R | P4 | Rebuilds regular imports; refuses others with a reason | fixtures |
| TOP-6 | Decimate | R | P3 (mask/color in P3; face-group borders in P4) | 1M -> 100k <= 3 s; Hausdorff <= 0.5% of bbox diagonal | unit + device perf |
| TOP-7 | Mesh cleanup | R | P4 | Weld, degenerates, fill holes | defect fixtures |
| TOP-8 | Poly and memory HUD | D | P1a | Tris, verts, level, memory ledger vs budget | e2e |
| TOP-9 | Quad remesher | R | P7 | Deferred: candidates @autoremesher/wasm (MIT), QuadriFlow (MIT core), Instant Meshes (BSD-3) | - |
| TOP-10 | Detail projection | R | P4 | Project a source mesh's detail onto the active mesh or level; Hausdorff to source <= 0.2% | unit |

## FLT · Filters

| ID | Feature | Tier | Phase | Done when | Test |
|---|---|---|---|---|---|
| FLT-1 | Mesh filters | R | P3 | Smooth, inflate, scale, sphere, relax, sharpen, enhance details, random; mask-respecting; sliced | unit |
| FLT-2 | Color filters | N | P5 | Fill, HSV, brightness/contrast | unit |

## MSK · Masking, selection, visibility

| ID | Feature | Tier | Phase | Done when | Test |
|---|---|---|---|---|---|
| MSK-1 | Mask brush + overlay | D | P2 | Masked verts immune in every brush test | brush_gates |
| MSK-2 | Mask operations | R | P3 | Invert, clear, blur, sharpen, grow, shrink, contrast | unit |
| MSK-3 | Shape selection | D | P3 | Lasso, polygon, rectangle, ellipse, line (shared by mask, hide, trim); front-face option; exact on test meshes | unit |
| MSK-4 | Mask from cavity/curvature | R | P4 | Sign matches curvature on the test surface | unit |
| MSK-5 | Mask expand (geodesic) | R | P6 | Monotone geodesic field | unit |
| MSK-6 | Extract / split by mask | R | P6 | Watertight results | unit |
| MSK-7 | Face groups | R | P4 | Paint, auto (normals/loose parts), hide/isolate, mask-by-group | unit |
| MSK-8 | Hide / show | R | P3 | Hidden faces skip brushes and drawing | unit |

## XFM · Transforms

| ID | Feature | Tier | Phase | Done when | Test |
|---|---|---|---|---|---|
| XFM-1 | Object gizmo | D | P2 | Move/rotate/scale, local/world, numeric entry | e2e |
| XFM-2 | Mask-aware gizmo (posing) | D | P3 | Masked area fixed exactly; smooth transition at the mask edge | unit |
| XFM-3 | Snapping | R | P3 | 15-degree rotation and grid snaps | unit |
| XFM-4 | Apply transform | R | P3 | Each exact | unit |

## BOO · Booleans and trimming

| ID | Feature | Tier | Phase | Done when | Test |
|---|---|---|---|---|---|
| BOO-1 | Exact booleans | R | P6 | Union/difference/intersect via manifold-3d; watertight | unit |
| BOO-2 | Trim with cap | R | P6 | Lasso/box/line; watertight; planar cap | unit |
| BOO-3 | Plane split | R | P6 | Splits into two watertight objects | unit |

## PNT · Paint, materials, viewport look

| ID | Feature | Tier | Phase | Done when | Test |
|---|---|---|---|---|---|
| PNT-1 | Vertex color paint | R | P5 | Symmetric, undoable, exported | e2e |
| PNT-2 | Roughness / metalness paint | N | P5 | Bytes allocated only when painted | unit |
| PNT-3 | Matcaps | D | P1a (one matcap in P1a; library >= 8 + import in P5) | Rendered with Blender at build time | visual snapshot |
| PNT-4 | PBR + HDRI | R | P5 | >= 4 environments prefiltered at build; exposure, rotation | visual snapshot |
| PNT-5 | SSAO, curvature, outline, AgX, FXAA | R | P5 | 60-fps polycount with SSAO >= 85% of without | frame harness |
| PNT-6 | Wireframe | R | P3 | Wireframe shows polygon runs (quads), not triangles | visual snapshot |
| PNT-7 | Background | R | P5 | Color, gradient, environment | e2e |
| PNT-8 | UV texture painting | N | P7 | Deferred: needs UV unwrap; vertex paint covers sculpt coloring | - |

## LYR · Sculpt layers

| ID | Feature | Tier | Phase | Done when | Test |
|---|---|---|---|---|---|
| LYR-1 | Sculpt layers | R | P4 (GLB morph export in P5) | Intensity -1..2, visibility, record, merge; survive dyntopo (interpolate) and remesh (reproject, lossy); toggle exact 1e-6; intensity linear | unit |

## UND · Undo and redo

| ID | Feature | Tier | Phase | Done when | Test |
|---|---|---|---|---|---|
| UND-1 | Undo / redo | D | P1a (RAM-budgeted in P1a; spill to OPFS in P2) | Every change; exact pre-state (hash); <= 50 ms per stroke at 2M; history budget in MB + max steps; heavy-op undo points at the pre-op checkpoint; history does not survive a relaunch (stated in UI) | unit + device perf |
| UND-2 | History panel | N | P6 | Shows and jumps to any step | e2e |

## EXP · Export and sharing

| ID | Feature | Tier | Phase | Done when | Test |
|---|---|---|---|---|---|
| EXP-1 | OBJ export | D | P1a | Polygon runs and vertex colors; Blender 5.1 oracle: counts exact, bbox <= 1e-4 | oracle |
| EXP-2 | STL export | D | P1b | Binary; watertight warning; mm via PRJ-9 | oracle |
| EXP-3 | PLY export | R | P5 | With colors | oracle |
| EXP-4 | GLB export | R | P5 | Objects, transforms, colors, PBR, layer morphs | oracle |
| EXP-5 | USDZ + View in AR | R | P5 | Opens in AR Quick Look on the device | device |
| EXP-6 | Export options | R | P5 | Selection, level, decimate-on-export, triangulate, scale | oracle |
| EXP-7 | Two-step export | D | P1a | Prepare (progress) then Share (fresh tap) to Files/AirDrop; download fallback; re-import of the shared file is hash-identical; 200 MB works | device + e2e |
| EXP-8 | Screenshot and turntable | R | P5 | Up to 4x, transparent background; turntable video | e2e |
| EXP-9 | UV unwrap + map baking | N | P7 | Deferred: game-asset pipeline | - |
| EXP-10 | Print prep | R | P5 (hollowing deferred to P7) | Watertight check + dimensions | unit |
