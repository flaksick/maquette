//! Manifold cell table. Surface nets puts one vertex in every cell whose 8 corners are not all
//! on one side, and one quad on every grid edge whose ends differ. That surface is the boundary
//! of the union of "inside" voxels (one voxel per grid point), so it is a closed 2-manifold
//! exactly when, in every cell, the inside corners are connected through cell edges and so are
//! the outside corners (no checkerboard face = no edge shared by 4 quads, no corners touching
//! only across the cell = no vertex shared by two cones). `GOOD[mask]` says whether a cell is
//! fine; `FIX[mask]` names the outside corner to turn inside first on the shortest way to a good
//! mask (repairs only ever add inside points, so they always terminate).
//!
//! Corner c = x + 2y + 4z; mask bit c set = corner c is inside.

use std::sync::OnceLock;

pub struct Lut {
    pub good: [bool; 256],
    pub fix: [u8; 256],
}

fn connected(set: u8) -> bool {
    if set == 0 {
        return true;
    }
    let mut seen = 1u8 << set.trailing_zeros();
    let mut frontier = seen;
    while frontier != 0 {
        let mut next = 0u8;
        for c in 0..8u8 {
            if frontier & (1 << c) == 0 {
                continue;
            }
            for d in [1u8, 2, 4] {
                let n = c ^ d;
                if set & (1 << n) != 0 && seen & (1 << n) == 0 {
                    next |= 1 << n;
                }
            }
        }
        seen |= next;
        frontier = next;
    }
    seen == set
}

pub fn lut() -> &'static Lut {
    static L: OnceLock<Lut> = OnceLock::new();
    L.get_or_init(|| {
        let mut good = [false; 256];
        for (m, g) in good.iter_mut().enumerate() {
            *g = connected(m as u8) && connected(!(m as u8));
        }
        let mut fix = [0u8; 256];
        for m in 0..256usize {
            if good[m] {
                continue;
            }
            // Breadth-first over supersets: fewest added corners, lowest corner index first.
            let mut seen = [false; 256];
            let mut first = [0u8; 256];
            let mut queue = vec![m];
            seen[m] = true;
            let mut qi = 0;
            let found = loop {
                let x = queue[qi];
                qi += 1;
                if good[x] {
                    break x;
                }
                for c in 0..8 {
                    let y = x | (1 << c);
                    if y != x && !seen[y] {
                        seen[y] = true;
                        first[y] = if x == m { c as u8 } else { first[x] };
                        queue.push(y);
                    }
                }
            };
            fix[m] = first[found];
        }
        Lut { good, fix }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn top1_lut_flags_exactly_the_critical_configurations() {
        let l = lut();
        // Uniform cells and single corners are fine; a checkerboard face and a body diagonal are not.
        assert!(l.good[0] && l.good[255] && l.good[1] && l.good[0xfe]);
        assert!(!l.good[0b0000_1001], "face diagonal (corners 0 and 3)");
        assert!(!l.good[0b1000_0001], "body diagonal (corners 0 and 7)");
        assert!(!l.good[!0b1000_0001u8 as usize], "complement of the body diagonal");
        let bad = (0..256).filter(|&m| !l.good[m]).count();
        // Every fix adds an outside corner, and following fixes always ends in a good mask.
        for m in 0..256usize {
            let mut x = m;
            let mut steps = 0;
            while !l.good[x] {
                let c = l.fix[x];
                assert_eq!(x & (1 << c), 0, "fix must turn an outside corner inside");
                x |= 1 << c;
                steps += 1;
            }
            assert!(steps <= 4);
        }
        println!("top1 lut: {bad} of 256 cell masks need repair");
    }
}
