// lumen_serve.mjs - the socket seam for the Lumen HTTP server kernel.
//
// The HTTP protocol logic (parse the request line, match a route table, build the response bytes)
// lives entirely in examples/http/http_serve.lm. The one thing a wasm program cannot do is own a
// TCP socket, so this thin host shim does exactly that and nothing more: it binds a port, and for
// each connection copies the request bytes into the kernel's raw memory, runs the kernel, and writes
// the response bytes the kernel produced back to the socket. It is a disposable bootstrap seam, the
// same class of host capability as console_print - re-derived in the language once native sockets
// land. It adds no compiler feature and never touches the compiler's hot path.
//
// The route table is data, not logic: a JSON config maps method+path to a status/content-type/body,
// and this shim stages it into the kernel's memory once at startup. The kernel does the routing.
//
// Run:  node lumen_serve.mjs [config.json]
//   config.json: { "port": 8080, "routes": [ { "method":"GET", "path":"/", "status":200,
//                  "contentType":"text/plain", "body":"hi" | "bodyFile":"page.html" }, ... ] }
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshInstance, writeSrc } from '../native/pipeline.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Memory map - must match examples/http/http_serve.lm.
const REQ_LEN_ADDR = 590000, REQ_BASE = 590016;
const ROUTE_COUNT_ADDR = 598000, ROUTE_BASE = 598016, BLOB_BASE = 604000, BLOB_CEIL = 820000;
const OUT_LEN_ADDR = 829996, OUT_BASE = 830000;
const REQ_CAP = ROUTE_COUNT_ADDR - REQ_BASE;   // largest request the kernel will read
const METHOD = { GET: 1, POST: 2, PUT: 3, DELETE: 4, HEAD: 5, PATCH: 6, OPTIONS: 7 };

function loadConfig(argv) {
  const cfgPath = argv[2] ? path.resolve(argv[2]) : null;
  if (!cfgPath) {
    return {
      dir: process.cwd(),
      port: 8080,
      routes: [
        { method: 'GET', path: '/', status: 200, contentType: 'text/plain', body: 'Lumen HTTP server is up.\n' },
        { method: 'GET', path: '/health', status: 200, contentType: 'text/plain', body: 'ok\n' },
      ],
    };
  }
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.dir = path.dirname(cfgPath);
  return cfg;
}

function routeBody(route, dir) {
  if (typeof route.body === 'string') return Buffer.from(route.body, 'utf8');
  if (route.bodyFile) return fs.readFileSync(path.resolve(dir, route.bodyFile));
  return Buffer.alloc(0);
}

// Stage the route table + blob into the kernel's raw memory once (the server's startup step).
function stageRoutes(mem, routes, dir) {
  const u8 = new Uint8Array(mem.buffer);
  const dv = new DataView(mem.buffer);
  let blob = BLOB_BASE;
  const packBytes = (bytes) => {
    if (blob + bytes.length > BLOB_CEIL) {
      throw new Error(`route table too large: bodies exceed ${BLOB_CEIL - BLOB_BASE} bytes of blob space`);
    }
    const off = blob;
    u8.set(bytes, off);
    blob += bytes.length;
    return [off, bytes.length];
  };
  dv.setInt32(ROUTE_COUNT_ADDR, routes.length, true);
  routes.forEach((r, i) => {
    const base = ROUTE_BASE + i * 32;
    const [pathOff, pathLen] = packBytes(Buffer.from(r.path, 'latin1'));
    const [ctOff, ctLen] = packBytes(Buffer.from(r.contentType || 'text/plain', 'latin1'));
    const [bodyOff, bodyLen] = packBytes(routeBody(r, dir));
    const code = METHOD[(r.method || 'GET').toUpperCase()];
    if (!code) throw new Error(`unknown method ${r.method} for ${r.path}`);
    dv.setInt32(base + 0, code, true);
    dv.setInt32(base + 4, pathOff, true);
    dv.setInt32(base + 8, pathLen, true);
    dv.setInt32(base + 12, r.status || 200, true);
    dv.setInt32(base + 16, ctOff, true);
    dv.setInt32(base + 20, ctLen, true);
    dv.setInt32(base + 24, bodyOff, true);
    dv.setInt32(base + 28, bodyLen, true);
  });
  return blob - BLOB_BASE;
}

const cfg = loadConfig(process.argv);
const SRC = fs.readFileSync(path.join(__dirname, '../examples/http/http_serve.lm'), 'utf8');
const I = await freshInstance();
const len = writeSrc(I, SRC);
I.ex.compile(len);
if (I.ex.dbg_nerr() > 0) throw new Error(`http_serve compile: ${I.ex.dbg_nerr()} error(s)`);
const mem = I.ex.mem;
const dv = new DataView(mem.buffer);
const u8 = new Uint8Array(mem.buffer);
const blobUsed = stageRoutes(mem, cfg.routes, cfg.dir);
const mainEntry = I.ex.dbg_main();

// Serve one request synchronously: copy bytes in, run the kernel, copy the response out. Running is
// synchronous, so per-connection handling is atomic within one event-loop tick (no memory interleave).
function serve(reqBytes) {
  const n = Math.min(reqBytes.length, REQ_CAP);
  u8.set(reqBytes.subarray(0, n), REQ_BASE);
  dv.setInt32(REQ_LEN_ADDR, n, true);
  I.ex.run(mainEntry);
  const outLen = dv.getInt32(OUT_LEN_ADDR, true);
  return Buffer.from(u8.subarray(OUT_BASE, OUT_BASE + outLen));   // copy out of the wasm heap
}

const server = net.createServer((socket) => {
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (buf.indexOf('\r\n\r\n') === -1) {                          // wait for the full header block
      if (buf.length > REQ_CAP) socket.destroy();
      return;
    }
    const line = buf.slice(0, buf.indexOf('\r\n')).toString('latin1');
    const resp = serve(buf);
    const status = resp.slice(9, 12).toString('latin1');
    process.stdout.write(`${line} -> ${status} (${resp.length} bytes)\n`);
    socket.end(resp);
  });
  socket.on('error', () => socket.destroy());
});

server.listen(cfg.port, () => {
  console.log(`Lumen HTTP server (kernel: examples/http/http_serve.lm) listening on :${cfg.port}`);
  console.log(`routes: ${cfg.routes.map(r => `${r.method} ${r.path}`).join(', ')}  (blob ${blobUsed} bytes)`);
});
