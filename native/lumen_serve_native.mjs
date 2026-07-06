// lumen_serve_native.mjs - the fast serving path: the HTTP server kernel compiled to native code,
// driven behind a socket.
//
// seed/lumen_serve.mjs runs the kernel on the wasm interpreter (the correctness oracle) - correct but
// slow. This module compiles the SAME examples/http/http_serve.lm through the language's own native
// emitter (emit_fn.lm -> C -> clang -O2) into a request/response serve loop. The socket still lives
// in the host (the one capability a wasm/native program cannot yet express in the language), but the
// per-request work - parse, route, frame - now runs as native code at the throughput the in-process
// benchmark measures, instead of interpreted.
//
// How the loop is formed: the route table is baked into the kernel by a generated stage() that the
// Lumen `main` runs once (guarded by a flag in raw memory), so the entry function both self-stages
// and serves. The native emitter turns that entry into a C function; we then replace the emitter's
// one-shot `main` with a stdin/stdout loop that calls the same entry per request. Framing on the
// pipe: each message is a 4-byte little-endian length followed by that many bytes. An empty response
// (length 0) means "no local route" - in proxy mode the socket host forwards the request to an origin.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { buildAndRunFn } from './pipeline.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KERNEL = fs.readFileSync(path.join(__dirname, '../examples/http/http_serve.lm'), 'utf8');

// Memory map - must match examples/http/http_serve.lm (+ a STAGED flag for the self-staging main).
export const REQ_LEN_ADDR = 590000, REQ_BASE = 590016, REQ_CAP = 598000 - 590016;
const ROUTE_COUNT_ADDR = 598000, PROXY_MODE_ADDR = 598008, STAGED_ADDR = 598012;
const ROUTE_BASE = 598016, BLOB_BASE = 604000, BLOB_CEIL = 610000;   // paths + content-types (baked in source)
const BODY_BASE = 610000, BODY_CAP = 820000 - 610000;                // bodies (streamed to the binary at startup)
export const OUT_LEN_ADDR = 829996, OUT_BASE = 830000;
const METHOD = { GET: 1, POST: 2, PUT: 3, DELETE: 4, HEAD: 5, PATCH: 6, OPTIONS: 7 };

// Emit a Lumen stage() that bakes the route table + proxy flag + small strings (paths, content-types)
// into raw memory, plus a self-staging main that stages once then serves. Body bytes are NOT baked
// (a large page would blow the compiler's source limit) - they are laid out contiguously from
// BODY_BASE and returned as `bodyBlock`, which the host streams into the binary at startup.
// serve_body is http_serve.lm's per-request `main`.
function genServeSrc(routes, proxyMode) {
  const serveBody = KERNEL.replace('fn main(c: Console) -> Unit {', 'fn serve_body() -> Unit {');
  const lines = [];
  lines.push(`  store32(${PROXY_MODE_ADDR}, ${proxyMode ? 1 : 0})`);
  lines.push(`  store32(${ROUTE_COUNT_ADDR}, ${routes.length})`);
  let blob = BLOB_BASE;
  const pack = (bytes) => {                          // small strings, baked into the source
    if (blob + bytes.length > BLOB_CEIL) throw new Error('route paths/content-types exceed metadata space');
    const off = blob;
    bytes.forEach((b, i) => lines.push(`  store8(${off + i}, ${b})`));
    blob += bytes.length;
    return [off, bytes.length];
  };
  let bodyOff = BODY_BASE;                            // bodies, streamed at startup
  const bodyChunks = [];
  routes.forEach((r, i) => {
    const base = ROUTE_BASE + i * 32;
    const [pathOff, pathLen] = pack(Buffer.from(r.path, 'latin1'));
    const [ctOff, ctLen] = pack(Buffer.from(r.contentType || 'text/plain', 'latin1'));
    const body = r.bodyBytes;
    const bOff = bodyOff;
    bodyOff += body.length;
    if (bodyOff > BODY_BASE + BODY_CAP) throw new Error('route bodies exceed body space');
    bodyChunks.push(body);
    const code = METHOD[(r.method || 'GET').toUpperCase()];
    if (!code) throw new Error(`unknown method ${r.method}`);
    for (const [k, v] of [[0, code], [4, pathOff], [8, pathLen], [12, r.status || 200],
      [16, ctOff], [20, ctLen], [24, bOff], [28, body.length]]) {
      lines.push(`  store32(${base + k}, ${v})`);
    }
  });
  const src = `${serveBody}
fn stage() -> Unit {
${lines.join('\n')}
  return ()
}

fn main(c: Console) -> Unit {
  if load32(${STAGED_ADDR}) == 0 {
    stage()
    store32(${STAGED_ADDR}, 1)
  }
  serve_body()
  return ()
}
`;
  return { src, bodyBlock: Buffer.concat(bodyChunks) };
}

// Replace the emitter's one-shot `int main(){ ...; fN(); return 0; }` with a length-framed serve loop
// that calls the same entry fN per request over stdin/stdout.
function patchMainToServeLoop(csrc) {
  const m = csrc.match(/int main\(void\)\{setvbuf\(stdout,0,_IONBF,0\);(f\d+)\(\);return 0;\}/);
  if (!m) throw new Error('could not find the emitted main entry to patch');
  const entry = m[1];
  const loop = `static uint32_t lm_rd4(void){unsigned char h[4]; if(fread(h,1,4,stdin)!=4)return 0xffffffffu; return (uint32_t)h[0]|((uint32_t)h[1]<<8)|((uint32_t)h[2]<<16)|((uint32_t)h[3]<<24);}
static void lm_preload(void){
  uint32_t n=lm_rd4();
  if(n==0xffffffffu)return;
  if(n>${BODY_CAP}u)n=${BODY_CAP}u;
  if(n)fread(LMEM+${BODY_BASE},1,n,stdin);
}
static void lm_serve_loop(void){
  for(;;){
    uint32_t n=lm_rd4();
    if(n==0xffffffffu)break;
    if(n>${REQ_CAP}u)n=${REQ_CAP}u;
    if(n && fread(LMEM+${REQ_BASE},1,n,stdin)!=n)break;
    *(int32_t*)(LMEM+${REQ_LEN_ADDR})=(int32_t)n;
    ${entry}();
    int32_t o=*(int32_t*)(LMEM+${OUT_LEN_ADDR});
    unsigned char oh[4]={(unsigned char)o,(unsigned char)(o>>8),(unsigned char)(o>>16),(unsigned char)(o>>24)};
    fwrite(oh,1,4,stdout);
    if(o>0)fwrite(LMEM+${OUT_BASE},1,(size_t)o,stdout);
    fflush(stdout);
  }
}
int main(void){lm_preload();lm_serve_loop();return 0;}`;
  return csrc.replace(m[0], loop);
}

// Build the native serve binary for a route table. Returns { bin, bodyBlock }: the binary path and
// the concatenated route bodies the caller must stream into the binary at startup (the preload block).
export async function buildNativeServe(routes, proxyMode) {
  const { src, bodyBlock } = genServeSrc(routes, proxyMode);
  const { csrc } = await buildAndRunFn(src, '-O2');   // emits C (and runs it once on empty input; ignored)
  const patched = patchMainToServeLoop(csrc);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-serve-native-'));
  const cfile = path.join(dir, 'serve.c'), bin = path.join(dir, 'serve');
  fs.writeFileSync(cfile, patched);
  execFileSync('clang', ['-ffp-contract=off', '-fno-fast-math', '-O2', '-o', bin, cfile],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  return { bin, bodyBlock };
}

// A 4-byte-length-prefixed frame (the pipe protocol used for both the preload block and requests).
function frame(bytes) {
  const h = Buffer.alloc(4);
  h.writeUInt32LE(bytes.length);
  return Buffer.concat([h, bytes]);
}

// --- TCP server: spawn the native binary once, serve over the socket with keep-alive. ---

function loadConfig(cfgPath) {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const dir = path.dirname(cfgPath);
  cfg.routes = cfg.routes.map((r) => ({
    ...r,
    bodyBytes: typeof r.body === 'string' ? Buffer.from(r.body, 'utf8')
      : r.bodyFile ? fs.readFileSync(path.resolve(dir, r.bodyFile)) : Buffer.alloc(0),
  }));
  return cfg;
}

// A single native child processes requests FIFO over its stdin/stdout pipe. This serializer writes a
// framed request and resolves with the framed response, correlating by order (the child reads one and
// writes one, in order). Every request runs as native code; the pipe is the only per-request overhead.
function makeServer(bin, bodyBlock) {
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
  child.on('exit', (code) => { console.error(`native serve binary exited (${code})`); process.exit(1); });
  child.stdin.write(frame(bodyBlock));   // preload the bodies once, before any request
  return (reqBytes) => new Promise((resolve) => {
    child.stdin.write(frame(reqBytes.subarray(0, REQ_CAP)));
    pending.push(resolve);
  });
}

// Slice complete HTTP/1.1 requests (headers + optional Content-Length body) out of a rolling buffer.
function nextRequest(buf) {
  const he = buf.indexOf('\r\n\r\n');
  if (he === -1) return null;
  const headers = buf.slice(0, he).toString('latin1');
  const cl = /content-length:\s*(\d+)/i.exec(headers);
  const end = he + 4 + (cl ? parseInt(cl[1], 10) : 0);
  if (buf.length < end) return null;
  return { req: buf.subarray(0, end), rest: buf.subarray(end) };
}

async function runServer(cfgPath) {
  const cfg = loadConfig(cfgPath);
  const origin = cfg.proxyPass ? new URL(cfg.proxyPass) : null;
  const { bin, bodyBlock } = await buildNativeServe(cfg.routes, !!origin);
  const serve = makeServer(bin, bodyBlock);

  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0), busy = false;
    const pump = async () => {
      if (busy) return;
      busy = true;
      let slice;
      while ((slice = nextRequest(buf))) {
        buf = slice.rest;
        const line = slice.req.slice(0, slice.req.indexOf('\r\n')).toString('latin1');
        const resp = await serve(slice.req);
        if (resp.length === 0) {                        // unmatched -> proxy to origin, then close
          const up = net.connect(Number(origin.port) || 80, origin.hostname, () => up.write(slice.req));
          up.on('data', (d) => socket.write(d));
          up.on('end', () => socket.end());
          up.on('error', () => socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'));
          process.stdout.write(`${line} -> proxied\n`);
          return;                                        // stop keep-alive loop for this connection
        }
        socket.write(resp);                              // keep-alive: write and continue
      }
      busy = false;
    };
    socket.on('data', (chunk) => { buf = Buffer.concat([buf, chunk]); if (buf.length > REQ_CAP) buf = buf.subarray(0, REQ_CAP); pump(); });
    socket.on('error', () => socket.destroy());
  });

  server.listen(cfg.port, () => {
    console.log(`Lumen HTTP server (NATIVE, kernel compiled via emit_fn.lm) listening on :${cfg.port}`);
    console.log(`routes: ${cfg.routes.map((r) => `${r.method} ${r.path}`).join(', ')} (keep-alive)`);
    if (origin) console.log(`proxy: unmatched requests -> ${origin.origin}`);
  });
}

// --- self-test: build a binary, pipe framed requests, check the framed responses. ---
if (process.argv[1] && process.argv[1].endsWith('lumen_serve_native.mjs') && process.argv.includes('--selftest')) {
  const routes = [
    { method: 'GET', path: '/', status: 200, contentType: 'text/plain', bodyBytes: Buffer.from('hi') },
    { method: 'GET', path: '/health', status: 200, contentType: 'application/json', bodyBytes: Buffer.from('{"status":"ok"}') },
    { method: 'GET', path: '/home', status: 200, contentType: 'text/html; charset=utf-8', bodyBytes: Buffer.from('<h1>Home</h1>') },
  ];
  const { bin, bodyBlock } = await buildNativeServe(routes, true);   // proxy mode on: unmatched -> empty

  const cases = [
    ['GET /home HTTP/1.1\r\nHost: x\r\n\r\n', 'HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: 13\r\nConnection: keep-alive\r\n\r\n<h1>Home</h1>'],
    ['GET /health HTTP/1.1\r\n\r\n', 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 15\r\nConnection: keep-alive\r\n\r\n{"status":"ok"}'],
    ['GET /nope HTTP/1.1\r\n\r\n', ''],   // unmatched -> empty (proxy signal)
  ];
  // preload the bodies, then send the framed requests.
  const input = Buffer.concat([frame(bodyBlock), ...cases.map(([req]) => frame(Buffer.from(req, 'latin1')))]);
  const out = execFileSync(bin, [], { input, maxBuffer: 1 << 20 });

  let off = 0, fail = 0;
  console.log('== native serve loop self-test ==');
  for (const [req, want] of cases) {
    const len = out.readUInt32LE(off); off += 4;
    const got = out.subarray(off, off + len).toString('latin1'); off += len;
    const ok = got === want;
    if (ok) console.log(`PASS  ${JSON.stringify(req.split('\r\n')[0])} -> ${len ? JSON.stringify(got.split('\r\n')[0]) : '(empty: proxy)'}`);
    else { console.log(`FAIL  ${JSON.stringify(req.split('\r\n')[0])}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); fail++; }
  }
  console.log(fail === 0 ? `\n${cases.length}/${cases.length} native serve-loop responses correct.` : `\nFAIL: ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

// server mode: node lumen_serve_native.mjs <config.json>
if (process.argv[1] && process.argv[1].endsWith('lumen_serve_native.mjs')
  && !process.argv.includes('--selftest') && process.argv[2]) {
  await runServer(path.resolve(process.argv[2]));
}
