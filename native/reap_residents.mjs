// reap_residents.mjs - kill orphaned `--resident` compiler-server processes older than a
// threshold.
//
// native_compile.mjs's ResidentCompiler (R3) spawns a long-lived `lumenc0 --resident` process and
// expects a graceful `stop()` (or `stopResidentCompiler()`) call to end it. When a test run is
// interrupted, crashes, or is force-killed before that call happens, the resident process is
// simply left running with nothing left to talk to it - nothing in the codebase reaps it. This is
// not hypothetical: 20 such orphans were found accumulated on this machine after about 3 hours of
// test runs (2026-07-22), each a live `--resident` process nobody was still using.
//
// This module finds and kills stale ones by process age (not by a PID-file registry - the
// simplest correct approach that needs no changes to ResidentCompiler's spawn path and cleans up
// orphans regardless of which caller or session created them). Safe to run standalone
// (`node native/reap_residents.mjs`) or call reapStaleResidents() from a test's own setup before
// spawning a new resident, so orphans never silently re-accumulate.
import { execFileSync } from 'node:child_process';

const DEFAULT_MAX_AGE_MINUTES = 30;

// Parse BSD/macOS `ps` etime format ([[DD-]HH:]MM:SS) into minutes.
export function parseEtimeMinutes(etime) {
  let days = 0, rest = etime;
  if (rest.includes('-')) { const [d, r] = rest.split('-'); days = Number(d); rest = r; }
  const parts = rest.split(':').map(Number);
  let seconds;
  if (parts.length === 3) seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
  else if (parts.length === 2) seconds = parts[0] * 60 + parts[1];
  else seconds = parts[0] || 0;
  return days * 1440 + seconds / 60;
}

// List every live process whose command line contains `--resident` (the exact flag
// lumenc_native.mjs's patchMainToCompileDriver switches on) together with its age in minutes.
// Never throws: a `ps` failure (unexpected platform/output) yields an empty list rather than
// aborting whatever called this as a safety-net step.
export function findStaleResidents(maxAgeMinutes = DEFAULT_MAX_AGE_MINUTES) {
  let out;
  try {
    out = execFileSync('ps', ['-eo', 'pid=,etime=,command='], { encoding: 'utf8' });
  } catch {
    return [];
  }
  const stale = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const [, pidStr, etime, command] = m;
    if (!command.includes('--resident')) continue;
    const ageMinutes = parseEtimeMinutes(etime);
    if (ageMinutes >= maxAgeMinutes) stale.push({ pid: Number(pidStr), ageMinutes, command });
  }
  return stale;
}

// Kill every stale resident found (SIGTERM; these are simple stdin/stdout loop processes with no
// cleanup of their own to run). Returns the list that was (attempted to be) killed, so a caller
// can log what happened. Never throws: a process that already exited between the `ps` snapshot
// and the kill attempt is not an error here.
export function reapStaleResidents(maxAgeMinutes = DEFAULT_MAX_AGE_MINUTES) {
  const stale = findStaleResidents(maxAgeMinutes);
  for (const { pid, ageMinutes, command } of stale) {
    try {
      process.kill(pid, 'SIGTERM');
      console.error(`reap_residents: killed stale resident pid=${pid} (age ${ageMinutes.toFixed(1)}min): ${command.slice(0, 100)}`);
    } catch {
      // Already gone, or not ours to kill - either way, nothing more to do for this pid.
    }
  }
  return stale;
}

if (process.argv[1] && process.argv[1].endsWith('reap_residents.mjs')) {
  const arg = process.argv.find((a) => a.startsWith('--max-age-minutes='));
  const maxAge = arg ? Number(arg.split('=')[1]) : DEFAULT_MAX_AGE_MINUTES;
  const stale = reapStaleResidents(maxAge);
  console.log(stale.length
    ? `Reaped ${stale.length} stale resident process(es) (older than ${maxAge} minutes).`
    : `No stale resident processes found (older than ${maxAge} minutes).`);
}
