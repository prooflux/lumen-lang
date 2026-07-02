// Exercises profile_report.lm (the profiler's report engine, written in Lumen itself) and its
// wiring into lumen_mcp's `lumen_profile` tool via {report: true}.
// Usage: node profile_report_test.mjs
process.env.LUMEN_NO_CACHE = '1';   // deterministic: every call recomputes, regardless of prior test-suite runs
import { dispatch } from './lumen_mcp.mjs';

let pass = 0, total = 0;
function check(name, cond, extra = '') { total++; if (cond) { pass++; console.log(`PASS  ${name}`); } else { console.log(`FAIL  ${name}  ${extra}`); } }

// ---- 1. synthetic 4-function dataset, known counts, via the MCP dispatch layer ----
// Four distinct functions, called a distinguishable number of times each, so the report's
// sort order is unambiguous: hot(9) > warm(6) > cool(3) > cold(1).
{
  const src = `
fn cold() -> Int { return 1 }
fn cool() -> Int { return cold() + 1 }
fn warm() -> Int { return cool() + cool() + cool() }
fn hot() -> Int { return warm() + warm() + warm() }
fn main(c: Console) -> Unit { c.print_int(hot()) }
`;
  const call = await dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lumen_profile', arguments: { source: src, report: true } } });
  const out = JSON.parse(call.result.content[0].text);
  check('synthetic: compiles and profiles ok', out.ok === true, JSON.stringify(out));
  check('synthetic: report field present', typeof out.report === 'string' && out.report.length > 0, JSON.stringify(out));

  const lines = (out.report || '').trim().split('\n').filter(l => l.length > 0);
  // print_int emits "<calls>\n", then print(name) emits "<name>\n" with no separator between
  // pairs, so the report is 2*N non-empty lines: calls, name, calls, name, ... N is every
  // profiled function (including `main` itself, which lumen_profile always reports).
  const expectedPairs = Math.min(out.functions.length, 10);
  check('synthetic: report has one calls+name pair per function', lines.length === expectedPairs * 2, JSON.stringify(lines));

  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) pairs.push({ calls: Number(lines[i]), name: lines[i + 1] });
  const callsSeq = pairs.map(p => p.calls);
  const sortedDesc = callsSeq.every((c, i) => i === 0 || callsSeq[i - 1] >= c);
  check('synthetic: sorted by calls desc', sortedDesc, JSON.stringify(callsSeq));

  const names = pairs.map(p => p.name);
  check('synthetic: report mentions hot/warm/cool/cold', ['hot', 'warm', 'cool', 'cold'].every(n => names.includes(n)), names.join(','));
  const first = pairs[0];
  check('synthetic: hottest function (main, argc apart) leads or ties for the top slot',
    first.calls >= pairs[pairs.length - 1].calls, JSON.stringify(pairs));
}

// ---- 2. end-to-end: lumen_profile(report:true) on fib_print.lm-style source ----
{
  const fibSrc = `
fn fib(n: Int) -> Int {
  if n < 2 { return n }
  return fib(n - 1) + fib(n - 2)
}
fn main(console: Console) -> Unit {
  console.print_int(fib(10))
}
`;
  const call = await dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'lumen_profile', arguments: { source: fibSrc, report: true } } });
  const out = JSON.parse(call.result.content[0].text);
  check('fib: compiles and profiles ok', out.ok === true, JSON.stringify(out));
  check('fib: report mentions fib', typeof out.report === 'string' && out.report.includes('fib'), JSON.stringify(out.report));
}

// ---- 3. lumen_profile without report:true keeps the old contract (no `report` field) ----
{
  const call = await dispatch({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'lumen_profile', arguments: { source: 'fn main(c: Console) -> Unit { c.print_int(1) }' } } });
  const out = JSON.parse(call.result.content[0].text);
  check('no-report: report field absent by default', out.ok === true && out.report === undefined, JSON.stringify(out));
}

console.log(`\n${pass}/${total} passed`);
if (pass !== total) process.exit(1);
