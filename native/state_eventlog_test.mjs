// state_eventlog_test.mjs - Stone E gate: pure-Lumen append-only event log + LWW read model.
//
// The kernel (examples/state/eventlog.lm) is pure Lumen protocol logic over a raw-memory LOG
// window: APPEND packs a record, GET is a last-write-wins linear fold, FOLD_COUNT walks the whole
// log. This harness proves three things:
//
//   1. ORACLE BIT-IDENTITY - a scripted sequence of commands (appends, overwrites, gets of
//      present/absent keys, fold counts, one FULL-boundary probe) executed under BOTH the
//      interpreter (the correctness oracle) and a native binary must produce byte-identical
//      results, command for command, with the LOG window persisted across commands within each
//      runtime.
//   2. THE PERSISTENCE SEAM - a native process is snapshotted (a framed byte-copy of the LOG
//      window, nothing more), killed, and a FRESH native process restores that snapshot and runs
//      the remaining commands. Results must equal the uninterrupted run byte for byte: the seam
//      is logic-free (bytes out, bytes in), so state survives process death.
//   3. Informational: native appends/sec for 5,000 small appends (throughput, not a gate).
//
// Like http_serve.lm's harness, the kernel adds no compiler feature (only load/store +
// arithmetic), so perf.mjs remains the only throughput gate; this file only checks correctness
// plus a reported-not-gated rate number.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { freshInstance, writeSrc, buildAndRunFn } from './pipeline.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(__dirname, '../examples/state/eventlog.lm'), 'utf8');

// Memory map - must match examples/state/eventlog.lm exactly.
const CMD_OP = 5990000, CMD_KLEN = 5990004, CMD_VLEN = 5990008, CMD_KEY = 5990016;
const CMD_CAP = 6000000 - 5990000;          // 10,000 bytes reserved for one command
const LOG_LEN_ADDR = 6000000, LOG_BASE = 6000016, LOG_CAP = 899984;
const OUT_LEN_ADDR = 7299996, OUT_BASE = 7300000;
const OP_APPEND = 1, OP_GET = 2, OP_FOLD_COUNT = 3;
const OP_SNAPSHOT = 99, OP_RESTORE = 98;    // meta-ops, handled by the native driver loop only

// Build the raw command buffer exactly as the memory map lays it out (relative to CMD_OP == 0):
// op i32 @0, key_len i32 @4, val_len i32 @8, key bytes @16, val bytes @16+key_len.
function cmdBuf(op, key = '', val = '') {
  const kb = Buffer.from(key, 'latin1');
  const vb = op === OP_APPEND ? Buffer.from(val, 'latin1') : Buffer.alloc(0);
  const buf = Buffer.alloc(16 + kb.length + vb.length);
  buf.writeInt32LE(op, 0);
  buf.writeInt32LE(kb.length, 4);
  buf.writeInt32LE(vb.length, 8);
  kb.copy(buf, 16);
  vb.copy(buf, 16 + kb.length);
  return buf;
}

// --- the scripted command sequence (the oracle gate script) ---
// 25 commands: fresh appends, overwrites (last-write-wins), gets of present/absent keys, and fold
// counts at different points. The FULL-boundary probe is a separate dedicated section below (it
// needs ~90 large fill-appends to reach the real 899,984-byte log_cap(), which would dwarf and
// obscure this semantic sequence, so it runs against its own fresh interpreter/native instances).
const SEQ = [
  ['APPEND', 'k0', 'v0'],
  ['APPEND', 'k1', 'v1'],
  ['APPEND', 'k2', 'v2'],
  ['APPEND', 'k3', 'v3'],
  ['APPEND', 'k4', 'v4'],
  ['GET', 'k2'],
  ['APPEND', 'k1', 'v1b'],          // overwrite k1
  ['GET', 'k1'],                    // -> v1b (last write wins)
  ['APPEND', 'k5', 'v5'],
  ['APPEND', 'k3', 'v3b'],          // overwrite k3
  ['GET', 'k3'],                    // -> v3b
  ['GET', 'k99'],                   // -> NOT_FOUND
  ['FOLD_COUNT'],                   // 8 appends so far
  ['APPEND', 'k6', 'v6'],
  ['APPEND', 'k7', 'v7'],
  ['GET', 'k0'],                    // -> v0
  ['APPEND', 'k8', 'v8'],
  ['GET', 'k7'],                    // -> v7
  ['APPEND', 'k5', 'v5b'],          // overwrite k5
  ['GET', 'k5'],                    // -> v5b
  ['GET', 'k6'],                    // -> v6
  ['FOLD_COUNT'],                   // 12 appends so far
  ['APPEND', 'k9', 'v9'],
  ['GET', 'k9'],                    // -> v9
  ['FOLD_COUNT'],                   // 13 appends total
];
const HALF = 13;   // split point for the persistence round-trip: first HALF commands, then the rest

function opOf(name) {
  if (name === 'APPEND') return OP_APPEND;
  if (name === 'GET') return OP_GET;
  return OP_FOLD_COUNT;
}

// --- INTERPRETER runtime: one instance, LOG window persists across every command in-process. ---
async function makeInterpreterRuntime() {
  const I = await freshInstance();
  const len = writeSrc(I, SRC);
  I.ex.compile(len);
  if (I.ex.dbg_nerr() > 0) throw new Error(`eventlog compile: ${I.ex.dbg_nerr()} error(s)`);
  const dv = new DataView(I.ex.mem.buffer);
  const u8 = new Uint8Array(I.ex.mem.buffer);
  return {
    run(name, key, val) {
      const buf = cmdBuf(opOf(name), key, val);
      u8.set(buf, CMD_OP);
      I.ex.run(I.ex.dbg_main());
      const outLen = dv.getInt32(OUT_LEN_ADDR, true);
      return Buffer.from(I.ex.mem.buffer, OUT_BASE, outLen).toString('latin1');
    },
  };
}

// --- NATIVE runtime: build once, drive a spawned child through a framed command loop. ---
//
// Framing: each message is a 4-byte little-endian length followed by that many bytes.
//   Normal command (op 1/2/3): payload IS the raw command buffer (cmdBuf layout above); the
//     driver copies it verbatim into the CMD window, runs the entry once, replies with the
//     framed RESULT bytes (OUT_LEN/OUT_BASE), exactly like http_serve's serve loop.
//   SNAPSHOT (op 99, 4-byte payload only): the driver replies with the LOG window bytes
//     [LOG_LEN_ADDR .. LOG_BASE + loglen) verbatim - a byte-copy, no interpretation beyond
//     reading the length field the kernel itself maintains.
//   RESTORE (op 98, payload = op i32 + the exact snapshot bytes): the driver copies the bytes
//     back into the LOG window verbatim and replies with an 8-byte "RESTORED" ack.
function patchMainToStateLoop(csrc) {
  const m = csrc.match(/int main\(void\)\{setvbuf\(stdout,0,_IONBF,0\);(f\d+)\(\);return 0;\}/);
  if (!m) throw new Error('could not find the emitted main entry to patch');
  const entry = m[1];
  const loop = `
static uint32_t lm_rd4(void){unsigned char h[4]; if(fread(h,1,4,stdin)!=4)return 0xffffffffu; return (uint32_t)h[0]|((uint32_t)h[1]<<8)|((uint32_t)h[2]<<16)|((uint32_t)h[3]<<24);}
static void lm_wr_frame(const unsigned char*buf, uint32_t n){
  unsigned char oh[4]={(unsigned char)n,(unsigned char)(n>>8),(unsigned char)(n>>16),(unsigned char)(n>>24)};
  fwrite(oh,1,4,stdout);
  if(n)fwrite(buf,1,n,stdout);
  fflush(stdout);
}
static unsigned char *lm_buf=0;
static uint32_t lm_bufcap=0;
static void lm_ensure(uint32_t n){ if(n>lm_bufcap){ lm_buf=realloc(lm_buf,n?n:1); lm_bufcap=n; } }
static void lm_state_loop(void){
  for(;;){
    uint32_t n=lm_rd4();
    if(n==0xffffffffu)break;
    lm_ensure(n);
    if(n && fread(lm_buf,1,n,stdin)!=n)break;
    int32_t op = n>=4 ? *(int32_t*)lm_buf : 0;
    if(op==99){
      int32_t loglen=*(int32_t*)(LMEM+${LOG_LEN_ADDR});
      uint32_t blk=(uint32_t)(${LOG_BASE - LOG_LEN_ADDR}+loglen);
      lm_wr_frame(LMEM+${LOG_LEN_ADDR}, blk);
      continue;
    }
    if(op==98){
      uint32_t plen = n>4?n-4:0;
      if(plen)memcpy(LMEM+${LOG_LEN_ADDR}, lm_buf+4, plen);
      lm_wr_frame((const unsigned char*)"RESTORED",8);
      continue;
    }
    uint32_t cn = n>${CMD_CAP}u?${CMD_CAP}u:n;
    if(cn)memcpy(LMEM+${CMD_OP}, lm_buf, cn);
    ${entry}();
    int32_t o=*(int32_t*)(LMEM+${OUT_LEN_ADDR});
    lm_wr_frame(LMEM+${OUT_BASE}, (uint32_t)o);
  }
}
int main(void){lm_state_loop();return 0;}`;
  return csrc.replace(m[0], loop);
}

async function buildNativeStateBinary() {
  const { csrc } = await buildAndRunFn(SRC, '-O2');
  const patched = patchMainToStateLoop(csrc);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-state-native-'));
  const cfile = path.join(dir, 'state.c'), bin = path.join(dir, 'state');
  fs.writeFileSync(cfile, patched);
  execFileSync('clang', ['-ffp-contract=off', '-fno-fast-math', '-O2', '-o', bin, cfile],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  return bin;
}

function frame(bytes) {
  const h = Buffer.alloc(4);
  h.writeUInt32LE(bytes.length);
  return Buffer.concat([h, bytes]);
}

// A single native child, driven request/response FIFO over its stdin/stdout pipe.
function makeNativeClient(bin) {
  const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = [];
  let acc = Buffer.alloc(0);
  child.stdout.on('data', (chunk) => {
    acc = Buffer.concat([acc, chunk]);
    while (acc.length >= 4) {
      const len = acc.readUInt32LE(0);
      if (acc.length < 4 + len) break;
      const resp = acc.subarray(4, 4 + len);
      acc = acc.subarray(4 + len);
      pending.shift()?.(Buffer.from(resp));
    }
  });
  const send = (bytes) => new Promise((resolve) => {
    pending.push(resolve);
    child.stdin.write(frame(bytes));
  });
  return {
    run: (name, key, val) => send(cmdBuf(opOf(name), key, val)).then((b) => b.toString('latin1')),
    snapshot: () => send(Buffer.from([99, 0, 0, 0])),
    restore: (bytes) => send(Buffer.concat([Buffer.from([98, 0, 0, 0]), bytes])).then((b) => b.toString('latin1')),
    kill: () => child.kill(),
  };
}

// ============================== run the gate ==============================
let fail = 0;
console.log('== Stone E: pure-Lumen event log (append-only log + LWW read model) ==');

// --- 1. ORACLE BIT-IDENTITY: interpreter vs. an uninterrupted native process, command for command.
const interp = await makeInterpreterRuntime();
const bin = await buildNativeStateBinary();
const nativeFull = makeNativeClient(bin);

const interpResults = [];
const nativeFullResults = [];
console.log('\n-- oracle bit-identity: interpreter vs native, command by command --');
for (const [name, key, val] of SEQ) {
  const ri = interp.run(name, key, val);
  const rn = await nativeFull.run(name, key, val);
  interpResults.push(ri);
  nativeFullResults.push(rn);
  const label = `${name}${key !== undefined ? ' ' + key : ''}${val !== undefined ? '=' + val : ''}`;
  if (ri === rn) {
    console.log(`PASS  ${label.padEnd(28)} -> ${ri.length > 24 ? ri.slice(0, 24) + '...' : ri}`);
  } else {
    // find first diverging byte + context, per the STOP rule.
    let off = 0;
    while (off < ri.length && off < rn.length && ri[off] === rn[off]) off++;
    console.log(`FAIL  ${label}\n  interpreter: ${JSON.stringify(ri)}\n  native:      ${JSON.stringify(rn)}\n  first diverging offset: ${off} (interp ctx ${JSON.stringify(ri.slice(Math.max(0, off - 8), off + 8))}, native ctx ${JSON.stringify(rn.slice(Math.max(0, off - 8), off + 8))})`);
    fail++;
  }
}
console.log(fail === 0
  ? `\n${SEQ.length}/${SEQ.length} commands bit-identical between interpreter and native.`
  : `\nFAIL: ${fail}/${SEQ.length} commands diverged.`);

// --- 2. PERSISTENCE ROUND-TRIP: snapshot mid-stream, kill, fresh process, restore, finish. ---
console.log('\n-- persistence round-trip: snapshot -> kill -> fresh process -> restore -> resume --');
const nativeSplit = makeNativeClient(bin);
const splitResults = [];
for (let i = 0; i < HALF; i++) {
  const [name, key, val] = SEQ[i];
  splitResults.push(await nativeSplit.run(name, key, val));
}
const snapBytes = await nativeSplit.snapshot();
const snapFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-state-snap-')), 'log.bin');
fs.writeFileSync(snapFile, snapBytes);
nativeSplit.kill();
console.log(`snapshotted ${snapBytes.length} bytes to ${snapFile}, killed the process`);

const nativeResumed = makeNativeClient(bin);
const restoreAck = await nativeResumed.restore(fs.readFileSync(snapFile));
console.log(`fresh process restored (${fs.readFileSync(snapFile).length} bytes) -> ack "${restoreAck}"`);
for (let i = HALF; i < SEQ.length; i++) {
  const [name, key, val] = SEQ[i];
  splitResults.push(await nativeResumed.run(name, key, val));
}
nativeResumed.kill();

let rtFail = 0;
console.log('\n-- round-trip vs uninterrupted run (must be byte-identical) --');
for (let i = 0; i < SEQ.length; i++) {
  const ok = splitResults[i] === interpResults[i];
  if (!ok) {
    console.log(`FAIL  cmd[${i}] ${SEQ[i][0]} ${SEQ[i][1] || ''}\n  uninterrupted: ${JSON.stringify(interpResults[i])}\n  round-trip:    ${JSON.stringify(splitResults[i])}`);
    rtFail++;
  }
}
console.log(rtFail === 0
  ? `\n${SEQ.length}/${SEQ.length} round-trip results match the uninterrupted run byte for byte. Persistence proven: state survives process death with a logic-free byte-copy seam.`
  : `\nFAIL: ${rtFail}/${SEQ.length} round-trip results diverged from the uninterrupted run.`);
fail += rtFail;

// --- 2b. FULL-BOUNDARY PROBE: fill the log to just under log_cap() (899,984 bytes), on fresh
// interpreter and native instances, then prove the exact boundary: one more large append that
// would overflow returns "FULL" and leaves the log untouched (fold count unchanged), a smaller
// append that still fits succeeds normally, and both runtimes agree byte for byte throughout.
console.log('\n-- FULL-boundary probe: fill log_cap() to the edge, then cross it --');
const FILL_VAL = 'A'.repeat(9900);
const FILL_REC = 8 + 4 + FILL_VAL.length;         // key "fNNN" is always 4 bytes
const N_FILL = Math.floor(LOG_CAP / FILL_REC);    // largest number of fills that stays under cap
const remaining = LOG_CAP - N_FILL * FILL_REC;
if (remaining >= FILL_REC) throw new Error('fill math is wrong: remaining should be < one fill record');

const fullInterp = await makeInterpreterRuntime();
const fullBin = bin;   // same binary; fresh process for isolation
const fullNative = makeNativeClient(fullBin);
let fullFail = 0;
for (let i = 0; i < N_FILL; i++) {
  const key = `f${String(i).padStart(3, '0')}`;
  const ri = fullInterp.run('APPEND', key, FILL_VAL);
  const rn = await fullNative.run('APPEND', key, FILL_VAL);
  if (ri !== rn || ri !== 'APPENDED') { console.log(`FAIL  fill[${i}] interp=${ri} native=${rn}`); fullFail++; }
}
const countBefore = fullInterp.run('FOLD_COUNT');
const countBeforeNative = await fullNative.run('FOLD_COUNT');
console.log(`filled ${N_FILL} records (${N_FILL * FILL_REC} bytes, log_cap() = ${LOG_CAP}, ${remaining} bytes remaining); fold count interp=${countBefore} native=${countBeforeNative}`);

// This append (same size as a fill record) exceeds the remaining space -> must be "FULL".
const overflowInterp = fullInterp.run('APPEND', 'over', FILL_VAL);
const overflowNative = await fullNative.run('APPEND', 'over', FILL_VAL);
const countAfter = fullInterp.run('FOLD_COUNT');
const countAfterNative = await fullNative.run('FOLD_COUNT');
if (overflowInterp === 'FULL' && overflowNative === 'FULL' && countAfter === countBefore && countAfterNative === countBeforeNative) {
  console.log(`PASS  overflow append -> "FULL" on both runtimes; fold count unchanged (${countBefore} -> ${countAfter})`);
} else {
  console.log(`FAIL  overflow append: interp=${overflowInterp} native=${overflowNative}, count ${countBefore}->${countAfter} / ${countBeforeNative}->${countAfterNative}`);
  fullFail++;
}

// A smaller append that still fits in the remaining space must succeed normally on both runtimes.
const fitVal = 'B'.repeat(Math.max(0, remaining - 8 - 4));
const fitInterp = fullInterp.run('APPEND', 'fits', fitVal);
const fitNative = await fullNative.run('APPEND', 'fits', fitVal);
if (fitInterp === 'APPENDED' && fitNative === 'APPENDED') {
  console.log(`PASS  boundary-fitting append (${fitVal.length}B) -> APPENDED on both runtimes`);
} else {
  console.log(`FAIL  boundary-fitting append: interp=${fitInterp} native=${fitNative}`);
  fullFail++;
}
fullNative.kill();
fail += fullFail;
console.log(fullFail === 0
  ? 'FULL-boundary probe: interpreter and native agree exactly at the log_cap() edge.'
  : `FAIL: ${fullFail} FULL-boundary check(s) diverged.`);

// --- 3. Informational: native appends/sec (not a gate). ---
console.log('\n-- informational: native appends/sec (5,000 small appends) --');
const bench = makeNativeClient(bin);
const N_BENCH = 5000;
const t0 = process.hrtime.bigint();
for (let i = 0; i < N_BENCH; i++) {
  await bench.run('APPEND', `bk${i}`, `bv${i}`);
}
const t1 = process.hrtime.bigint();
bench.kill();
const secs = Number(t1 - t0) / 1e9;
const rate = N_BENCH / secs;
console.log(`${N_BENCH} appends in ${secs.toFixed(3)}s -> ${rate.toFixed(0)} appends/sec (framed pipe round-trip included; not gated)`);

nativeFull.kill();

process.exit(fail === 0 ? 0 : 1);
