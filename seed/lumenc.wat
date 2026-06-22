;; lumenc: the Lumen-mu (integer subset) compiler, in WebAssembly text.
;; Zero-legacy: WAT is a compilation substrate, not a high-level language. Disposable seed.
;;
;; Pipeline: host writes source bytes at SRC_BASE -> $lex (tokenizer) -> $c_program
;; (recursive-descent parser that emits IR directly, with JZ backpatching and a function
;; symbol table) -> $run (the bytecode interpreter). Exported: compile_and_run(srclen).
;;
;; Subset: fn / params / let locals / if [else] / return / Int arithmetic (+ - * / <) /
;; function calls (ANY order: forward references and mutual recursion via a fixup table) /
;; console.print_int(expr). No Text/sum/Result yet.
;;
;; Frame model: a call's args occupy frame slots [0,nparam); `let` locals occupy
;; [nparam, nparam+nlocal). RESERVE sizes the frame at entry; GETARG reads any slot;
;; SETLOCAL writes a local slot. RET discards the whole frame and pushes the result.
;;
;; Memory map (bytes). Region sizes are constants, trivially enlarged if a program needs more.
;;   [1024 .. 9216)    operand stack (i64 slots; 1024 frames deep)
;;   [9216 .. 11264)   call stack (i32 pairs: return_pc, prev_argbase; 256 deep)
;;   [11264 .. 11328)  itoa text buffer (ANCHOR 11326)
;;   [11328 .. 20000)  CODE (emitted IR words; ~2167)
;;   [20000 .. 30000)  SRC (source bytes, host-written; 10 KB)
;;   [30000 .. 50000)  TOKENS (kind:i32, a:i32, b:i32) = 12 bytes each (~1666)
;;   [50000 .. 51000)  SYMBOLS (name_off, name_len, entry) = 12 bytes each (~83 fns)
;;   [51000 .. 51500)  PARAMS of current fn (name_off, name_len) = 8 bytes each (~62)
;;   [51500 .. 52000)  LOCALS of current fn (name_off, name_len) = 8 bytes each (~62)
;;   [52000 .. 52073]  keyword literals (data)
;;   [53000 .. )       call-target FIXUPS (code_pos, name_off, name_len) = 12 bytes each
(module
  (import "lumen" "console_print" (func $console_print (param i32 i32)))
  (memory (export "mem") 3)

  (data (i32.const 52000) "fn")
  (data (i32.const 52010) "if")
  (data (i32.const 52020) "else")
  (data (i32.const 52030) "return")
  (data (i32.const 52040) "print_int")
  (data (i32.const 52060) "main")
  (data (i32.const 52070) "let")

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
  (global $main_entry (mut i32) (i32.const 0))

  ;; ---------- small helpers ----------
  (func $b (param $i i32) (result i32)
    (i32.load8_u (i32.add (i32.const 20000) (local.get $i))))
  (func $is_digit (param $c i32) (result i32)
    (i32.and (i32.ge_u (local.get $c) (i32.const 48)) (i32.le_u (local.get $c) (i32.const 57))))
  (func $is_alpha (param $c i32) (result i32)
    (i32.or
      (i32.or (i32.and (i32.ge_u (local.get $c) (i32.const 65)) (i32.le_u (local.get $c) (i32.const 90)))
              (i32.and (i32.ge_u (local.get $c) (i32.const 97)) (i32.le_u (local.get $c) (i32.const 122))))
      (i32.eq (local.get $c) (i32.const 95))))
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

  ;; token accessors
  (func $tk (param $i i32) (result i32)
    (i32.load (i32.add (i32.const 30000) (i32.mul (local.get $i) (i32.const 12)))))
  (func $ta (param $i i32) (result i32)
    (i32.load (i32.add (i32.add (i32.const 30000) (i32.mul (local.get $i) (i32.const 12))) (i32.const 4))))
  (func $tb (param $i i32) (result i32)
    (i32.load (i32.add (i32.add (i32.const 30000) (i32.mul (local.get $i) (i32.const 12))) (i32.const 8))))
  (func $tokset (param $i i32) (param $k i32) (param $a i32) (param $bb i32)
    (local $base i32)
    (local.set $base (i32.add (i32.const 30000) (i32.mul (local.get $i) (i32.const 12))))
    (i32.store (local.get $base) (local.get $k))
    (i32.store (i32.add (local.get $base) (i32.const 4)) (local.get $a))
    (i32.store (i32.add (local.get $base) (i32.const 8)) (local.get $bb)))
  (func $kw_is (param $i i32) (param $p i32) (param $plen i32) (result i32)
    (if (i32.ne (call $tk (local.get $i)) (i32.const 1)) (then (return (i32.const 0))))
    (return (call $eqlit (call $ta (local.get $i)) (call $tb (local.get $i)) (local.get $p) (local.get $plen))))

  ;; symbol + param tables
  (func $sym_add (param $off i32) (param $len i32) (param $entry i32)
    (local $base i32)
    (local.set $base (i32.add (i32.const 50000) (i32.mul (global.get $nsym) (i32.const 12))))
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
        (local.set $base (i32.add (i32.const 50000) (i32.mul (local.get $k) (i32.const 12))))
        (if (call $eqlit (i32.load (local.get $base)) (i32.load (i32.add (local.get $base) (i32.const 4)))
                         (local.get $off) (local.get $len))
          (then (return (i32.load (i32.add (local.get $base) (i32.const 8))))))
        (local.set $k (i32.add (local.get $k) (i32.const 1)))
        (br $l)))
    (return (i32.const -1)))
  (func $param_add (param $off i32) (param $len i32)
    (local $base i32)
    (local.set $base (i32.add (i32.const 51000) (i32.mul (global.get $nparam) (i32.const 8))))
    (i32.store (local.get $base) (local.get $off))
    (i32.store (i32.add (local.get $base) (i32.const 4)) (local.get $len))
    (global.set $nparam (i32.add (global.get $nparam) (i32.const 1))))
  (func $param_find (param $off i32) (param $len i32) (result i32)
    (local $k i32) (local $base i32)
    (local.set $k (i32.const 0))
    (block $done
      (loop $l
        (br_if $done (i32.ge_u (local.get $k) (global.get $nparam)))
        (local.set $base (i32.add (i32.const 51000) (i32.mul (local.get $k) (i32.const 8))))
        (if (call $eqlit (i32.load (local.get $base)) (i32.load (i32.add (local.get $base) (i32.const 4)))
                         (local.get $off) (local.get $len))
          (then (return (local.get $k))))
        (local.set $k (i32.add (local.get $k) (i32.const 1)))
        (br $l)))
    (return (i32.const -1)))

  ;; locals (let bindings) table at [51500 .. 52000), 8 bytes each (name_off, name_len)
  (func $local_add (param $off i32) (param $len i32)
    (local $base i32)
    (local.set $base (i32.add (i32.const 51500) (i32.mul (global.get $nlocal) (i32.const 8))))
    (i32.store (local.get $base) (local.get $off))
    (i32.store (i32.add (local.get $base) (i32.const 4)) (local.get $len))
    (global.set $nlocal (i32.add (global.get $nlocal) (i32.const 1))))
  (func $local_find (param $off i32) (param $len i32) (result i32)
    (local $k i32) (local $base i32)
    (local.set $k (i32.const 0))
    (block $done
      (loop $l
        (br_if $done (i32.ge_u (local.get $k) (global.get $nlocal)))
        (local.set $base (i32.add (i32.const 51500) (i32.mul (local.get $k) (i32.const 8))))
        (if (call $eqlit (i32.load (local.get $base)) (i32.load (i32.add (local.get $base) (i32.const 4)))
                         (local.get $off) (local.get $len))
          (then (return (local.get $k))))
        (local.set $k (i32.add (local.get $k) (i32.const 1)))
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

  ;; call-target fixups at [53000 ..), 12 bytes each (code_pos, name_off, name_len).
  ;; Every CALL records one; all are resolved after the whole program is parsed, so a
  ;; function may be CALLed before it is defined (forward refs, mutual recursion).
  (func $fixup_add (param $pos i32) (param $off i32) (param $len i32)
    (local $base i32)
    (local.set $base (i32.add (i32.const 53000) (i32.mul (global.get $nfixup) (i32.const 12))))
    (i32.store (local.get $base) (local.get $pos))
    (i32.store (i32.add (local.get $base) (i32.const 4)) (local.get $off))
    (i32.store (i32.add (local.get $base) (i32.const 8)) (local.get $len))
    (global.set $nfixup (i32.add (global.get $nfixup) (i32.const 1))))
  (func $resolve_fixups
    (local $k i32) (local $base i32)
    (local.set $k (i32.const 0))
    (block $done
      (loop $l
        (br_if $done (i32.ge_u (local.get $k) (global.get $nfixup)))
        (local.set $base (i32.add (i32.const 53000) (i32.mul (local.get $k) (i32.const 12))))
        (call $patch (i32.load (local.get $base))
          (call $sym_find (i32.load (i32.add (local.get $base) (i32.const 4)))
                          (i32.load (i32.add (local.get $base) (i32.const 8)))))
        (local.set $k (i32.add (local.get $k) (i32.const 1)))
        (br $l))))

  ;; code emit
  (func $emitw (param $v i32)
    (i32.store (i32.add (i32.const 11328) (i32.mul (global.get $emit) (i32.const 4))) (local.get $v))
    (global.set $emit (i32.add (global.get $emit) (i32.const 1))))
  (func $patch (param $idx i32) (param $v i32)
    (i32.store (i32.add (i32.const 11328) (i32.mul (local.get $idx) (i32.const 4))) (local.get $v)))
  (func $adv (global.set $tp (i32.add (global.get $tp) (i32.const 1))))

  ;; ---------- tokenizer ----------
  (func $lex (param $srclen i32)
    (local $i i32) (local $n i32) (local $c i32) (local $start i32) (local $val i32)
    (local.set $i (i32.const 0)) (local.set $n (i32.const 0))
    (block $end
      (loop $L
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
        ;; number
        (if (call $is_digit (local.get $c))
          (then
            (local.set $val (i32.const 0))
            (block $de
              (loop $dl
                (br_if $de (i32.ge_u (local.get $i) (local.get $srclen)))
                (local.set $c (call $b (local.get $i)))
                (br_if $de (i32.eqz (call $is_digit (local.get $c))))
                (local.set $val (i32.add (i32.mul (local.get $val) (i32.const 10)) (i32.sub (local.get $c) (i32.const 48))))
                (local.set $i (i32.add (local.get $i) (i32.const 1)))
                (br $dl)))
            (call $tokset (local.get $n) (i32.const 2) (local.get $val) (i32.const 0))
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
              (i32.add (i32.const 20000) (local.get $start)) (i32.sub (local.get $i) (local.get $start)))
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
        ;; single-char tokens
        (local.set $val (i32.const 0))
        (if (i32.eq (local.get $c) (i32.const 40)) (then (local.set $val (i32.const 3))))
        (if (i32.eq (local.get $c) (i32.const 41)) (then (local.set $val (i32.const 4))))
        (if (i32.eq (local.get $c) (i32.const 123)) (then (local.set $val (i32.const 5))))
        (if (i32.eq (local.get $c) (i32.const 125)) (then (local.set $val (i32.const 6))))
        (if (i32.eq (local.get $c) (i32.const 44)) (then (local.set $val (i32.const 7))))
        (if (i32.eq (local.get $c) (i32.const 58)) (then (local.set $val (i32.const 8))))
        (if (i32.eq (local.get $c) (i32.const 43)) (then (local.set $val (i32.const 10))))
        (if (i32.eq (local.get $c) (i32.const 60)) (then (local.set $val (i32.const 12))))
        (if (i32.eq (local.get $c) (i32.const 46)) (then (local.set $val (i32.const 13))))
        (if (i32.eq (local.get $c) (i32.const 91)) (then (local.set $val (i32.const 15))))
        (if (i32.eq (local.get $c) (i32.const 93)) (then (local.set $val (i32.const 16))))
        (if (i32.eq (local.get $c) (i32.const 42)) (then (local.set $val (i32.const 17))))   ;; '*'
        (if (i32.eq (local.get $c) (i32.const 47)) (then (local.set $val (i32.const 18))))   ;; '/'
        (if (i32.eq (local.get $c) (i32.const 61)) (then (local.set $val (i32.const 19))))   ;; '='
        (call $tokset (local.get $n) (local.get $val) (i32.const 0) (i32.const 0))
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

  (func $c_primary
    (local $off i32) (local $len i32) (local $argc i32)
    (if (i32.eq (call $tk (global.get $tp)) (i32.const 2))   ;; INT
      (then
        (call $emitw (i32.const 1)) (call $emitw (call $ta (global.get $tp)))
        (call $adv) (return)))
    (if (i32.eq (call $tk (global.get $tp)) (i32.const 3))   ;; '(' grouping
      (then (call $adv) (call $c_expr) (call $adv) (return)))
    (if (i32.eq (call $tk (global.get $tp)) (i32.const 1))   ;; IDENT
      (then
        (local.set $off (call $ta (global.get $tp)))
        (local.set $len (call $tb (global.get $tp)))
        (call $adv)
        (if (i32.eq (call $tk (global.get $tp)) (i32.const 13))   ;; '.method(...)'
          (then
            (call $adv) (call $adv) (call $adv)   ;; '.'  method  '('
            (if (i32.ne (call $tk (global.get $tp)) (i32.const 4)) (then (call $c_expr)))
            (call $adv)   ;; ')'
            (call $emitw (i32.const 10))   ;; PRINTINT
            (return)))
        (if (i32.eq (call $tk (global.get $tp)) (i32.const 3))   ;; call '('
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
            (call $emitw (i32.const 8))   ;; CALL
            (call $fixup_add (global.get $emit) (local.get $off) (local.get $len))   ;; entry resolved later
            (call $emitw (i32.const 0))   ;; placeholder entry (backpatched by $resolve_fixups)
            (call $emitw (local.get $argc))
            (return)))
        ;; variable (param or local) -> GETARG reads frame slot argbase+slot
        (call $emitw (i32.const 2))   ;; GETARG
        (call $emitw (call $var_find (local.get $off) (local.get $len)))
        (return))))

  (func $c_mul
    (call $c_primary)
    (block $me
      (loop $ml
        (if (i32.eq (call $tk (global.get $tp)) (i32.const 17))   ;; '*'
          (then (call $adv) (call $c_primary) (call $emitw (i32.const 11)) (br $ml)))
        (if (i32.eq (call $tk (global.get $tp)) (i32.const 18))   ;; '/'
          (then (call $adv) (call $c_primary) (call $emitw (i32.const 12)) (br $ml)))
        (br $me))))

  (func $c_add
    (call $c_mul)
    (block $ae
      (loop $al
        (if (i32.eq (call $tk (global.get $tp)) (i32.const 10))
          (then (call $adv) (call $c_mul) (call $emitw (i32.const 3)) (br $al)))
        (if (i32.eq (call $tk (global.get $tp)) (i32.const 11))
          (then (call $adv) (call $c_mul) (call $emitw (i32.const 4)) (br $al)))
        (br $ae))))

  (func $c_cmp
    (call $c_add)
    (if (i32.eq (call $tk (global.get $tp)) (i32.const 12))
      (then (call $adv) (call $c_add) (call $emitw (i32.const 5)))))

  (func $c_expr (call $c_cmp))

  (func $c_if
    (local $jz i32) (local $jmp i32)
    (call $adv)            ;; 'if'
    (call $c_expr)         ;; condition
    (call $emitw (i32.const 6))                ;; JZ
    (local.set $jz (global.get $emit)) (call $emitw (i32.const 0))
    (call $c_block)        ;; then
    (if (call $kw_is (global.get $tp) (i32.const 52020) (i32.const 4))   ;; 'else'
      (then
        (call $adv)
        (call $emitw (i32.const 7))            ;; JMP
        (local.set $jmp (global.get $emit)) (call $emitw (i32.const 0))
        (call $patch (local.get $jz) (global.get $emit))
        (call $c_block)
        (call $patch (local.get $jmp) (global.get $emit)))
      (else
        (call $patch (local.get $jz) (global.get $emit)))))

  (func $c_let
    (local $off i32) (local $len i32) (local $idx i32)
    (call $adv)   ;; 'let'
    (local.set $off (call $ta (global.get $tp)))
    (local.set $len (call $tb (global.get $tp)))
    (call $adv)   ;; binding name
    (if (i32.eq (call $tk (global.get $tp)) (i32.const 8))   ;; optional ': type'
      (then (call $adv) (call $skip_type)))
    (call $adv)        ;; '='
    (call $c_expr)     ;; value -> top of operand stack
    (local.set $idx (global.get $nlocal))
    (call $local_add (local.get $off) (local.get $len))
    (call $emitw (i32.const 14))                              ;; SETLOCAL
    (call $emitw (i32.add (global.get $nparam) (local.get $idx))))

  (func $c_stmt
    (if (call $kw_is (global.get $tp) (i32.const 52070) (i32.const 3))   ;; 'let'
      (then (call $c_let) (return)))
    (if (call $kw_is (global.get $tp) (i32.const 52010) (i32.const 2))   ;; 'if'
      (then (call $c_if) (return)))
    (if (call $kw_is (global.get $tp) (i32.const 52030) (i32.const 6))   ;; 'return'
      (then (call $adv) (call $c_expr) (call $emitw (i32.const 9)) (return)))
    (call $c_expr))

  (func $c_block
    (call $adv)   ;; '{'
    (block $be
      (loop $bl
        (br_if $be (i32.eq (call $tk (global.get $tp)) (i32.const 6)))   ;; '}'
        (call $c_stmt)
        (br $bl)))
    (call $adv))  ;; '}'

  (func $c_fn
    (local $foff i32) (local $flen i32) (local $ismain i32) (local $reservefix i32)
    (call $adv)   ;; 'fn'
    (local.set $foff (call $ta (global.get $tp)))
    (local.set $flen (call $tb (global.get $tp)))
    (call $adv)   ;; fn name
    (call $sym_add (local.get $foff) (local.get $flen) (global.get $emit))
    (local.set $ismain (call $eqlit (local.get $foff) (local.get $flen) (i32.const 52060) (i32.const 4)))
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
        (call $skip_type)   ;; type
        (if (i32.eq (call $tk (global.get $tp)) (i32.const 7)) (then (call $adv) (br $pl)))   ;; ','
        (br $pe)))
    (call $adv)   ;; ')'
    (if (i32.eq (call $tk (global.get $tp)) (i32.const 9)) (then (call $adv) (call $skip_type)))   ;; '->' type
    ;; reserve the frame (params + locals); operand backpatched once nlocal is known
    (call $emitw (i32.const 13))   ;; RESERVE
    (local.set $reservefix (global.get $emit)) (call $emitw (i32.const 0))
    (call $c_block)
    (call $patch (local.get $reservefix) (i32.add (global.get $nparam) (global.get $nlocal)))
    (if (local.get $ismain) (then (call $emitw (i32.const 0)))))   ;; HALT after main

  (func $c_program
    (block $done
      (loop $L
        (br_if $done (i32.eq (call $tk (global.get $tp)) (i32.const 14)))   ;; EOF
        (call $c_fn)
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

  ;; ---------- interpreter ----------
  (func $run (param $start i32)
    (local $op i32) (local $a i64) (local $bb i64) (local $t i64)
    (local $entry i32) (local $argc i32) (local $target i32)
    (global.set $pc (local.get $start))
    (global.set $osp (i32.const 0)) (global.set $csp (i32.const 0)) (global.set $argbase (i32.const 0))
    (block $halt
      (loop $loop
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
          (global.set $pc (i32.add (global.get $pc) (i32.const 2)))
          (i32.store (i32.add (i32.const 9216) (i32.mul (global.get $csp) (i32.const 8))) (global.get $pc))
          (i32.store (i32.add (i32.add (i32.const 9216) (i32.mul (global.get $csp) (i32.const 8))) (i32.const 4)) (global.get $argbase))
          (global.set $csp (i32.add (global.get $csp) (i32.const 1)))
          (global.set $argbase (i32.sub (global.get $osp) (local.get $argc)))
          (global.set $pc (local.get $entry)) (br $loop)))
        (if (i32.eq (local.get $op) (i32.const 9)) (then
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
        (if (i32.eq (local.get $op) (i32.const 10)) (then (call $print_i64 (call $opop)) (br $loop)))
        (br $halt))))

  ;; ---------- entry points ----------
  (func (export "compile") (param $srclen i32) (result i32)
    (drop (call $lex_compile (local.get $srclen)))
    (global.get $emit))
  (func (export "compile_and_run") (param $srclen i32)
    (drop (call $lex_compile (local.get $srclen)))
    (call $run (global.get $main_entry)))
  (func $lex_compile (param $srclen i32) (result i32)
    (global.set $emit (i32.const 0)) (global.set $nsym (i32.const 0))
    (global.set $nfixup (i32.const 0)) (global.set $main_entry (i32.const 0))
    (call $lex (local.get $srclen))
    (global.set $tp (i32.const 0))
    (call $c_program)
    (call $resolve_fixups)   ;; resolve all call targets, including forward references
    (global.get $emit))
  (func (export "run") (param $start i32) (call $run (local.get $start)))
  (func (export "dbg_ntok") (result i32) (global.get $ntok))
  (func (export "dbg_emit") (result i32) (global.get $emit))
  (func (export "dbg_main") (result i32) (global.get $main_entry))
)
