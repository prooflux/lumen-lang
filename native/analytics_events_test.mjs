// analytics_events_test.mjs - gate for the pure-Lumen click/event analytics kernel.
//
// The kernel (examples/analytics/click_events.lm) is an append-only event log plus the three
// read models of a self-owned product-analytics pipeline: SUMMARY (distinct event names with
// counts, most-common first), FUNNEL (counts for an ordered list of names), TRAIL (one user's
// events, oldest first - append order is time order, so no sorting exists anywhere). It is
// also the first example authored with the boolean operators and/or/not.
//
// This harness proves four things:
//   1. TRIPLE AGREEMENT - a scripted sequence of commands runs under (a) the seed interpreter,
//      (b) a native binary, and (c) an INDEPENDENT JavaScript oracle that reimplements the
//      report semantics from scratch (insertion-ordered counter, stable most-common sort).
//      All three must agree byte for byte on every command. The oracle catches a kernel that
//      is self-consistent but wrong; the interpreter/native pair catches a backend divergence.
//   2. THE PERSISTENCE SEAM - snapshot the LOG window mid-sequence, kill the process, restore
//      into a fresh process, finish the sequence: results must equal the uninterrupted run.
//   3. BOUNDARIES - the LOG cap ("FULL": log untouched, reports unchanged) exercised on all
//      three runtimes, and the COUNT-table cap ("TABLE_FULL" at 32,501 distinct names)
//      exercised native-vs-oracle only (the O(d^2) fold at the cap is seconds native but
//      minutes interpreted; the interpreter still gates the same code path at small d).
//   4. Informational: native appends/sec and SUMMARY latency (throughput, not a gate).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { freshInstance, writeSrc, buildAndRunFn } from './pipeline.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(__dirname, '../examples/analytics/click_events.lm'), 'utf8');

// Memory map - must match examples/analytics/click_events.lm exactly.
const CMD_OP = 5990000, CMD_A = 5990004, CMD_B = 5990008, CMD_BYTES = 5990016;
const CMD_CAP = 6000000 - 5990000;
const LOG_LEN_ADDR = 6000000, LOG_BASE = 6000016, LOG_CAP = 899984;
const OUT_LEN_ADDR = 7299996, OUT_BASE = 7300000;
const TABLE_MAX = 32500;
const OP_APPEND = 1, OP_SUMMARY = 2, OP_FUNNEL = 3, OP_TRAIL = 4;
const OP_SNAPSHOT = 99, OP_RESTORE = 98;   // meta-ops, handled by the native driver loop only

// --- raw command buffers, laid out exactly as the kernel's CMD region expects ---
function cmdAppend(name, user, path_) {
  const nb = Buffer.from(name, 'latin1'), ub = Buffer.from(user, 'latin1'), pb = Buffer.from(path_, 'latin1');
  const buf = Buffer.alloc(16 + nb.length + ub.length + pb.length);
  buf.writeInt32LE(OP_APPEND, 0);
  buf.writeInt32LE(nb.length, 4);
  buf.writeInt32LE(ub.length, 8);
  buf.writeInt32LE(pb.length, 12);
  Buffer.concat([nb, ub, pb]).copy(buf, 16);
  return buf;
}
function cmdSummary() {
  const buf = Buffer.alloc(16);
  buf.writeInt32LE(OP_SUMMARY, 0);
  return buf;
}
function cmdFunnel(names) {
  const bufs = names.map((n) => Buffer.from(n, 'latin1'));
  const bytes = Buffer.concat(bufs);
  const buf = Buffer.alloc(8 + 4 * names.length + bytes.length);
  buf.writeInt32LE(OP_FUNNEL, 0);
  buf.writeInt32LE(names.length, 4);
  bufs.forEach((b, i) => buf.writeInt32LE(b.length, 8 + 4 * i));
  bytes.copy(buf, 8 + 4 * names.length);
  return buf;
}
function cmdTrail(user) {
  const ub = Buffer.from(user, 'latin1');
  const buf = Buffer.alloc(16 + ub.length);
  buf.writeInt32LE(OP_TRAIL, 0);
  buf.writeInt32LE(ub.length, 4);
  ub.copy(buf, 16);
  return buf;
}
function cmdOf([kind, ...args]) {
  if (kind === 'APPEND') return cmdAppend(...args);
  if (kind === 'SUMMARY') return cmdSummary();
  if (kind === 'FUNNEL') return cmdFunnel(args[0]);
  return cmdTrail(args[0]);
}

// --- the INDEPENDENT oracle: report semantics reimplemented from scratch in JS. ---
// Counts live in an insertion-ordered map; most-common order is count descending with
// first-seen order breaking ties (a stable sort over insertion order); a trail is the
// append-ordered subsequence for one user. Capacity models mirror the kernel's documented
// caps, not its code.
function makeOracle() {
  const events = [];
  let logBytes = 0;
  return {
    run(cmd) {
      const [kind, ...args] = cmd;
      if (kind === 'APPEND') {
        const [name, user, path_] = args;
        const size = 12 + Buffer.byteLength(name, 'latin1') + Buffer.byteLength(user, 'latin1') + Buffer.byteLength(path_, 'latin1');
        if (logBytes + size > LOG_CAP) return 'FULL';
        logBytes += size;
        events.push({ name, user, path: path_ });
        return 'APPENDED';
      }
      const counts = new Map();
      for (const e of events) counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
      if (kind === 'SUMMARY') {
        if (counts.size > TABLE_MAX) return 'TABLE_FULL';
        const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1]);  // stable: ties stay first-seen
        return `TOTAL ${events.length}\n` + ordered.map(([n, c]) => `${n} ${c}\n`).join('');
      }
      if (kind === 'FUNNEL') {
        if (counts.size > TABLE_MAX) return 'TABLE_FULL';
        return args[0].map((n) => `${n} ${counts.get(n) ?? 0}\n`).join('');
      }
      const trail = events.filter((e) => e.user === args[0]);
      return `EVENTS ${trail.length}\n` + trail.map((e) => `${e.name} ${e.path}\n`).join('');
    },
  };
}

// --- INTERPRETER runtime: one seed instance, LOG persists across commands in-process. ---
async function makeInterpreterRuntime() {
  const I = await freshInstance();
  const len = writeSrc(I, SRC);
  I.ex.compile(len);
  if (I.ex.dbg_nerr() > 0) throw new Error(`click_events compile: ${I.ex.dbg_nerr()} error(s)`);
  const dv = new DataView(I.ex.mem.buffer);
  const u8 = new Uint8Array(I.ex.mem.buffer);
  return {
    run(cmd) {
      u8.set(cmdOf(cmd), CMD_OP);
      I.ex.run(I.ex.dbg_main());
      const outLen = dv.getInt32(OUT_LEN_ADDR, true);
      return Buffer.from(I.ex.mem.buffer, OUT_BASE, outLen).toString('latin1');
    },
  };
}

// --- NATIVE runtime: the same framed request/response driver as state_eventlog_test.mjs. ---
function patchMainToStateLoop(csrc) {
  // S1b: generic setvbuf mode/size match (not hardcoded _IONBF,0) - see the matching comment in
  // lumenc_native.mjs's patchMainToCompileDriver for why.
  const m = csrc.match(/int main\(void\)\{setvbuf\(stdout,0,[A-Za-z_]+,\d+\);(f\d+)\(\);return 0;\}/);
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
    if(op==${OP_SNAPSHOT}){
      int32_t loglen=*(int32_t*)(LMEM+${LOG_LEN_ADDR});
      uint32_t blk=(uint32_t)(${LOG_BASE - LOG_LEN_ADDR}+loglen);
      lm_wr_frame(LMEM+${LOG_LEN_ADDR}, blk);
      continue;
    }
    if(op==${OP_RESTORE}){
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

async function buildNativeBinary() {
  const { csrc } = await buildAndRunFn(SRC, '-O2');
  const patched = patchMainToStateLoop(csrc);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-analytics-native-'));
  const cfile = path.join(dir, 'events.c'), bin = path.join(dir, 'events');
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
    run: (cmd) => send(cmdOf(cmd)).then((b) => b.toString('latin1')),
    snapshot: () => send(Buffer.from([OP_SNAPSHOT, 0, 0, 0])),
    restore: (bytes) => send(Buffer.concat([Buffer.from([OP_RESTORE, 0, 0, 0]), bytes])).then((b) => b.toString('latin1')),
    kill: () => child.kill(),
  };
}

// --- the scripted command sequence: the funnel below mirrors the shape of a real signup
// funnel report (pageview -> lead -> signup -> trial -> checkout); the kernel itself has no
// event vocabulary baked in - names arrive as bytes. Reports run empty, interleaved with
// appends, after ties, and for present/absent users.
const FUNNEL = ['pageview', 'lead_submit', 'signup_submit', 'trial_cta_click', 'checkout_intent'];
const SEQ = [
  ['SUMMARY'],                                            // empty log: "TOTAL 0\n"
  ['FUNNEL', FUNNEL],                                     // empty log: all zeros
  ['TRAIL', 'u1'],                                        // empty log: "EVENTS 0\n"
  ['APPEND', 'pageview', 'u1', '/'],
  ['APPEND', 'pageview', 'u2', '/pricing'],
  ['APPEND', 'trial_cta_click', 'u2', '/pricing'],
  ['APPEND', 'pageview', 'u1', '/lessons/vol-surface'],
  ['SUMMARY'],
  ['APPEND', 'signup_submit', 'u1', '/signup'],
  ['APPEND', 'lead_submit', 'u3', '/'],
  ['APPEND', 'scroll_75', 'u2', '/pricing'],              // event outside the funnel list
  ['SUMMARY'],                                            // tie: trial_cta_click vs signup_submit vs lead_submit vs scroll_75 (first-seen order)
  ['FUNNEL', FUNNEL],
  ['TRAIL', 'u1'],
  ['TRAIL', 'u2'],
  ['TRAIL', 'ghost'],                                     // absent user: "EVENTS 0\n"
  ['APPEND', 'pageview', 'u3', '/lessons/greeks'],
  ['APPEND', 'trial_cta_click', 'u1', '/pricing'],
  ['APPEND', 'checkout_intent', 'u1', '/checkout'],
  ['SUMMARY'],
  ['FUNNEL', FUNNEL],
  ['FUNNEL', ['checkout_intent', 'never_fired', 'pageview']],   // absent name mid-list
  ['TRAIL', 'u1'],
  ['SUMMARY'],                                            // reports are read-only: repeat is identical
];
const HALF = 12;   // split point for the persistence round-trip

let fail = 0;
console.log('== analytics kernel: append-only event log + SUMMARY / FUNNEL / TRAIL ==');

// --- 1. TRIPLE AGREEMENT: interpreter vs native vs the independent JS oracle. ---
const interp = await makeInterpreterRuntime();
const bin = await buildNativeBinary();
const nativeFull = makeNativeClient(bin);
const oracle = makeOracle();

const interpResults = [];
console.log('\n-- triple agreement: interpreter vs native vs oracle, command by command --');
for (const cmd of SEQ) {
  const ri = interp.run(cmd);
  const rn = await nativeFull.run(cmd);
  const ro = oracle.run(cmd);
  interpResults.push(ri);
  const label = cmd[0] === 'APPEND' ? `APPEND ${cmd[1]} ${cmd[2]}` : cmd[0] === 'FUNNEL' ? `FUNNEL [${cmd[1].length}]` : cmd.join(' ');
  if (ri === rn && ri === ro) {
    const first = ri.split('\n')[0];
    console.log(`PASS  ${label.padEnd(34)} -> ${first}${ri.includes('\n', first.length + 1) ? ' ...' : ''}`);
  } else {
    console.log(`FAIL  ${label}\n  interpreter: ${JSON.stringify(ri)}\n  native:      ${JSON.stringify(rn)}\n  oracle:      ${JSON.stringify(ro)}`);
    fail++;
  }
}
console.log(fail === 0
  ? `\n${SEQ.length}/${SEQ.length} commands agree byte for byte across interpreter, native, and the independent oracle.`
  : `\nFAIL: ${fail}/${SEQ.length} commands diverged.`);

// --- 2. PERSISTENCE ROUND-TRIP: snapshot -> kill -> fresh process -> restore -> resume. ---
console.log('\n-- persistence round-trip: snapshot -> kill -> fresh process -> restore -> resume --');
const nativeSplit = makeNativeClient(bin);
const splitResults = [];
for (let i = 0; i < HALF; i++) splitResults.push(await nativeSplit.run(SEQ[i]));
const snapBytes = await nativeSplit.snapshot();
nativeSplit.kill();
console.log(`snapshotted ${snapBytes.length} bytes, killed the process`);
const nativeResumed = makeNativeClient(bin);
const restoreAck = await nativeResumed.restore(snapBytes);
console.log(`fresh process restored -> ack "${restoreAck}"`);
for (let i = HALF; i < SEQ.length; i++) splitResults.push(await nativeResumed.run(SEQ[i]));
nativeResumed.kill();

let rtFail = 0;
for (let i = 0; i < SEQ.length; i++) {
  if (splitResults[i] !== interpResults[i]) {
    console.log(`FAIL  cmd[${i}] ${SEQ[i][0]}\n  uninterrupted: ${JSON.stringify(interpResults[i])}\n  round-trip:    ${JSON.stringify(splitResults[i])}`);
    rtFail++;
  }
}
console.log(rtFail === 0
  ? `${SEQ.length}/${SEQ.length} round-trip results match the uninterrupted run byte for byte.`
  : `FAIL: ${rtFail}/${SEQ.length} round-trip results diverged.`);
fail += rtFail;

// --- 3a. LOG-FULL boundary: fill to just under log_cap(), cross it, verify the log is
// untouched (SUMMARY unchanged), on all three runtimes. ---
console.log('\n-- LOG-full boundary: fill log_cap() to the edge, then cross it --');
const FILL_PATH = 'p'.repeat(9900);
const FILL_REC = 12 + 2 + 2 + FILL_PATH.length;   // name "ev", user "uu"
const N_FILL = Math.floor(LOG_CAP / FILL_REC);
const fullInterp = await makeInterpreterRuntime();
const fullNative = makeNativeClient(bin);
const fullOracle = makeOracle();
let fullFail = 0;
for (let i = 0; i < N_FILL; i++) {
  const cmd = ['APPEND', 'ev', 'uu', FILL_PATH];
  const ri = fullInterp.run(cmd), rn = await fullNative.run(cmd), ro = fullOracle.run(cmd);
  if (ri !== 'APPENDED' || rn !== 'APPENDED' || ro !== 'APPENDED') { console.log(`FAIL  fill[${i}] interp=${ri} native=${rn} oracle=${ro}`); fullFail++; }
}
const before = [fullInterp.run(['SUMMARY']), await fullNative.run(['SUMMARY']), fullOracle.run(['SUMMARY'])];
const over = [fullInterp.run(['APPEND', 'ev', 'uu', FILL_PATH]), await fullNative.run(['APPEND', 'ev', 'uu', FILL_PATH]), fullOracle.run(['APPEND', 'ev', 'uu', FILL_PATH])];
const after = [fullInterp.run(['SUMMARY']), await fullNative.run(['SUMMARY']), fullOracle.run(['SUMMARY'])];
if (over.every((r) => r === 'FULL') && after.every((r, i) => r === before[i]) && before[0] === before[1] && before[0] === before[2]) {
  console.log(`PASS  ${N_FILL} fills, overflow append -> "FULL" on all three runtimes, log untouched (${before[0].split('\n')[0]})`);
} else {
  console.log(`FAIL  overflow: over=${JSON.stringify(over)} before=${JSON.stringify(before[0])} after=${JSON.stringify(after)}`);
  fullFail++;
}
fullNative.kill();
fail += fullFail;

// --- 3b. TABLE-full boundary: 32,500 distinct names report fine; the 32,501st flips
// SUMMARY/FUNNEL to "TABLE_FULL" while appends keep working. Native vs oracle only: the
// O(d^2) fold at the cap runs in seconds native but minutes interpreted; the interpreter
// gates the identical code path at small d in section 1. ---
console.log('\n-- TABLE-full boundary: 32,500 distinct names ok, 32,501 -> TABLE_FULL (native vs oracle) --');
const capNative = makeNativeClient(bin);
const capOracle = makeOracle();
let capFail = 0;
for (let i = 0; i < TABLE_MAX; i++) {
  const cmd = ['APPEND', `n${i}`, 'u', '/'];
  const rn = await capNative.run(cmd), ro = capOracle.run(cmd);
  if (rn !== 'APPENDED' || ro !== 'APPENDED') { capFail++; }
}
const funnelAtCap = [await capNative.run(['FUNNEL', ['n0', 'n32499']]), capOracle.run(['FUNNEL', ['n0', 'n32499']])];
const overflowAppend = [await capNative.run(['APPEND', 'n32500', 'u', '/']), capOracle.run(['APPEND', 'n32500', 'u', '/'])];
const funnelOver = [await capNative.run(['FUNNEL', ['n0']]), capOracle.run(['FUNNEL', ['n0']])];
const summaryOver = [await capNative.run(['SUMMARY']), capOracle.run(['SUMMARY'])];
if (funnelAtCap[0] === 'n0 1\nn32499 1\n' && funnelAtCap[0] === funnelAtCap[1]
  && overflowAppend.every((r) => r === 'APPENDED')
  && funnelOver.every((r) => r === 'TABLE_FULL') && summaryOver.every((r) => r === 'TABLE_FULL')) {
  console.log('PASS  reports work at exactly 32,500 distinct names; 32,501st append still APPENDED; reports then say TABLE_FULL (bounded, explicit)');
} else {
  console.log(`FAIL  at-cap=${JSON.stringify(funnelAtCap)} append=${JSON.stringify(overflowAppend)} over=${JSON.stringify(funnelOver)} summary=${JSON.stringify(summaryOver)}`);
  capFail++;
}
capNative.kill();
fail += capFail;

// --- 4. Informational: native throughput (not a gate). ---
console.log('\n-- informational: native events/sec and report latency (not gated) --');
const bench = makeNativeClient(bin);
const N_BENCH = 5000;
let t0 = process.hrtime.bigint();
for (let i = 0; i < N_BENCH; i++) {
  await bench.run(['APPEND', FUNNEL[i % FUNNEL.length], `user${i % 97}`, `/page/${i % 31}`]);
}
let t1 = process.hrtime.bigint();
const appendSecs = Number(t1 - t0) / 1e9;
t0 = process.hrtime.bigint();
const REPORTS = 100;
for (let i = 0; i < REPORTS; i++) await bench.run(['SUMMARY']);
t1 = process.hrtime.bigint();
const sumSecs = Number(t1 - t0) / 1e9;
bench.kill();
console.log(`${N_BENCH} appends in ${appendSecs.toFixed(3)}s -> ${(N_BENCH / appendSecs).toFixed(0)} events/sec; ` +
  `${REPORTS} SUMMARY folds over ${N_BENCH} events in ${sumSecs.toFixed(3)}s -> ${(sumSecs / REPORTS * 1000).toFixed(2)} ms/report (framed pipe round-trips included)`);

nativeFull.kill();
process.exit(fail === 0 ? 0 : 1);
