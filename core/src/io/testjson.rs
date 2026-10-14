//! Minimal JSON reader for the tests (this crate has no dependencies): enough for
//! tests/fixtures/blender_counts.json, so expectations come from Blender, not from hand counts.

#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    pub fn parse(s: &str) -> Json {
        let mut p = P { b: s.as_bytes(), at: 0 };
        let v = p.value();
        p.ws();
        assert_eq!(p.at, p.b.len(), "trailing data in JSON");
        v
    }

    /// Member `k` of an object (panics with the key name if missing).
    pub fn get(&self, k: &str) -> &Json {
        match self {
            Json::Obj(m) => &m.iter().find(|(key, _)| key == k).unwrap_or_else(|| panic!("JSON key {k} missing")).1,
            _ => panic!("not an object (looking for {k})"),
        }
    }

    pub fn num(&self) -> f64 {
        match self {
            Json::Num(x) => *x,
            other => panic!("not a number: {other:?}"),
        }
    }

    pub fn u(&self) -> u32 {
        let x = self.num();
        assert!(x >= 0.0 && x.fract() == 0.0, "not a count: {x}");
        x as u32
    }

    pub fn arr(&self) -> &[Json] {
        match self {
            Json::Arr(a) => a,
            other => panic!("not an array: {other:?}"),
        }
    }
}

struct P<'a> {
    b: &'a [u8],
    at: usize,
}

impl P<'_> {
    fn ws(&mut self) {
        while self.at < self.b.len() && self.b[self.at].is_ascii_whitespace() {
            self.at += 1;
        }
    }

    fn eat(&mut self, c: u8) {
        self.ws();
        assert_eq!(self.b.get(self.at), Some(&c), "expected '{}' at {}", c as char, self.at);
        self.at += 1;
    }

    fn value(&mut self) -> Json {
        self.ws();
        match self.b[self.at] {
            b'{' => {
                self.at += 1;
                let mut m = Vec::new();
                self.ws();
                if self.b[self.at] == b'}' {
                    self.at += 1;
                    return Json::Obj(m);
                }
                loop {
                    self.ws();
                    let k = self.string();
                    self.eat(b':');
                    m.push((k, self.value()));
                    self.ws();
                    self.at += 1;
                    if self.b[self.at - 1] == b'}' {
                        return Json::Obj(m);
                    }
                }
            }
            b'[' => {
                self.at += 1;
                let mut a = Vec::new();
                self.ws();
                if self.b[self.at] == b']' {
                    self.at += 1;
                    return Json::Arr(a);
                }
                loop {
                    a.push(self.value());
                    self.ws();
                    self.at += 1;
                    if self.b[self.at - 1] == b']' {
                        return Json::Arr(a);
                    }
                }
            }
            b'"' => Json::Str(self.string()),
            b't' => {
                self.at += 4;
                Json::Bool(true)
            }
            b'f' => {
                self.at += 5;
                Json::Bool(false)
            }
            b'n' => {
                self.at += 4;
                Json::Null
            }
            _ => {
                let s = self.at;
                while self.at < self.b.len() && matches!(self.b[self.at], b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9' | b'I' | b'n' | b'f' | b'i' | b't' | b'y') {
                    self.at += 1;
                }
                let t = std::str::from_utf8(&self.b[s..self.at]).unwrap();
                Json::Num(match t {
                    "Infinity" => f64::INFINITY,
                    "-Infinity" => f64::NEG_INFINITY,
                    _ => t.parse().unwrap_or_else(|_| panic!("bad number {t}")),
                })
            }
        }
    }

    fn string(&mut self) -> String {
        self.eat(b'"');
        let mut out = String::new();
        loop {
            let c = self.b[self.at];
            self.at += 1;
            match c {
                b'"' => return out,
                b'\\' => {
                    let e = self.b[self.at];
                    self.at += 1;
                    out.push(match e {
                        b'n' => '\n',
                        b't' => '\t',
                        b'u' => {
                            let h = std::str::from_utf8(&self.b[self.at..self.at + 4]).unwrap();
                            self.at += 4;
                            char::from_u32(u32::from_str_radix(h, 16).unwrap()).unwrap_or('?')
                        }
                        other => other as char,
                    });
                }
                _ => {
                    // Copy the whole UTF-8 sequence.
                    let s = self.at - 1;
                    let mut e = self.at;
                    while e < self.b.len() && (self.b[e] & 0xc0) == 0x80 {
                        e += 1;
                    }
                    out.push_str(std::str::from_utf8(&self.b[s..e]).unwrap());
                    self.at = e;
                }
            }
        }
    }
}
