;; lumenc: the Lumen-mu (integer subset) compiler, in WebAssembly text.
;; Zero-legacy: WAT is a compilation substrate, not a high-level language. Disposable seed.
;;
;; Pipeline: host writes source bytes at SRC_BASE -> $lex (tokenizer) -> $c_program
;; (recursive-descent parser that emits IR directly, with JZ backpatching and a function
;; symbol table) -> $run (the bytecode interpreter). Exported: compile_and_run(srclen).
;;
;; Subset: fn / params / let+var locals / if [else] / while / return / Int + Text types /
;; arithmetic (+ - * / %) / comparison (< <= > >= == !=) / string literals ("..\n") /
;; function calls (ANY order: forward references and mutual recursion via a fixup table) /
;; sum types (`type T = | A | B(F)`), the built-in Result with ok/err, `match` (incl.
;; nested + binding + `_`), and the non-coercing `?` operator / console.print(text),
;; console.print_int(int), int_to_text(int), text_concat(a,b), text_eq(a,b).
;; Compile errors recorded for the CLI. SAFETY: the compiler and interpreter always
;; terminate (parser forward-progress + EOF guards; interpreter fuel cap).
;;
;; Frame model: a call's args occupy frame slots [0,nparam); `let` locals occupy
;; [nparam, nparam+nlocal). RESERVE sizes the frame at entry; GETARG reads any slot;
;; SETLOCAL writes a local slot. RET discards the whole frame and pushes the result.
;;
;; Memory map (bytes). Region sizes are constants, trivially enlarged if a program needs more.
;;   [1024 .. 9216)    operand stack (i64 slots; 1024 frames deep)
;;   [9216 .. 11264)   call stack (i32 pairs: return_pc, prev_argbase; 256 deep)
;;   [11264 .. 11328)  itoa text buffer (ANCHOR 11326)
;;   [11328 .. 100000) CODE (emitted IR words; ~2167)
;;   [100000 .. 170000) SRC (source bytes, host-written; 10 KB)
;;   [170000 .. 177000) SYMBOLS (name_off, name_len, entry) = 12 bytes each (~583 fns)
;;   [177000 .. 177500) PARAMS of current fn (name_off, name_len) = 8 bytes each (~62)
;;   [177500 .. 178000) LOCALS of current fn (name_off, name_len) = 8 bytes each (~62)
;;   [178000 .. 248000) free; builtin op-name literals at 180000 (band/bor/bxor/shl/shr/bnot)
;;                      because the keyword region below is full and abuts the nvariant table
;;   [248000 .. 248400] keyword literals (data) + nvariant table
;;   [249000 .. 286000) call-target FIXUPS (code_pos, name_off, name_len) = 12 bytes each
;;   [286000 .. 296000) DIAG: compile-error records (code, name_off, name_len) = 12 bytes each
;;   [296000 .. 488000) TOKENS (kind:i32, a:i32, b:i32) = 12 bytes each (~16000)
;;   [488000 .. 524288) HEAP: Text objects [len:i32][utf8 bytes]; bump-allocated via $hp.
;;                     COUPLING: emit_fn.lm emits LM_CAP_BYTES = 524288 - 488000 = 36288 (the
;;                     interpreter's exact byte capacity; its halt gate mirrors the unrounded
;;                     byte cursor). ANY change to the heap base MUST update that constant and
;;                     re-run native/heapcap_test.mjs (halt-parity gate).
;;                     Compile materializes string literals here; run continues above them.
(module
  (import "lumen" "console_print" (func $console_print (param i32 i32)))
  (memory (export "mem") 128)   ;; page 9 [524288..589824) holds the compile-time type tables (slot/return types); pages above it are runtime scratch (the HTTP serve kernel's request/route/body/output windows live in [590000..8388608), matching the native LMEM_CAP)

  (data (i32.const 248000) "fn")
  (data (i32.const 248010) "if")
  (data (i32.const 248020) "else")
  (data (i32.const 248030) "return")
  (data (i32.const 248040) "print_int")
  (data (i32.const 248050) "while")
  (data (i32.const 248060) "main")
  (data (i32.const 248070) "let")
  (data (i32.const 248080) "var")
  (data (i32.const 248090) "Unit")
  (data (i32.const 248100) "int_to_text")
  (data (i32.const 248120) "text_concat")
  (data (i32.const 248140) "print")
  (data (i32.const 248150) "type")
  (data (i32.const 248160) "match")
  (data (i32.const 248170) "text_eq")
  (data (i32.const 248180) "ok")
  (data (i32.const 248190) "err")
  (data (i32.const 248200) "and")
  (data (i32.const 248210) "or")
  (data (i32.const 248220) "not")
  (data (i32.const 248230) "Float")
  (data (i32.const 248240) "to_int")
  (data (i32.const 248250) "round")
  (data (i32.const 248260) "to_float")
  (data (i32.const 248270) "sqrt")
  (data (i32.const 248280) "exp")
  (data (i32.const 248290) "ln")
  (data (i32.const 248300) "pow")
  (data (i32.const 248310) "abs")
  (data (i32.const 248320) "array")
  (data (i32.const 248330) "aget")
  (data (i32.const 248340) "aset")
  (data (i32.const 248350) "alen")
  (data (i32.const 248360) "load32")
  (data (i32.const 248370) "store32")
  (data (i32.const 248380) "load8")
  (data (i32.const 248390) "store8")
  ;; bitwise builtin names. The keyword region [248000..248400] is full and abuts the runtime
  ;; nvariant table at 248400, so these live in the free gap [178000..248000) (see memory map);
  ;; $eqlit compares source tokens against these bytes at any address.
  (data (i32.const 180000) "band")
  (data (i32.const 180016) "bor")
  (data (i32.const 180032) "bxor")
  (data (i32.const 180048) "shl")
  (data (i32.const 180064) "shr")
  (data (i32.const 180080) "bnot")
  ;; Dec (exact decimal, D1): the type keyword + its three builtin names, same free-gap
  ;; convention as the bitwise names above (16-byte slots, keyword region [248000..248400)
  ;; is full).
  (data (i32.const 180096) "Dec")
  (data (i32.const 180112) "dec_div")
  (data (i32.const 180128) "dec_to_text")
  (data (i32.const 180144) "dec_to_float")

  (global $osp     (mut i32) (i32.const 0))
  (global $csp     (mut i32) (i32.const 0))
  (global $argbase (mut i32) (i32.const 0))
  (global $pc      (mut i32) (i32.const 0))
  (global $emit    (mut i32) (i32.const 0))   ;; next free CODE word index
  (global $tp      (mut i32) (i32.const 0))   ;; token parse pointer
  (global $ntok    (mut i32) (i32.const 0))
  (global $nsym    (mut i32) (i32.const 0))
  (global $nparam  (mut i32) (i32.const 0))
  (global $nlocal  (mut i32) (i32.const 0))   ;; local (let) count of current fn
  (global $nfixup  (mut i32) (i32.const 0))   ;; pending call-target fixups (forward refs)
  (global $nerr    (mut i32) (i32.const 0))   ;; compile errors (unknown name); records at [90000)
  (global $hp      (mut i32) (i32.const 488000))   ;; heap bump pointer (Text objects)
  (global $main_entry (mut i32) (i32.const 0))
  (global $fuel_max (mut i64) (i64.const 4000000000))   ;; SAFETY: interpreter step cap (overridable via set_fuel_max)
  (global $nvariant (mut i32) (i32.const 0))   ;; sum-type variants; table at [52400), 12 bytes (name_off, name_len, tag)
  (global $ety (mut i32) (i32.const 0))   ;; type of the value the last-compiled expression leaves on the stack: 0=Int, 1=Float
  (global $nfield (mut i32) (i32.const 0))   ;; record field registry count; table at [528000) (off,len,index,type) 16 bytes
  (global $nrec (mut i32) (i32.const 0))      ;; record-type count; table at [533632) (off,len,size) 12 bytes
  (global $discard_slot (mut i32) (i32.const 0))
  (global $expr_pushes (mut i32) (i32.const 0))
  (global $cur_fn_is_unit (mut i32) (i32.const 1))
  (global $prof (mut i32) (i32.const 0))          ;; profiling on/off flag
  (global $last_steps (mut i64) (i64.const 0))    ;; exact fuel/step count of the most recent $run
  ;; Dec (D1) runtime scratch: a return channel for the two-output helpers below (this WAT
  ;; module never uses multi-value function results, so a scratch-global pair is the
  ;; established, toolchain-version-safe way to hand back a second value).
  (global $dec_hi (mut i64) (i64.const 0))        ;; $mul128 high 64 bits
  (global $dec_lo (mut i64) (i64.const 0))        ;; $mul128 low 64 bits
  (global $dec_q  (mut i64) (i64.const 0))        ;; $divmod128by64 quotient
  (global $dec_r  (mut i64) (i64.const 0))        ;; $divmod128by64 remainder
  (global $dec_qoverflow (mut i32) (i32.const 0)) ;; $divmod128by64: 1 if the true quotient needs >64 bits

  ;; ---------- small helpers ----------
  (func $b (param $i i32) (result i32)
    (i32.load8_u (i32.add (i32.const 100000) (local.get $i))))
  (func $is_digit (param $c i32) (result i32)
    (i32.and (i32.ge_u (local.get $c) (i32.const 48)) (i32.le_u (local.get $c) (i32.const 57))))
  (func $is_alpha (param $c i32) (result i32)
    (i32.or
      (i32.or (i32.and (i32.ge_u (local.get $c) (i32.const 65)) (i32.le_u (local.get $c) (i32.const 90)))
              (i32.and (i32.ge_u (local.get $c) (i32.const 97)) (i32.le_u (local.get $c) (i32.const 122))))
      (i32.eq (local.get $c) (i32.const 95))))
  ;; Dec (D1): true if source byte $i is 'd' AND not immediately followed by an
  ;; identifier-continuation character, so a number directly abutting an identifier (e.g. a
  ;; typo like `1death`) is not silently swallowed as DEC(1) + garbage; it lexes as before
  ;; (INT then IDENT) and fails to parse, same as it always has.
  (func $is_d_suffix (param $i i32) (param $srclen i32) (result i32)
    (if (i32.ge_u (local.get $i) (local.get $srclen)) (then (return (i32.const 0))))
    (if (i32.ne (call $b (local.get $i)) (i32.const 100)) (then (return (i32.const 0))))
    (if (i32.and (i32.lt_u (i32.add (local.get $i) (i32.const 1)) (local.get $srclen))
                 (i32.or (call $is_alpha (call $b (i32.add (local.get $i) (i32.const 1))))
                         (call $is_digit (call $b (i32.add (local.get $i) (i32.const 1))))))
      (then (return (i32.const 0))))
    (i32.const 1))
  (func $streq (param $p1 i32) (param $p2 i32) (param $len i32) (result i32)
    (local $i i32)
    (local.set $i (i32.const 0))
    (loop $l
      (if (i32.ge_u (local.get $i) (local.get $len)) (then (return (i32.const 1))))   ;; all bytes matched
      (if (i32.ne (i32.load8_u (i32.add (local.get $p1) (local.get $i)))
                  (i32.load8_u (i32.add (local.get $p2) (local.get $i))))
        (then (return (i32.const 0))))                                                 ;; mismatch
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l))
    (unreachable))
  (func $eqlit (param $off i32) (param $len i32) (param $p i32) (param $plen i32) (result i32)
    (if (i32.ne (local.get $len) (local.get $plen)) (then (return (i32.const 0))))
    (return (call $streq (local.get $off) (local.get $p) (local.get $len))))

  ;; token accessors. SAFETY: any index at or past $ntok reads as EOF (kind 14, payload 0),
  ;; so every `tk==14` guard correctly detects end-of-stream and no parser loop can walk
  ;; past the token region (which would be an out-of-bounds read).
  (func $tk (param $i i32) (result i32)
    (if (i32.ge_u (local.get $i) (global.get $ntok)) (then (return (i32.const 14))))
    (i32.load (i32.add (i32.const 296000) (i32.mul (local.get $i) (i32.const 12)))))
  (func $ta (param $i i32) (result i32)
    (if (i32.ge_u (local.get $i) (global.get $ntok)) (then (return (i32.const 0))))
    (i32.load (i32.add (i32.add (i32.const 296000) (i32.mul (local.get $i) (i32.const 12))) (i32.const 4))))
  (func $tb (param $i i32) (result i32)
    (if (i32.ge_u (local.get $i) (global.get $ntok)) (then (return (i32.const 0))))
    (i32.load (i32.add (i32.add (i32.const 296000) (i32.mul (local.get $i) (i32.const 12))) (i32.const 8))))
  (func $tokset (param $i i32) (param $k i32) (param $a i32) (param $bb i32)
    (local $base i32)
    (local.set $base (i32.add (i32.const 296000) (i32.mul (local.get $i) (i32.const 12))))
    (i32.store (local.get $base) (local.get $k))
    (i32.store (i32.add (local.get $base) (i32.const 4)) (local.get $a))
    (i32.store (i32.add (local.get $base) (i32.const 8)) (local.get $bb)))
  (func $kw_is (param $i i32) (param $p i32) (param $plen i32) (result i32)
    (if (i32.ne (call $tk (local.get $i)) (i32.const 1)) (then (return (i32.const 0))))
    (return (call $eqlit (call $ta (local.get $i)) (call $tb (local.get $i)) (local.get $p) (local.get $plen))))

  ;; symbol + param tables
  (func $sym_add (param $off i32) (param $len i32) (param $entry i32)
    (local $base i32)
    (if (i32.ge_u (global.get $nsym) (i32.const 512))
      (then
        (call $err_add (i32.const 3) (local.get $off) (local.get $len))
        (return)))
    (local.set $base (i32.add (i32.const 170000) (i32.mul (global.get $nsym) (i32.const 12))))
    (i32.store (local.get $base) (local.get $off))
    (i32.store (i32.add (local.get $base) (i32.const 4)) (local.get $len))
    (i32.store (i32.add (local.get $base) (i32.const 8)) (local.get $entry))
    (global.set $nsym (i32.add (global.get $nsym) (i32.const 1))))
  (func $sym_find (param $off i32) (param $len i32) (result i32)
    (local $k i32) (local $base i32)
    (local.set $k (i32.const 0))
    (block $done
      (loop $l
        (br_if $done (i32.ge_u (local.get $k) (global.get $nsym)))
        (local.set $base (i32.add (i32.const 170000) (i32.mul (local.get $k) (i32.const 12))))
        (if (call $eqlit (i32.load (local.get $base)) (i32.load (i32.add (local.get $base) (i32.const 4)))
                         (local.get $off) (local.get $len))
          (then (return (i32.load (i32.add (local.get $base) (i32.const 8))))))
        (local.set $k (i32.add (local.get $k) (i32.const 1)))
        (br $l)))
    (return (i32.const -1)))
  (func $param_add (param $off i32) (param $len i32)
    (local $base i32)
    (local.set $base (i32.add (i32.const 177000) (i32.mul (global.get $nparam) (i32.const 8))))
    (i32.store (local.get $base) (local.get $off))
    (i32.store (i32.add (local.get $base) (i32.const 4)) (local.get $len))
    (global.set $nparam (i32.add (global.get $nparam) (i32.const 1))))
  (func $param_find (param $off i32) (param $len i32) (result i32)
    (local $k i32) (local $base i32)
    (local.set $k (i32.const 0))
    (block $done
      (loop $l
        (br_if $done (i32.ge_u (local.get $k) (global.get $nparam)))
        (local.set $base (i32.add (i32.const 177000) (i32.mul (local.get $k) (i32.const 8))))
        (if (call $eqlit (i32.load (local.get $base)) (i32.load (i32.add (local.get $base) (i32.const 4)))
                         (local.get $off) (local.get $len))
          (then (return (local.get $k))))
        (local.set $k (i32.add (local.get $k) (i32.const 1)))
        (br $l)))
    (return (i32.const -1)))

  ;; locals (let bindings) table at [177500 .. 178000), 8 bytes each (name_off, name_len)
  (func $local_add (param $off i32) (param $len i32)
    (local $base i32)
    (local.set $base (i32.add (i32.const 177500) (i32.mul (global.get $nlocal) (i32.const 8))))
    (i32.store (local.get $base) (local.get $off))
    (i32.store (i32.add (local.get $base) (i32.const 4)) (local.get $len))
    (global.set $nlocal (i32.add (global.get $nlocal) (i32.const 1))))
  (func $local_find (param $off i32) (param $len i32) (result i32)
    (local $k i32) (local $base i32)
    ;; The locals table is flat and append-only for the whole function (no scope push/pop:
    ;; see the frame-model comment above, every `let` keeps a permanent slot). So when a name
    ;; is re-declared in a later sibling branch (e.g. the same `let t` in an `if` and its
    ;; `else if`), TWO entries share that name. Scan newest-first so a lookup resolves to the
    ;; nearest preceding declaration, not the oldest one (which may be a sibling branch's
    ;; stale, never-written-this-call slot).
    (local.set $k (i32.sub (global.get $nlocal) (i32.const 1)))
    (block $done
      (loop $l
        (br_if $done (i32.lt_s (local.get $k) (i32.const 0)))
        (local.set $base (i32.add (i32.const 177500) (i32.mul (local.get $k) (i32.const 8))))
        (if (call $eqlit (i32.load (local.get $base)) (i32.load (i32.add (local.get $base) (i32.const 4)))
                         (local.get $off) (local.get $len))
          (then (return (local.get $k))))
        (local.set $k (i32.sub (local.get $k) (i32.const 1)))
        (br $l)))
    (return (i32.const -1)))
  ;; resolve a name to a frame slot: params occupy [0,nparam), locals occupy [nparam, nparam+nlocal)
  (func $var_find (param $off i32) (param $len i32) (result i32)
    (local $s i32)
    (local.set $s (call $param_find (local.get $off) (local.get $len)))
    (if (i32.ge_s (local.get $s) (i32.const 0)) (then (return (local.get $s))))
    (local.set $s (call $local_find (local.get $off) (local.get $len)))
    (if (i32.ge_s (local.get $s) (i32.const 0)) (then (return (i32.add (global.get $nparam) (local.get $s)))))
    (return (i32.const -1)))

  ;; sum-type variant table at [52400 ..), 12 bytes each (name_off, name_len, tag).
  (func $variant_add (param $off i32) (param $len i32) (param $tag i32)
    (local $base i32)
    (local.set $base (i32.add (i32.const 248400) (i32.mul (global.get $nvariant) (i32.const 12))))
    (i32.store (local.get $base) (local.get $off))
    (i32.store (i32.add (local.get $base) (i32.const 4)) (local.get $len))
    (i32.store (i32.add (local.get $base) (i32.const 8)) (local.get $tag))
    (global.set $nvariant (i32.add (global.get $nvariant) (i32.const 1))))
  (func $variant_find (param $off i32) (param $len i32) (result i32)   ;; -> tag, or -1
    (local $k i32) (local $base i32)
    (local.set $k (i32.const 0))
    (block $done
      (loop $l
        (br_if $done (i32.ge_u (local.get $k) (global.get $nvariant)))
        (local.set $base (i32.add (i32.const 248400) (i32.mul (local.get $k) (i32.const 12))))
        (if (call $eqlit (i32.load (local.get $base)) (i32.load (i32.add (local.get $base) (i32.const 4)))
                         (local.get $off) (local.get $len))
          (then (return (i32.load (i32.add (local.get $base) (i32.const 8))))))
        (local.set $k (i32.add (local.get $k) (i32.const 1)))
        (br $l)))
    (return (i32.const -1)))
  ;; allocate an anonymous frame slot (scratch for match/?); returns its slot index.
  ;; Adds a real locals-table entry with name_len 0 so it never matches a named lookup
  ;; and the table stays dense (local_find scans [0,nlocal)).
  (func $tmp_local (result i32)
    (local $idx i32)
    (local.set $idx (i32.add (global.get $nparam) (global.get $nlocal)))
    (call $local_add (i32.const 0) (i32.const 0))
    (call $set_slot_type (local.get $idx) (i32.const 0))   ;; scratch slots are Int (sum ptrs / ints)
    (local.get $idx))

  ;; ---------- compile-time type tables (page 9) ----------
  ;; slot_types[s] (frame slot -> 0=Int / 1=Float) at [524288); sym_rettype[k] (symbol
  ;; index -> return type) at [526336). Both reset implicitly: slot_types is overwritten
  ;; per declared slot each function; sym_rettype per symbol as functions are declared.
  (func $set_slot_type (param $s i32) (param $t i32)
    (i32.store (i32.add (i32.const 524288) (i32.mul (local.get $s) (i32.const 4))) (local.get $t)))
  (func $slot_type (param $s i32) (result i32)
    (i32.load (i32.add (i32.const 524288) (i32.mul (local.get $s) (i32.const 4)))))
  (func $set_sym_rettype (param $k i32) (param $t i32)
    (i32.store (i32.add (i32.const 526336) (i32.mul (local.get $k) (i32.const 4))) (local.get $t)))
  ;; return type of a (possibly already-declared) function by name; 0 (Int) if unknown
  ;; (a forward reference is assumed Int until defined — a documented cycle-1 limitation).
  (func $sym_rettype_of (param $off i32) (param $len i32) (result i32)
    (local $k i32) (local $base i32)
    (local.set $k (i32.const 0))
    (block $done
      (loop $l
        (br_if $done (i32.ge_u (local.get $k) (global.get $nsym)))
        (local.set $base (i32.add (i32.const 170000) (i32.mul (local.get $k) (i32.const 12))))
        (if (call $eqlit (i32.load (local.get $base)) (i32.load (i32.add (local.get $base) (i32.const 4)))
                         (local.get $off) (local.get $len))
          (then (return (i32.load (i32.add (i32.const 526336) (i32.mul (local.get $k) (i32.const 4)))))))
        (local.set $k (i32.add (local.get $k) (i32.const 1)))
        (br $l)))
    (i32.const 0))
  ;; 1 if the CURRENT token is the type `Float`, else 0 (Int / any other type). Peeks, does not consume.
  (func $type_code (result i32)
    (if (call $kw_is (global.get $tp) (i32.const 248230) (i32.const 5)) (then (return (i32.const 1))))   ;; Float
    (if (call $kw_is (global.get $tp) (i32.const 180096) (i32.const 3)) (then (return (i32.const 2))))   ;; Dec
    (i32.const 0))

  ;; ---------- record / field registries (page 9) ----------
  ;; Records are compile-time sugar over arrays. A field NAME interns to a STABLE
  ;; global slot index (reused across record types), so `p.field` needs only the
  ;; field name, not p's type. field table [528000): (name_off, name_len, index, type)
  ;; 16 bytes. rec-type table [533632): (name_off, name_len, size) 12 bytes.
  (func $field_intern (param $off i32) (param $len i32) (param $type i32) (result i32)
    (local $k i32) (local $base i32)
    (local.set $k (i32.const 0))
    (block $done (loop $l
      (br_if $done (i32.ge_u (local.get $k) (global.get $nfield)))
      (local.set $base (i32.add (i32.const 528000) (i32.mul (local.get $k) (i32.const 16))))
      (if (call $eqlit (i32.load (local.get $base)) (i32.load (i32.add (local.get $base) (i32.const 4))) (local.get $off) (local.get $len))
        (then (return (i32.load (i32.add (local.get $base) (i32.const 8))))))
      (local.set $k (i32.add (local.get $k) (i32.const 1)))
      (br $l)))
    (local.set $base (i32.add (i32.const 528000) (i32.mul (global.get $nfield) (i32.const 16))))
    (i32.store (local.get $base) (local.get $off))
    (i32.store (i32.add (local.get $base) (i32.const 4)) (local.get $len))
    (i32.store (i32.add (local.get $base) (i32.const 8)) (global.get $nfield))
    (i32.store (i32.add (local.get $base) (i32.const 12)) (local.get $type))
    (local.set $k (global.get $nfield))
    (global.set $nfield (i32.add (global.get $nfield) (i32.const 1)))
    (local.get $k))
  (func $field_index (param $off i32) (param $len i32) (result i32)   ;; -1 if unknown
    (local $k i32) (local $base i32)
    (local.set $k (i32.const 0))
    (block $done (loop $l
      (br_if $done (i32.ge_u (local.get $k) (global.get $nfield)))
      (local.set $base (i32.add (i32.const 528000) (i32.mul (local.get $k) (i32.const 16))))
      (if (call $eqlit (i32.load (local.get $base)) (i32.load (i32.add (local.get $base) (i32.const 4))) (local.get $off) (local.get $len))
        (then (return (i32.load (i32.add (local.get $base) (i32.const 8))))))
      (local.set $k (i32.add (local.get $k) (i32.const 1)))
      (br $l)))
    (i32.const -1))
  (func $field_type (param $off i32) (param $len i32) (result i32)   ;; 0 if unknown
    (local $k i32) (local $base i32)
    (local.set $k (i32.const 0))
    (block $done (loop $l
      (br_if $done (i32.ge_u (local.get $k) (global.get $nfield)))
      (local.set $base (i32.add (i32.const 528000) (i32.mul (local.get $k) (i32.const 16))))
      (if (call $eqlit (i32.load (local.get $base)) (i32.load (i32.add (local.get $base) (i32.const 4))) (local.get $off) (local.get $len))
        (then (return (i32.load (i32.add (local.get $base) (i32.const 12))))))
      (local.set $k (i32.add (local.get $k) (i32.const 1)))
      (br $l)))
    (i32.const 0))
  (func $rec_add (param $off i32) (param $len i32) (param $size i32)
    (local $base i32)
    (local.set $base (i32.add (i32.const 533632) (i32.mul (global.get $nrec) (i32.const 12))))
    (i32.store (local.get $base) (local.get $off))
    (i32.store (i32.add (local.get $base) (i32.const 4)) (local.get $len))
    (i32.store (i32.add (local.get $base) (i32.const 8)) (local.get $size))
    (global.set $nrec (i32.add (global.get $nrec) (i32.const 1))))
  (func $rec_size (param $off i32) (param $len i32) (result i32)   ;; -1 if name is not a record type
    (local $k i32) (local $base i32)
    (local.set $k (i32.const 0))
    (block $done (loop $l
      (br_if $done (i32.ge_u (local.get $k) (global.get $nrec)))
      (local.set $base (i32.add (i32.const 533632) (i32.mul (local.get $k) (i32.const 12))))
      (if (call $eqlit (i32.load (local.get $base)) (i32.load (i32.add (local.get $base) (i32.const 4))) (local.get $off) (local.get $len))
        (then (return (i32.load (i32.add (local.get $base) (i32.const 8))))))
      (local.set $k (i32.add (local.get $k) (i32.const 1)))
      (br $l)))
    (i32.const -1))
  ;; parse a decimal float literal (bytes at absolute src addr `off`, length `len`, e.g.
  ;; "0.05") into an f64. Integer part + fractional part / 10^k. No exponent form yet.
  (func $parse_float (param $off i32) (param $len i32) (result f64)
    (local $i i32) (local $c i32) (local $ip i64) (local $fp i64) (local $div f64) (local $dot i32)
    (local.set $i (i32.const 0)) (local.set $ip (i64.const 0)) (local.set $fp (i64.const 0))
    (local.set $div (f64.const 1)) (local.set $dot (i32.const 0))
    (block $e (loop $l
      (br_if $e (i32.ge_u (local.get $i) (local.get $len)))
      (local.set $c (i32.load8_u (i32.add (local.get $off) (local.get $i))))
      (if (i32.eq (local.get $c) (i32.const 46))   ;; '.'
        (then (local.set $dot (i32.const 1)))
        (else
          (if (call $is_digit (local.get $c))
            (then
              (if (local.get $dot)
                (then (local.set $fp (i64.add (i64.mul (local.get $fp) (i64.const 10))
                                              (i64.extend_i32_u (i32.sub (local.get $c) (i32.const 48)))))
                      (local.set $div (f64.mul (local.get $div) (f64.const 10))))
                (else (local.set $ip (i64.add (i64.mul (local.get $ip) (i64.const 10))
                                              (i64.extend_i32_u (i32.sub (local.get $c) (i32.const 48)))))))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (f64.add (f64.convert_i64_u (local.get $ip))
             (f64.div (f64.convert_i64_u (local.get $fp)) (local.get $div))))

  ;; Dec (D1): parse a decimal literal's digit span (off,len; NOT including the trailing 'd'
  ;; suffix, e.g. "1.50" or "3" or "0.000001") into an EXACT i64 scaled by 1_000_000
  ;; (micro-units: int_part*1_000_000 + frac scaled to 6 digits). Deliberately pure integer
  ;; accumulation, NOT $parse_float's f64 arithmetic: exactness is the entire point of Dec,
  ;; and even one f64 division would silently reintroduce the rounding error Dec exists to
  ;; avoid. Errors recorded via err_add (execution continues with a 0 fallback, matching the
  ;; file's existing diagnose-and-keep-going convention, so a bad literal never aborts the
  ;; compiler): code 5 = more than 6 fractional digits, code 6 = magnitude does not fit in
  ;; i64 after scaling (the valid Dec range is [-(2^63-1), 2^63-1]: i64::MIN is deliberately
  ;; excluded so every Dec value can always be safely negated, one value out of 2^64 lost).
  (func $parse_dec_literal (param $off i32) (param $len i32) (result i64)
    (local $i i32) (local $c i32) (local $d i64) (local $digit i64)
    (local $dot i32) (local $fdigits i32) (local $overflow i32) (local $pad i32)
    (local.set $i (i32.const 0)) (local.set $d (i64.const 0))
    (local.set $dot (i32.const 0)) (local.set $fdigits (i32.const 0)) (local.set $overflow (i32.const 0))
    (block $e (loop $l
      (br_if $e (i32.ge_u (local.get $i) (local.get $len)))
      (local.set $c (i32.load8_u (i32.add (local.get $off) (local.get $i))))
      (if (i32.eq (local.get $c) (i32.const 46))   ;; '.'
        (then (local.set $dot (i32.const 1)))
        (else
          (local.set $digit (i64.extend_i32_u (i32.sub (local.get $c) (i32.const 48))))
          (if (local.get $dot) (then (local.set $fdigits (i32.add (local.get $fdigits) (i32.const 1)))))
          ;; overflow-safe accumulate: d > (I64_MAX - digit)/10  <=>  d*10+digit would overflow
          (if (i64.gt_s (local.get $d) (i64.div_s (i64.sub (i64.const 9223372036854775807) (local.get $digit)) (i64.const 10)))
            (then (local.set $overflow (i32.const 1)))
            (else (local.set $d (i64.add (i64.mul (local.get $d) (i64.const 10)) (local.get $digit)))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (if (i32.gt_u (local.get $fdigits) (i32.const 6))
      (then (call $err_add (i32.const 5) (local.get $off) (local.get $len)) (return (i64.const 0))))
    (if (local.get $overflow)
      (then (call $err_add (i32.const 6) (local.get $off) (local.get $len)) (return (i64.const 0))))
    ;; pad the accumulated digits up to exactly 6 fractional digits (e.g. "1.5" -> d=15,
    ;; pad=5 more zeros -> 1500000), with the same overflow guard on each multiply.
    (local.set $pad (i32.sub (i32.const 6) (local.get $fdigits)))
    (block $pe (loop $pl
      (br_if $pe (i32.le_s (local.get $pad) (i32.const 0)))
      (if (i64.gt_s (local.get $d) (i64.div_s (i64.const 9223372036854775807) (i64.const 10)))
        (then (local.set $overflow (i32.const 1)) (br $pe))
        (else (local.set $d (i64.mul (local.get $d) (i64.const 10)))))
      (local.set $pad (i32.sub (local.get $pad) (i32.const 1)))
      (br $pl)))
    (if (local.get $overflow)
      (then (call $err_add (i32.const 6) (local.get $off) (local.get $len)) (return (i64.const 0))))
    (local.get $d))

  ;; Dec (D1): exact unsigned 64x64->128 multiply via 32-bit limb decomposition (the
  ;; Hacker's Delight technique: every partial product and intermediate sum is proven to fit
  ;; in 64 bits, so no step needs a wider-than-64-bit register). u,v are magnitudes (the
  ;; caller has already stripped any sign). Writes the 128-bit result to $dec_hi:$dec_lo.
  (func $mul128 (param $u i64) (param $v i64)
    (local $u0 i64) (local $u1 i64) (local $v0 i64) (local $v1 i64)
    (local $w0 i64) (local $t i64) (local $w1 i64) (local $w2 i64)
    (local.set $u0 (i64.and (local.get $u) (i64.const 0xFFFFFFFF)))
    (local.set $u1 (i64.shr_u (local.get $u) (i64.const 32)))
    (local.set $v0 (i64.and (local.get $v) (i64.const 0xFFFFFFFF)))
    (local.set $v1 (i64.shr_u (local.get $v) (i64.const 32)))
    (local.set $w0 (i64.mul (local.get $u0) (local.get $v0)))
    (local.set $t  (i64.add (i64.mul (local.get $u1) (local.get $v0)) (i64.shr_u (local.get $w0) (i64.const 32))))
    (local.set $w1 (i64.and (local.get $t) (i64.const 0xFFFFFFFF)))
    (local.set $w2 (i64.shr_u (local.get $t) (i64.const 32)))
    (local.set $w1 (i64.add (i64.mul (local.get $u0) (local.get $v1)) (local.get $w1)))
    (global.set $dec_hi (i64.add (i64.add (i64.mul (local.get $u1) (local.get $v1)) (local.get $w2)) (i64.shr_u (local.get $w1) (i64.const 32))))
    (global.set $dec_lo (i64.or (i64.shl (local.get $w1) (i64.const 32)) (i64.and (local.get $w0) (i64.const 0xFFFFFFFF)))))

  ;; Dec (D1): unsigned 128-bit (hi:lo) / 64-bit d (d != 0) -> quotient + remainder, via
  ;; classic bit-by-bit restoring binary long division. Correct by construction regardless
  ;; of the divisor's magnitude (unlike a word-at-a-time scheme, which would only be safe
  ;; for a small divisor) — this is what lets DMUL (divide by the constant 1_000_000) and
  ;; DDIV (divide by an arbitrary Dec magnitude) share one division primitive. Writes the
  ;; quotient to $dec_q and remainder to $dec_r; sets $dec_qoverflow if the true quotient
  ;; needs more than 64 bits (detected by catching a 1-bit that would be shifted out of the
  ;; 64-bit quotient register — the accumulator's sign bit already set before a left-shift
  ;; means a bit is about to be lost).
  (func $divmod128by64 (param $hi i64) (param $lo i64) (param $d i64)
    (local $r i64) (local $q i64) (local $i i32) (local $bit i64) (local $qoverflow i32)
    (local.set $r (i64.const 0)) (local.set $q (i64.const 0)) (local.set $i (i32.const 127))
    (local.set $qoverflow (i32.const 0))
    (block $e (loop $l
      (br_if $e (i32.lt_s (local.get $i) (i32.const 0)))
      (if (i32.ge_s (local.get $i) (i32.const 64))
        (then (local.set $bit (i64.and (i64.shr_u (local.get $hi) (i64.extend_i32_u (i32.sub (local.get $i) (i32.const 64)))) (i64.const 1))))
        (else (local.set $bit (i64.and (i64.shr_u (local.get $lo) (i64.extend_i32_u (local.get $i))) (i64.const 1)))))
      (local.set $r (i64.or (i64.shl (local.get $r) (i64.const 1)) (local.get $bit)))
      (if (i64.lt_s (local.get $q) (i64.const 0)) (then (local.set $qoverflow (i32.const 1))))   ;; top bit set: next shift loses it
      (local.set $q (i64.shl (local.get $q) (i64.const 1)))
      (if (i64.ge_u (local.get $r) (local.get $d))
        (then (local.set $r (i64.sub (local.get $r) (local.get $d))) (local.set $q (i64.or (local.get $q) (i64.const 1)))))
      (local.set $i (i32.sub (local.get $i) (i32.const 1)))
      (br $l)))
    (global.set $dec_q (local.get $q)) (global.set $dec_r (local.get $r)) (global.set $dec_qoverflow (local.get $qoverflow)))

  ;; Dec (D1): a*b, exact 128-bit product then round_half_even(.../1_000_000). Half-even is
  ;; sign-symmetric: compute on magnitudes, apply sign after (equivalent to Python decimal's
  ;; ROUND_HALF_EVEN). Traps (unreachable, mirroring how the interpreter already lets i64
  ;; div_s/rem_s trap on divide-by-zero: a deliberate trap is the established idiom for a
  ;; deterministic runtime failure here) if the final magnitude exceeds the valid Dec range.
  (func $dec_mul (param $a i64) (param $b i64) (result i64)
    (local $neg i32) (local $q i64) (local $r i64)
    (local.set $neg (i32.const 0))
    (if (i64.lt_s (local.get $a) (i64.const 0)) (then (local.set $neg (i32.xor (local.get $neg) (i32.const 1))) (local.set $a (i64.sub (i64.const 0) (local.get $a)))))
    (if (i64.lt_s (local.get $b) (i64.const 0)) (then (local.set $neg (i32.xor (local.get $neg) (i32.const 1))) (local.set $b (i64.sub (i64.const 0) (local.get $b)))))
    (call $mul128 (local.get $a) (local.get $b))
    (call $divmod128by64 (global.get $dec_hi) (global.get $dec_lo) (i64.const 1000000))
    (if (global.get $dec_qoverflow) (then (unreachable)))
    (local.set $q (global.get $dec_q)) (local.set $r (global.get $dec_r))
    (local.set $r (i64.mul (local.get $r) (i64.const 2)))
    (if (i64.gt_u (local.get $r) (i64.const 1000000))
      (then (local.set $q (i64.add (local.get $q) (i64.const 1))))
      (else (if (i64.eq (local.get $r) (i64.const 1000000))
        (then (if (i64.ne (i64.and (local.get $q) (i64.const 1)) (i64.const 0)) (then (local.set $q (i64.add (local.get $q) (i64.const 1)))))))))
    (if (i64.gt_u (local.get $q) (i64.const 9223372036854775807)) (then (unreachable)))
    (if (local.get $neg) (then (return (i64.sub (i64.const 0) (local.get $q)))))
    (local.get $q))

  ;; Dec (D1): dec_div(a,b) = round_half_even(a * 1_000_000 / b). b==0 traps (mirrors the
  ;; interpreter's existing native div-by-zero trap for Int /). Same sign/magnitude/overflow
  ;; discipline as $dec_mul.
  (func $dec_div (param $a i64) (param $b i64) (result i64)
    (local $neg i32) (local $q i64) (local $r i64)
    (if (i64.eqz (local.get $b)) (then (unreachable)))
    (local.set $neg (i32.const 0))
    (if (i64.lt_s (local.get $a) (i64.const 0)) (then (local.set $neg (i32.xor (local.get $neg) (i32.const 1))) (local.set $a (i64.sub (i64.const 0) (local.get $a)))))
    (if (i64.lt_s (local.get $b) (i64.const 0)) (then (local.set $neg (i32.xor (local.get $neg) (i32.const 1))) (local.set $b (i64.sub (i64.const 0) (local.get $b)))))
    (call $mul128 (local.get $a) (i64.const 1000000))
    (call $divmod128by64 (global.get $dec_hi) (global.get $dec_lo) (local.get $b))
    (if (global.get $dec_qoverflow) (then (unreachable)))
    (local.set $q (global.get $dec_q)) (local.set $r (global.get $dec_r))
    (local.set $r (i64.mul (local.get $r) (i64.const 2)))
    (if (i64.gt_u (local.get $r) (local.get $b))
      (then (local.set $q (i64.add (local.get $q) (i64.const 1))))
      (else (if (i64.eq (local.get $r) (local.get $b))
        (then (if (i64.ne (i64.and (local.get $q) (i64.const 1)) (i64.const 0)) (then (local.set $q (i64.add (local.get $q) (i64.const 1)))))))))
    (if (i64.gt_u (local.get $q) (i64.const 9223372036854775807)) (then (unreachable)))
    (if (local.get $neg) (then (return (i64.sub (i64.const 0) (local.get $q)))))
    (local.get $q))

  ;; compile-error records at [90000 ..), 12 bytes each (code, name_off, name_len).
  ;; code 1 = unknown variable, code 2 = unknown function.
  (func $err_add (param $code i32) (param $off i32) (param $len i32)
    (local $base i32)
    (if (i32.ge_u (global.get $nerr) (i32.const 800)) (then (return)))
    (local.set $base (i32.add (i32.const 286000) (i32.mul (global.get $nerr) (i32.const 12))))
    (i32.store (local.get $base) (local.get $code))
    (i32.store (i32.add (local.get $base) (i32.const 4)) (local.get $off))
    (i32.store (i32.add (local.get $base) (i32.const 8)) (local.get $len))
    (global.set $nerr (i32.add (global.get $nerr) (i32.const 1))))

  ;; call-target fixups at [53000 ..), 12 bytes each (code_pos, name_off, name_len).
  ;; Every CALL records one; all are resolved after the whole program is parsed, so a
  ;; function may be CALLed before it is defined (forward refs, mutual recursion).
  (func $fixup_add (param $pos i32) (param $off i32) (param $len i32)
    (local $base i32)
    (local.set $base (i32.add (i32.const 249000) (i32.mul (global.get $nfixup) (i32.const 12))))
    (i32.store (local.get $base) (local.get $pos))
    (i32.store (i32.add (local.get $base) (i32.const 4)) (local.get $off))
    (i32.store (i32.add (local.get $base) (i32.const 8)) (local.get $len))
    (global.set $nfixup (i32.add (global.get $nfixup) (i32.const 1))))
  (func $resolve_fixups
    (local $k i32) (local $base i32) (local $off i32) (local $len i32) (local $entry i32)
    (local.set $k (i32.const 0))
    (block $done
      (loop $l
        (br_if $done (i32.ge_u (local.get $k) (global.get $nfixup)))
        (local.set $base (i32.add (i32.const 249000) (i32.mul (local.get $k) (i32.const 12))))
        (local.set $off (i32.load (i32.add (local.get $base) (i32.const 4))))
        (local.set $len (i32.load (i32.add (local.get $base) (i32.const 8))))
        (local.set $entry (call $sym_find (local.get $off) (local.get $len)))
        (if (i32.lt_s (local.get $entry) (i32.const 0))   ;; unknown function
          (then (call $err_add (i32.const 2) (local.get $off) (local.get $len)) (local.set $entry (i32.const 0))))
        (call $patch (i32.load (local.get $base)) (local.get $entry))
        (local.set $k (i32.add (local.get $k) (i32.const 1)))
        (br $l))))

  ;; code emit
  (func $emitw (param $v i32)
    (i32.store (i32.add (i32.const 11328) (i32.mul (global.get $emit) (i32.const 4))) (local.get $v))
    (global.set $emit (i32.add (global.get $emit) (i32.const 1))))
  (func $patch (param $idx i32) (param $v i32)
    (i32.store (i32.add (i32.const 11328) (i32.mul (local.get $idx) (i32.const 4))) (local.get $v)))
  (func $adv (global.set $tp (i32.add (global.get $tp) (i32.const 1))))

  ;; ---------- heap / Text helpers ----------
  ;; a Text value is a heap pointer to [len:i32][utf8 bytes...]
  (func $halloc (param $size i32) (result i32)
    (local $p i32)
    (local.set $p (global.get $hp))
    (global.set $hp (i32.add (global.get $hp) (local.get $size)))
    (local.get $p))
  ;; compile-time: materialize a string-literal token (raw bytes at off, length len, with \n escape)
  ;; into a heap Text object; return its pointer (emitted as the MKTEXT operand).
  (func $mktext_lit (param $off i32) (param $len i32) (result i32)
    (local $ptr i32) (local $w i32) (local $i i32) (local $c i32)
    (local.set $ptr (global.get $hp))
    (local.set $w (i32.add (local.get $ptr) (i32.const 4)))
    (local.set $i (i32.const 0))
    (block $e
      (loop $l
        (br_if $e (i32.ge_u (local.get $i) (local.get $len)))
        (local.set $c (i32.load8_u (i32.add (local.get $off) (local.get $i))))
        (if (i32.and (i32.eq (local.get $c) (i32.const 92))   ;; '\'
                     (i32.lt_u (i32.add (local.get $i) (i32.const 1)) (local.get $len)))
          (then
            (if (i32.eq (i32.load8_u (i32.add (local.get $off) (i32.add (local.get $i) (i32.const 1)))) (i32.const 110))   ;; 'n'
              (then (local.set $c (i32.const 10)) (local.set $i (i32.add (local.get $i) (i32.const 1)))))))
        (i32.store8 (local.get $w) (local.get $c))
        (local.set $w (i32.add (local.get $w) (i32.const 1)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $l)))
    (i32.store (local.get $ptr) (i32.sub (local.get $w) (i32.add (local.get $ptr) (i32.const 4))))
    (global.set $hp (local.get $w))
    (local.get $ptr))
  ;; runtime: int -> Text (decimal, with sign, no newline)
  (func $int2text (param $v i64) (result i32)
    (local $neg i32) (local $nd i32) (local $tmp i64) (local $ptr i32) (local $w i32) (local $len i32)
    (local.set $neg (i32.const 0))
    (if (i64.lt_s (local.get $v) (i64.const 0))
      (then (local.set $neg (i32.const 1)) (local.set $v (i64.sub (i64.const 0) (local.get $v)))))
    (local.set $nd (i32.const 1)) (local.set $tmp (local.get $v))
    (block $ce (loop $cl
      (local.set $tmp (i64.div_u (local.get $tmp) (i64.const 10)))
      (br_if $ce (i64.eqz (local.get $tmp)))
      (local.set $nd (i32.add (local.get $nd) (i32.const 1)))
      (br $cl)))
    (local.set $len (i32.add (local.get $nd) (local.get $neg)))
    (local.set $ptr (call $halloc (i32.add (i32.const 4) (local.get $len))))
    (i32.store (local.get $ptr) (local.get $len))
    (local.set $w (i32.add (i32.add (local.get $ptr) (i32.const 4)) (local.get $len)))
    (block $we (loop $wl
      (local.set $w (i32.sub (local.get $w) (i32.const 1)))
      (i32.store8 (local.get $w) (i32.add (i32.const 48) (i32.wrap_i64 (i64.rem_u (local.get $v) (i64.const 10)))))
      (local.set $v (i64.div_u (local.get $v) (i64.const 10)))
      (br_if $we (i64.eqz (local.get $v)))
      (br $wl)))
    (if (local.get $neg) (then (i32.store8 (i32.add (local.get $ptr) (i32.const 4)) (i32.const 45))))
    (local.get $ptr))
  ;; Dec (D1): runtime Dec (i64, scale 1e-6) -> Text, canonical form. Trailing fractional
  ;; zeros are trimmed but at least one fractional digit always remains ("3.0", not "3"),
  ;; matching a decimal literal's own shape. i64::MIN is unreachable here (see the range
  ;; note on $parse_dec_literal), so negation is always safe.
  (func $dec2text (param $v i64) (result i32)
    (local $neg i32) (local $ip i64) (local $fp i64) (local $nd i32) (local $tmp i64)
    (local $flen i32) (local $probe i64) (local $len i32) (local $ptr i32) (local $w i32)
    (local.set $neg (i32.const 0))
    (if (i64.lt_s (local.get $v) (i64.const 0))
      (then (local.set $neg (i32.const 1)) (local.set $v (i64.sub (i64.const 0) (local.get $v)))))
    (local.set $ip (i64.div_s (local.get $v) (i64.const 1000000)))
    (local.set $fp (i64.rem_s (local.get $v) (i64.const 1000000)))
    ;; count int-part digits (at least 1, so "0.1" prints its leading "0")
    (local.set $nd (i32.const 1)) (local.set $tmp (local.get $ip))
    (block $ce (loop $cl
      (local.set $tmp (i64.div_s (local.get $tmp) (i64.const 10)))
      (br_if $ce (i64.eqz (local.get $tmp)))
      (local.set $nd (i32.add (local.get $nd) (i32.const 1)))
      (br $cl)))
    ;; trim trailing zero fractional digits, keep at least 1 (flen = digits to print; probe
    ;; = fp with those trimmed zeros already divided out, so probe IS the value to print)
    (local.set $flen (i32.const 6)) (local.set $probe (local.get $fp))
    (block $te (loop $tl
      (br_if $te (i32.le_s (local.get $flen) (i32.const 1)))
      (br_if $te (i64.ne (i64.rem_s (local.get $probe) (i64.const 10)) (i64.const 0)))
      (local.set $probe (i64.div_s (local.get $probe) (i64.const 10)))
      (local.set $flen (i32.sub (local.get $flen) (i32.const 1)))
      (br $tl)))
    (local.set $len (i32.add (i32.add (i32.add (local.get $neg) (local.get $nd)) (i32.const 1)) (local.get $flen)))
    (local.set $ptr (call $halloc (i32.add (i32.const 4) (local.get $len))))
    (i32.store (local.get $ptr) (local.get $len))
    ;; write right to left: fractional digits (fixed flen iterations -> leading zeros within
    ;; the field are preserved, e.g. probe=5 flen=2 prints "05"), then '.', then int digits.
    (local.set $w (i32.add (i32.add (local.get $ptr) (i32.const 4)) (local.get $len)))
    (block $fwe (loop $fwl
      (br_if $fwe (i32.eqz (local.get $flen)))
      (local.set $w (i32.sub (local.get $w) (i32.const 1)))
      (i32.store8 (local.get $w) (i32.add (i32.const 48) (i32.wrap_i64 (i64.rem_s (local.get $probe) (i64.const 10)))))
      (local.set $probe (i64.div_s (local.get $probe) (i64.const 10)))
      (local.set $flen (i32.sub (local.get $flen) (i32.const 1)))
      (br $fwl)))
    (local.set $w (i32.sub (local.get $w) (i32.const 1)))
    (i32.store8 (local.get $w) (i32.const 46))   ;; '.'
    (block $iwe (loop $iwl
      (br_if $iwe (i32.eqz (local.get $nd)))
      (local.set $w (i32.sub (local.get $w) (i32.const 1)))
      (i32.store8 (local.get $w) (i32.add (i32.const 48) (i32.wrap_i64 (i64.rem_s (local.get $ip) (i64.const 10)))))
      (local.set $ip (i64.div_s (local.get $ip) (i64.const 10)))
      (local.set $nd (i32.sub (local.get $nd) (i32.const 1)))
      (br $iwl)))
    (if (local.get $neg) (then (i32.store8 (i32.add (local.get $ptr) (i32.const 4)) (i32.const 45))))
    (local.get $ptr))
  ;; runtime: Text concat -> new Text
  (func $concat (param $pa i32) (param $pb i32) (result i32)
    (local $la i32) (local $lb i32) (local $ptr i32) (local $i i32)
    (local.set $la (i32.load (local.get $pa)))
    (local.set $lb (i32.load (local.get $pb)))
    (local.set $ptr (call $halloc (i32.add (i32.const 4) (i32.add (local.get $la) (local.get $lb)))))
    (i32.store (local.get $ptr) (i32.add (local.get $la) (local.get $lb)))
    (local.set $i (i32.const 0))
    (block $ae (loop $al (br_if $ae (i32.ge_u (local.get $i) (local.get $la)))
      (i32.store8 (i32.add (i32.add (local.get $ptr) (i32.const 4)) (local.get $i))
                  (i32.load8_u (i32.add (i32.add (local.get $pa) (i32.const 4)) (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $al)))
    (local.set $i (i32.const 0))
    (block $be (loop $bl (br_if $be (i32.ge_u (local.get $i) (local.get $lb)))
      (i32.store8 (i32.add (i32.add (i32.add (local.get $ptr) (i32.const 4)) (local.get $la)) (local.get $i))
                  (i32.load8_u (i32.add (i32.add (local.get $pb) (i32.const 4)) (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $bl)))
    (local.get $ptr))
  ;; runtime: Text equality (len-prefixed) -> 0/1
  (func $texteq (param $pa i32) (param $pb i32) (result i32)
    (local $la i32)
    (local.set $la (i32.load (local.get $pa)))
    (if (i32.ne (local.get $la) (i32.load (local.get $pb))) (then (return (i32.const 0))))
    (return (call $streq (i32.add (local.get $pa) (i32.const 4)) (i32.add (local.get $pb) (i32.const 4)) (local.get $la))))

  ;; ---------- tokenizer ----------
  (func $lex (param $srclen i32)
    (local $i i32) (local $n i32) (local $c i32) (local $start i32) (local $val i32)
    (local $ival i64)   ;; Bug #25: Int literal digit accumulator, widened to i64 (was i32,
                        ;; silently truncating any literal past ~2.1e9). $val (i32) stays for
                        ;; the unrelated single-char-token dispatch further down this function.
    (local.set $i (i32.const 0)) (local.set $n (i32.const 0))
    (block $end
      (loop $L
        (if (i32.ge_u (local.get $n) (i32.const 16000))
          (then
            (call $err_add (i32.const 3) (local.get $i) (i32.const 1))
            (br $end)))   ;; SAFETY: token-capacity guard (region [296000,488000) holds 16000; index 15999 ends at 487988 < HEAP@488000)
        ;; skip whitespace and comments
        (block $skipped
          (loop $sk
            (br_if $end (i32.ge_u (local.get $i) (local.get $srclen)))
            (local.set $c (call $b (local.get $i)))
            (if (i32.or (i32.or (i32.eq (local.get $c) (i32.const 32)) (i32.eq (local.get $c) (i32.const 10)))
                        (i32.or (i32.eq (local.get $c) (i32.const 9)) (i32.eq (local.get $c) (i32.const 13))))
              (then (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $sk)))
            (if (i32.eq (local.get $c) (i32.const 35))   ;; '#' comment
              (then
                (block $cend
                  (loop $cl
                    (br_if $cend (i32.ge_u (local.get $i) (local.get $srclen)))
                    (br_if $cend (i32.eq (call $b (local.get $i)) (i32.const 10)))
                    (local.set $i (i32.add (local.get $i) (i32.const 1)))
                    (br $cl)))
                (br $sk)))
            (br $skipped)))
        (br_if $end (i32.ge_u (local.get $i) (local.get $srclen)))
        (local.set $c (call $b (local.get $i)))
        ;; number (Int, or Float when a `.digit` fractional part follows)
        (if (call $is_digit (local.get $c))
          (then
            (local.set $start (local.get $i))
            (local.set $ival (i64.const 0))
            (block $de
              (loop $dl
                (br_if $de (i32.ge_u (local.get $i) (local.get $srclen)))
                (local.set $c (call $b (local.get $i)))
                (br_if $de (i32.eqz (call $is_digit (local.get $c))))
                ;; Bug #25: accumulate as i64 (was i32, silently wrapping past ~2.1e9). Scope is
                ;; 0..2^63-1 (magnitudes only; negation is a separate unary op elsewhere in this
                ;; function) - a literal with ~19+ digits still wraps here exactly like every
                ;; other Int overflow in this language (Int add/mul never trap), which is
                ;; accepted, documented behavior, not a new diagnostic surface.
                (local.set $ival (i64.add (i64.mul (local.get $ival) (i64.const 10))
                                           (i64.extend_i32_u (i32.sub (local.get $c) (i32.const 48)))))
                (local.set $i (i32.add (local.get $i) (i32.const 1)))
                (br $dl)))
            ;; Dec literal (D1)? an integer with no fraction, immediately followed by a 'd'
            ;; suffix (e.g. `3d`, `-3d` where the '-' is a separate unary-minus token).
            ;; Checked before the float '.' probe below so `3d` cannot be misread as
            ;; anything else; span excludes the 'd' (matches $parse_dec_literal's contract).
            (if (call $is_d_suffix (local.get $i) (local.get $srclen))
              (then
                (call $tokset (local.get $n) (i32.const 30)
                  (i32.add (i32.const 100000) (local.get $start)) (i32.sub (local.get $i) (local.get $start)))
                (local.set $i (i32.add (local.get $i) (i32.const 1)))   ;; consume 'd'
                (local.set $n (i32.add (local.get $n) (i32.const 1)))
                (br $L)))
            ;; float? a '.' immediately followed by a digit (so `x.method` stays Int + '.')
            (if (i32.and
                  (i32.and (i32.lt_u (local.get $i) (local.get $srclen))
                           (i32.eq (call $b (local.get $i)) (i32.const 46)))
                  (i32.and (i32.lt_u (i32.add (local.get $i) (i32.const 1)) (local.get $srclen))
                           (call $is_digit (call $b (i32.add (local.get $i) (i32.const 1))))))
              (then
                (local.set $i (i32.add (local.get $i) (i32.const 1)))   ;; consume '.'
                (block $fe
                  (loop $fl
                    (br_if $fe (i32.ge_u (local.get $i) (local.get $srclen)))
                    (br_if $fe (i32.eqz (call $is_digit (call $b (local.get $i)))))
                    (local.set $i (i32.add (local.get $i) (i32.const 1)))
                    (br $fl)))
                ;; Dec literal (D1)? same 'd'-suffix probe, now after the fractional digits.
                (if (call $is_d_suffix (local.get $i) (local.get $srclen))
                  (then
                    (call $tokset (local.get $n) (i32.const 30)
                      (i32.add (i32.const 100000) (local.get $start)) (i32.sub (local.get $i) (local.get $start)))
                    (local.set $i (i32.add (local.get $i) (i32.const 1)))   ;; consume 'd'
                    (local.set $n (i32.add (local.get $n) (i32.const 1)))
                    (br $L)))
                (call $tokset (local.get $n) (i32.const 29)
                  (i32.add (i32.const 100000) (local.get $start)) (i32.sub (local.get $i) (local.get $start)))
                (local.set $n (i32.add (local.get $n) (i32.const 1)))
                (br $L)))
            ;; Bug #25: a literal that fits i32 (the overwhelming majority) keeps the exact
            ;; single-PUSH encoding (kind 2, a=value, b=0) so every existing golden/census
            ;; program still compiles to byte-identical IR (no regolding). A literal outside
            ;; i32 range gets a new token kind (32) carrying its low/high 32-bit halves;
            ;; $c_primary reconstructs the i64 constant from those halves using only existing
            ;; opcodes (PUSH/SHL/SHR/BOR) - zero new opcodes.
            (if (i64.le_s (local.get $ival) (i64.const 2147483647))
              (then
                (call $tokset (local.get $n) (i32.const 2) (i32.wrap_i64 (local.get $ival)) (i32.const 0)))
              (else
                (call $tokset (local.get $n) (i32.const 32)
                  (i32.wrap_i64 (local.get $ival))
                  (i32.wrap_i64 (i64.shr_u (local.get $ival) (i64.const 32))))))
            (local.set $n (i32.add (local.get $n) (i32.const 1)))
            (br $L)))
        ;; identifier
        (if (call $is_alpha (local.get $c))
          (then
            (local.set $start (local.get $i))
            (block $ie
              (loop $il
                (br_if $ie (i32.ge_u (local.get $i) (local.get $srclen)))
                (local.set $c (call $b (local.get $i)))
                (br_if $ie (i32.eqz (i32.or (call $is_alpha (local.get $c)) (call $is_digit (local.get $c)))))
                (local.set $i (i32.add (local.get $i) (i32.const 1)))
                (br $il)))
            (call $tokset (local.get $n) (i32.const 1)
              (i32.add (i32.const 100000) (local.get $start)) (i32.sub (local.get $i) (local.get $start)))
            (local.set $n (i32.add (local.get $n) (i32.const 1)))
            (br $L)))
        ;; string literal "..."
        (if (i32.eq (local.get $c) (i32.const 34))   ;; '"'
          (then
            (local.set $i (i32.add (local.get $i) (i32.const 1)))   ;; skip opening quote
            (local.set $start (local.get $i))
            (block $se
              (loop $sl
                (br_if $se (i32.ge_u (local.get $i) (local.get $srclen)))
                (br_if $se (i32.eq (call $b (local.get $i)) (i32.const 34)))   ;; closing quote
                (local.set $i (i32.add (local.get $i) (i32.const 1)))
                (br $sl)))
            (call $tokset (local.get $n) (i32.const 20)
              (i32.add (i32.const 100000) (local.get $start)) (i32.sub (local.get $i) (local.get $start)))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))   ;; skip closing quote
            (local.set $n (i32.add (local.get $n) (i32.const 1)))
            (br $L)))
        ;; '-' or '->'
        (if (i32.eq (local.get $c) (i32.const 45))
          (then
            (if (i32.and (i32.lt_u (i32.add (local.get $i) (i32.const 1)) (local.get $srclen))
                         (i32.eq (call $b (i32.add (local.get $i) (i32.const 1))) (i32.const 62)))
              (then
                (call $tokset (local.get $n) (i32.const 9) (i32.const 0) (i32.const 0))
                (local.set $i (i32.add (local.get $i) (i32.const 2))))
              (else
                (call $tokset (local.get $n) (i32.const 11) (i32.const 0) (i32.const 0))
                (local.set $i (i32.add (local.get $i) (i32.const 1)))))
            (local.set $n (i32.add (local.get $n) (i32.const 1)))
            (br $L)))
        ;; comparison operators (two-char-aware): <  <=  >  >=  =  ==  !=
        (if (i32.eq (local.get $c) (i32.const 60))   ;; '<'
          (then
            (if (i32.and (i32.lt_u (i32.add (local.get $i) (i32.const 1)) (local.get $srclen))
                         (i32.eq (call $b (i32.add (local.get $i) (i32.const 1))) (i32.const 61)))
              (then (call $tokset (local.get $n) (i32.const 23) (i32.const 0) (i32.const 0)) (local.set $i (i32.add (local.get $i) (i32.const 2))))
              (else (call $tokset (local.get $n) (i32.const 12) (i32.const 0) (i32.const 0)) (local.set $i (i32.add (local.get $i) (i32.const 1)))))
            (local.set $n (i32.add (local.get $n) (i32.const 1))) (br $L)))
        (if (i32.eq (local.get $c) (i32.const 62))   ;; '>'
          (then
            (if (i32.and (i32.lt_u (i32.add (local.get $i) (i32.const 1)) (local.get $srclen))
                         (i32.eq (call $b (i32.add (local.get $i) (i32.const 1))) (i32.const 61)))
              (then (call $tokset (local.get $n) (i32.const 24) (i32.const 0) (i32.const 0)) (local.set $i (i32.add (local.get $i) (i32.const 2))))
              (else (call $tokset (local.get $n) (i32.const 25) (i32.const 0) (i32.const 0)) (local.set $i (i32.add (local.get $i) (i32.const 1)))))
            (local.set $n (i32.add (local.get $n) (i32.const 1))) (br $L)))
        (if (i32.eq (local.get $c) (i32.const 61))   ;; '='
          (then
            (if (i32.and (i32.lt_u (i32.add (local.get $i) (i32.const 1)) (local.get $srclen))
                         (i32.eq (call $b (i32.add (local.get $i) (i32.const 1))) (i32.const 61)))
              (then (call $tokset (local.get $n) (i32.const 21) (i32.const 0) (i32.const 0)) (local.set $i (i32.add (local.get $i) (i32.const 2))))
              (else (call $tokset (local.get $n) (i32.const 19) (i32.const 0) (i32.const 0)) (local.set $i (i32.add (local.get $i) (i32.const 1)))))
            (local.set $n (i32.add (local.get $n) (i32.const 1))) (br $L)))
        (if (i32.eq (local.get $c) (i32.const 33))   ;; '!' (only '!=' supported)
          (then
            (if (i32.and (i32.lt_u (i32.add (local.get $i) (i32.const 1)) (local.get $srclen))
                         (i32.eq (call $b (i32.add (local.get $i) (i32.const 1))) (i32.const 61)))
              (then (call $tokset (local.get $n) (i32.const 22) (i32.const 0) (i32.const 0)) (local.set $i (i32.add (local.get $i) (i32.const 2)))
                    (local.set $n (i32.add (local.get $n) (i32.const 1))) (br $L)))))
        ;; single-char tokens
        (local.set $val (i32.const 0))
        (if (i32.eq (local.get $c) (i32.const 40)) (then (local.set $val (i32.const 3))))
        (if (i32.eq (local.get $c) (i32.const 41)) (then (local.set $val (i32.const 4))))
        (if (i32.eq (local.get $c) (i32.const 123)) (then (local.set $val (i32.const 5))))
        (if (i32.eq (local.get $c) (i32.const 125)) (then (local.set $val (i32.const 6))))
        (if (i32.eq (local.get $c) (i32.const 44)) (then (local.set $val (i32.const 7))))
        (if (i32.eq (local.get $c) (i32.const 58)) (then (local.set $val (i32.const 8))))
        (if (i32.eq (local.get $c) (i32.const 43)) (then (local.set $val (i32.const 10))))
        (if (i32.eq (local.get $c) (i32.const 46)) (then (local.set $val (i32.const 13))))
        (if (i32.eq (local.get $c) (i32.const 91)) (then (local.set $val (i32.const 15))))
        (if (i32.eq (local.get $c) (i32.const 93)) (then (local.set $val (i32.const 16))))
        (if (i32.eq (local.get $c) (i32.const 42)) (then (local.set $val (i32.const 17))))   ;; '*'
        (if (i32.eq (local.get $c) (i32.const 47)) (then (local.set $val (i32.const 18))))   ;; '/'
        (if (i32.eq (local.get $c) (i32.const 37)) (then (local.set $val (i32.const 26))))   ;; '%'
        (if (i32.eq (local.get $c) (i32.const 124)) (then (local.set $val (i32.const 27))))  ;; '|' (sum-type variant separator)
        (if (i32.eq (local.get $c) (i32.const 63)) (then (local.set $val (i32.const 28))))   ;; '?' (try / error propagation)
        (if (i32.eq (local.get $c) (i32.const 61)) (then (local.set $val (i32.const 19))))   ;; '='
        ;; store the source position (addr, len 1) so an unexpected single-char token can be located + fixed
        (call $tokset (local.get $n) (local.get $val) (i32.add (i32.const 100000) (local.get $i)) (i32.const 1))
        (local.set $n (i32.add (local.get $n) (i32.const 1)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $L)))
    (call $tokset (local.get $n) (i32.const 14) (i32.const 0) (i32.const 0))   ;; EOF
    (global.set $ntok (i32.add (local.get $n) (i32.const 1))))

  ;; ---------- parser / emitter ----------
  (func $skip_type
    (call $adv)   ;; the type identifier
    (if (i32.eq (call $tk (global.get $tp)) (i32.const 15))   ;; '['
      (then
        (block $be
          (loop $bl
            (br_if $be (i32.eq (call $tk (global.get $tp)) (i32.const 16)))
            (br_if $be (i32.eq (call $tk (global.get $tp)) (i32.const 14)))
            (call $adv) (br $bl)))
        (call $adv))))

  ;; emit FPUSH (opcode 29) + the f64's two 32-bit halves (low, high).
  (func $emit_fpush (param $x f64)
    (local $bits i64)
    (local.set $bits (i64.reinterpret_f64 (local.get $x)))
    (call $emitw (i32.const 29))
    (call $emitw (i32.wrap_i64 (local.get $bits)))
    (call $emitw (i32.wrap_i64 (i64.shr_u (local.get $bits) (i64.const 32)))))
  ;; Dec (D1): emit DPUSH (opcode 64) + the i64's two 32-bit halves, mirroring $emit_fpush.
  ;; Simpler than FPUSH: a Dec value is already a plain i64 (no float reinterpret needed).
  (func $emit_dpush (param $x i64)
    (call $emitw (i32.const 64))
    (call $emitw (i32.wrap_i64 (local.get $x)))
    (call $emitw (i32.wrap_i64 (i64.shr_u (local.get $x) (i64.const 32)))))
  ;; Emit a binary arithmetic op given operand types `tl` (lhs, under TOS) and `tr`
  ;; (rhs, TOS). If either is Float the result is Float: coerce the Int operand
  ;; (I2F=30 converts TOS, I2FU=31 converts the value under TOS) then emit `floatop`;
  ;; else emit `intop`. Sets `$ety` to the result type.
  (func $emit_arith (param $tl i32) (param $tr i32) (param $intop i32) (param $floatop i32)
    (if (i32.or (i32.eq (local.get $tl) (i32.const 1)) (i32.eq (local.get $tr) (i32.const 1)))
      (then
        (if (i32.eqz (local.get $tr)) (then (call $emitw (i32.const 30))))   ;; rhs Int -> I2F (TOS)
        (if (i32.eqz (local.get $tl)) (then (call $emitw (i32.const 31))))   ;; lhs Int -> I2FU (under)
        (call $emitw (local.get $floatop))
        (global.set $ety (i32.const 1)))
      (else
        (call $emitw (local.get $intop))
        (global.set $ety (i32.const 0)))))
  ;; Same coercion, for a comparison: result is always Int (0/1).
  (func $emit_cmp (param $tl i32) (param $tr i32) (param $intop i32) (param $floatop i32)
    (if (i32.or (i32.eq (local.get $tl) (i32.const 1)) (i32.eq (local.get $tr) (i32.const 1)))
      (then
        (if (i32.eqz (local.get $tr)) (then (call $emitw (i32.const 30))))
        (if (i32.eqz (local.get $tl)) (then (call $emitw (i32.const 31))))
        (call $emitw (local.get $floatop)))
      (else (call $emitw (local.get $intop))))
    (global.set $ety (i32.const 0)))

  ;; ---------- Dec (D1): coercion + dispatch for +, -, *, and comparisons ----------
  ;; Design note: rather than folding Dec into $emit_arith/$emit_cmp above (risking the
  ;; well-tested Int/Float paths), Dec gets its own parallel helpers, gated at each call
  ;; site by "is either operand Dec"; when neither is, the original functions run
  ;; byte-for-byte unchanged. `opoff`/`oplen` anchor any diagnostic on the OPERATOR token
  ;; (always a safely-positioned single-char token per the lexer's tokset convention),
  ;; never on an operand: a bare Int operand's own token stores its numeric VALUE in the
  ;; `a` field, not a source address (see $lex's number branch), so anchoring on an operand
  ;; would be unsafe whenever that operand is a literal Int being auto-coerced to Dec (a
  ;; routine, expected case for Dec, unlike for Float).
  ;;
  ;; Int-side coercion to Dec (DFROMI, opcode 65) converts only TOS, mirroring I2F. When the
  ;; Int operand is instead the value UNDER TOS (lhs Int, rhs Dec — stack is [lhs, rhs] with
  ;; rhs on top), there is no DFROMIU: instead of adding an 8th opcode beyond the brief's
  ;; exact list, this reuses the codebase's own scratch-slot idiom ($tmp_local, already used
  ;; by $c_match/$c_apply_try/record literals) to shuffle rhs out of the way, convert the
  ;; now-TOS lhs, then bring rhs back:
  ;;   SETLOCAL tmp   ; pops rhs into a fresh scratch slot -> stack [lhs]
  ;;   DFROMI         ; converts the now-TOS lhs Int -> Dec
  ;;   GETARG tmp     ; pushes rhs back on top -> stack [lhs_dec, rhs]
  (func $emit_dec_arith (param $tl i32) (param $tr i32) (param $decop i32) (param $opoff i32) (param $oplen i32)
    (local $tmp i32)
    (if (i32.or (i32.eq (local.get $tl) (i32.const 1)) (i32.eq (local.get $tr) (i32.const 1)))
      (then   ;; Float on one side, Dec on the other: never mix (E0007)
        (call $err_add (i32.const 7) (local.get $opoff) (local.get $oplen))
        (call $emitw (i32.const 3))   ;; ADD: stack-balancing fallback only; never executed (nerr>0 blocks run)
        (global.set $ety (i32.const 2))
        (return)))
    (if (i32.eqz (local.get $tr)) (then (call $emitw (i32.const 65))))   ;; rhs Int -> DFROMI (TOS)
    (if (i32.eqz (local.get $tl))
      (then   ;; lhs Int, rhs Dec: shuffle via a scratch slot (see design note above)
        (local.set $tmp (call $tmp_local))
        (call $emitw (i32.const 14)) (call $emitw (local.get $tmp))
        (call $emitw (i32.const 65))
        (call $emitw (i32.const 2)) (call $emitw (local.get $tmp))))
    (call $emitw (local.get $decop))
    (global.set $ety (i32.const 2)))
  ;; Unified entry point for '+', '-', '*': routes to $emit_dec_arith when Dec is involved,
  ;; else calls $emit_arith exactly as before (zero change to the Int/Float path). Keeps
  ;; each call site in $c_add/$c_mul a near-mechanical addition of two params.
  (func $emit_arith2 (param $tl i32) (param $tr i32) (param $intop i32) (param $floatop i32) (param $decop i32) (param $opoff i32) (param $oplen i32)
    (if (i32.or (i32.eq (local.get $tl) (i32.const 2)) (i32.eq (local.get $tr) (i32.const 2)))
      (then (call $emit_dec_arith (local.get $tl) (local.get $tr) (local.get $decop) (local.get $opoff) (local.get $oplen)) (return)))
    (call $emit_arith (local.get $tl) (local.get $tr) (local.get $intop) (local.get $floatop)))
  ;; Dec-aware comparison: same Float-mix ban and Int-coercion shuffle as $emit_dec_arith,
  ;; but Dec-Dec (once same-scaled) reuses the given INT comparison op directly — the
  ;; same-scale invariant makes a raw i64 compare exact, so there are no separate Dec
  ;; comparison opcodes.
  (func $emit_dec_cmp (param $tl i32) (param $tr i32) (param $intop i32) (param $opoff i32) (param $oplen i32)
    (local $tmp i32)
    (if (i32.or (i32.eq (local.get $tl) (i32.const 1)) (i32.eq (local.get $tr) (i32.const 1)))
      (then
        (call $err_add (i32.const 7) (local.get $opoff) (local.get $oplen))
        (call $emitw (i32.const 3))
        (global.set $ety (i32.const 0))
        (return)))
    (if (i32.eqz (local.get $tr)) (then (call $emitw (i32.const 65))))
    (if (i32.eqz (local.get $tl))
      (then
        (local.set $tmp (call $tmp_local))
        (call $emitw (i32.const 14)) (call $emitw (local.get $tmp))
        (call $emitw (i32.const 65))
        (call $emitw (i32.const 2)) (call $emitw (local.get $tmp))))
    (call $emitw (local.get $intop))
    (global.set $ety (i32.const 0)))
  (func $emit_cmp2 (param $tl i32) (param $tr i32) (param $intop i32) (param $floatop i32) (param $opoff i32) (param $oplen i32)
    (if (i32.or (i32.eq (local.get $tl) (i32.const 2)) (i32.eq (local.get $tr) (i32.const 2)))
      (then (call $emit_dec_cmp (local.get $tl) (local.get $tr) (local.get $intop) (local.get $opoff) (local.get $oplen)) (return)))
    (call $emit_cmp (local.get $tl) (local.get $tr) (local.get $intop) (local.get $floatop)))
  ;; '/' on Dec: Float-mix is checked FIRST (the more fundamental error: `1.5 / priceDec`
  ;; should say "Float and Dec never mix", not send the user to dec_div with a Float
  ;; argument dec_div cannot accept either). Only once Float is ruled out does a Dec operand
  ;; (bare or Int-coerced) ban '/' outright (E0008; use dec_div). Neither operand Dec: the
  ;; existing Int/Float '/' behavior, completely unchanged.
  (func $c_div_op (param $tl i32) (param $opoff i32) (param $oplen i32)
    (local $tr i32)
    (local.set $tr (global.get $ety))
    (if (i32.and (i32.or (i32.eq (local.get $tl) (i32.const 1)) (i32.eq (local.get $tr) (i32.const 1)))
                 (i32.or (i32.eq (local.get $tl) (i32.const 2)) (i32.eq (local.get $tr) (i32.const 2))))
      (then
        (call $err_add (i32.const 7) (local.get $opoff) (local.get $oplen))
        (call $emitw (i32.const 3)) (global.set $ety (i32.const 2)) (return)))
    (if (i32.or (i32.eq (local.get $tl) (i32.const 2)) (i32.eq (local.get $tr) (i32.const 2)))
      (then
        (call $err_add (i32.const 8) (local.get $opoff) (local.get $oplen))
        (call $emitw (i32.const 3)) (global.set $ety (i32.const 2)) (return)))
    (call $emit_arith (local.get $tl) (local.get $tr) (i32.const 12) (i32.const 35)))

  (func $c_primary
    (local $off i32) (local $len i32) (local $argc i32) (local $moff i32) (local $mlen i32) (local $slot i32) (local $tag i32)
    (local $recsize i32) (local $tmpslot i32) (local $fi i32)
    (if (call $kw_is (global.get $tp) (i32.const 248160) (i32.const 5))   ;; 'match' expression
      (then (call $c_match) (return)))
    (if (i32.eq (call $tk (global.get $tp)) (i32.const 11))   ;; unary minus:  -x  ==  0 - x
      (then
        (call $adv)
        (call $emitw (i32.const 1)) (call $emitw (i32.const 0))   ;; PUSH 0
        (call $c_primary)                                         ;; operand (allows -5, -x, -(e), - -x)
        (if (i32.eq (global.get $ety) (i32.const 1))
          (then (call $emitw (i32.const 31)) (call $emitw (i32.const 33)))   ;; I2FU the 0 -> FSUB (0.0 - x)
          (else
            (if (i32.eq (global.get $ety) (i32.const 2))
              (then (call $emitw (i32.const 67)))    ;; DSUB (0 - x): the pushed 0 needs no coercion (0*1e6=0), and DSUB's own overflow trap covers unary negation for free
              (else (call $emitw (i32.const 4))))))   ;; SUB
        (return)))
    (if (i32.eq (call $tk (global.get $tp)) (i32.const 2))   ;; INT
      (then
        (call $emitw (i32.const 1)) (call $emitw (call $ta (global.get $tp)))
        (global.set $ety (i32.const 0))
        (call $adv) (return)))
    (if (i32.eq (call $tk (global.get $tp)) (i32.const 32))   ;; BigInt literal (Bug #25): magnitude past i32 range
      (then
        ;; Reconstruct the i64 constant from its low/high 32-bit halves (token fields a, b)
        ;; using only existing opcodes - PUSH/SHL/SHR/BOR - so no new opcode is introduced.
        ;; hi is always <= 0x7FFFFFFF (source magnitudes are capped at 2^63-1; negation is a
        ;; separate unary op), so PUSHing it never hits PUSH's sign-extension edge case. lo
        ;; may have its own top bit set, so PUSH lo; PUSH 32; SHL discards whatever
        ;; sign-extension garbage PUSH produced (shifted out of the low 64 bits, standard
        ;; wrapping shift), then PUSH 32; SHR (logical/unsigned - verified identical across
        ;; all four engines: this wat interpreter, native/ir_interpreter.mjs, emit_fn.lm's C,
        ;; emit_llvm.lm's LLVM lshr) zero-extends lo back down before BOR-ing it with hi<<32.
        (call $emitw (i32.const 1)) (call $emitw (call $tb (global.get $tp)))   ;; PUSH hi
        (call $emitw (i32.const 1)) (call $emitw (i32.const 32))               ;; PUSH 32
        (call $emitw (i32.const 61))                                          ;; SHL -> hi<<32
        (call $emitw (i32.const 1)) (call $emitw (call $ta (global.get $tp)))  ;; PUSH lo
        (call $emitw (i32.const 1)) (call $emitw (i32.const 32))               ;; PUSH 32
        (call $emitw (i32.const 61))                                          ;; SHL -> discard sign-ext garbage; lo now sits in bits[32:63]
        (call $emitw (i32.const 1)) (call $emitw (i32.const 32))               ;; PUSH 32
        (call $emitw (i32.const 62))                                          ;; SHR -> zero-extended lo
        (call $emitw (i32.const 59))                                          ;; BOR -> (hi<<32) | lo
        (global.set $ety (i32.const 0))
        (call $adv) (return)))
    (if (i32.eq (call $tk (global.get $tp)) (i32.const 29))   ;; FLOAT literal
      (then
        (call $emit_fpush (call $parse_float (call $ta (global.get $tp)) (call $tb (global.get $tp))))
        (global.set $ety (i32.const 1))
        (call $adv) (return)))
    (if (i32.eq (call $tk (global.get $tp)) (i32.const 30))   ;; Dec literal (D1)
      (then
        (call $emit_dpush (call $parse_dec_literal (call $ta (global.get $tp)) (call $tb (global.get $tp))))
        (global.set $ety (i32.const 2))
        (call $adv) (return)))
    (if (i32.eq (call $tk (global.get $tp)) (i32.const 20))   ;; TEXT literal
      (then
        (call $emitw (i32.const 15))   ;; MKTEXT
        (call $emitw (call $mktext_lit (call $ta (global.get $tp)) (call $tb (global.get $tp))))
        (global.set $ety (i32.const 0))
        (call $adv) (return)))
    (if (i32.and (i32.eq (call $tk (global.get $tp)) (i32.const 3))
                 (i32.eq (call $tk (i32.add (global.get $tp) (i32.const 1))) (i32.const 4)))
      (then
        (if (i32.eqz (global.get $cur_fn_is_unit))
          (then
            (call $err_add (i32.const 3) (call $ta (global.get $tp)) (i32.sub (i32.add (call $ta (i32.add (global.get $tp) (i32.const 1))) (call $tb (i32.add (global.get $tp) (i32.const 1)))) (call $ta (global.get $tp))))))
        (call $emitw (i32.const 1)) (call $emitw (i32.const 0))
        (global.set $ety (i32.const 0))
        (call $adv) (call $adv)
        (return)))
    (if (i32.eq (call $tk (global.get $tp)) (i32.const 3))   ;; '(' grouping
      (then (call $adv) (call $c_expr) (if (i32.eq (call $tk (global.get $tp)) (i32.const 4)) (then (call $adv))) (return)))
    (if (i32.eq (call $tk (global.get $tp)) (i32.const 1))   ;; IDENT
      (then
        (local.set $off (call $ta (global.get $tp)))
        (local.set $len (call $tb (global.get $tp)))
        (call $adv)
        ;; record literal: Name { field: expr, ... } when Name is a known record type
        (if (i32.eq (call $tk (global.get $tp)) (i32.const 5))   ;; '{'
          (then
            (local.set $recsize (call $rec_size (local.get $off) (local.get $len)))
            (if (i32.ge_s (local.get $recsize) (i32.const 0))
              (then
                (call $adv)   ;; '{'
                (local.set $tmpslot (call $tmp_local))
                (call $emitw (i32.const 1)) (call $emitw (local.get $recsize))   ;; PUSH size
                (call $emitw (i32.const 49))                                     ;; ANEW -> record cell
                (call $emitw (i32.const 14)) (call $emitw (local.get $tmpslot))  ;; SETLOCAL tmp
                (block $rce (loop $rcl
                  (br_if $rce (i32.eq (call $tk (global.get $tp)) (i32.const 6)))    ;; '}'
                  (br_if $rce (i32.eq (call $tk (global.get $tp)) (i32.const 14)))   ;; SAFETY: EOF
                  (local.set $fi (call $field_index (call $ta (global.get $tp)) (call $tb (global.get $tp))))
                  (call $adv)   ;; field name
                  (if (i32.eq (call $tk (global.get $tp)) (i32.const 8)) (then (call $adv)))   ;; ':'
                  (call $emitw (i32.const 2)) (call $emitw (local.get $tmpslot))   ;; GETARG tmp (a)
                  (call $emitw (i32.const 1)) (call $emitw (local.get $fi))        ;; PUSH field index (i)
                  (call $c_expr)                                                   ;; value (x)
                  (call $emitw (i32.const 51))                                     ;; ASET a i x
                  (if (i32.eq (call $tk (global.get $tp)) (i32.const 7)) (then (call $adv)))   ;; ','
                  (br $rcl)))
                (if (i32.eq (call $tk (global.get $tp)) (i32.const 6)) (then (call $adv)))   ;; '}'
                (call $emitw (i32.const 2)) (call $emitw (local.get $tmpslot))   ;; GETARG tmp -> the record
                (global.set $ety (i32.const 0))
                (return)))))
        (if (i32.eq (call $tk (global.get $tp)) (i32.const 13))   ;; '.' -> field access OR method call
          (then
            (call $adv)   ;; '.'
            (local.set $moff (call $ta (global.get $tp)))
            (local.set $mlen (call $tb (global.get $tp)))
            (call $adv)   ;; field / method name
            (if (i32.eq (call $tk (global.get $tp)) (i32.const 3))   ;; '(' -> method call (console.print / print_int)
              (then
                (call $adv)   ;; '('
                (if (i32.ne (call $tk (global.get $tp)) (i32.const 4)) (then (call $c_expr)))
                (call $adv)   ;; ')'
                (if (call $eqlit (local.get $moff) (local.get $mlen) (i32.const 248140) (i32.const 5))   ;; "print"
                  (then (call $emitw (i32.const 16)) (global.set $expr_pushes (i32.const 0)))    ;; PRINTTEXT
                  (else (call $emitw (i32.const 10)) (global.set $expr_pushes (i32.const 0))))   ;; PRINTINT (print_int)
                (return))
              (else
                ;; field access p.field: GETARG the record, AGET its field's global slot
                (local.set $slot (call $var_find (local.get $off) (local.get $len)))
                (if (i32.lt_s (local.get $slot) (i32.const 0))
                  (then (call $err_add (i32.const 1) (local.get $off) (local.get $len)) (local.set $slot (i32.const 0))))
                (call $emitw (i32.const 2)) (call $emitw (local.get $slot))   ;; GETARG base record
                (call $emitw (i32.const 1)) (call $emitw (call $field_index (local.get $moff) (local.get $mlen)))   ;; PUSH field index
                (call $emitw (i32.const 50))                                  ;; AGET -> field value
                (global.set $ety (call $field_type (local.get $moff) (local.get $mlen)))
                (return)))))
        ;; dec_div(a, b) (D1): special-cased ahead of the generic call parsing below, because
        ;; it needs BOTH argument types individually for coercion, and the generic argc-loop
        ;; only leaves $ety reflecting the LAST argument once it has run. $emit_dec_arith
        ;; already contains the full Float-mix-ban + Int-coercion + decop-emission logic, so
        ;; this is a thin wrapper: parse "(a, b)" by hand, capture arg-a's type in $tag
        ;; (reused here as a scratch Int local; its normal variant-tag use is finished by
        ;; this point in a call-position parse), then let $emit_dec_arith do the rest with
        ;; decop=DDIV(69). b==0 and overflow are runtime traps inside $dec_div, not
        ;; compile-time concerns here.
        (if (i32.and (i32.eq (call $tk (global.get $tp)) (i32.const 3))
                     (call $eqlit (local.get $off) (local.get $len) (i32.const 180112) (i32.const 7)))
          (then
            (call $adv)   ;; '('
            (call $c_expr) (local.set $tag (global.get $ety))
            (if (i32.eq (call $tk (global.get $tp)) (i32.const 7)) (then (call $adv)))   ;; ','
            (call $c_expr)
            (if (i32.eq (call $tk (global.get $tp)) (i32.const 4)) (then (call $adv)))   ;; ')'
            (call $emit_dec_arith (local.get $tag) (global.get $ety) (i32.const 69) (local.get $off) (local.get $len))
            (return)))
        (if (i32.eq (call $tk (global.get $tp)) (i32.const 3))   ;; call '('  (builtin or function)
          (then
            (call $adv)
            (local.set $argc (i32.const 0))
            (if (i32.ne (call $tk (global.get $tp)) (i32.const 4))
              (then
                (call $c_expr) (local.set $argc (i32.const 1))
                (block $ce
                  (loop $cl
                    (br_if $ce (i32.ne (call $tk (global.get $tp)) (i32.const 7)))
                    (call $adv) (call $c_expr) (local.set $argc (i32.add (local.get $argc) (i32.const 1)))
                    (br $cl)))))
            (call $adv)   ;; ')'
            (local.set $tag (call $variant_find (local.get $off) (local.get $len)))
            (if (i32.ge_s (local.get $tag) (i32.const 0))   ;; variant constructor Name(arg): payload is on the stack
              (then (call $emitw (i32.const 25)) (call $emitw (local.get $tag)) (global.set $ety (i32.const 0)) (return)))   ;; MKSUM tag
            ;; builtin dispatch, length-bucketed: gate each group on the identifier
            ;; length so a call skips every builtin whose name-length cannot match. A
            ;; user-function call now falls through to CALL below after only its own
            ;; length group's comparisons instead of all ~18. $eqlit still length-checks
            ;; internally, so the emitted code is identical to the old flat chain.
            (if (i32.eq (local.get $len) (i32.const 2)) (then
              (if (call $eqlit (local.get $off) (local.get $len) (i32.const 248290) (i32.const 2))   ;; ln(x)
                (then (call $emitw (i32.const 47)) (global.set $ety (i32.const 1)) (return)))))
            (if (i32.eq (local.get $len) (i32.const 3)) (then
              (if (call $eqlit (local.get $off) (local.get $len) (i32.const 248310) (i32.const 3))   ;; abs(x) (Float)
                (then (call $emitw (i32.const 45)) (global.set $ety (i32.const 1)) (return)))
              (if (call $eqlit (local.get $off) (local.get $len) (i32.const 248280) (i32.const 3))   ;; exp(x)
                (then (call $emitw (i32.const 46)) (global.set $ety (i32.const 1)) (return)))
              (if (call $eqlit (local.get $off) (local.get $len) (i32.const 248300) (i32.const 3))   ;; pow(x,y)
                (then (call $emitw (i32.const 48)) (global.set $ety (i32.const 1)) (return)))
              (if (call $eqlit (local.get $off) (local.get $len) (i32.const 180016) (i32.const 3))   ;; bor(a,b) -> Int
                (then (call $emitw (i32.const 59)) (global.set $ety (i32.const 0)) (return)))
              (if (call $eqlit (local.get $off) (local.get $len) (i32.const 180048) (i32.const 3))   ;; shl(a,n) -> Int
                (then (call $emitw (i32.const 61)) (global.set $ety (i32.const 0)) (return)))
              (if (call $eqlit (local.get $off) (local.get $len) (i32.const 180064) (i32.const 3))   ;; shr(a,n) -> Int (logical/unsigned)
                (then (call $emitw (i32.const 62)) (global.set $ety (i32.const 0)) (return)))))
            (if (i32.eq (local.get $len) (i32.const 4)) (then
              (if (call $eqlit (local.get $off) (local.get $len) (i32.const 248270) (i32.const 4))   ;; sqrt(x)
                (then (call $emitw (i32.const 44)) (global.set $ety (i32.const 1)) (return)))
              (if (call $eqlit (local.get $off) (local.get $len) (i32.const 248330) (i32.const 4))   ;; aget(a,i) -> Float
                (then (call $emitw (i32.const 50)) (global.set $ety (i32.const 1)) (return)))
              (if (call $eqlit (local.get $off) (local.get $len) (i32.const 248340) (i32.const 4))   ;; aset(a,i,x) -> Unit (no value)
                (then (call $emitw (i32.const 51)) (global.set $ety (i32.const 0)) (global.set $expr_pushes (i32.const 0)) (return)))
              (if (call $eqlit (local.get $off) (local.get $len) (i32.const 248350) (i32.const 4))   ;; alen(a) -> Int
                (then (call $emitw (i32.const 52)) (global.set $ety (i32.const 0)) (return)))
              (if (call $eqlit (local.get $off) (local.get $len) (i32.const 180000) (i32.const 4))   ;; band(a,b) -> Int
                (then (call $emitw (i32.const 58)) (global.set $ety (i32.const 0)) (return)))
              (if (call $eqlit (local.get $off) (local.get $len) (i32.const 180032) (i32.const 4))   ;; bxor(a,b) -> Int
                (then (call $emitw (i32.const 60)) (global.set $ety (i32.const 0)) (return)))
              (if (call $eqlit (local.get $off) (local.get $len) (i32.const 180080) (i32.const 4))   ;; bnot(a) -> Int
                (then (call $emitw (i32.const 63)) (global.set $ety (i32.const 0)) (return)))))
            (if (i32.eq (local.get $len) (i32.const 5)) (then
              (if (call $eqlit (local.get $off) (local.get $len) (i32.const 248250) (i32.const 5))   ;; round(x): Float -> Int (nearest)
                (then (call $emitw (i32.const 43)) (global.set $ety (i32.const 0)) (return)))
              (if (call $eqlit (local.get $off) (local.get $len) (i32.const 248320) (i32.const 5))   ;; array(n) -> handle
                (then (call $emitw (i32.const 49)) (global.set $ety (i32.const 0)) (return)))
              (if (call $eqlit (local.get $off) (local.get $len) (i32.const 248380) (i32.const 5))   ;; load8(addr) -> Int (byte, zero-ext)
                (then (call $emitw (i32.const 55)) (global.set $ety (i32.const 0)) (return)))))
            (if (i32.eq (local.get $len) (i32.const 6)) (then
              (if (call $eqlit (local.get $off) (local.get $len) (i32.const 248240) (i32.const 6))   ;; to_int(x): Float -> Int (trunc)
                (then (call $emitw (i32.const 42)) (global.set $ety (i32.const 0)) (return)))
              (if (call $eqlit (local.get $off) (local.get $len) (i32.const 248360) (i32.const 6))   ;; load32(addr) -> Int (raw mem, sign-ext)
                (then (call $emitw (i32.const 53)) (global.set $ety (i32.const 0)) (return)))
              (if (call $eqlit (local.get $off) (local.get $len) (i32.const 248390) (i32.const 6))   ;; store8(addr,val) -> Unit
                (then (call $emitw (i32.const 56)) (global.set $ety (i32.const 0)) (global.set $expr_pushes (i32.const 0)) (return)))))
            (if (i32.eq (local.get $len) (i32.const 7)) (then
              (if (call $eqlit (local.get $off) (local.get $len) (i32.const 248370) (i32.const 7))   ;; store32(addr,val) -> Unit
                (then (call $emitw (i32.const 54)) (global.set $ety (i32.const 0)) (global.set $expr_pushes (i32.const 0)) (return)))
              (if (call $eqlit (local.get $off) (local.get $len) (i32.const 248170) (i32.const 7))   ;; text_eq(a,b)
                (then (call $emitw (i32.const 28)) (global.set $ety (i32.const 0)) (return)))))
            (if (i32.eq (local.get $len) (i32.const 8)) (then
              (if (call $eqlit (local.get $off) (local.get $len) (i32.const 248260) (i32.const 8))   ;; to_float(n): Int -> Float
                (then (call $emitw (i32.const 30)) (global.set $ety (i32.const 1)) (return)))))
            (if (i32.eq (local.get $len) (i32.const 11)) (then
              (if (call $eqlit (local.get $off) (local.get $len) (i32.const 248100) (i32.const 11))   ;; int_to_text(x)
                (then (call $emitw (i32.const 18)) (global.set $ety (i32.const 0)) (return)))   ;; INT2TEXT
              (if (call $eqlit (local.get $off) (local.get $len) (i32.const 248120) (i32.const 11))   ;; text_concat(a,b)
                (then (call $emitw (i32.const 17)) (global.set $ety (i32.const 0)) (return)))   ;; CONCAT
              (if (call $eqlit (local.get $off) (local.get $len) (i32.const 180128) (i32.const 11))   ;; dec_to_text(d) (D1): canonical decimal string
                (then
                  (if (i32.eq (global.get $ety) (i32.const 1))
                    (then (call $err_add (i32.const 7) (local.get $off) (local.get $len)))
                    (else (if (i32.eqz (global.get $ety)) (then (call $emitw (i32.const 65))))))   ;; Int arg -> DFROMI (TOS)
                  (call $emitw (i32.const 70)) (global.set $ety (i32.const 0)) (return)))))        ;; D2TEXT -> Text
            (if (i32.eq (local.get $len) (i32.const 12)) (then
              (if (call $eqlit (local.get $off) (local.get $len) (i32.const 180144) (i32.const 12))   ;; dec_to_float(d) (D1): explicit, lossy Dec -> Float; no reverse float_to_dec
                (then
                  (if (i32.eq (global.get $ety) (i32.const 1))
                    (then (call $err_add (i32.const 7) (local.get $off) (local.get $len)))
                    (else (if (i32.eqz (global.get $ety)) (then (call $emitw (i32.const 65))))))   ;; Int arg -> DFROMI (TOS)
                  (call $emitw (i32.const 30))            ;; I2F: TOS Dec(i64) -> f64, bit-identical convert
                  (call $emit_fpush (f64.const 1000000))
                  (call $emitw (i32.const 35))            ;; FDIV -> the real value
                  (global.set $ety (i32.const 1)) (return)))))
            (call $emitw (i32.const 8))   ;; CALL
            (call $fixup_add (global.get $emit) (local.get $off) (local.get $len))   ;; entry resolved later
            (call $emitw (i32.const 0))   ;; placeholder entry (backpatched by $resolve_fixups)
            (call $emitw (local.get $argc))
            (global.set $ety (call $sym_rettype_of (local.get $off) (local.get $len)))
            (return)))
        ;; nullary variant constructor (e.g. DivByZero) -> push dummy payload, then MKSUM
        (local.set $tag (call $variant_find (local.get $off) (local.get $len)))
        (if (i32.ge_s (local.get $tag) (i32.const 0))
          (then (call $emitw (i32.const 1)) (call $emitw (i32.const 0))                ;; PUSH 0 payload
                (call $emitw (i32.const 25)) (call $emitw (local.get $tag)) (global.set $ety (i32.const 0)) (return)))  ;; MKSUM tag
        ;; variable (param or local) -> GETARG reads frame slot argbase+slot
        (local.set $slot (call $var_find (local.get $off) (local.get $len)))
        (if (i32.lt_s (local.get $slot) (i32.const 0))   ;; unknown name
          (then (call $err_add (i32.const 1) (local.get $off) (local.get $len)) (local.set $slot (i32.const 0))))
        (call $emitw (i32.const 2))   ;; GETARG
        (call $emitw (local.get $slot))
        (global.set $ety (call $slot_type (local.get $slot)))
        (return)))
    ;; SAFETY: no production matched this token. Guarantee forward progress so the
    ;; statement/block/program loops always terminate. EOF is left unconsumed (callers
    ;; guard it); any other unexpected token is diagnosed and consumed.
    (if (i32.eq (call $tk (global.get $tp)) (i32.const 14))   ;; EOF: do not consume
      (then (call $emitw (i32.const 1)) (call $emitw (i32.const 0)) (return)))
    (call $err_add (i32.const 3) (call $ta (global.get $tp)) (call $tb (global.get $tp)))   ;; unexpected token
    (call $adv)                                              ;; consume it -> strict forward progress
    (call $emitw (i32.const 1)) (call $emitw (i32.const 0)))  ;; PUSH 0 (keep operand stack balanced)

  ;; the `?` operator: on a Result, short-circuit-return the err, else unwrap the ok value.
  ;; Non-coercing: the err value is returned unchanged, so the enclosing fn's error type must match.
  (func $c_apply_try
    (local $s i32) (local $jz i32)
    (local.set $s (call $tmp_local))
    (call $emitw (i32.const 14)) (call $emitw (local.get $s))   ;; SETLOCAL S
    (call $emitw (i32.const 2)) (call $emitw (local.get $s))    ;; GETARG S
    (call $emitw (i32.const 26))                                ;; SUMTAG
    (call $emitw (i32.const 1)) (call $emitw (i32.const 1))     ;; PUSH 1 (err tag)
    (call $emitw (i32.const 19))                                ;; EQ  -> 1 if err, 0 if ok
    (call $emitw (i32.const 6)) (local.set $jz (global.get $emit)) (call $emitw (i32.const 0))   ;; JZ -> ok
    (call $emitw (i32.const 2)) (call $emitw (local.get $s))    ;; GETARG S   (err path)
    (call $emitw (i32.const 9))                                 ;; RET (return the err Result)
    (call $patch (local.get $jz) (global.get $emit))           ;; ok:
    (call $emitw (i32.const 2)) (call $emitw (local.get $s))    ;; GETARG S
    (call $emitw (i32.const 27)))                              ;; SUMVAL -> unwrapped value

  (func $c_postfix
    (call $c_primary)
    (block $pe
      (loop $pl
        (br_if $pe (i32.ne (call $tk (global.get $tp)) (i32.const 28)))   ;; '?'
        (call $adv)
        (call $c_apply_try)
        (br $pl))))

  (func $c_mul
    (local $tl i32) (local $opoff i32) (local $oplen i32)
    (call $c_postfix)
    (local.set $tl (global.get $ety))
    (block $me
      (loop $ml
        (if (i32.eq (call $tk (global.get $tp)) (i32.const 17))   ;; '*'
          (then
                (local.set $opoff (call $ta (global.get $tp))) (local.set $oplen (call $tb (global.get $tp)))
                (call $adv) (call $c_postfix)
                (call $emit_arith2 (local.get $tl) (global.get $ety) (i32.const 11) (i32.const 34) (i32.const 68) (local.get $opoff) (local.get $oplen))
                (local.set $tl (global.get $ety)) (br $ml)))
        (if (i32.eq (call $tk (global.get $tp)) (i32.const 18))   ;; '/'
          (then
                (local.set $opoff (call $ta (global.get $tp))) (local.set $oplen (call $tb (global.get $tp)))
                (call $adv) (call $c_postfix)
                (call $c_div_op (local.get $tl) (local.get $opoff) (local.get $oplen))
                (local.set $tl (global.get $ety)) (br $ml)))
        (if (i32.eq (call $tk (global.get $tp)) (i32.const 26))   ;; '%' (Int only)
          (then (call $adv) (call $c_postfix) (call $emitw (i32.const 24))
                (global.set $ety (i32.const 0)) (local.set $tl (i32.const 0)) (br $ml)))
        (br $me))))

  (func $c_add
    (local $tl i32) (local $opoff i32) (local $oplen i32)
    (call $c_mul)
    (local.set $tl (global.get $ety))
    (block $ae
      (loop $al
        (if (i32.eq (call $tk (global.get $tp)) (i32.const 10))   ;; '+'
          (then
                (local.set $opoff (call $ta (global.get $tp))) (local.set $oplen (call $tb (global.get $tp)))
                (call $adv) (call $c_mul)
                (call $emit_arith2 (local.get $tl) (global.get $ety) (i32.const 3) (i32.const 32) (i32.const 66) (local.get $opoff) (local.get $oplen))
                (local.set $tl (global.get $ety)) (br $al)))
        (if (i32.eq (call $tk (global.get $tp)) (i32.const 11))   ;; '-'
          (then
                (local.set $opoff (call $ta (global.get $tp))) (local.set $oplen (call $tb (global.get $tp)))
                (call $adv) (call $c_mul)
                (call $emit_arith2 (local.get $tl) (global.get $ety) (i32.const 4) (i32.const 33) (i32.const 67) (local.get $opoff) (local.get $oplen))
                (local.set $tl (global.get $ety)) (br $al)))
        (br $ae))))

  (func $c_cmp
    (local $tl i32) (local $opoff i32) (local $oplen i32)
    (call $c_add)
    (local.set $tl (global.get $ety))
    (local.set $opoff (call $ta (global.get $tp))) (local.set $oplen (call $tb (global.get $tp)))
    (if (i32.eq (call $tk (global.get $tp)) (i32.const 12)) (then (call $adv) (call $c_add) (call $emit_cmp2 (local.get $tl) (global.get $ety) (i32.const 5)  (i32.const 36) (local.get $opoff) (local.get $oplen)) (return)))   ;; <
    (if (i32.eq (call $tk (global.get $tp)) (i32.const 21)) (then (call $adv) (call $c_add) (call $emit_cmp2 (local.get $tl) (global.get $ety) (i32.const 19) (i32.const 40) (local.get $opoff) (local.get $oplen)) (return)))   ;; ==
    (if (i32.eq (call $tk (global.get $tp)) (i32.const 22)) (then (call $adv) (call $c_add) (call $emit_cmp2 (local.get $tl) (global.get $ety) (i32.const 20) (i32.const 41) (local.get $opoff) (local.get $oplen)) (return)))   ;; !=
    (if (i32.eq (call $tk (global.get $tp)) (i32.const 23)) (then (call $adv) (call $c_add) (call $emit_cmp2 (local.get $tl) (global.get $ety) (i32.const 21) (i32.const 37) (local.get $opoff) (local.get $oplen)) (return)))   ;; <=
    (if (i32.eq (call $tk (global.get $tp)) (i32.const 24)) (then (call $adv) (call $c_add) (call $emit_cmp2 (local.get $tl) (global.get $ety) (i32.const 22) (i32.const 39) (local.get $opoff) (local.get $oplen)) (return)))   ;; >=
    (if (i32.eq (call $tk (global.get $tp)) (i32.const 25)) (then (call $adv) (call $c_add) (call $emit_cmp2 (local.get $tl) (global.get $ety) (i32.const 23) (i32.const 38) (local.get $opoff) (local.get $oplen)))))           ;; >

  ;; logical 'not' (prefix): not x  ==  (x == 0).  Binds looser than a comparison
  ;; (its operand is a full comparison, so `not a == b` is `not (a == b)`) and
  ;; tighter than 'and'/'or' (it sits just below them in the precedence chain).
  ;; `not not x` is supported via the recursive operand. No `not` -> plain comparison.
  (func $c_not
    (if (call $kw_is (global.get $tp) (i32.const 248220) (i32.const 3))   ;; 'not'
      (then
        (call $adv)
        (call $c_not)                                                     ;; operand (recurses for `not not`)
        (call $emitw (i32.const 1)) (call $emitw (i32.const 0))           ;; PUSH 0
        (call $emitw (i32.const 19)))                                     ;; EQ -> (operand == 0) = logical negation
      (else (call $c_cmp))))

  ;; logical 'and' (short-circuit): a and b  ==  if a is false, 0, else b
  (func $c_and
    (local $jz i32) (local $jmp i32)
    (call $c_not)
    (block $ae
      (loop $al
        (if (call $kw_is (global.get $tp) (i32.const 248200) (i32.const 3))   ;; 'and'
          (then
            (call $adv)
            (call $emitw (i32.const 6)) (local.set $jz (global.get $emit)) (call $emitw (i32.const 0))   ;; JZ -> false (pops lhs)
            (call $c_not)                                                     ;; rhs is the result when lhs is true
            (call $emitw (i32.const 7)) (local.set $jmp (global.get $emit)) (call $emitw (i32.const 0))  ;; JMP -> end
            (call $patch (local.get $jz) (global.get $emit))
            (call $emitw (i32.const 1)) (call $emitw (i32.const 0))            ;; false: PUSH 0
            (call $patch (local.get $jmp) (global.get $emit))
            (br $al)))
        (br $ae))))

  ;; logical 'or' (short-circuit): a or b  ==  if a is true, 1, else b
  (func $c_or
    (local $jz i32) (local $jmp i32)
    (call $c_and)
    (block $oe
      (loop $ol
        (if (call $kw_is (global.get $tp) (i32.const 248210) (i32.const 2))   ;; 'or'
          (then
            (call $adv)
            (call $emitw (i32.const 6)) (local.set $jz (global.get $emit)) (call $emitw (i32.const 0))   ;; JZ -> eval rhs (pops lhs)
            (call $emitw (i32.const 1)) (call $emitw (i32.const 1))            ;; lhs true: PUSH 1
            (call $emitw (i32.const 7)) (local.set $jmp (global.get $emit)) (call $emitw (i32.const 0))  ;; JMP -> end
            (call $patch (local.get $jz) (global.get $emit))
            (call $c_and)                                                     ;; rhs is the result when lhs is false
            (call $patch (local.get $jmp) (global.get $emit))
            (br $ol)))
        (br $oe))))

  (func $c_expr
    (global.set $expr_pushes (i32.const 1))
    (call $c_or))

  ;; '_' wildcard pattern?  (off is an absolute source address)
  (func $is_wild (param $off i32) (param $len i32) (result i32)
    (if (i32.ne (local.get $len) (i32.const 1)) (then (return (i32.const 0))))
    (return (i32.eq (i32.load8_u (local.get $off)) (i32.const 95))))   ;; '_'

  ;; type NAME = | V1 | V2(T) | ...   (registers each variant name -> tag, declaration order)
  (func $c_type
    (local $voff i32) (local $vlen i32) (local $tag i32) (local $toff i32) (local $tlen i32) (local $maxidx i32) (local $fidx i32)
    (call $adv)   ;; 'type'
    (local.set $toff (call $ta (global.get $tp)))   ;; type name (kept for record registration)
    (local.set $tlen (call $tb (global.get $tp)))
    (call $adv)   ;; type name
    (if (i32.eq (call $tk (global.get $tp)) (i32.const 19)) (then (call $adv)))   ;; '='
    ;; RECORD: type T = { field: Type, ... }  -> register fields (global slots) + size
    (if (i32.eq (call $tk (global.get $tp)) (i32.const 5))   ;; '{'
      (then
        (call $adv)   ;; '{'
        (local.set $maxidx (i32.const -1))
        (block $rdone (loop $rl
          (br_if $rdone (i32.eq (call $tk (global.get $tp)) (i32.const 6)))    ;; '}'
          (br_if $rdone (i32.eq (call $tk (global.get $tp)) (i32.const 14)))   ;; SAFETY: EOF
          (local.set $voff (call $ta (global.get $tp)))   ;; field name
          (local.set $vlen (call $tb (global.get $tp)))
          (call $adv)
          (if (i32.eq (call $tk (global.get $tp)) (i32.const 8)) (then (call $adv)))   ;; ':'
          (local.set $fidx (call $field_intern (local.get $voff) (local.get $vlen) (call $type_code)))
          (call $skip_type)
          (if (i32.gt_s (local.get $fidx) (local.get $maxidx)) (then (local.set $maxidx (local.get $fidx))))
          (if (i32.eq (call $tk (global.get $tp)) (i32.const 7)) (then (call $adv)))   ;; ','
          (br $rl)))
        (if (i32.eq (call $tk (global.get $tp)) (i32.const 6)) (then (call $adv)))   ;; '}'
        (call $rec_add (local.get $toff) (local.get $tlen) (i32.add (local.get $maxidx) (i32.const 1)))
        (return)))
    (local.set $tag (i32.const 0))
    (block $done
      (loop $vl
        (br_if $done (i32.ne (call $tk (global.get $tp)) (i32.const 27)))   ;; '|' precedes each variant; absence ends the type
        (call $adv)                                                          ;; '|'
        (br_if $done (i32.ne (call $tk (global.get $tp)) (i32.const 1)))     ;; need a variant name
        (local.set $voff (call $ta (global.get $tp)))
        (local.set $vlen (call $tb (global.get $tp)))
        (call $adv)
        (call $variant_add (local.get $voff) (local.get $vlen) (local.get $tag))
        (local.set $tag (i32.add (local.get $tag) (i32.const 1)))
        (if (i32.eq (call $tk (global.get $tp)) (i32.const 3))   ;; optional '(' Type ')'
          (then (call $adv) (call $skip_type)
                (if (i32.eq (call $tk (global.get $tp)) (i32.const 4)) (then (call $adv)))))
        (br $vl))))

  ;; match SCRUT { PAT -> BODY ... }   (PAT = Name | Name(bind) | _)
  (func $c_match
    (local $s i32) (local $jz i32) (local $endchain i32) (local $tag i32)
    (local $poff i32) (local $plen i32) (local $boff i32) (local $blen i32)
    (local $vslot i32) (local $havebind i32) (local $next i32)
    (call $adv)                       ;; 'match'
    (call $c_expr)                    ;; scrutinee -> stack
    (local.set $s (call $tmp_local))
    (call $emitw (i32.const 14)) (call $emitw (local.get $s))   ;; SETLOCAL S
    (call $adv)                       ;; '{'
    (local.set $endchain (i32.const -1))
    (block $arms_done
      (loop $arms
        (br_if $arms_done (i32.eq (call $tk (global.get $tp)) (i32.const 6)))    ;; '}'
        (br_if $arms_done (i32.eq (call $tk (global.get $tp)) (i32.const 14)))   ;; SAFETY: EOF
        (local.set $jz (i32.const -1))
        (local.set $havebind (i32.const 0))
        (if (i32.eq (call $tk (global.get $tp)) (i32.const 1))
          (then
            (local.set $poff (call $ta (global.get $tp)))
            (local.set $plen (call $tb (global.get $tp)))
            (call $adv)
            (if (call $is_wild (local.get $poff) (local.get $plen))
              (then)   ;; wildcard: matches anything, no dispatch
              (else
                (local.set $tag (call $variant_find (local.get $poff) (local.get $plen)))
                (if (i32.lt_s (local.get $tag) (i32.const 0))
                  (then (call $err_add (i32.const 3) (local.get $poff) (local.get $plen)) (local.set $tag (i32.const 0))))
                (if (i32.eq (call $tk (global.get $tp)) (i32.const 3))   ;; binding: Name(bind)
                  (then
                    (call $adv)
                    (local.set $boff (call $ta (global.get $tp)))
                    (local.set $blen (call $tb (global.get $tp)))
                    (call $adv)   ;; bind name (or '_')
                    (call $adv)   ;; ')'
                    (if (call $is_wild (local.get $boff) (local.get $blen))
                      (then)
                      (else (local.set $havebind (i32.const 1))))))
                (call $emitw (i32.const 2)) (call $emitw (local.get $s))      ;; GETARG S
                (call $emitw (i32.const 26))                                  ;; SUMTAG
                (call $emitw (i32.const 1)) (call $emitw (local.get $tag))    ;; PUSH tag
                (call $emitw (i32.const 19))                                  ;; EQ
                (call $emitw (i32.const 6)) (local.set $jz (global.get $emit)) (call $emitw (i32.const 0))   ;; JZ -> next arm
                (if (local.get $havebind)
                  (then
                    (local.set $vslot (i32.add (global.get $nparam) (global.get $nlocal)))
                    (call $local_add (local.get $boff) (local.get $blen))
                    (call $set_slot_type (local.get $vslot) (i32.const 0))     ;; match bind: Int/ptr payload
                    (call $emitw (i32.const 2)) (call $emitw (local.get $s))   ;; GETARG S
                    (call $emitw (i32.const 27))                               ;; SUMVAL
                    (call $emitw (i32.const 14)) (call $emitw (local.get $vslot)))))))   ;; SETLOCAL bind
          (else
            (call $err_add (i32.const 3) (call $ta (global.get $tp)) (call $tb (global.get $tp)))
            (call $adv)))
        (call $adv)            ;; '->'
        (call $c_expr)         ;; arm body -> value (or Unit)
        (call $emitw (i32.const 7))                          ;; JMP -> end (chained)
        (call $emitw (local.get $endchain))                  ;; operand = prev chain head (placeholder)
        (local.set $endchain (i32.sub (global.get $emit) (i32.const 1)))
        (if (i32.ge_s (local.get $jz) (i32.const 0)) (then (call $patch (local.get $jz) (global.get $emit))))
        (br $arms)))
    (block $pdone   ;; backpatch every arm's end-jump to here
      (loop $pl
        (br_if $pdone (i32.lt_s (local.get $endchain) (i32.const 0)))
        (local.set $next (call $codew (local.get $endchain)))
        (call $patch (local.get $endchain) (global.get $emit))
        (local.set $endchain (local.get $next))
        (br $pl)))
    (if (i32.eq (call $tk (global.get $tp)) (i32.const 6)) (then (call $adv))))   ;; consume '}'

  (func $c_if
    (local $jz i32) (local $jmp i32)
    (call $adv)            ;; 'if'
    (call $c_expr)         ;; condition
    (call $emitw (i32.const 6))                ;; JZ
    (local.set $jz (global.get $emit)) (call $emitw (i32.const 0))
    (call $c_block)        ;; then
    (if (call $kw_is (global.get $tp) (i32.const 248020) (i32.const 4))   ;; 'else'
      (then
        (call $adv)
        (call $emitw (i32.const 7))            ;; JMP
        (local.set $jmp (global.get $emit)) (call $emitw (i32.const 0))
        (call $patch (local.get $jz) (global.get $emit))
        (if (call $kw_is (global.get $tp) (i32.const 248010) (i32.const 2))   ;; 'else if' -> chain
          (then (call $c_if))
          (else (call $c_block)))
        (call $patch (local.get $jmp) (global.get $emit)))
      (else
        (call $patch (local.get $jz) (global.get $emit)))))

  (func $c_let
    (local $off i32) (local $len i32) (local $idx i32) (local $hasann i32) (local $anntype i32)
    (call $adv)   ;; 'let'
    (local.set $off (call $ta (global.get $tp)))
    (local.set $len (call $tb (global.get $tp)))
    (call $adv)   ;; binding name
    (local.set $hasann (i32.const 0))
    (if (i32.eq (call $tk (global.get $tp)) (i32.const 8))   ;; optional ': type'
      (then (call $adv)
            (local.set $hasann (i32.const 1)) (local.set $anntype (call $type_code))
            (call $skip_type)))
    (call $adv)        ;; '='
    (call $c_expr)     ;; value -> top of operand stack ($ety = its type)
    (local.set $idx (global.get $nlocal))
    (call $local_add (local.get $off) (local.get $len))
    ;; the local's type is its annotation if given, else inferred from the value
    (call $set_slot_type (i32.add (global.get $nparam) (local.get $idx))
      (select (local.get $anntype) (global.get $ety) (local.get $hasann)))
    (call $emitw (i32.const 14))                              ;; SETLOCAL
    (call $emitw (i32.add (global.get $nparam) (local.get $idx))))

  (func $c_assign
    (local $off i32) (local $len i32) (local $slot i32)
    (local.set $off (call $ta (global.get $tp)))
    (local.set $len (call $tb (global.get $tp)))
    (call $adv)   ;; IDENT
    (call $adv)   ;; '='
    (call $c_expr)
    (local.set $slot (call $var_find (local.get $off) (local.get $len)))
    (if (i32.lt_s (local.get $slot) (i32.const 0))
      (then (call $err_add (i32.const 1) (local.get $off) (local.get $len)) (local.set $slot (i32.const 0))))
    (call $emitw (i32.const 14))   ;; SETLOCAL
    (call $emitw (local.get $slot)))

  (func $c_while
    (local $jz i32) (local $cond_pc i32)
    (call $adv)            ;; 'while'
    (local.set $cond_pc (global.get $emit))
    (call $c_expr)         ;; condition
    (call $emitw (i32.const 6))                ;; JZ
    (local.set $jz (global.get $emit)) (call $emitw (i32.const 0))
    (call $c_block)        ;; body
    (call $emitw (i32.const 7))                ;; JMP
    (call $emitw (local.get $cond_pc))
    (call $patch (local.get $jz) (global.get $emit)))

  (func $c_stmt
    (if (call $kw_is (global.get $tp) (i32.const 248070) (i32.const 3))   ;; 'let'
      (then (call $c_let) (return)))
    (if (call $kw_is (global.get $tp) (i32.const 248080) (i32.const 3))   ;; 'var'
      (then (call $c_let) (return)))
    (if (call $kw_is (global.get $tp) (i32.const 248050) (i32.const 5))   ;; 'while'
      (then (call $c_while) (return)))
    (if (call $kw_is (global.get $tp) (i32.const 248010) (i32.const 2))   ;; 'if'
      (then (call $c_if) (return)))
    (if (call $kw_is (global.get $tp) (i32.const 248030) (i32.const 6))   ;; 'return'
      (then (call $adv) (call $c_expr) (call $emitw (i32.const 9)) (return)))
    (if (i32.eq (call $tk (global.get $tp)) (i32.const 1))   ;; IDENT
      (then
        (if (i32.eq (call $tk (i32.add (global.get $tp) (i32.const 1))) (i32.const 19))   ;; '='
          (then (call $c_assign) (return)))))
    (call $c_expr)
    (if (i32.eqz (global.get $expr_pushes)) (then (return)))
    (call $emitw (i32.const 14))   ;; SETLOCAL
    (call $emitw (global.get $discard_slot)))

  (func $c_block
    (call $adv)   ;; '{'
    (block $be
      (loop $bl
        (br_if $be (i32.eq (call $tk (global.get $tp)) (i32.const 6)))    ;; '}'
        (br_if $be (i32.eq (call $tk (global.get $tp)) (i32.const 14)))   ;; SAFETY: stop at EOF (never spin past it)
        (call $c_stmt)
        (br $bl)))
    (if (i32.eq (call $tk (global.get $tp)) (i32.const 6))
      (then (call $adv))                                           ;; consume '}'
      (else (call $err_add (i32.const 4) (i32.const 0) (i32.const 0)))))   ;; expected '}' (unterminated block)

  (func $c_fn
    (local $foff i32) (local $flen i32) (local $ismain i32) (local $reservefix i32) (local $i i32) (local $ntot i32)
    (global.set $cur_fn_is_unit (i32.const 1))
    (call $adv)   ;; 'fn'
    (if (i32.ne (call $tk (global.get $tp)) (i32.const 1))   ;; a function name (identifier) must follow 'fn'
      (then (call $err_add (i32.const 3) (call $ta (global.get $tp)) (call $tb (global.get $tp)))))
    (local.set $foff (call $ta (global.get $tp)))
    (local.set $flen (call $tb (global.get $tp)))
    (call $adv)   ;; fn name
    (call $sym_add (local.get $foff) (local.get $flen) (global.get $emit))
    (local.set $ismain (call $eqlit (local.get $foff) (local.get $flen) (i32.const 248060) (i32.const 4)))
    (if (local.get $ismain) (then (global.set $main_entry (global.get $emit))))
    (call $adv)   ;; '('
    (global.set $nparam (i32.const 0))
    (global.set $nlocal (i32.const 0))
    (block $pe
      (loop $pl
        (br_if $pe (i32.eq (call $tk (global.get $tp)) (i32.const 4)))   ;; ')'
        (call $param_add (call $ta (global.get $tp)) (call $tb (global.get $tp)))
        (call $adv)         ;; param name
        (call $adv)         ;; ':'
        (call $set_slot_type (i32.sub (global.get $nparam) (i32.const 1)) (call $type_code))   ;; param slot type
        (call $skip_type)   ;; type
        (if (i32.eq (call $tk (global.get $tp)) (i32.const 7)) (then (call $adv) (br $pl)))   ;; ','
        (br $pe)))
    (call $adv)   ;; ')'
    (if (i32.eq (call $tk (global.get $tp)) (i32.const 9))   ;; '->' type
      (then (call $adv)
            (if (i32.eqz (call $eqlit (call $ta (global.get $tp)) (call $tb (global.get $tp)) (i32.const 248090) (i32.const 4)))
              (then (global.set $cur_fn_is_unit (i32.const 0))))
            (call $set_sym_rettype (i32.sub (global.get $nsym) (i32.const 1)) (call $type_code))
            (call $skip_type)))
    ;; Allocate a nameless discard slot for expression statements
    (global.set $discard_slot (i32.add (global.get $nparam) (global.get $nlocal)))
    (call $local_add (i32.const 0) (i32.const 0))
    (call $set_slot_type (global.get $discard_slot) (i32.const 0))
    ;; reserve the frame (params + locals); operand backpatched once nlocal is known
    (call $emitw (i32.const 13))   ;; RESERVE
    (local.set $reservefix (global.get $emit)) (call $emitw (i32.const 0))
    (call $c_block)
    (local.set $ntot (i32.add (global.get $nparam) (global.get $nlocal)))
    (call $patch (local.get $reservefix) (local.get $ntot))
    (call $emitw (i32.const 57))   ;; TYPEMAP
    (call $emitw (local.get $ntot))
    (call $emitw (call $sym_rettype_of (local.get $foff) (local.get $flen)))
    (local.set $i (i32.const 0))
    (block $tmap_end (loop $tmap_loop
      (br_if $tmap_end (i32.ge_s (local.get $i) (local.get $ntot)))
      (call $emitw (call $slot_type (local.get $i)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $tmap_loop)))
    ;; terminator: main halts; every other function gets an implicit `return Unit` so a
    ;; body that falls through (e.g. a void fn ending in a statement) cannot run into the
    ;; next function's code. Unreachable for bodies that already end in `return`.
    (if (local.get $ismain)
      (then (call $emitw (i32.const 0)))                                          ;; HALT
      (else (call $emitw (i32.const 1)) (call $emitw (i32.const 0)) (call $emitw (i32.const 9)))))   ;; PUSH 0; RET

  (func $c_program
    (block $done
      (loop $L
        (br_if $done (i32.eq (call $tk (global.get $tp)) (i32.const 14)))   ;; EOF
        (br_if $done (i32.ge_u (global.get $tp) (global.get $ntok)))        ;; SAFETY: never read past the token stream
        (if (call $kw_is (global.get $tp) (i32.const 248150) (i32.const 4))   ;; 'type' declaration
          (then (call $c_type))
          (else
            (if (call $kw_is (global.get $tp) (i32.const 248000) (i32.const 2))   ;; 'fn'
              (then (call $c_fn))
              (else
                (call $err_add (i32.const 3) (call $ta (global.get $tp)) (call $tb (global.get $tp)))   ;; expected 'type' or 'fn'
                (call $adv)))))                                              ;; skip stray token -> progress
        (br $L))))

  ;; ---------- runtime helpers ----------
  (func $opush (param $v i64)
    (i64.store (i32.add (i32.const 1024) (i32.mul (global.get $osp) (i32.const 8))) (local.get $v))
    (global.set $osp (i32.add (global.get $osp) (i32.const 1))))
  (func $opop (result i64)
    (global.set $osp (i32.sub (global.get $osp) (i32.const 1)))
    (i64.load (i32.add (i32.const 1024) (i32.mul (global.get $osp) (i32.const 8)))))
  (func $getarg (param $i i32)
    (call $opush (i64.load (i32.add (i32.const 1024)
      (i32.mul (i32.add (global.get $argbase) (local.get $i)) (i32.const 8))))))
  (func $codew (param $idx i32) (result i32)
    (i32.load (i32.add (i32.const 11328) (i32.mul (local.get $idx) (i32.const 4)))))
  (func $print_i64 (param $v i64)
    (local $p i32) (local $neg i32)
    (i32.store8 (i32.const 11326) (i32.const 10))
    (local.set $p (i32.const 11326)) (local.set $neg (i32.const 0))
    (if (i64.lt_s (local.get $v) (i64.const 0))
      (then (local.set $neg (i32.const 1)) (local.set $v (i64.sub (i64.const 0) (local.get $v)))))
    (if (i64.eqz (local.get $v))
      (then (local.set $p (i32.sub (local.get $p) (i32.const 1))) (i32.store8 (local.get $p) (i32.const 48)))
      (else
        (block $d (loop $l
          (br_if $d (i64.eqz (local.get $v)))
          (local.set $p (i32.sub (local.get $p) (i32.const 1)))
          (i32.store8 (local.get $p) (i32.add (i32.const 48) (i32.wrap_i64 (i64.rem_u (local.get $v) (i64.const 10)))))
          (local.set $v (i64.div_u (local.get $v) (i64.const 10)))
          (br $l)))))
    (if (local.get $neg) (then (local.set $p (i32.sub (local.get $p) (i32.const 1))) (i32.store8 (local.get $p) (i32.const 45))))
    (call $console_print (local.get $p) (i32.sub (i32.const 11327) (local.get $p))))

  ;; ---------- float math (pure WAT; sqrt/abs are native, these are not) ----------
  ;; exp(x): range-reduce x = k*ln2 + r (|r| <= ln2/2), exp(x) = 2^k * exp(r),
  ;; exp(r) by Taylor series (r small -> fast). 2^k built from the f64 exponent bits.
  (func $f_exp (param $x f64) (result f64)
    (local $k i64) (local $r f64) (local $term f64) (local $sum f64) (local $i i32)
    (local.set $k (i64.trunc_sat_f64_s (f64.nearest (f64.div (local.get $x) (f64.const 0.6931471805599453)))))
    (local.set $r (f64.sub (local.get $x) (f64.mul (f64.convert_i64_s (local.get $k)) (f64.const 0.6931471805599453))))
    (local.set $sum (f64.const 1)) (local.set $term (f64.const 1)) (local.set $i (i32.const 1))
    (block $e (loop $l
      (br_if $e (i32.gt_s (local.get $i) (i32.const 16)))
      (local.set $term (f64.div (f64.mul (local.get $term) (local.get $r)) (f64.convert_i32_s (local.get $i))))
      (local.set $sum (f64.add (local.get $sum) (local.get $term)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    ;; 2^k = reinterpret((k+1023) << 52); fine for the |k| a pricing kernel reaches
    (f64.mul (local.get $sum)
      (f64.reinterpret_i64 (i64.shl (i64.add (local.get $k) (i64.const 1023)) (i64.const 52)))))
  ;; ln(x), x>0: x = m*2^e, m in [sqrt(0.5), sqrt2); ln = e*ln2 + 2*atanh((m-1)/(m+1)).
  ;; x <= 0 returns 0 (documented domain guard; never traps / NaNs).
  (func $f_ln (param $x f64) (result f64)
    (local $bits i64) (local $e i64) (local $m f64) (local $s f64) (local $s2 f64) (local $term f64) (local $sum f64) (local $i i32)
    (if (f64.le (local.get $x) (f64.const 0)) (then (return (f64.const 0))))
    (local.set $bits (i64.reinterpret_f64 (local.get $x)))
    (local.set $e (i64.sub (i64.and (i64.shr_u (local.get $bits) (i64.const 52)) (i64.const 0x7FF)) (i64.const 1023)))
    (local.set $m (f64.reinterpret_i64 (i64.or (i64.and (local.get $bits) (i64.const 0xFFFFFFFFFFFFF)) (i64.shl (i64.const 1023) (i64.const 52)))))
    (if (f64.gt (local.get $m) (f64.const 1.4142135623730951))
      (then (local.set $m (f64.mul (local.get $m) (f64.const 0.5))) (local.set $e (i64.add (local.get $e) (i64.const 1)))))
    (local.set $s (f64.div (f64.sub (local.get $m) (f64.const 1)) (f64.add (local.get $m) (f64.const 1))))
    (local.set $s2 (f64.mul (local.get $s) (local.get $s)))
    (local.set $term (local.get $s)) (local.set $sum (local.get $s)) (local.set $i (i32.const 3))
    (block $e2 (loop $l
      (br_if $e2 (i32.gt_s (local.get $i) (i32.const 31)))
      (local.set $term (f64.mul (local.get $term) (local.get $s2)))
      (local.set $sum (f64.add (local.get $sum) (f64.div (local.get $term) (f64.convert_i32_s (local.get $i)))))
      (local.set $i (i32.add (local.get $i) (i32.const 2)))
      (br $l)))
    (f64.add (f64.mul (f64.convert_i64_s (local.get $e)) (f64.const 0.6931471805599453))
             (f64.mul (f64.const 2) (local.get $sum))))
  ;; pow(x, y) = exp(y * ln x)  (x>0; integer y via the same path)
  (func $f_pow (param $x f64) (param $y f64) (result f64)
    (call $f_exp (f64.mul (local.get $y) (call $f_ln (local.get $x)))))

  ;; ---------- interpreter ----------
  (func $run (param $start i32)
    (local $op i32) (local $a i64) (local $bb i64) (local $t i64)
    (local $entry i32) (local $argc i32) (local $target i32) (local $fuel i64)
    (global.set $pc (local.get $start))
    (global.set $osp (i32.const 0)) (global.set $csp (i32.const 0)) (global.set $argbase (i32.const 0))
    (local.set $fuel (i64.const 0))
    (block $halt
      (loop $loop
        (local.set $fuel (i64.add (local.get $fuel) (i64.const 1)))            ;; SAFETY: fuel limit -> no infinite run
        (br_if $halt (i64.gt_u (local.get $fuel) (global.get $fuel_max)))
        (local.set $op (call $codew (global.get $pc)))
        (global.set $pc (i32.add (global.get $pc) (i32.const 1)))
        (if (i32.eqz (local.get $op)) (then (br $halt)))
        (if (i32.eq (local.get $op) (i32.const 1)) (then
          (call $opush (i64.extend_i32_s (call $codew (global.get $pc))))
          (global.set $pc (i32.add (global.get $pc) (i32.const 1))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 2)) (then
          (call $getarg (call $codew (global.get $pc)))
          (global.set $pc (i32.add (global.get $pc) (i32.const 1))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 3)) (then
          (local.set $bb (call $opop)) (local.set $a (call $opop))
          (call $opush (i64.add (local.get $a) (local.get $bb))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 4)) (then
          (local.set $bb (call $opop)) (local.set $a (call $opop))
          (call $opush (i64.sub (local.get $a) (local.get $bb))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 5)) (then
          (local.set $bb (call $opop)) (local.set $a (call $opop))
          (call $opush (i64.extend_i32_u (i64.lt_s (local.get $a) (local.get $bb)))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 6)) (then
          (local.set $target (call $codew (global.get $pc)))
          (global.set $pc (i32.add (global.get $pc) (i32.const 1)))
          (if (i64.eqz (call $opop)) (then (global.set $pc (local.get $target)))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 7)) (then
          (global.set $pc (call $codew (global.get $pc))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 8)) (then
          (local.set $entry (call $codew (global.get $pc)))
          (local.set $argc (call $codew (i32.add (global.get $pc) (i32.const 1))))
          (if (global.get $prof) (then
            (i32.store (i32.add (i32.const 600000) (i32.mul (local.get $entry) (i32.const 4)))
              (i32.add (i32.load (i32.add (i32.const 600000) (i32.mul (local.get $entry) (i32.const 4)))) (i32.const 1)))))
          (global.set $pc (i32.add (global.get $pc) (i32.const 2)))
          (i32.store (i32.add (i32.const 9216) (i32.mul (global.get $csp) (i32.const 8))) (global.get $pc))
          (i32.store (i32.add (i32.add (i32.const 9216) (i32.mul (global.get $csp) (i32.const 8))) (i32.const 4)) (global.get $argbase))
          (global.set $csp (i32.add (global.get $csp) (i32.const 1)))
          (global.set $argbase (i32.sub (global.get $osp) (local.get $argc)))
          (global.set $pc (local.get $entry)) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 9)) (then
          (br_if $halt (i32.eqz (global.get $csp)))   ;; top-level RET (main returning with no caller frame): halt, do not underflow csp
          (local.set $t (call $opop))
          (global.set $osp (global.get $argbase))
          (call $opush (local.get $t))
          (global.set $csp (i32.sub (global.get $csp) (i32.const 1)))
          (global.set $pc (i32.load (i32.add (i32.const 9216) (i32.mul (global.get $csp) (i32.const 8)))))
          (global.set $argbase (i32.load (i32.add (i32.add (i32.const 9216) (i32.mul (global.get $csp) (i32.const 8))) (i32.const 4))))
          (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 11)) (then
          (local.set $bb (call $opop)) (local.set $a (call $opop))
          (call $opush (i64.mul (local.get $a) (local.get $bb))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 12)) (then
          (local.set $bb (call $opop)) (local.set $a (call $opop))
          (call $opush (i64.div_s (local.get $a) (local.get $bb))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 13)) (then           ;; RESERVE n (frame slots): zero-fill up to argbase+n
          (local.set $target (i32.add (global.get $argbase) (call $codew (global.get $pc))))
          (global.set $pc (i32.add (global.get $pc) (i32.const 1)))
          (block $re (loop $rl
            (br_if $re (i32.ge_s (global.get $osp) (local.get $target)))
            (call $opush (i64.const 0))
            (br $rl)))
          (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 14)) (then           ;; SETLOCAL slot: pop -> frame slot argbase+slot
          (local.set $target (call $codew (global.get $pc)))
          (global.set $pc (i32.add (global.get $pc) (i32.const 1)))
          (local.set $t (call $opop))
          (i64.store (i32.add (i32.const 1024) (i32.mul (i32.add (global.get $argbase) (local.get $target)) (i32.const 8))) (local.get $t))
          (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 15)) (then           ;; MKTEXT ptr: push a Text pointer
          (call $opush (i64.extend_i32_u (call $codew (global.get $pc))))
          (global.set $pc (i32.add (global.get $pc) (i32.const 1))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 16)) (then           ;; PRINTTEXT: pop Text ptr -> print its bytes
          (local.set $a (call $opop))
          (call $console_print (i32.add (i32.wrap_i64 (local.get $a)) (i32.const 4)) (i32.load (i32.wrap_i64 (local.get $a))))
          (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 17)) (then           ;; CONCAT: pop b, pop a -> push concat(a,b)
          (local.set $bb (call $opop)) (local.set $a (call $opop))
          (call $opush (i64.extend_i32_u (call $concat (i32.wrap_i64 (local.get $a)) (i32.wrap_i64 (local.get $bb))))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 18)) (then           ;; INT2TEXT: pop int -> push Text
          (call $opush (i64.extend_i32_u (call $int2text (call $opop)))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 19)) (then           ;; EQ
          (local.set $bb (call $opop)) (local.set $a (call $opop))
          (call $opush (i64.extend_i32_u (i64.eq (local.get $a) (local.get $bb)))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 20)) (then           ;; NE
          (local.set $bb (call $opop)) (local.set $a (call $opop))
          (call $opush (i64.extend_i32_u (i64.ne (local.get $a) (local.get $bb)))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 21)) (then           ;; LE
          (local.set $bb (call $opop)) (local.set $a (call $opop))
          (call $opush (i64.extend_i32_u (i64.le_s (local.get $a) (local.get $bb)))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 22)) (then           ;; GE
          (local.set $bb (call $opop)) (local.set $a (call $opop))
          (call $opush (i64.extend_i32_u (i64.ge_s (local.get $a) (local.get $bb)))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 23)) (then           ;; GT
          (local.set $bb (call $opop)) (local.set $a (call $opop))
          (call $opush (i64.extend_i32_u (i64.gt_s (local.get $a) (local.get $bb)))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 24)) (then           ;; MOD
          (local.set $bb (call $opop)) (local.set $a (call $opop))
          (call $opush (i64.rem_s (local.get $a) (local.get $bb))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 25)) (then           ;; MKSUM tag: pop payload -> push sum cell {tag@+0, payload@+8}
          (local.set $target (call $codew (global.get $pc)))
          (global.set $pc (i32.add (global.get $pc) (i32.const 1)))
          (local.set $t (call $opop))                              ;; payload
          (br_if $halt (i32.gt_u (i32.add (global.get $hp) (i32.const 16)) (i32.const 524288)))   ;; SAFETY: heap bound
          (local.set $entry (call $halloc (i32.const 16)))         ;; $entry reused as cell ptr
          (i32.store (local.get $entry) (local.get $target))       ;; tag
          (i64.store (i32.add (local.get $entry) (i32.const 8)) (local.get $t))   ;; payload
          (call $opush (i64.extend_i32_u (local.get $entry)))
          (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 26)) (then           ;; SUMTAG: pop sum ptr -> push tag
          (call $opush (i64.extend_i32_u (i32.load (i32.wrap_i64 (call $opop))))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 27)) (then           ;; SUMVAL: pop sum ptr -> push payload
          (call $opush (i64.load (i32.add (i32.wrap_i64 (call $opop)) (i32.const 8)))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 28)) (then           ;; TEXTEQ: pop b, pop a (Text ptrs) -> push 0/1
          (local.set $bb (call $opop)) (local.set $a (call $opop))
          (call $opush (i64.extend_i32_u (call $texteq (i32.wrap_i64 (local.get $a)) (i32.wrap_i64 (local.get $bb))))) (br $loop)))
        ;; ---- Float ops (values are f64 bits stored in the i64 stack slot) ----
        (if (i32.eq (local.get $op) (i32.const 29)) (then           ;; FPUSH lo hi: push an f64 literal (two 32-bit halves)
          (call $opush (i64.or
            (i64.extend_i32_u (call $codew (global.get $pc)))
            (i64.shl (i64.extend_i32_u (call $codew (i32.add (global.get $pc) (i32.const 1)))) (i64.const 32))))
          (global.set $pc (i32.add (global.get $pc) (i32.const 2))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 30)) (then           ;; I2F: TOS Int -> Float
          (call $opush (i64.reinterpret_f64 (f64.convert_i64_s (call $opop)))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 31)) (then           ;; I2FU: convert the value UNDER TOS (sp-2) Int -> Float, in place
          (i64.store (i32.add (i32.const 1024) (i32.mul (i32.sub (global.get $osp) (i32.const 2)) (i32.const 8)))
            (i64.reinterpret_f64 (f64.convert_i64_s
              (i64.load (i32.add (i32.const 1024) (i32.mul (i32.sub (global.get $osp) (i32.const 2)) (i32.const 8)))))))
          (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 32)) (then           ;; FADD
          (local.set $bb (call $opop)) (local.set $a (call $opop))
          (call $opush (i64.reinterpret_f64 (f64.add (f64.reinterpret_i64 (local.get $a)) (f64.reinterpret_i64 (local.get $bb))))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 33)) (then           ;; FSUB (a - b)
          (local.set $bb (call $opop)) (local.set $a (call $opop))
          (call $opush (i64.reinterpret_f64 (f64.sub (f64.reinterpret_i64 (local.get $a)) (f64.reinterpret_i64 (local.get $bb))))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 34)) (then           ;; FMUL
          (local.set $bb (call $opop)) (local.set $a (call $opop))
          (call $opush (i64.reinterpret_f64 (f64.mul (f64.reinterpret_i64 (local.get $a)) (f64.reinterpret_i64 (local.get $bb))))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 35)) (then           ;; FDIV (a / b)
          (local.set $bb (call $opop)) (local.set $a (call $opop))
          (call $opush (i64.reinterpret_f64 (f64.div (f64.reinterpret_i64 (local.get $a)) (f64.reinterpret_i64 (local.get $bb))))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 36)) (then           ;; FLT
          (local.set $bb (call $opop)) (local.set $a (call $opop))
          (call $opush (i64.extend_i32_u (f64.lt (f64.reinterpret_i64 (local.get $a)) (f64.reinterpret_i64 (local.get $bb))))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 37)) (then           ;; FLE
          (local.set $bb (call $opop)) (local.set $a (call $opop))
          (call $opush (i64.extend_i32_u (f64.le (f64.reinterpret_i64 (local.get $a)) (f64.reinterpret_i64 (local.get $bb))))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 38)) (then           ;; FGT
          (local.set $bb (call $opop)) (local.set $a (call $opop))
          (call $opush (i64.extend_i32_u (f64.gt (f64.reinterpret_i64 (local.get $a)) (f64.reinterpret_i64 (local.get $bb))))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 39)) (then           ;; FGE
          (local.set $bb (call $opop)) (local.set $a (call $opop))
          (call $opush (i64.extend_i32_u (f64.ge (f64.reinterpret_i64 (local.get $a)) (f64.reinterpret_i64 (local.get $bb))))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 40)) (then           ;; FEQ
          (local.set $bb (call $opop)) (local.set $a (call $opop))
          (call $opush (i64.extend_i32_u (f64.eq (f64.reinterpret_i64 (local.get $a)) (f64.reinterpret_i64 (local.get $bb))))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 41)) (then           ;; FNE
          (local.set $bb (call $opop)) (local.set $a (call $opop))
          (call $opush (i64.extend_i32_u (f64.ne (f64.reinterpret_i64 (local.get $a)) (f64.reinterpret_i64 (local.get $bb))))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 42)) (then           ;; F2I: Float -> Int (truncate toward zero; saturating, never traps)
          (call $opush (i64.trunc_sat_f64_s (f64.reinterpret_i64 (call $opop)))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 43)) (then           ;; FROUND: Float -> Int, nearest via floor(x + 0.5)
          (call $opush (i64.trunc_sat_f64_s (f64.floor (f64.add (f64.reinterpret_i64 (call $opop)) (f64.const 0.5))))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 44)) (then           ;; FSQRT
          (call $opush (i64.reinterpret_f64 (f64.sqrt (f64.reinterpret_i64 (call $opop))))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 45)) (then           ;; FABS
          (call $opush (i64.reinterpret_f64 (f64.abs (f64.reinterpret_i64 (call $opop))))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 46)) (then           ;; FEXP
          (call $opush (i64.reinterpret_f64 (call $f_exp (f64.reinterpret_i64 (call $opop))))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 47)) (then           ;; FLN
          (call $opush (i64.reinterpret_f64 (call $f_ln (f64.reinterpret_i64 (call $opop))))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 48)) (then           ;; FPOW (a^b)
          (local.set $bb (call $opop)) (local.set $a (call $opop))
          (call $opush (i64.reinterpret_f64 (call $f_pow (f64.reinterpret_i64 (local.get $a)) (f64.reinterpret_i64 (local.get $bb))))) (br $loop)))
        ;; ---- arrays: handle = ptr to [len:i32][n x i64 slots] (holds int or float bits) ----
        (if (i32.eq (local.get $op) (i32.const 49)) (then           ;; ANEW: pop n -> alloc zeroed array, push handle
          (local.set $a (call $opop))   ;; n
          (br_if $halt (i32.gt_u (i32.add (global.get $hp) (i32.add (i32.const 4) (i32.mul (i32.wrap_i64 (local.get $a)) (i32.const 8)))) (i32.const 524288)))   ;; SAFETY: heap bound
          (local.set $entry (call $halloc (i32.add (i32.const 4) (i32.mul (i32.wrap_i64 (local.get $a)) (i32.const 8)))))
          (i32.store (local.get $entry) (i32.wrap_i64 (local.get $a)))   ;; len
          (call $opush (i64.extend_i32_u (local.get $entry)))
          (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 50)) (then           ;; AGET: pop i, pop a -> push slot i (0 if out of bounds)
          (local.set $bb (call $opop)) (local.set $a (call $opop))
          (if (i32.and (i32.ge_s (i32.wrap_i64 (local.get $bb)) (i32.const 0))
                       (i32.lt_s (i32.wrap_i64 (local.get $bb)) (i32.load (i32.wrap_i64 (local.get $a)))))
            (then (call $opush (i64.load (i32.add (i32.add (i32.wrap_i64 (local.get $a)) (i32.const 4)) (i32.mul (i32.wrap_i64 (local.get $bb)) (i32.const 8))))))
            (else (call $opush (i64.const 0))))
          (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 51)) (then           ;; ASET: pop x, pop i, pop a -> store (no value pushed); bounds-guarded
          (local.set $t (call $opop)) (local.set $bb (call $opop)) (local.set $a (call $opop))
          (if (i32.and (i32.ge_s (i32.wrap_i64 (local.get $bb)) (i32.const 0))
                       (i32.lt_s (i32.wrap_i64 (local.get $bb)) (i32.load (i32.wrap_i64 (local.get $a)))))
            (then (i64.store (i32.add (i32.add (i32.wrap_i64 (local.get $a)) (i32.const 4)) (i32.mul (i32.wrap_i64 (local.get $bb)) (i32.const 8))) (local.get $t))))
          (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 52)) (then           ;; ALEN: pop a -> push len
          (call $opush (i64.extend_i32_u (i32.load (i32.wrap_i64 (call $opop))))) (br $loop)))
        ;; ---- raw memory (the self-host keystone): unchecked load/store, how a Lumen compiler reaches its own memory map ----
        (if (i32.eq (local.get $op) (i32.const 53)) (then           ;; LOAD32 addr -> i32 sign-extended (PUSH immediates round-trip)
          (call $opush (i64.extend_i32_s (i32.load (i32.wrap_i64 (call $opop))))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 54)) (then           ;; STORE32 addr val -> Unit (pops val then addr)
          (local.set $t (call $opop)) (local.set $a (call $opop))
          (i32.store (i32.wrap_i64 (local.get $a)) (i32.wrap_i64 (local.get $t))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 55)) (then           ;; LOAD8 addr -> byte zero-extended
          (call $opush (i64.extend_i32_u (i32.load8_u (i32.wrap_i64 (call $opop))))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 56)) (then           ;; STORE8 addr val -> Unit (pops val then addr)
          (local.set $t (call $opop)) (local.set $a (call $opop))
          (i32.store8 (i32.wrap_i64 (local.get $a)) (i32.wrap_i64 (local.get $t))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 57)) (then           ;; TYPEMAP N type_1 .. type_N (skip)
          (global.set $pc (i32.add (global.get $pc) (i32.add (call $codew (global.get $pc)) (i32.const 2))))
          (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 58)) (then           ;; BAND a b -> a & b
          (local.set $bb (call $opop)) (local.set $a (call $opop))
          (call $opush (i64.and (local.get $a) (local.get $bb))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 59)) (then           ;; BOR a b -> a | b
          (local.set $bb (call $opop)) (local.set $a (call $opop))
          (call $opush (i64.or (local.get $a) (local.get $bb))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 60)) (then           ;; BXOR a b -> a ^ b
          (local.set $bb (call $opop)) (local.set $a (call $opop))
          (call $opush (i64.xor (local.get $a) (local.get $bb))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 61)) (then           ;; SHL a n -> a << n
          (local.set $bb (call $opop)) (local.set $a (call $opop))
          (call $opush (i64.shl (local.get $a) (local.get $bb))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 62)) (then           ;; SHR a n -> a >>> n (logical / unsigned)
          (local.set $bb (call $opop)) (local.set $a (call $opop))
          (call $opush (i64.shr_u (local.get $a) (local.get $bb))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 63)) (then           ;; BNOT a -> ~a
          (call $opush (i64.xor (call $opop) (i64.const -1))) (br $loop)))
        ;; ---- Dec (D1): exact decimal, i64 scaled by 1_000_000. Overflow/div-by-zero trap
        ;; via `unreachable`, the same deterministic-WASM-trap idiom the interpreter already
        ;; relies on for Int '/' and '%' (i64.div_s/rem_s trap natively on a zero divisor;
        ;; there is no explicit check for that in this file either) ----
        (if (i32.eq (local.get $op) (i32.const 64)) (then           ;; DPUSH lo hi: push a Dec i64 literal (two 32-bit halves, like FPUSH)
          (call $opush (i64.or
            (i64.extend_i32_u (call $codew (global.get $pc)))
            (i64.shl (i64.extend_i32_u (call $codew (i32.add (global.get $pc) (i32.const 1)))) (i64.const 32))))
          (global.set $pc (i32.add (global.get $pc) (i32.const 2))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 65)) (then           ;; DFROMI: TOS Int -> Dec (i64 * 1_000_000), overflow traps
          (local.set $a (call $opop))
          (if (i32.or (i64.gt_s (local.get $a) (i64.const 9223372036854)) (i64.lt_s (local.get $a) (i64.const -9223372036854)))
            (then (unreachable)))
          (call $opush (i64.mul (local.get $a) (i64.const 1000000))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 66)) (then           ;; DADD: exact i64 add, overflow (or landing on the excluded i64::MIN) traps
          (local.set $bb (call $opop)) (local.set $a (call $opop))
          (local.set $t (i64.add (local.get $a) (local.get $bb)))
          (if (i32.or (i64.lt_s (i64.and (i64.xor (local.get $a) (local.get $t)) (i64.xor (local.get $bb) (local.get $t))) (i64.const 0))
                      (i64.eq (local.get $t) (i64.const -9223372036854775808)))
            (then (unreachable)))
          (call $opush (local.get $t)) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 67)) (then           ;; DSUB (a - b): exact i64 sub, overflow (or i64::MIN) traps
          (local.set $bb (call $opop)) (local.set $a (call $opop))
          (local.set $t (i64.sub (local.get $a) (local.get $bb)))
          (if (i32.or (i64.lt_s (i64.and (i64.xor (local.get $a) (local.get $bb)) (i64.xor (local.get $a) (local.get $t))) (i64.const 0))
                      (i64.eq (local.get $t) (i64.const -9223372036854775808)))
            (then (unreachable)))
          (call $opush (local.get $t)) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 68)) (then           ;; DMUL: Dec*Dec, exact 128-bit product, round-half-even /1e6, overflow traps
          (local.set $bb (call $opop)) (local.set $a (call $opop))
          (call $opush (call $dec_mul (local.get $a) (local.get $bb))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 69)) (then           ;; DDIV: dec_div(a,b) = round_half_even(a*1e6/b); b==0 or overflow traps
          (local.set $bb (call $opop)) (local.set $a (call $opop))
          (call $opush (call $dec_div (local.get $a) (local.get $bb))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 70)) (then           ;; D2TEXT: pop Dec -> push Text ptr (canonical form)
          (call $opush (i64.extend_i32_u (call $dec2text (call $opop)))) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 10)) (then (call $print_i64 (call $opop)) (br $loop)))
        (br $halt)))
    (global.set $last_steps (local.get $fuel)))

  ;; ---------- entry points ----------
  (func (export "compile") (param $srclen i32) (result i32)
    (drop (call $lex_compile (local.get $srclen)))
    (global.get $emit))
  (func (export "compile_and_run") (param $srclen i32)
    (drop (call $lex_compile (local.get $srclen)))
    (call $run (global.get $main_entry)))
  (func $lex_compile (param $srclen i32) (result i32)
    (global.set $emit (i32.const 0)) (global.set $nsym (i32.const 0))
    (global.set $nfixup (i32.const 0)) (global.set $nerr (i32.const 0)) (global.set $main_entry (i32.const 0))
    (global.set $hp (i32.const 488000))   ;; literals materialize from here; run continues above them
    (global.set $nfield (i32.const 0)) (global.set $nrec (i32.const 0))   ;; record field/type registries
    (global.set $nvariant (i32.const 0))   ;; built-in Result variants: ok=tag 0, err=tag 1
    (call $variant_add (i32.const 248180) (i32.const 2) (i32.const 0))
    (call $variant_add (i32.const 248190) (i32.const 3) (i32.const 1))
    (call $lex (local.get $srclen))
    (global.set $tp (i32.const 0))
    (call $c_program)
    (call $resolve_fixups)   ;; resolve all call targets, including forward references
    (global.get $emit))
  (func (export "run") (param $start i32) (call $run (local.get $start)))
  (func (export "set_fuel_max") (param $v i64) (global.set $fuel_max (local.get $v)))   ;; SAFETY: override interpreter step cap (tests)
  (func (export "set_prof") (param $on i32)
    (local $i i32)
    (if (i32.eqz (local.get $on)) (then (global.set $prof (i32.const 0)))
      (else
        (local.set $i (i32.const 600000))
        (block $ze (loop $zl
          (br_if $ze (i32.ge_u (local.get $i) (i32.const 700000)))
          (i32.store (local.get $i) (i32.const 0))
          (local.set $i (i32.add (local.get $i) (i32.const 4)))
          (br $zl)))
        (global.set $prof (local.get $on)))))
  (func (export "get_last_steps") (result i64) (global.get $last_steps))
  (func (export "prof_count") (param $entry i32) (result i32)
    (i32.load (i32.add (i32.const 600000) (i32.mul (local.get $entry) (i32.const 4)))))
  (func (export "dbg_nerr") (result i32) (global.get $nerr))
  (func (export "dbg_ntok") (result i32) (global.get $ntok))
  (func (export "dbg_emit") (result i32) (global.get $emit))
  (func (export "dbg_main") (result i32) (global.get $main_entry))
  (func (export "dbg_pc") (result i32) (global.get $pc))
)
