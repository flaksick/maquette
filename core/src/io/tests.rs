//! Import/export tests. Expectations come from Blender (tests/fixtures/blender_counts.json, made
//! by tests/fixtures/make_fixtures.py) or from how a defect fixture was built ("defect" entries);
//! every comparison is exact. Names start with the feature IDs they verify.

use super::testjson::Json;
use super::*;
use crate::mesh::EditMesh;
use crate::sphere::cube_sphere;
use std::path::PathBuf;

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures")
}

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(dir().join(name)).unwrap_or_else(|e| panic!("{name}: {e}"))
}

fn blender() -> Json {
    Json::parse(&std::fs::read_to_string(dir().join("blender_counts.json")).unwrap())
}

fn entry<'a>(j: &'a Json, name: &str) -> &'a Json {
    j.get("fixtures").get(name)
}

fn import_ok(bytes: &[u8], hint: u32) -> (TriMesh, ImportReport) {
    import(bytes, hint).unwrap_or_else(|f| panic!("import failed: {f:?}"))
}

fn valid(tm: &TriMesh) -> MeshCheck {
    let c = check(tm.nverts(), &tm.tris, &tm.poly_next);
    assert!(c.valid(), "validator: {c:?}");
    c
}

/// Polygon sizes of the fan runs, sorted.
fn run_sizes(tm: &TriMesh) -> Vec<usize> {
    let mut sizes = Vec::new();
    let mut n = 0;
    for &p in &tm.poly_next {
        n += 1;
        if p == 0 {
            sizes.push(n + 2);
            n = 0;
        }
    }
    sizes.sort_unstable();
    sizes
}

fn face_sizes(raw: &RawMesh) -> Vec<usize> {
    let mut s: Vec<usize> = (0..raw.nfaces()).map(|f| raw.face(f).len()).collect();
    s.sort_unstable();
    s
}

/// Six times the enclosed volume (positive = outward winding).
fn volume6(tm: &TriMesh) -> f64 {
    let p = |v: u32| [0, 1, 2].map(|k| tm.positions[3 * v as usize + k] as f64);
    tm.tris
        .chunks(3)
        .map(|t| {
            let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
            a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])
        })
        .sum()
}

fn obj_text(verts: &[[f32; 3]], faces: &[Vec<u32>]) -> String {
    let mut s = String::new();
    for v in verts {
        s += &format!("v {} {} {}\n", v[0], v[1], v[2]);
    }
    for f in faces {
        s += "f";
        for &i in f {
            s += &format!(" {}", i + 1);
        }
        s += "\n";
    }
    s
}

/// An outward-wound unit cube at `o` (vertex 4x + 2y + z), as in make_fixtures.py.
fn cube(o: [f32; 3], verts: &mut Vec<[f32; 3]>, faces: &mut Vec<Vec<u32>>) {
    const F: [[u32; 4]; 6] = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
    let mut id = [0u32; 8];
    for (c, slot) in id.iter_mut().enumerate() {
        let p = [o[0] + (c >> 2) as f32, o[1] + ((c >> 1) & 1) as f32, o[2] + (c & 1) as f32];
        *slot = match verts.iter().position(|&q| q == p) {
            Some(i) => i as u32,
            None => {
                verts.push(p);
                (verts.len() - 1) as u32
            }
        };
    }
    for f in F {
        faces.push(f.iter().map(|&c| id[c as usize]).collect());
    }
}

// ------------------------------------------------------------------ IMP-1 OBJ

#[test]
fn imp1_obj_fixtures_match_blender_counts() {
    let j = blender();
    for name in ["cube_quads.obj", "prism_ngon.obj", "monkey_subdiv.obj"] {
        let b = entry(&j, name).get("blender");
        let bytes = fixture(name);
        let (raw, _) = obj::parse(&bytes).unwrap();
        assert_eq!(raw.nverts() as u32, b.get("vertices").u(), "{name} vertices");
        assert_eq!(raw.nfaces() as u32, b.get("faces").u(), "{name} faces");
        let sizes = face_sizes(&raw);
        let count = |k: usize| sizes.iter().filter(|&&s| s == k).count() as u32;
        assert_eq!(count(3), b.get("tris").u(), "{name} tris");
        assert_eq!(count(4), b.get("quads").u(), "{name} quads");
        assert_eq!(sizes.iter().filter(|&&s| s > 4).count() as u32, b.get("ngons").u(), "{name} n-gons");

        let (tm, r) = import_ok(&bytes, HINT_OBJ);
        valid(&tm);
        assert_eq!(r.verts, b.get("vertices").u(), "{name}");
        assert_eq!(r.faces, b.get("faces").u(), "{name}");
        assert_eq!(r.tris, b.get("triangles").u(), "{name}");
        assert_eq!(r.components, b.get("loose_parts").u(), "{name}");
        assert_eq!(r.boundary_edges, b.get("boundary_edges").u(), "{name}");
        let changes = (r.welded_verts, r.dropped_duplicate, r.dropped_degenerate, r.flipped_faces, r.split_non_manifold, r.loose_verts);
        assert_eq!(changes, (0, 0, 0, 0, 0, 0), "{name}: a clean file must come through unchanged");
        // Tris, quads and n-gons stay polygons: one fan run per face, same sizes.
        assert_eq!(run_sizes(&tm), sizes, "{name}");
        // Coordinates are Blender's to the bit (both parse to correctly rounded f32).
        let bb = b.get("bbox").arr();
        for k in 0..3 {
            assert_eq!(r.bbox[k], bb[0].arr()[k].num() as f32, "{name} bbox min");
            assert_eq!(r.bbox[3 + k], bb[1].arr()[k].num() as f32, "{name} bbox max");
        }
        // Into the engine's mesh and out as OBJ: Blender's face and quad counts again.
        let m = EditMesh::from_trimesh(tm, 64);
        assert!(check(m.nverts(), &m.tris, &m.poly_next).valid());
        let mut out = Vec::new();
        let st = crate::objio::write_obj(&m, &mut out);
        assert_eq!(st.faces as u32, b.get("faces").u(), "{name} OBJ export faces");
        let text = String::from_utf8(out).unwrap();
        let quads = text.lines().filter(|l| l.starts_with("f ") && l.split_whitespace().count() == 5).count();
        assert_eq!(quads as u32, b.get("quads").u(), "{name} OBJ export quads");
    }
}

#[test]
fn imp1_obj_face_forms_and_negative_indices() {
    let plain = "v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nv 0 0 1\nf 1 2 3 4\nf 1 2 5\n";
    // v/vt, v/vt/vn, v//vn and relative indices (counted back from the vertices read so far).
    let forms = "v 0 0 0\nv 1 0 0\nvt 0 0\nvn 0 0 1\nv 1 1 0\nv 0 1 0\nv 0 0 1\nf 1/1 2/1/1 3//1 -2\nf -5/1/1 -4//1 5\n";
    let (a, _) = obj::parse(plain.as_bytes()).unwrap();
    let (b, _) = obj::parse(forms.as_bytes()).unwrap();
    assert_eq!(a.face_off, b.face_off);
    assert_eq!(a.face_verts, b.face_verts);
    assert_eq!(b.face_verts, vec![0, 1, 2, 3, 0, 1, 4]);
    // Forward references are legal; the check happens at the end of the file.
    let (c, _) = obj::parse(b"f 1 2 3\nv 0 0 0\nv 1 0 0\nv 0 1 0\n").unwrap();
    assert_eq!(c.face_verts, vec![0, 1, 2]);
}

#[test]
fn imp1_obj_streaming_chunks_match_whole_file() {
    let bytes = fixture("monkey_subdiv.obj");
    let (whole, _) = obj::parse(&bytes).unwrap();
    for size in [1usize, 2, 3, 7, 64, 4096] {
        let mut p = obj::ObjParser::new();
        for chunk in bytes.chunks(size) {
            p.feed(chunk).unwrap();
        }
        let (raw, _) = p.finish().unwrap();
        assert_eq!(raw.positions.iter().map(|x| x.to_bits()).collect::<Vec<_>>(), whole.positions.iter().map(|x| x.to_bits()).collect::<Vec<_>>(), "chunk {size}");
        assert_eq!(raw.face_off, whole.face_off, "chunk {size}");
        assert_eq!(raw.face_verts, whole.face_verts, "chunk {size}");
    }
}

#[test]
fn imp1_obj_line_endings_continuations_and_no_final_newline() {
    let crlf = obj::parse(b"v 0 0 0\r\nv 1 0 0\r\nv 0 1 0\r\nf 1 2 3\r\n").unwrap().0;
    let cont = obj::parse(b"v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 \\\n 3\n").unwrap().0;
    let last = obj::parse(b"v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3").unwrap().0;
    for raw in [&crlf, &cont, &last] {
        assert_eq!(raw.nfaces(), 1);
        assert_eq!(raw.face_verts, vec![0, 1, 2]);
    }
    // A continuation split across two chunks.
    let mut p = obj::ObjParser::new();
    p.feed(b"v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 \\").unwrap();
    p.feed(b"\n2 3\n").unwrap();
    assert_eq!(p.finish().unwrap().0.face_verts, vec![0, 1, 2]);
}

#[test]
fn imp1_obj_vertex_colors_are_read_and_counted() {
    let text = b"v 0 0 0\nv 1 0 0 1 0 0\nv 0 1 0 0 1 0\nv 0 0 1\nf 1 2 3\nf 1 3 4\n";
    let (raw, st) = obj::parse(text).unwrap();
    assert_eq!(st.colored_verts, 2);
    assert_eq!(raw.colors.len(), 3 * raw.nverts());
    assert_eq!(&raw.colors[..12], &[1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 1.0]);
    let (_, r) = import_ok(text, HINT_OBJ);
    assert_eq!(r.colored_verts, 2);
}

#[test]
fn imp1_obj_groups_merge_and_non_mesh_elements_are_counted() {
    let text = b"o a\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\no b\nv 0 0 1\nv 1 0 1\nv 0 1 1\nf 4 5 6\nl 1 4\ng c\np 2\n";
    let (tm, r) = import_ok(text, HINT_OBJ);
    valid(&tm);
    assert_eq!((r.groups, r.ignored_elements, r.faces, r.components), (3, 2, 2, 2));
}

#[test]
fn imp1_obj_errors_name_the_line() {
    let fail = |t: &[u8]| import(t, HINT_OBJ).err().unwrap();
    assert_eq!(fail(b"v 0 0 0\nv 1 0 x\n"), Failure { error: ImportError::BadNumber, line: 2 });
    assert_eq!(fail(b"v 0 0 0\nv 1 0 nan\n"), Failure { error: ImportError::BadNumber, line: 2 });
    assert_eq!(fail(b"v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 4\n"), Failure { error: ImportError::BadIndex, line: 4 });
    assert_eq!(fail(b"v 0 0 0\nf 0 1 1\n"), Failure { error: ImportError::BadIndex, line: 2 });
    assert_eq!(fail(b"v 0 0 0\nf -2 1 1\n"), Failure { error: ImportError::BadIndex, line: 2 });
    assert_eq!(fail(b"# nothing\n").error, ImportError::NoFaces);
    assert_eq!(fail(b"").error, ImportError::NoFaces);
}

// ------------------------------------------------------------------ IMP-2 STL

#[test]
fn imp2_stl_weld_counts_match_blender() {
    let j = blender();
    for (name, format) in [("cube_binary.stl", Format::StlBinary), ("cube_ascii.stl", Format::StlAscii), ("monkey_binary.stl", Format::StlBinary)] {
        let b = entry(&j, name).get("blender");
        let bytes = fixture(name);
        assert_eq!(detect(&bytes, HINT_STL).unwrap(), format, "{name}");
        let soup = if format == Format::StlBinary { stl::parse_binary(&bytes) } else { stl::parse_ascii(&bytes) }.unwrap();
        assert_eq!(soup.nfaces() as u32, b.get("faces").u(), "{name} facets");
        // Blender's STL importer merges equal positions; the weld must find exactly as many.
        let raw = stl::weld(&soup, stl::WELD_REL_EPS);
        assert_eq!(raw.nverts() as u32, b.get("vertices").u(), "{name} welded vertices");
        let (tm, r) = import_ok(&bytes, HINT_STL);
        valid(&tm);
        assert_eq!(r.in_verts, 3 * b.get("faces").u());
        assert_eq!(r.welded_verts, 3 * b.get("faces").u() - b.get("vertices").u(), "{name} weld count");
        assert_eq!(r.tris, b.get("faces").u(), "{name}");
        assert_eq!(r.boundary_edges, b.get("boundary_edges").u(), "{name}");
        assert_eq!(r.components, b.get("loose_parts").u(), "{name}");
        assert_eq!(r.verts, b.get("vertices").u() + r.split_non_manifold, "{name}");
    }
}

#[test]
fn imp2_imp0_stl_monkey_weld_then_bowtie_split() {
    // Suzanne has 507 vertices but 505 distinct positions (@ blender_counts.json): two points
    // where an eye touches the head. The STL weld joins them (as Blender's STL import does),
    // which makes two bow-tie vertices; cleanup splits them back apart.
    let j = blender();
    let (_, r) = import_ok(&fixture("monkey_binary.stl"), HINT_STL);
    let b = entry(&j, "monkey_binary.stl").get("blender");
    assert_eq!(b.get("vertices").u(), 505);
    assert_eq!(r.split_non_manifold, 2);
    assert_eq!(r.verts, 507);
    assert_eq!((r.dropped_duplicate, r.dropped_degenerate, r.flipped_faces, r.loose_verts), (0, 0, 0, 0));
}

#[test]
fn imp2_stl_binary_and_ascii_read_the_same_mesh() {
    let a = stl::weld(&stl::parse_binary(&fixture("cube_binary.stl")).unwrap(), stl::WELD_REL_EPS);
    let b = stl::weld(&stl::parse_ascii(&fixture("cube_ascii.stl")).unwrap(), stl::WELD_REL_EPS);
    assert_eq!(a.positions, b.positions);
    assert_eq!(a.face_verts, b.face_verts);
}

#[test]
fn imp2_stl_tolerance_weld() {
    let soup = stl::parse_binary(&fixture("cube_binary.stl")).unwrap();
    let eps = stl::WELD_REL_EPS * 12f32.sqrt(); // cube diagonal
    // Every corner nudged by up to 0.25 eps per axis: still 8 vertices, 28 welded.
    let mut near = soup.clone();
    for (i, x) in near.corners.iter_mut().enumerate() {
        *x += ((i * 7919 % 11) as f32 - 5.0) / 5.0 * 0.25 * eps;
    }
    assert_eq!(stl::weld(&near, stl::WELD_REL_EPS).nverts(), 8);
    // Nudged 10 eps apart (each corner its own amount): nothing merges.
    let mut far = soup.clone();
    for (i, x) in far.corners.iter_mut().enumerate() {
        if i % 3 == 0 {
            *x += (i / 3 + 1) as f32 * 10.0 * eps;
        }
    }
    assert_eq!(stl::weld(&far, stl::WELD_REL_EPS).nverts(), 36);
    // Exact duplicates only (tolerance 0): the same 8.
    assert_eq!(stl::weld(&soup, 0.0).nverts(), 8);
}

#[test]
fn imp2_stl_detection_by_size_not_header() {
    let mut b = fixture("cube_binary.stl");
    b[..5].copy_from_slice(b"solid"); // legal in a binary header; size decides
    assert_eq!(detect(&b, HINT_STL).unwrap(), Format::StlBinary);
    assert_eq!(detect(&b, HINT_DETECT).unwrap(), Format::StlBinary);
    let (_, r) = import_ok(&b, HINT_STL);
    assert_eq!((r.tris, r.verts, r.welded_verts), (12, 8, 28));
    assert_eq!(detect(&fixture("cube_ascii.stl"), HINT_DETECT).unwrap(), Format::StlAscii);
    assert_eq!(detect(&fixture("cube_quads.obj"), HINT_DETECT).unwrap(), Format::Obj);
    let short = &fixture("cube_binary.stl")[..600];
    assert_eq!(import(short, HINT_STL).err().unwrap().error, ImportError::Truncated);
    assert_eq!(import(b"hello", HINT_STL).err().unwrap().error, ImportError::UnknownFormat);
}

#[test]
fn imp2_stl_is_turned_z_up_to_y_up_exactly() {
    let j = blender();
    let (_, r) = import_ok(&fixture("monkey_binary.stl"), HINT_STL);
    let bb = entry(&j, "monkey_binary.stl").get("blender").get("bbox").arr();
    let (lo, hi) = (|k: usize| bb[0].arr()[k].num() as f32, |k: usize| bb[1].arr()[k].num() as f32);
    // engine (x, y, z) = file (x, z, -y)
    assert_eq!([r.bbox[0], r.bbox[1], r.bbox[2]], [lo(0), lo(2), -hi(1)]);
    assert_eq!([r.bbox[3], r.bbox[4], r.bbox[5]], [hi(0), hi(2), -lo(1)]);
    let mut p = vec![0.25f32, -1.5, 3.0e-7];
    stl::z_up_to_y_up(&mut p);
    assert_eq!(stl::y_up_to_z_up([p[0], p[1], p[2]]), [0.25, -1.5, 3.0e-7]);
}

// ------------------------------------------------------------------ IMP-0 cleanup

#[test]
fn imp0_defect_duplicate_faces() {
    let j = blender();
    let e = entry(&j, "defect_duplicate.obj");
    let (tm, r) = import_ok(&fixture("defect_duplicate.obj"), HINT_OBJ);
    valid(&tm);
    assert_eq!(r.dropped_duplicate, e.get("defect").get("duplicate_faces").u());
    // Blender's own validation drops the same faces.
    assert_eq!(r.dropped_duplicate, e.get("raw").get("faces").u() - e.get("blender").get("faces").u());
    assert_eq!(r.faces, e.get("blender").get("faces").u());
    assert_eq!((r.boundary_edges, r.components, r.flipped_faces, r.split_non_manifold), (0, 1, 0, 0));
}

#[test]
fn imp0_defect_flipped_faces() {
    let j = blender();
    let e = entry(&j, "defect_flipped.obj");
    let (tm, r) = import_ok(&fixture("defect_flipped.obj"), HINT_OBJ);
    valid(&tm);
    assert_eq!(r.flipped_faces, e.get("defect").get("flipped_faces").u());
    // Blender's "Recalculate Outside" reverses the same number.
    assert_eq!(r.flipped_faces, e.get("raw").get("flipped_by_recalc_outside").u());
    assert!(volume6(&tm) > 0.0, "closed component must face outward");
    assert_eq!((r.boundary_edges, r.components), (0, 1));
}

#[test]
fn imp0_defect_nonmanifold_edge() {
    let j = blender();
    let e = entry(&j, "defect_nonmanifold.obj");
    assert_eq!(e.get("raw").get("edges_over_2_faces").u(), 1);
    let (tm, r) = import_ok(&fixture("defect_nonmanifold.obj"), HINT_OBJ);
    valid(&tm);
    let d = e.get("defect");
    assert_eq!(r.split_non_manifold, d.get("vertex_copies_to_split").u());
    assert_eq!(r.components, d.get("components_after_split").u());
    // Paired into wedges around the edge: still two closed cubes (6 = 2 x unit volume x 6).
    assert_eq!(r.boundary_edges, 0);
    assert_eq!(r.verts, e.get("raw").get("vertices").u() + 2);
    assert_eq!(r.flipped_faces, 0);
    assert!((volume6(&tm) - 12.0).abs() < 1e-9, "volume6 {}", volume6(&tm));
}

#[test]
fn imp0_defect_hole() {
    let j = blender();
    let e = entry(&j, "defect_hole.obj");
    let (tm, r) = import_ok(&fixture("defect_hole.obj"), HINT_OBJ);
    valid(&tm);
    assert_eq!(r.boundary_edges, e.get("defect").get("boundary_edges").u());
    assert_eq!(r.boundary_edges, e.get("blender").get("boundary_edges").u());
    assert_eq!((r.components, r.flipped_faces, r.split_non_manifold), (1, 0, 0));
}

#[test]
fn imp0_degenerate_faces_are_dropped() {
    let (mut v, mut f) = (Vec::new(), Vec::new());
    cube([0.0; 3], &mut v, &mut f);
    v.push(v[0]); // vertex 8 sits exactly on vertex 0
    f.push(vec![0, 0, 1]); // repeats a vertex: fewer than 3 distinct
    f.push(vec![0, 8, 1]); // three distinct ids, zero area
    f.push(vec![2, 3]); // two vertices
    let (tm, r) = import_ok(obj_text(&v, &f).as_bytes(), HINT_OBJ);
    valid(&tm);
    assert_eq!(r.dropped_degenerate, 3);
    assert_eq!(r.loose_verts, 1, "vertex 8 is used by no kept face");
    assert_eq!((r.faces, r.verts, r.boundary_edges, r.components), (6, 8, 0, 1));
}

#[test]
fn imp0_fin_is_detached_and_bowtie_vertex_split() {
    // Fin: two coplanar quads share an edge with a third quad standing up on it. The coplanar pair
    // winds opposite ways and encloses the solid side, so it stays joined; the fin comes off.
    let v = [[0.0, 0.0, 0.0], [0.0, 1.0, 0.0], [-1.0, 0.0, 0.0], [-1.0, 1.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 0.0, 1.0], [0.0, 1.0, 1.0]];
    let f = vec![vec![2, 0, 1, 3], vec![0, 4, 5, 1], vec![0, 1, 7, 6]];
    let (tm, r) = import_ok(obj_text(&v, &f).as_bytes(), HINT_OBJ);
    valid(&tm);
    assert_eq!((r.split_non_manifold, r.components, r.boundary_edges, r.verts, r.faces), (2, 2, 10, 10, 3));
    // Bow-tie: two cubes touching at one corner.
    let (mut v, mut f) = (Vec::new(), Vec::new());
    cube([0.0; 3], &mut v, &mut f);
    cube([-1.0; 3], &mut v, &mut f);
    assert_eq!(v.len(), 15);
    let (tm, r) = import_ok(obj_text(&v, &f).as_bytes(), HINT_OBJ);
    valid(&tm);
    assert_eq!((r.split_non_manifold, r.components, r.boundary_edges, r.verts, r.flipped_faces), (1, 2, 0, 16, 0));
}

#[test]
fn imp0_mobius_strip_becomes_orientable() {
    // A one-face-wide band of 8 quads with a half twist: no consistent winding exists. The fill
    // cuts one join (where it meets itself), the two vertices of that rung split, and the result
    // is an orientable strip: valid, one component, 16 + 2 boundary edges.
    let n = 8;
    let mut v = Vec::new();
    for i in 0..n {
        let th = std::f32::consts::TAU * i as f32 / n as f32;
        let (c, s) = (th.cos(), th.sin());
        for side in [-1.0f32, 1.0] {
            let (rad, up) = ((th / 2.0).cos() * side * 0.3, (th / 2.0).sin() * side * 0.3);
            v.push([(2.0 + rad) * c, (2.0 + rad) * s, up]);
        }
    }
    let p = |i: usize, side: usize| -> u32 { if i < n { (2 * i + side) as u32 } else { (1 - side) as u32 } };
    let f: Vec<Vec<u32>> = (0..n).map(|i| vec![p(i, 0), p(i + 1, 0), p(i + 1, 1), p(i, 1)]).collect();
    let (tm, r) = import_ok(obj_text(&v, &f).as_bytes(), HINT_OBJ);
    valid(&tm);
    assert_eq!((r.split_non_manifold, r.components, r.boundary_edges, r.faces), (2, 1, 18, 8));
    assert_eq!(r.flipped_faces, 2);
}

#[test]
fn imp0_concave_ngon_fans_from_a_vertex_that_sees_it_all() {
    // An L-shaped hexagon listed from a corner whose fan would fold over; the fan moves to a
    // vertex from which every triangle is positively oriented.
    let v = [[2.0, 1.0, 0.0], [1.0, 1.0, 0.0], [1.0, 2.0, 0.0], [0.0, 2.0, 0.0], [0.0, 0.0, 0.0], [2.0, 0.0, 0.0]];
    let f = vec![vec![0, 1, 2, 3, 4, 5]];
    let (tm, r) = import_ok(obj_text(&v, &f).as_bytes(), HINT_OBJ);
    valid(&tm);
    assert_eq!((r.faces, r.tris), (1, 4));
    assert_eq!(run_sizes(&tm), vec![6]);
    for t in tm.tris.chunks(3) {
        let q = |i: u32| [tm.positions[3 * i as usize], tm.positions[3 * i as usize + 1]];
        let (a, b, c) = (q(t[0]), q(t[1]), q(t[2]));
        let area2 = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        assert!(area2 > 0.0, "fan triangle {t:?} folds over (2A = {area2})");
    }
}

#[test]
fn imp0_cleaned_meshes_reimport_unchanged() {
    for name in ["monkey_subdiv.obj", "defect_duplicate.obj", "defect_flipped.obj", "defect_nonmanifold.obj", "defect_hole.obj", "monkey_binary.stl"] {
        let bytes = fixture(name);
        let (tm, r) = import_ok(&bytes, 0);
        let m = EditMesh::from_trimesh(tm, 64);
        let mut out = Vec::new();
        crate::objio::write_obj(&m, &mut out);
        let (_, r2) = import_ok(&out, HINT_OBJ);
        let changes = (r2.dropped_duplicate, r2.dropped_degenerate, r2.flipped_faces, r2.split_non_manifold, r2.loose_verts);
        assert_eq!(changes, (0, 0, 0, 0, 0), "{name}: cleanup must be idempotent");
        assert_eq!((r2.verts, r2.faces, r2.tris, r2.components, r2.boundary_edges), (r.verts, r.faces, r.tris, r.components, r.boundary_edges), "{name}");
    }
}

#[test]
fn imp0_validator_flags_the_raw_defects() {
    // The validator is not vacuous: on the files as written (naive fans, no cleanup) it finds
    // exactly the defects the cleanup removes.
    let naive = |name: &str| -> MeshCheck {
        let (raw, _) = obj::parse(&fixture(name)).unwrap();
        let (mut tris, mut pn) = (Vec::new(), Vec::new());
        for f in 0..raw.nfaces() {
            let q = raw.face(f);
            for i in 1..q.len() - 1 {
                tris.extend_from_slice(&[q[0], q[i], q[i + 1]]);
                pn.push((i + 2 < q.len()) as u8);
            }
        }
        check(raw.nverts(), &tris, &pn)
    };
    // Two flipped faces that share one edge: 4 + 4 - 2 inconsistent edges.
    assert_eq!(naive("defect_flipped.obj").inconsistent_edges, 6);
    assert_eq!(naive("defect_nonmanifold.obj").nonmanifold_edges, 1);
    assert!(naive("defect_duplicate.obj").nonmanifold_edges > 0);
    assert!(naive("cube_quads.obj").valid());
}

#[test]
fn imp0_all_fixtures_pass_the_validator_in_the_engine() {
    for name in ["cube_quads.obj", "prism_ngon.obj", "monkey_subdiv.obj", "cube_binary.stl", "cube_ascii.stl", "monkey_binary.stl", "defect_duplicate.obj", "defect_flipped.obj", "defect_nonmanifold.obj", "defect_hole.obj"] {
        let (tm, r) = import_ok(&fixture(name), 0);
        let m = EditMesh::from_trimesh(tm, 32);
        let c = check(m.nverts(), &m.tris, &m.poly_next);
        assert!(c.valid(), "{name}: {c:?}");
        assert_eq!((c.boundary_edges, c.components), (r.boundary_edges, r.components), "{name}");
        assert_eq!(r.verts as usize, m.nverts());
        assert_eq!(r.verts, r.in_verts - r.welded_verts - r.loose_verts + r.split_non_manifold, "{name}: vertex accounting");
    }
}

#[test]
fn imp1_imp2_abi_installs_the_mesh_and_reports() {
    let bytes = fixture("prism_ngon.obj");
    let w = unsafe { std::slice::from_raw_parts(super::abi::eng_import(bytes.as_ptr(), bytes.len() as u32, HINT_OBJ, 64), REPORT_WORDS) }.to_vec();
    assert_eq!(w[0], 0);
    assert_eq!((w[1], w[13], w[14], w[15], w[19]), (Format::Obj as u32, 14, 9, 24, Units::M as u32));
    assert_eq!(crate::abi::with_engine(|e| (e.mesh.nverts(), e.mesh.ntris())), Some((14, 24)));
    // A broken file is refused and leaves the engine's mesh alone.
    let bad = b"v 0 0 0\nf 1 2 3\n";
    let w = unsafe { std::slice::from_raw_parts(super::abi::eng_import(bad.as_ptr(), bad.len() as u32, HINT_OBJ, 64), REPORT_WORDS) }.to_vec();
    assert_eq!((w[0], w[2]), (ImportError::BadIndex as u32, 2));
    assert_eq!(crate::abi::with_engine(|e| e.mesh.ntris()), Some(24));
    let mut info = [0u32; 3];
    let len = unsafe { super::abi::eng_export_stl(1000.0, info.as_mut_ptr()) };
    assert_eq!((len, info), (84 + 50 * 24, [24, 0, 0]));
    let mut chk = [0u32; 7];
    assert_eq!(unsafe { super::abi::eng_mesh_check(chk.as_mut_ptr()) }, 1);
    assert_eq!((chk[1], chk[2], chk[3], chk[6]), (0, 0, 0, 1));
}

// ------------------------------------------------------------------ PRJ-9 units

#[test]
fn prj9_units_guessed_from_the_bounding_box() {
    assert_eq!(guess_units(120.0, Format::StlBinary), Units::Mm);
    assert_eq!(guess_units(5.0, Format::StlAscii), Units::Mm);
    assert_eq!(guess_units(2.0, Format::StlBinary), Units::M);
    assert_eq!(guess_units(2.0, Format::Obj), Units::M);
    assert_eq!(guess_units(180.0, Format::Obj), Units::Cm);
    assert_eq!(guess_units(2500.0, Format::Obj), Units::Mm);
    assert_eq!([Units::Mm.to_mm(), Units::Cm.to_mm(), Units::M.to_mm()], [1.0, 10.0, 1000.0]);
    // The Blender fixtures are ~2 units across: metres.
    for name in ["cube_quads.obj", "monkey_subdiv.obj", "cube_binary.stl", "monkey_binary.stl"] {
        assert_eq!(import_ok(&fixture(name), 0).1.units_guess, Units::M as u32, "{name}");
    }
    // The same cube as a 120 mm print: every coordinate of the binary STL times 60.
    let mut b = fixture("cube_binary.stl");
    for t in 0..12 {
        for k in 0..9 {
            let at = 84 + 50 * t + 12 + 4 * k;
            let x = f32::from_le_bytes(b[at..at + 4].try_into().unwrap()) * 60.0;
            b[at..at + 4].copy_from_slice(&x.to_le_bytes());
        }
    }
    let (_, r) = import_ok(&b, HINT_STL);
    assert_eq!(r.bbox[3] - r.bbox[0], 120.0);
    assert_eq!(r.units_guess, Units::Mm as u32);
}

// ------------------------------------------------------------------ EXP-2 STL export

#[test]
fn exp2_stl_export_reads_back_in_millimetres() {
    let (tm, r) = import_ok(&fixture("monkey_subdiv.obj"), HINT_OBJ);
    let m = EditMesh::from_trimesh(tm, 64);
    let mut out = Vec::new();
    let st = stl::write_binary(&m, Units::M.to_mm(), &mut out);
    assert_eq!(out.len(), 84 + 50 * m.ntris());
    assert!(!out.starts_with(b"solid"), "a binary header must not read as ASCII");
    assert_eq!(st.triangles as usize, m.ntris());
    assert_eq!((st.boundary_edges, st.nonmanifold_edges), (84, 0), "the monkey has holes: watertight warning");
    let (tm2, r2) = import_ok(&out, HINT_STL);
    valid(&tm2);
    assert_eq!((r2.tris, r2.verts, r2.components, r2.boundary_edges), (r.tris, r.verts, r.components, r.boundary_edges));
    for k in 0..6 {
        assert!((r2.bbox[k] - 1000.0 * r.bbox[k]).abs() <= 1e-3, "bbox {k}: {} vs {}", r2.bbox[k], 1000.0 * r.bbox[k]);
    }
    assert_eq!(r2.units_guess, Units::Mm as u32);
}

#[test]
fn exp2_watertight_mesh_has_no_boundary_edges() {
    let m = EditMesh::from_trimesh(cube_sphere(8), 64);
    let mut out = Vec::new();
    let st = stl::write_binary(&m, 10.0, &mut out);
    assert_eq!((st.triangles, st.boundary_edges, st.nonmanifold_edges), (768, 0, 0));
    // Facet normals point outward (the sphere is centred on the origin).
    let f = |at: usize| f32::from_le_bytes(out[at..at + 4].try_into().unwrap());
    for t in 0..st.triangles as usize {
        let base = 84 + 50 * t;
        let n = [f(base), f(base + 4), f(base + 8)];
        let a = [f(base + 12), f(base + 16), f(base + 20)];
        assert!(n[0] * a[0] + n[1] * a[1] + n[2] * a[2] > 0.0, "facet {t} normal points inward");
    }
}
