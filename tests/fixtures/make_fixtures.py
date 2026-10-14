"""Import fixtures (IMP-0, IMP-1, IMP-2), made with Blender, plus Blender's own counts for each.

Usage (from the repository root):
  Blender --background --factory-startup --python tests/fixtures/make_fixtures.py -- tests/fixtures

Writes the .obj/.stl fixtures and blender_counts.json: what Blender itself sees when it imports
each file (default import settings, which validate the mesh, and "raw" with validation off), so
the Rust tests compare Maquette's importer against Blender's numbers, never against hand counts.
Defect fixtures also record what each defect is ("defect"), which is what the cleanup counts are
checked against.
"""
import json
import math
import os
import sys

import bmesh
import bpy
from mathutils import Vector

OUT = os.path.abspath(sys.argv[sys.argv.index("--") + 1])
os.makedirs(OUT, exist_ok=True)


def reset():
    bpy.ops.wm.read_homefile(use_empty=True, use_factory_startup=True)


def only(ob):
    for o in bpy.context.scene.objects:
        o.select_set(False)
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob


def from_data(name, verts, faces, uv=False):
    me = bpy.data.meshes.new(name)
    me.from_pydata([Vector(v) for v in verts], [], faces)  # no validate(): defects must survive
    if uv:
        me.uv_layers.new(name="UVMap")
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def export_obj(ob, name, uv, normals):
    only(ob)
    path = os.path.join(OUT, name)
    bpy.ops.wm.obj_export(filepath=path, export_selected_objects=True, export_materials=False,
                          export_uv=uv, export_normals=normals)
    return path


def export_stl(ob, name, ascii_format):
    only(ob)
    path = os.path.join(OUT, name)
    bpy.ops.wm.stl_export(filepath=path, export_selected_objects=True, ascii_format=ascii_format)
    return path


CUBE_V = [(x, y, z) for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)]
# Outward-wound quads of CUBE_V (index = 4x + 2y + z with 0 for -1, 1 for +1).
CUBE_F = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]


def rev(f):
    return tuple(reversed(f))


def two_cubes_sharing_an_edge():
    # Cube A = [0,1]^3, cube B = [-1,0]x[-1,0]x[0,1]: they share the edge x = y = 0.
    verts, faces, index = [], [], {}

    def vid(p):
        if p not in index:
            index[p] = len(verts)
            verts.append(p)
        return index[p]

    for (ox, oy) in ((0, 0), (-1, -1)):
        corner = [vid((ox + c[0] * 0.5 + 0.5, oy + c[1] * 0.5 + 0.5, c[2] * 0.5 + 0.5)) for c in CUBE_V]
        faces += [tuple(corner[i] for i in f) for f in CUBE_F]
    return verts, faces


# ---------------------------------------------------------------- fixtures
made = {}

reset()
bpy.ops.mesh.primitive_cube_add(size=2)
made["cube_quads.obj"] = export_obj(bpy.context.active_object, "cube_quads.obj", uv=True, normals=True)
made["cube_binary.stl"] = export_stl(bpy.context.active_object, "cube_binary.stl", False)
made["cube_ascii.stl"] = export_stl(bpy.context.active_object, "cube_ascii.stl", True)

reset()
bpy.ops.mesh.primitive_cylinder_add(vertices=7, radius=1, depth=2, end_fill_type="NGON")
made["prism_ngon.obj"] = export_obj(bpy.context.active_object, "prism_ngon.obj", uv=False, normals=True)

reset()
bpy.ops.mesh.primitive_monkey_add()
made["monkey_binary.stl"] = export_stl(bpy.context.active_object, "monkey_binary.stl", False)
mod = bpy.context.active_object.modifiers.new("subdiv", "SUBSURF")
mod.levels = 1
made["monkey_subdiv.obj"] = export_obj(bpy.context.active_object, "monkey_subdiv.obj", uv=False, normals=False)

defects = {
    "defect_duplicate.obj": (CUBE_V, CUBE_F + [CUBE_F[0], rev(CUBE_F[3])],
                             {"what": "cube + face 1 repeated + face 4 repeated reversed", "duplicate_faces": 2}),
    "defect_flipped.obj": (CUBE_V, [rev(f) if i in (1, 4) else f for i, f in enumerate(CUBE_F)],
                           {"what": "cube with faces 2 and 5 wound inward", "flipped_faces": 2}),
    "defect_nonmanifold.obj": (*two_cubes_sharing_an_edge(),
                               {"what": "two cubes sharing one edge (4 faces on it)", "nonmanifold_edges": 1,
                                "vertex_copies_to_split": 2, "components_after_split": 2}),
    "defect_hole.obj": (CUBE_V, CUBE_F[:5], {"what": "cube with its last face deleted", "boundary_edges": 4}),
}
for name, (verts, faces, _) in defects.items():
    reset()
    made[name] = export_obj(from_data(name, verts, faces, uv=True), name, uv=True, normals=False)


# ---------------------------------------------------------------- Blender's own counts
def mesh_counts(objs):
    out = {"objects": len(objs), "vertices": 0, "edges": 0, "faces": 0, "tris": 0, "quads": 0, "ngons": 0,
           "triangles": 0, "boundary_edges": 0, "edges_over_2_faces": 0, "loose_parts": 0,
           "unique_positions": 0, "color_attributes": 0}
    lo = [math.inf] * 3
    hi = [-math.inf] * 3
    positions = set()
    for ob in objs:
        me = ob.data
        me.calc_loop_triangles()
        out["vertices"] += len(me.vertices)
        out["edges"] += len(me.edges)
        out["faces"] += len(me.polygons)
        out["triangles"] += len(me.loop_triangles)
        out["color_attributes"] += len(me.color_attributes)
        for p in me.polygons:
            n = len(p.vertices)
            out["tris" if n == 3 else "quads" if n == 4 else "ngons"] += 1
        for v in me.vertices:
            positions.add(tuple(v.co))
            for k in range(3):
                lo[k] = min(lo[k], v.co[k])
                hi[k] = max(hi[k], v.co[k])
        bm = bmesh.new()
        bm.from_mesh(me)
        out["boundary_edges"] += sum(1 for e in bm.edges if len(e.link_faces) == 1)
        out["edges_over_2_faces"] += sum(1 for e in bm.edges if len(e.link_faces) > 2)
        seen = set()
        for f in bm.faces:
            if f.index in seen:
                continue
            out["loose_parts"] += 1
            stack = [f]
            seen.add(f.index)
            while stack:
                g = stack.pop()
                for e in g.edges:
                    for h in e.link_faces:
                        if h.index not in seen:
                            seen.add(h.index)
                            stack.append(h)
        bm.free()
    out["unique_positions"] = len(positions)
    out["bbox"] = [lo, hi]
    return out


def flipped_by_blender(objs):
    """Faces whose winding Blender's own 'Recalculate Outside' (bmesh) reverses."""
    n = 0
    for ob in objs:
        bm = bmesh.new()
        bm.from_mesh(ob.data)
        before = [f.normal.copy() for f in bm.faces]
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        bm.normal_update()
        n += sum(1 for f, b in zip(bm.faces, before) if f.normal.dot(b) < 0)
        bm.free()
    return n


def min_distinct_distance(objs):
    pts = sorted({tuple(v.co) for ob in objs for v in ob.data.vertices})
    best = math.inf
    for i in range(len(pts)):  # sorted by x: stop once x alone exceeds the best distance
        for j in range(i + 1, len(pts)):
            if pts[j][0] - pts[i][0] >= best:
                break
            best = min(best, math.dist(pts[i], pts[j]))
    return best


def blender_import(path, validate):
    reset()
    if path.endswith(".obj"):
        # Native axes (no Y-up conversion), so coordinates compare one to one with the file.
        bpy.ops.wm.obj_import(filepath=path, forward_axis="Y", up_axis="Z", validate_meshes=validate)
    else:
        bpy.ops.wm.stl_import(filepath=path, use_mesh_validate=validate)
    return [o for o in bpy.context.scene.objects if o.type == "MESH"]


report = {"blender": bpy.app.version_string, "fixtures": {}}
for name, path in sorted(made.items()):
    entry = {"bytes": os.path.getsize(path)}
    objs = blender_import(path, validate=True)
    entry["blender"] = mesh_counts(objs)
    entry["blender"]["min_distinct_distance"] = min_distinct_distance(objs)
    objs = blender_import(path, validate=False)
    entry["raw"] = mesh_counts(objs)
    entry["raw"]["flipped_by_recalc_outside"] = flipped_by_blender(objs)
    if name in defects:
        entry["defect"] = defects[name][2]
    report["fixtures"][name] = entry

with open(os.path.join(OUT, "blender_counts.json"), "w", encoding="utf-8") as f:
    json.dump(report, f, indent=1, sort_keys=True)
    f.write("\n")
total = sum(e["bytes"] for e in report["fixtures"].values())
print("FIXTURES " + json.dumps({"files": len(made), "total_bytes": total}))
