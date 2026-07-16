#!/usr/bin/env node
// Pure fs+crypto seal verifier for bench/promptgreen/shards.json. Deliberately imports no
// compiler: this module only hashes committed shard files and compares against the seal
// committed in shards.json. See PREREGISTRATION_v1.md ("Shard design") for the held_out seal
// recipe and its Addendum 1 for the metamorphic shard's repo-root-relative-path disambiguation.
//
// Recipe (implemented in computeShardSha below): for every task in a shard, its spec.md,
// reference.lm, and hidden_tests.mjs are each one hash-input entry of
// `relative_path_from_repo_root + NUL + file_bytes + NUL`. All entries across every task in the
// shard are concatenated in path-sorted (lexicographic) order, then hashed once with SHA-256.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// bench/promptgreen/ is two levels under the repo root.
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SHARDS_PATH = path.join(__dirname, 'shards.json');
const TASKS_DIR = path.join(__dirname, 'tasks');

const SEALED_FILENAMES = ['spec.md', 'reference.lm', 'hidden_tests.mjs'];

export function loadShards() {
  const raw = fs.readFileSync(SHARDS_PATH, 'utf8');
  return JSON.parse(raw);
}

function shardOrThrow(shards, shardName) {
  const shard = shards.shards[shardName];
  if (!shard) throw new Error(`seal_check: unknown shard '${shardName}'`);
  return shard;
}

// Recompute the seal recipe's SHA-256 for a shard's current task list. Reads bytes off disk
// every call; never caches, so a tampered file is caught on the next call, not the first.
export function computeShardSha(shardName, shards = loadShards()) {
  const shard = shardOrThrow(shards, shardName);
  const relPaths = [];
  for (const taskId of shard.tasks) {
    for (const fname of SEALED_FILENAMES) {
      const abs = path.join(TASKS_DIR, taskId, fname);
      relPaths.push(path.relative(REPO_ROOT, abs).split(path.sep).join('/'));
    }
  }
  relPaths.sort();

  const hash = crypto.createHash('sha256');
  const NUL = Buffer.from([0]);
  for (const rel of relPaths) {
    const bytes = fs.readFileSync(path.join(REPO_ROOT, rel));
    hash.update(Buffer.from(rel, 'utf8'));
    hash.update(NUL);
    hash.update(bytes);
    hash.update(NUL);
  }
  return hash.digest('hex');
}

// { ok, expected, actual }: expected/actual are null if the shard has no registered seal.
export function verifyShardSeal(shardName, shards = loadShards()) {
  const shard = shardOrThrow(shards, shardName);
  if (!shard.seal) {
    return { ok: false, expected: null, actual: null, reason: 'no seal registered for this shard' };
  }
  const actual = computeShardSha(shardName, shards);
  const expected = shard.seal.sha256;
  return { ok: actual === expected, expected, actual };
}

// Throws unless the shard has a registered seal AND it verifies. Call this before treating any
// run against a shard as a measured observation (PREREGISTRATION_v1.md's whole reason for
// sealing in the first place). dev and extended have no seal and are never eligible.
export function assertSealsForMeasuredRun(shardName) {
  const shards = loadShards();
  const shard = shardOrThrow(shards, shardName);
  if (!shard.seal) {
    throw new Error(
      `assertSealsForMeasuredRun: shard '${shardName}' has no registered seal; a measured run ` +
      `requires a sealed shard (dev/extended are not eligible per shards.json)`
    );
  }
  const result = verifyShardSeal(shardName, shards);
  if (!result.ok) {
    throw new Error(
      `assertSealsForMeasuredRun: shard '${shardName}' FAILED seal verification ` +
      `(expected ${result.expected}, actual ${result.actual}). The shard drifted or was ` +
      `tampered with; this run does not count (PREREGISTRATION_v1.md, Shard design).`
    );
  }
  return result;
}

function main() {
  const args = process.argv.slice(2);
  const shards = loadShards();
  const allShardNames = Object.keys(shards.shards);

  let targets;
  if (args.includes('--all')) {
    targets = allShardNames;
  } else {
    const idx = args.indexOf('--shard');
    if (idx === -1 || !args[idx + 1]) {
      console.error('usage: node seal_check.mjs [--shard NAME | --all]');
      process.exit(2);
      return;
    }
    targets = [args[idx + 1]];
  }

  let failures = 0;
  for (const name of targets) {
    const shard = shards.shards[name];
    if (!shard) {
      console.error(`[${name}] unknown shard`);
      failures++;
      continue;
    }
    if (!shard.seal) {
      console.log(`[${name}] no seal registered (${shard.role}); skipped`);
      continue;
    }
    const result = verifyShardSeal(name, shards);
    if (result.ok) {
      console.log(`[${name}] seal OK  sha256=${result.actual}`);
    } else {
      console.error(`[${name}] seal MISMATCH  expected=${result.expected}  actual=${result.actual}`);
      failures++;
    }
  }

  if (failures > 0) {
    console.error(`\nseal_check FAILED: ${failures} shard(s) failed verification`);
    process.exit(1);
  }
  console.log('\nseal_check OK: all requested shards verified');
  process.exit(0);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main();
