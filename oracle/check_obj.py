"""Blender oracle for exports (EXP-1): imports an OBJ written by Maquette into a clean Blender and
prints what Blender sees next to what the file claims, as one JSON line prefixed ORACLE.

Usage:
  Blender --background --factory-startup --python oracle/check_obj.py -- path/to/file.obj
"""
import json
import sys

import bpy

path = sys.argv[sys.argv.index("--") + 1]

# What the file itself says (the expectation).
verts_file = 0
faces_file = 0
quads_file = 0
lo = [float("inf")] * 3
hi = [float("-inf")] * 3
with open(path, encoding="utf-8") as f:
    for line in f:
        if line.startswith("v "):
            xyz = [float(t) for t in line.split()[1:4]]
            verts_file += 1
            for k in range(3):
                lo[k] = min(lo[k], xyz[k])
                hi[k] = max(hi[k], xyz[k])
        elif line.startswith("f "):
            faces_file += 1
            if len(line.split()) == 5:
                quads_file += 1

bpy.ops.wm.read_homefile(use_empty=True, use_factory_startup=True)
# Native axes (no Y-up conversion), so coordinates compare one to one.
bpy.ops.wm.obj_import(filepath=path, forward_axis="Y", up_axis="Z")
objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
mesh = objs[0].data if objs else None
blo = [float("inf")] * 3
bhi = [float("-inf")] * 3
if mesh:
    for v in mesh.vertices:
        for k in range(3):
            blo[k] = min(blo[k], v.co[k])
            bhi[k] = max(bhi[k], v.co[k])
result = {
    "file": {"vertices": verts_file, "faces": faces_file, "quads": quads_file, "bbox": [lo, hi]},
    "blender": {
        "version": bpy.app.version_string,
        "objects": len(objs),
        "vertices": len(mesh.vertices) if mesh else 0,
        "faces": len(mesh.polygons) if mesh else 0,
        "quads": sum(1 for p in mesh.polygons if len(p.vertices) == 4) if mesh else 0,
        "bbox": [blo, bhi],
        "non_manifold_edges": None,
    },
}
if mesh:
    import bmesh

    bm = bmesh.new()
    bm.from_mesh(mesh)
    result["blender"]["non_manifold_edges"] = sum(1 for e in bm.edges if not e.is_manifold)
    bm.free()
bbox_delta = max(abs(a - b) for pair in zip(result["file"]["bbox"], result["blender"]["bbox"]) for a, b in zip(*pair)) if mesh else None
result["bbox_max_delta"] = bbox_delta
result["pass"] = bool(
    mesh
    and result["blender"]["vertices"] == verts_file
    and result["blender"]["faces"] == faces_file
    and result["blender"]["quads"] == quads_file
    and bbox_delta is not None
    and bbox_delta <= 1e-4
)
print("ORACLE " + json.dumps(result))
