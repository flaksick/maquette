;; Spike S4: a minimal module that runs on a SHARED memory from several workers at once.
;; `work(ptr, n, rounds)` rewrites n floats starting at byte `ptr`, `rounds` times:
;; x = x * 0.999 + 0.001. Each worker gets its own disjoint range, so no atomics are needed
;; for correctness; `ping` exercises atomic wait/notify on a shared i32 cell.
(module
  (import "env" "memory" (memory 1 65536 shared))

  (func (export "work") (param $ptr i32) (param $n i32) (param $rounds i32)
    (local $r i32) (local $i i32) (local $p i32)
    (local.set $r (i32.const 0))
    (block $done_r
      (loop $loop_r
        (br_if $done_r (i32.ge_u (local.get $r) (local.get $rounds)))
        (local.set $i (i32.const 0))
        (local.set $p (local.get $ptr))
        (block $done_i
          (loop $loop_i
            (br_if $done_i (i32.ge_u (local.get $i) (local.get $n)))
            (f32.store (local.get $p)
              (f32.add
                (f32.mul (f32.load (local.get $p)) (f32.const 0.999))
                (f32.const 0.001)))
            (local.set $p (i32.add (local.get $p) (i32.const 4)))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $loop_i)))
        (local.set $r (i32.add (local.get $r) (i32.const 1)))
        (br $loop_r))))

  ;; Wait while *addr == expected (timeout -1 = forever). Returns 0 ok, 1 not-equal, 2 timed out.
  (func (export "wait") (param $addr i32) (param $expected i32) (result i32)
    (memory.atomic.wait32 (local.get $addr) (local.get $expected) (i64.const -1)))

  (func (export "notify") (param $addr i32) (result i32)
    (memory.atomic.notify (local.get $addr) (i32.const 1)))

  (func (export "store") (param $addr i32) (param $v i32)
    (i32.atomic.store (local.get $addr) (local.get $v)))

  (func (export "load") (param $addr i32) (result i32)
    (i32.atomic.load (local.get $addr)))
)
