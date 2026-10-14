"""Blender oracle for STL exports (EXP-2): reads a binary STL written by Maquette, imports it into a
clean Blender and prints what Blender sees next to what the file says, as one JSON line prefixed
ORACLE. STL carries positions only, so Blender (like any reader) merges equal positions: the
expected vertex count is the file's distinct positions.

Usage:
  Blender --background --factory-startup --python oracle/check_stl.py -- path/to/file.stl
"""
import json
import math
import struct
import sys

import bmesh
import bpy

path = sys.argv[sys.argv.index("--") + 1]

# What the file itself says (the expectation).
with open(path, "rb") as f:
    data = f.read()
count = struct.unpack_from("<I", data, 80)[0] if len(data) >= 84 else -1
size_ok = len(data) == 84 + 50 * count
positions = set()
lo = [math.inf] * 3
hi = [-math.inf] * 3
for t in range(count if size_ok else 0):
    vals = struct.unpack_from("<12f", data, 84 + 50 * t)
    for k in range(3):
        p = vals[3 + 3 * k: 6 + 3 * k]
        positions.add(p)
        for a in range(3):
            lo[a] = min(lo[a], p[a])
            hi[a] = max(hi[a], p[a])

bpy.ops.wm.read_homefile(use_empty=True, use_factory_startup=True)
# Native axes and scale: coordinates compare one to one with the file.
bpy.ops.wm.stl_import(filepath=path, forward_axis="Y", up_axis="Z", global_scale=1.0, use_scene_unit=False)
objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
mesh = objs[0].data if objs else None
blo = [math.inf] * 3
bhi = [-math.inf] * 3
result = {
    "file": {
        "bytes": len(data),
        "size_ok": size_ok,
        "header_is_ascii_like": data[:5].lower() == b"solid",
        "triangles": count,
        "unique_positions": len(positions),
        "bbox": [lo, hi],
    },
    "blender": {"version": bpy.app.version_string, "objects": len(objs), "vertices": 0, "faces": 0, "boundary_edges": None, "edges_over_2_faces": None},
}
if mesh:
    for v in mesh.vertices:
        for k in range(3):
            blo[k] = min(blo[k], v.co[k])
            bhi[k] = max(bhi[k], v.co[k])
    bm = bmesh.new()
    bm.from_mesh(mesh)
    result["blender"].update(
        vertices=len(mesh.vertices),
        faces=len(mesh.polygons),
        triangles=sum(1 for p in mesh.polygons if len(p.vertices) == 3),
        boundary_edges=sum(1 for e in bm.edges if len(e.link_faces) == 1),
        edges_over_2_faces=sum(1 for e in bm.edges if len(e.link_faces) > 2),
        bbox=[blo, bhi],
    )
    bm.free()
bbox_delta = max(abs(a - b) for pair in zip(result["file"]["bbox"], [blo, bhi]) for a, b in zip(*pair)) if mesh else None
result["bbox_max_delta"] = bbox_delta
result["pass"] = bool(
    mesh
    and size_ok
    and not result["file"]["header_is_ascii_like"]
    and result["blender"]["faces"] == count
    and result["blender"]["triangles"] == count
    and result["blender"]["vertices"] == len(positions)
    and bbox_delta is not None
    and bbox_delta <= 1e-4
)
print("ORACLE " + json.dumps(result))
