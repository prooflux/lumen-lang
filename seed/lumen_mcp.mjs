#!/usr/bin/env node
// `lumen-mcp`: a Model Context Protocol server (stdio, JSON-RPC 2.0) that exposes the warm
// Lumen compiler to any MCP-capable model, local or cloud. It embeds compiler_core directly,
// so the compiler is assembled once and every tool call is a hot, sub-millisecond compile.
// Zero new dependencies: the MCP framing is hand-rolled (newline-delimited JSON-RPC), keeping
// the toolchain self-contained on top of the existing `wabt` bootstrap assembler.
//
// Tools: lumen_check, lumen_fix, lumen_run, lumen_ir, lumen_explain.
import readline from 'node:readline';
import { createCompiler } from './compiler_core.mjs';
import { buildDiagnostics, applyFixes, fixableCount, explain } from './diagnostics.mjs';
import { withCache } from './cache.mjs';

const lumen = await createCompiler();

const TOOLS = [
  { name: 'lumen_check', description: 'Compile Lumen source and return structured diagnostics (the canonical Diagnostic stream). Empty diagnostics means it compiles.',
    inputSchema: { type: 'object', properties: { source: { type: 'string', description: 'Lumen (.lm) source' } }, required: ['source'] } },
  { name: 'lumen_fix', description: 'Apply the compiler\'s confident fixes to Lumen source (delete an unexpected token, close an unterminated block) and return the repaired source plus any remaining diagnostics.',
    inputSchema: { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] } },
  { name: 'lumen_run', description: 'Compile and run Lumen source; return its stdout, or diagnostics if it does not compile.',
    inputSchema: { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] } },
  { name: 'lumen_ir', description: 'Compile Lumen source and return the IR disassembly (one instruction per line).',
    inputSchema: { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] } },
  { name: 'lumen_explain', description: 'Explain a Lumen diagnostic code (e.g. E0003).',
    inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } },
];

function callTool(name, args) {
  const src = (args && args.source) || '';
  if (name === 'lumen_check') {
    const c = withCache('check', src, () => lumen.compile(src)); const d = buildDiagnostics(c.rawDiags, src);
    return { ok: d.length === 0, irWords: c.irWords, fixable: fixableCount(d), diagnostics: d };
  }
  if (name === 'lumen_fix') {
    let cur = src, applied = 0, rounds = 0;
    while (rounds++ < 20) {
      const c = lumen.compile(cur); const d = buildDiagnostics(c.rawDiags, cur);
      if (!d.length) break;
      const r = applyFixes(cur, d);
      if (r.applied === 0 || r.source === cur) break;
      cur = r.source; applied += r.applied;
    }
    const fc = lumen.compile(cur);
    return { source: cur, applied, diagnostics: buildDiagnostics(fc.rawDiags, cur) };
  }
  if (name === 'lumen_run') {
    const r = withCache('run', src, () => lumen.run(src));
    return { ok: r.ok, stdout: r.stdout, diagnostics: buildDiagnostics(r.rawDiags, src) };
  }
  if (name === 'lumen_ir') {
    const r = withCache('ir', src, () => lumen.ir(src));
    return { ok: r.ok, ir: r.ok ? r.text : '', diagnostics: buildDiagnostics(r.rawDiags, src) };
  }
  if (name === 'lumen_explain') {
    const reg = explain((args && args.code) || ''); return reg ? { code: reg.id, msg: reg.msg, explain: reg.explain } : { error: 'unknown code' };
  }
  throw new Error(`unknown tool ${name}`);
}

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

export function dispatch(req) {
  const { id, method, params } = req;
  if (method === 'initialize')
    return { jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'lumen-mcp', version: '0.1.0' } } };
  if (method === 'notifications/initialized' || method === 'initialized') return null;   // notification
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'tools/call') {
    try {
      const out = callTool(params.name, params.arguments || {});
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out) }] } };
    } catch (e) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(e.message || e) }], isError: true } };
    }
  }
  if (id !== undefined) return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
  return null;
}

// stdio loop (skipped when imported for testing)
if (import.meta.url === `file://${process.argv[1]}`) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', line => {
    if (!line.trim()) return;
    let req; try { req = JSON.parse(line); } catch { return; }
    const resp = dispatch(req);
    if (resp) send(resp);
  });
  process.stderr.write(`lumen-mcp: warm in ${lumen.assembleMs.toFixed(1)}ms, ready on stdio\n`);
}
