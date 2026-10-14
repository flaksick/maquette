//! OBJ export (EXP-1). Polygon runs are written back as their original polygons (quads stay
//! quads), so a sphere made here opens in Blender with the same face count it was made with.
//! A run is a triangle fan (v0, vi, vi+1); anything that isn't a clean fan is written as
//! triangles rather than guessed.

use crate::mesh::EditMesh;
use std::fmt::Write;

pub struct ObjStats {
    pub vertices: usize,
    pub faces: usize,
}

pub fn write_obj(m: &EditMesh, out: &mut Vec<u8>) -> ObjStats {
    let mut s = String::with_capacity(m.nverts() * 40 + m.ntris() * 20);
    s.push_str("# Maquette\n");
    for v in 0..m.nverts() {
        let _ = writeln!(s, "v {} {} {}", m.positions[3 * v], m.positions[3 * v + 1], m.positions[3 * v + 2]);
    }
    let mut faces = 0;
    let mut t = 0;
    let ntri = m.ntris();
    while t < ntri {
        let mut end = t;
        while end + 1 < ntri && m.poly_next[end] == 1 {
            end += 1;
        }
        let v0 = m.tris[3 * t];
        let fan = (t + 1..=end).all(|k| m.tris[3 * k] == v0 && m.tris[3 * k + 1] == m.tris[3 * (k - 1) + 2]);
        if fan {
            s.push('f');
            let _ = write!(s, " {} {}", m.tris[3 * t] + 1, m.tris[3 * t + 1] + 1);
            for k in t..=end {
                let _ = write!(s, " {}", m.tris[3 * k + 2] + 1);
            }
            s.push('\n');
            faces += 1;
        } else {
            for k in t..=end {
                let _ = writeln!(s, "f {} {} {}", m.tris[3 * k] + 1, m.tris[3 * k + 1] + 1, m.tris[3 * k + 2] + 1);
                faces += 1;
            }
        }
        t = end + 1;
    }
    out.clear();
    out.extend_from_slice(s.as_bytes());
    ObjStats { vertices: m.nverts(), faces }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sphere::cube_sphere;

    #[test]
    fn exp1_sphere_exports_as_quads() {
        let n = 10;
        let m = EditMesh::from_trimesh(cube_sphere(n), 64);
        let mut out = Vec::new();
        let st = write_obj(&m, &mut out);
        assert_eq!(st.vertices, (6 * n * n + 2) as usize);
        assert_eq!(st.faces, (6 * n * n) as usize);
        let text = String::from_utf8(out).unwrap();
        let quads = text.lines().filter(|l| l.starts_with("f ") && l.split_whitespace().count() == 5).count();
        assert_eq!(quads, st.faces);
        // Written floats parse back to the exact same values.
        let first_v = text.lines().find(|l| l.starts_with("v ")).unwrap();
        let x: f32 = first_v.split_whitespace().nth(1).unwrap().parse().unwrap();
        assert_eq!(x.to_bits(), m.positions[0].to_bits());
    }
}
