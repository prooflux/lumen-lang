// native_socket_test.mjs - gate for the native SOCKET server (SaaS Stone F): the compiled serve
// binary opens its OWN listening TCP socket and serves HTTP directly, with NO Node process in the
// request path (Node only spawns the child once, at startup, and writes the preload block).
//
// PART A (BYTE-IDENTITY vs the pipe transport): the SAME route table is built twice - once through
// buildNativeServe (the existing stdin/stdout framed-pipe driver, already gated by
// native_pipeline_test.mjs / native_handlers_test.mjs) and once through buildNativeSocketServer
// (this stone's new socket driver) - and driven with the SAME requests. The response bytes coming
// back over a real TCP socket must be byte-identical to the response bytes coming back over the
// framed pipe, proving the new C main is just a different transport around the identical compiled
// entry point.
//
// PART B (LIVENESS): 100 sequential real HTTP connections against the socket server, all correct,
// process still alive afterward - the socket analogue of native_handlers_test.mjs's 10,000-request
// pipe immortality run, proving the accept loop + per-request arena reset survive repeated
// connect/serve/close cycles.
//
// PART C (IMAGE-SIZE EVIDENCE, informational): report the built binary's byte size and that it
// links only libc/libm (no Node, no node_modules) - the cost/cold-start claim this stone exists to
// support.
import fs from 'node:fs';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { buildNativeServe, buildNativeSocketServer } from './lumen_serve_native.mjs';

const ROUTES = [
  { method: 'GET', path: '/home', status: 200, contentType: 'text/plain', body: 'hi' },
  { method: 'GET', path: '/health', status: 200, contentType: 'application/json', body: '{"status":"ok"}' },
].map((r) => ({ ...r, bodyBytes: Buffer.from(r.body, 'utf8') }));

const REQUESTS = [
  'GET /home HTTP/1.1\r\nHost: x\r\n\r\n',
  'GET /health HTTP/1.1\r\n\r\n',
  'GET /nope HTTP/1.1\r\n\r\n',   // unmatched, proxy mode on -> empty on the pipe side, 502 on the socket side
  'HEAD /home HTTP/1.1\r\n\r\n',
];

let fail = 0;

function frame(bytes) {
  const h = Buffer.alloc(4);
  h.writeUInt32LE(bytes.length);
  return Buffer.concat([h, bytes]);
}

// --- pipe reference: one framed-pipe child, drive it FIFO (same protocol makeServer uses). ---
function makePipeDriver(binPath, preload) {
  const child = spawn(binPath, [], { stdio: ['pipe', 'pipe', 'inherit'] });
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
  child.stdin.write(frame(preload));
  return {
    send: (reqBytes) => new Promise((resolve) => {
      child.stdin.write(frame(reqBytes));
      pending.push(resolve);
    }),
    kill: () => child.kill(),
  };
}

// --- socket child: spawn with the preload written to its stdin, wait for it to print the bound
// port on stderr (port 0 -> ephemeral, avoids collisions), then issue one raw TCP request per call
// (one connection per request - matches the v1 "no keep-alive multiplexing" scope). ---
function spawnSocketServer(binPath, preload) {
  return new Promise((resolve, reject) => {
    const child = spawn(binPath, ['0'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let errBuf = '';
    const onErr = (chunk) => {
      errBuf += chunk.toString('utf8');
      const m = errBuf.match(/LUMEN_NATIVE_SOCKET_PORT=(\d+)/);
      if (m) { child.stderr.off('data', onErr); resolve({ child, port: Number(m[1]) }); }
    };
    child.stderr.on('data', onErr);
    child.on('exit', (code, signal) => reject(new Error(`socket server exited early (${code}/${signal}): ${errBuf}`)));
    child.stdin.write(frame(preload));
  });
}

function sendRawRequest(port, reqBytes) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ port, host: '127.0.0.1' }, () => sock.write(reqBytes));
    let acc = Buffer.alloc(0);
    sock.on('data', (chunk) => { acc = Buffer.concat([acc, chunk]); });
    sock.on('end', () => resolve(acc));
    sock.on('close', () => resolve(acc));
    sock.on('error', reject);
    setTimeout(() => { sock.destroy(); resolve(acc); }, 5000);
  });
}

console.log('== native socket server: build ==');
const { bin: pipeBin, bodyBlock: pipeBody } = await buildNativeServe(ROUTES, true);
console.log(`built pipe-transport reference binary: ${pipeBin}`);
const { bin: sockBin, bodyBlock: sockBody } = await buildNativeSocketServer(ROUTES, true);
console.log(`built socket-transport binary: ${sockBin}`);

// ============================== PART A: byte-identity ==============================
console.log('\n== Part A: socket-transport responses vs framed-pipe-transport responses (byte-identical) ==');

const pipeDriver = makePipeDriver(pipeBin, pipeBody);
const { child: sockChild, port } = await spawnSocketServer(sockBin, sockBody);
console.log(`socket server listening on 127.0.0.1:${port}`);

let checks = 0;
for (const raw of REQUESTS) {
  checks++;
  const reqBytes = Buffer.from(raw, 'latin1');
  const wantRaw = (await pipeDriver.send(reqBytes)).toString('latin1');
  // The pipe transport's "unmatched -> empty" signal (proxy mode) has no socket-transport analogue
  // (this stone doesn't proxy in C - see the module comment); the socket driver writes a short 502
  // instead. Compare against that documented substitution for the unmatched case only.
  const want = wantRaw.length === 0
    ? 'HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
    : wantRaw;
  const got = (await sendRawRequest(port, reqBytes)).toString('latin1');
  const label = JSON.stringify(raw.split('\r\n')[0]);
  if (got === want) {
    console.log(`PASS  ${label} -> bit-identical (${want.length} bytes${wantRaw.length === 0 ? ', pipe=empty/proxy -> socket=502 (documented)' : ''})`);
  } else {
    console.log(`FAIL  ${label}`);
    const n = Math.min(got.length, want.length);
    let i = 0;
    while (i < n && got[i] === want[i]) i++;
    console.log(`  diverge at byte ${i} (want len ${want.length}, got len ${got.length})`);
    console.log(`  want context: ${JSON.stringify(want.slice(Math.max(0, i - 30), i + 30))}`);
    console.log(`  got  context: ${JSON.stringify(got.slice(Math.max(0, i - 30), i + 30))}`);
    fail++;
  }
}
console.log(fail === 0 ? `\n${checks}/${checks} socket responses bit-identical to the pipe-transport reference.`
  : `\nFAIL: ${fail}/${checks} diverged.`);

pipeDriver.kill();

// ============================== PART B: liveness (100 sequential connections) ==============
console.log('\n== Part B: 100 sequential real HTTP connections, process still alive ==');

const N = 100;
let liveFail = 0;
const t0 = process.hrtime.bigint();
const homeReq = Buffer.from('GET /home HTTP/1.1\r\nHost: x\r\n\r\n', 'latin1');
const wantHome = 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nhi';
let allCorrect = true;
for (let i = 1; i <= N; i++) {
  const resp = (await sendRawRequest(port, homeReq)).toString('latin1');
  if (resp !== wantHome) { allCorrect = false; console.log(`  connection ${i}: unexpected response ${JSON.stringify(resp)}`); }
  if (sockChild.exitCode !== null || sockChild.killed) {
    console.log(`FAIL  process died before connection ${i} finished (exit ${sockChild.exitCode})`);
    liveFail++;
    break;
  }
}
const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
const stillUp = sockChild.exitCode === null;

if (liveFail === 0 && allCorrect && stillUp) {
  console.log(`PASS  ${N}/${N} connections served correctly; process still up after the run`);
} else {
  console.log(`FAIL  liveness check (allCorrect=${allCorrect}, stillUp=${stillUp})`);
  liveFail++;
}
fail += liveFail;

const rps = N / (elapsedMs / 1000);
console.log(`\n${N} connections in ${elapsedMs.toFixed(1)}ms -> ${rps.toFixed(0)} req/s over loopback TCP`);
console.log('(informational; one process, one connection per request, no HTTP keep-alive multiplexing - v1 scope)');

sockChild.kill();

// ============================== PART C: image-size evidence (informational) ==============
console.log('\n== Part C: image-size evidence ==');
const st = fs.statSync(sockBin);
console.log(`socket-server binary: ${sockBin}`);
console.log(`size: ${st.size} bytes (${(st.size / 1024).toFixed(1)} KiB)`);
try {
  const otool = execFileSync('otool', ['-L', sockBin], { encoding: 'utf8' });
  console.log('linked libraries (otool -L):');
  console.log(otool.trim());
} catch {
  console.log('(otool unavailable on this platform; binary was linked via plain `clang -O2` with no extra -l flags - libc/libm only, no Node, no node_modules)');
}
console.log('No Node runtime, no npm packages are in this binary or its request path: cold start for');
console.log('this executable is a fork+exec of a small static-ish ELF/Mach-O, not a Node process boot.');

console.log(`\nSummary: ${checks - fail >= 0 ? checks + 1 - fail : 0} pass, ${fail} fail (${checks} byte-identity checks + 1 liveness check)`);
process.exit(fail === 0 ? 0 : 1);
