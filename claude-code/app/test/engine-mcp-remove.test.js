'use strict';

// engine_mcp_remove drops a user-scope MCP registration made by engine_mcp_add.
// A stand-in `claude` keeps the registrations in a file, so the real shell
// functions run against something that behaves like `claude mcp add/remove/list`.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOKS = path.join(__dirname, '..', '..', 'rootfs', 'usr', 'local', 'lib', 'engine-hooks.sh');

const FAKE_CLAUDE = `#!/usr/bin/env bash
db="$FAKE_MCP_DB"
[ "$1" = mcp ] || exit 2
names=(); while IFS= read -r l; do [ -n "$l" ] && names+=("$l"); done < "$db"
case "$2" in
  add) echo "$3" >> "$db" ;;
  remove)
    [ "$3" = -s ] && [ "$4" = user ] || exit 3
    kept=(); found=0
    for n in "\${names[@]}"; do [ "$n" = "$5" ] && found=1 || kept+=("$n"); done
    [ "$found" = 1 ] || { echo "No MCP server found with name: $5" >&2; exit 1; }
    { [ "\${#kept[@]}" -eq 0 ] || printf '%s\\n' "\${kept[@]}"; } > "$db" ;;
  list) for n in "\${names[@]}"; do echo "$n: stub - ok"; done ;;
esac
`;

function run(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-remove-'));
  try {
    fs.writeFileSync(path.join(dir, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'db'), '');
    // The file sources two sibling libraries by absolute image path; only the
    // MCP adapter functions are under test, so load just those.
    const src = fs.readFileSync(HOOKS, 'utf8');
    const has = src.match(/^engine_mcp_has\(\).*$/m)[0];
    const remove = src.match(/^engine_mcp_remove\(\).*$/m)[0];
    const add = src.match(/^engine_mcp_add\(\) \{[\s\S]*?^\}/m)[0];
    return spawnSync('bash', ['-c', `${has}\n${add}\n${remove}\n${script}`], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_MCP_DB: path.join(dir, 'db') },
      encoding: 'utf8',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('engine_mcp_remove deletes a registered server and leaves the others', () => {
  const r = run('engine_mcp_add hass-mcp K=V -- npx x; engine_mcp_add other -- y; '
    + 'engine_mcp_remove hass-mcp; echo rc=$?; engine_mcp_has hass-mcp && echo has-hass; engine_mcp_has other && echo has-other');
  assert.match(r.stdout, /rc=0/, r.stderr);
  assert.doesNotMatch(r.stdout, /has-hass/);
  assert.match(r.stdout, /has-other/);
});

test('engine_mcp_remove reports failure for a server that is not registered', () => {
  const r = run('engine_mcp_remove absent; echo rc=$?');
  assert.match(r.stdout, /rc=1/);
});
