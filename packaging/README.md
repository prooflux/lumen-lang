# Lumen MCP packaging

One-line install for the `lumen-mcp` server: a stdio Model Context Protocol server that exposes
a warm Lumen compiler (`lumen_check`, `lumen_fix`, `lumen_run`, `lumen_ir`, `lumen_explain`) to
any MCP-capable model.

## Quickstart

```sh
sh packaging/install.sh
```

This verifies `node >= 20`, runs `npm install` inside `seed/`, and prints the exact registration
command for your tool. It never registers the server itself — copy/paste the printed command.

Preview what it would do without touching anything:

```sh
sh packaging/install.sh --dry-run
```

## Register the MCP server

**Claude Code:**

```sh
claude mcp add lumen -- node /absolute/path/to/projects/lumen/seed/lumen_mcp.mjs
```

**Cursor** (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "lumen": {
      "command": "node",
      "args": ["/absolute/path/to/projects/lumen/seed/lumen_mcp.mjs"]
    }
  }
}
```

Both commands are printed with the resolved absolute path by `install.sh`; use that output rather
than retyping the path.

## Skill / rules files

- `packaging/claude-skill/lumen/SKILL.md` — copy into `.claude/skills/lumen/SKILL.md` for a
  Claude Code skill that triggers on writing/checking/running `.lm` code.
- `packaging/cursor/lumen.mdc` — copy into `.cursor/rules/lumen.mdc` for the equivalent Cursor
  rule (auto-attaches to `**/*.lm` files).

## Hello world

```lumen
fn main(console: Console) -> Unit {
  console.print("hello, world\n")
}
```

Run it directly (no MCP needed) with the seed CLI:

```sh
cd seed && npm install
node run.mjs path/to/hello.lm
```

Or drive it through the MCP tools once registered: `lumen_run` with the source as the `source`
argument returns stdout, or structured diagnostics if it doesn't compile.

## Where the oracle gates live

The compiler's correctness gates are the test suite in `seed/`:

```sh
cd seed && npm test
```

This runs, in order: `basics.mjs` (18 Lumen-mu programs compiled from source and executed),
`test.mjs` (conformance + safety-termination cases), `safety.mjs`, and `loop_test.mjs` (the
MCP/daemon round-trip loop, including the `lumend` incremental-edit daemon's
edit-to-diagnostic latency gate, p50 < 5ms). All of it runs against the single warm
`compiler_core.mjs` instance that `lumen_mcp.mjs` also embeds — the tests and the MCP server share
the same compiler, so a green `npm test` is the real oracle for "does the packaged server work".
