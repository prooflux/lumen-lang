// architecture-update.mjs - the host seam for the self-updating ARCHITECTURE.md.
//
// Lumen cannot touch the filesystem (console + raw memory only), so this thin host harness does
// the I/O: it gathers the repo facts that drift as the project grows (the pure-Lumen kernels, the
// CI gates, the Lumen-written native emitters), hands each list to tools/architecture-update.lm to
// RENDER into markdown, and splices the result into the AUTO blocks of ARCHITECTURE.md. All the
// rendering logic lives in Lumen; this file only reads files, runs the compiler, and writes bytes.
//
//   node tools/architecture-update.mjs            # regenerate ARCHITECTURE.md in place
//   node tools/architecture-update.mjs --check    # exit 1 if ARCHITECTURE.md is stale (CI gate)
//
// Wired into .github/workflows/architecture.yml, which runs it on every push to main and commits
// the refreshed doc - so the file is up to date "by definition" after each merge.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshInstance, writeSrc } from '../native/pipeline.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LM = fs.readFileSync(path.join(REPO, 'tools/architecture-update.lm'), 'utf8');
const DOC = path.join(REPO, 'ARCHITECTURE.md');

// Run the Lumen renderer over a list of names -> markdown bullet list (or "(none)" if empty).
async function render(names) {
  const I = await freshInstance();
  I.ex.compile(writeSrc(I, LM));
  if (I.ex.dbg_nerr() > 0) throw new Error(`architecture-update.lm compile: ${I.ex.dbg_nerr()} error(s)`);
  const bytes = Buffer.from(names.join('\n'), 'latin1');
  new Uint8Array(I.ex.mem.buffer).set(bytes, 600000);
  new DataView(I.ex.mem.buffer).setInt32(599996, bytes.length, true);
  I.resetOut();
  I.ex.run(I.ex.dbg_main());
  const outLen = new DataView(I.ex.mem.buffer).getInt32(699996, true);
  const md = Buffer.from(new Uint8Array(I.ex.mem.buffer, 700000, outLen)).toString('latin1');
  return md.trimEnd() || '_(none)_';
}

// The facts that drift over time. Each is gathered from the filesystem here (the seam Lumen lacks).
function facts() {
  const lmIn = (dir) => fs.readdirSync(path.join(REPO, dir))
    .filter(f => f.endsWith('.lm')).map(f => f.slice(0, -3)).sort();
  const kernels = lmIn('examples/http');
  const emitters = lmIn('native').filter(n => !n.endsWith('_orig'));
  const gateYml = fs.readFileSync(path.join(REPO, '.github/workflows/gate.yml'), 'utf8');
  const gates = [...gateYml.matchAll(/node\s+([a-z0-9_]+\.mjs)/g)].map(m => m[1]);
  return { kernels, emitters, gates };
}

// Replace the text between <!-- AUTO:name --> and <!-- /AUTO:name --> with `body`.
function spliceBlock(doc, name, body) {
  const re = new RegExp(`(<!-- AUTO:${name} -->)[\\s\\S]*?(<!-- /AUTO:${name} -->)`);
  if (!re.test(doc)) throw new Error(`ARCHITECTURE.md is missing the AUTO:${name} block`);
  return doc.replace(re, `$1\n${body}\n$2`);
}

async function main() {
  const check = process.argv.includes('--check');
  const f = facts();
  const blocks = {
    kernels: await render(f.kernels),
    emitters: await render(f.emitters),
    gates: await render(f.gates),
  };
  const original = fs.readFileSync(DOC, 'utf8');
  let updated = original;
  for (const [name, body] of Object.entries(blocks)) updated = spliceBlock(updated, name, body);

  if (updated === original) {
    console.log('ARCHITECTURE.md is up to date.');
    return;
  }
  if (check) {
    console.error('ARCHITECTURE.md is STALE. Run: node tools/architecture-update.mjs');
    process.exit(1);
  }
  fs.writeFileSync(DOC, updated);
  console.log(`ARCHITECTURE.md refreshed (${f.kernels.length} kernels, ${f.emitters.length} emitters, ${f.gates.length} gates).`);
}

main().catch(e => { console.error(e); process.exit(1); });
