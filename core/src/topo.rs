//! Static adjacency in CSR form: vertex -> triangles and vertex -> one-ring vertices.
//! (P1a replaces this with the corner table; P0 uses it for the benchmark kernels.)

pub struct Topo {
    pub vt_off: Vec<u32>,
    pub vt: Vec<u32>,
    pub vv_off: Vec<u32>,
    pub vv: Vec<u32>,
}

pub fn build(nv: usize, tris: &[u32]) -> Topo {
    let mut vt_off = vec![0u32; nv + 1];
    for &v in tris {
        vt_off[v as usize + 1] += 1;
    }
    for i in 0..nv {
        vt_off[i + 1] += vt_off[i];
    }
    let mut fill = vt_off.clone();
    let mut vt = vec![0u32; tris.len()];
    for (t, tri) in tris.chunks(3).enumerate() {
        for &v in tri {
            let slot = &mut fill[v as usize];
            vt[*slot as usize] = t as u32;
            *slot += 1;
        }
    }

    let mut vv_off = Vec::with_capacity(nv + 1);
    let mut vv = Vec::with_capacity(nv * 7);
    let mut ring: Vec<u32> = Vec::with_capacity(16);
    vv_off.push(0u32);
    for v in 0..nv {
        ring.clear();
        for &t in &vt[vt_off[v] as usize..vt_off[v + 1] as usize] {
            let tri = &tris[3 * t as usize..3 * t as usize + 3];
            for &w in tri {
                if w as usize != v {
                    ring.push(w);
                }
            }
        }
        ring.sort_unstable();
        ring.dedup();
        vv.extend_from_slice(&ring);
        vv_off.push(vv.len() as u32);
    }
    Topo { vt_off, vt, vv_off, vv }
}

#[cfg(test)]
mod tests {
    #[test]
    fn sphere_rings_are_symmetric() {
        let m = crate::sphere::cube_sphere(6);
        let t = super::build(m.nverts(), &m.tris);
        for v in 0..m.nverts() {
            for &w in &t.vv[t.vv_off[v] as usize..t.vv_off[v + 1] as usize] {
                let back = &t.vv[t.vv_off[w as usize] as usize..t.vv_off[w as usize + 1] as usize];
                assert!(back.contains(&(v as u32)));
            }
        }
    }
}
