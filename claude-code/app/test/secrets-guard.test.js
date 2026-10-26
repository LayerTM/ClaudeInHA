'use strict';

// protect_secrets: the protected list is ONE file, and two mechanisms enforce
// it — the app's AppArmor profile (the kernel refuses the file) and a Claude Code
// PreToolUse hook (the agent learns why; without AppArmor it is the only
// layer and refuses the call itself). These tests hold the two to the same
// list, and the hook to what it must and must not refuse.
//
// What they would catch: a path added to the list but not to apparmor.txt
// (the hook refuses it, the kernel still serves it to any other command); a
// hook that lets `cat secrets.yaml` through from the configuration folder; a
// hook that refuses ordinary work — a search over the configuration, git, a
// new secret appended without reading the file; a service that starts
// without passing through secrets-guard, so nothing is guarded at all.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ADDON = path.join(__dirname, '..', '..');
const ROOTFS = path.join(ADDON, 'rootfs');
const LIST = path.join(ROOTFS, 'usr', 'share', 'agent-core', 'protected-paths.txt');
const HOOK = path.join(ROOTFS, 'usr', 'local', 'bin', 'secrets-guard-hook');
const GUARD = path.join(ROOTFS, 'usr', 'local', 'bin', 'secrets-guard');
const MANAGED = path.join(ROOTFS, 'etc', 'claude-code', 'managed-settings.json');
const RUN = path.join(ROOTFS, 'etc', 's6-overlay', 's6-rc.d', 'claude-code', 'run');
const APPARMOR = path.join(ADDON, 'apparmor.txt');

function listEntries(file = LIST) {
  return fs.readFileSync(file, 'utf8').split('\n')
    .map((line) => line.split('#')[0].trim())
    .filter(Boolean)
    .map((p) => ({ path: p }));
}

function apparmorRules(entry) {
  return [`deny ${entry.path} rwklmx,`];
}

function hook(event, list = LIST, level = 'cli-only') {
  const input = typeof event === 'string' ? event : JSON.stringify(event);
  const env = { ...process.env, PROTECT_SECRETS_LEVEL: level };
  const r = spawnSync('python3', ['-I', HOOK, list], { input, encoding: 'utf8', env });
  return { status: r.status, stderr: r.stderr, stdout: r.stdout };
}

function bash(command, cwd = '/homeassistant') {
  return { cwd, tool_name: 'Bash', tool_input: { command } };
}

test('the list names absolute paths only, and the credential stores', () => {
  const entries = listEntries();
  for (const e of entries) assert.match(e.path, /^\//, `${e.path} is not absolute`);
  const byPath = new Map(entries.map((e) => [e.path, e]));
  for (const must of [
    '/homeassistant/secrets.yaml',
    '/homeassistant/.storage/auth',
    '/homeassistant/.storage/auth_provider.homeassistant',
    '/homeassistant/.storage/core.config_entries',
  ]) assert.ok(byPath.has(must), `${must} missing`);
});

test('apparmor.txt denies exactly the listed paths, in the guarded child only', () => {
  const text = fs.readFileSync(APPARMOR, 'utf8');
  const block = text.match(/# BEGIN protected paths\n([\s\S]*?)\n\s*# END protected paths/);
  assert.ok(block, 'apparmor.txt has no protected-paths block');
  const denied = block[1].split('\n').map((l) => l.trim()).filter(Boolean);
  assert.deepStrictEqual(denied, listEntries().flatMap(apparmorRules));
  // The block sits inside `profile guarded`, after the child's opening line.
  assert.ok(text.indexOf('profile guarded') < text.indexOf('# BEGIN protected paths'));
  // The Supervisor renames the first `profile` line to the slug; the child is
  // reached through the kernel's own name for the parent, never a spelled slug.
  assert.match(text, /change_profile -> @\{profile_name\}\/\/guarded,/);
  assert.strictEqual(text.match(/^profile /gm).length, 1, 'exactly one top-level profile');
  const child = text.slice(text.indexOf('profile guarded'));
  assert.doesNotMatch(child, /change_profile/, 'the guarded child must have no way out');
});

test('the service enters the guard before the start script', () => {
  assert.match(fs.readFileSync(RUN, 'utf8'), /^exec \/usr\/local\/bin\/secrets-guard \/usr\/local\/bin\/addon-run$/m);
  // Nothing before the guarded mode is looked up through PATH, whose first
  // directory (the CLI's) the agent can write to.
  assert.match(fs.readFileSync(RUN, 'utf8'), /^#!\/command\/with-contenv \/usr\/bin\/bash-static\n/);
  assert.match(fs.readFileSync(path.join(path.dirname(RUN), 'finish'), 'utf8'), /^#!\/usr\/bin\/bash-static\n/);
  for (const f of [GUARD, HOOK]) assert.ok(fs.statSync(f).mode & 0o111, `${f} is not executable`);
  // Managed settings: no user, project or --settings file overrides them, and
  // the prompt API's runs (which read no settings files) still load them.
  // Hook only — static deny rules could not follow protect_secrets off.
  const managed = JSON.parse(fs.readFileSync(MANAGED, 'utf8'));
  assert.deepStrictEqual(Object.keys(managed), ['hooks']);
  assert.deepStrictEqual(managed.hooks.PreToolUse, [
    { matcher: '*', hooks: [{ type: 'command', command: '/usr/local/bin/secrets-guard-hook', timeout: 10 }] },
  ]);
});

// Calls aimed at a protected file. Without AppArmor (cli-only) the hook is the
// only layer and refuses them; with it (kernel) the kernel refuses the file,
// and the hook only tells the agent why.
const AIMED = [
  bash('cat secrets.yaml'),
  bash('wc -c /homeassistant/secrets.yaml | head'),
  bash('python3 -c "print(open(\'/homeassistant/secrets.yaml\').read())"'),
  bash('node -e "require(\'fs\').readFileSync(\'secrets.yaml\')"'),
  bash('echo "x: 1" > secrets.yaml'),
  bash('printf "\\nk: v\\n" >> secrets.yaml'),
  bash('echo "k: v" | tee -a /homeassistant/secrets.yaml'),
  bash('cat secrets.yaml >> /tmp/copy'),
  bash('printf "x: 1\\n" >> secrets.yaml; cat secrets.yaml'),
  bash('cat .storage/auth'),
  bash('jq . .storage/core.config_entries'),
  bash('cd .storage && cat core.config_entries'),
  bash('cd /homeassistant/.storage; jq . auth_provider.homeassistant'),
  bash('cat ../homeassistant/./secrets.yaml', '/homeassistant/.storage'),
  bash('cat esphome/secrets.yaml'),
  bash('ls .cloud/production_auth.json'),
  bash('cat auth', '/homeassistant/.storage'),
  bash('tar tf /backup/0a1b2c3d.tar'),
  { cwd: '/homeassistant', tool_name: 'Bash', tool_input: { command: 'cat auth', workdir: '.storage' } },
  { cwd: '/homeassistant', tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: secrets.yaml\n@@\n-a\n+b\n*** End Patch' } },
  { cwd: '/', tool_name: 'view_image', tool_input: { path: '/homeassistant/.storage/core.config_entries' } },
  { cwd: '/homeassistant', tool_name: 'Read', tool_input: { file_path: '/homeassistant/secrets.yaml', limit: 1 } },
  { cwd: '/homeassistant', tool_name: 'Grep', tool_input: { pattern: 'token', path: '.storage/auth' } },
  { cwd: '/homeassistant', tool_name: 'Edit', tool_input: { file_path: 'secrets.yaml', old_string: 'a', new_string: 'b' } },
  { cwd: '/homeassistant', tool_name: 'Monitor', tool_input: { command: 'tail -f /ssl/privkey.pem' } },
];

// Ordinary work, which neither layer may cost the agent.
const ORDINARY = [
  bash('cat configuration.yaml'),
  { cwd: '/homeassistant', tool_name: 'Read', tool_input: { file_path: '/homeassistant/configuration.yaml' } },
  { cwd: '/homeassistant', tool_name: 'Glob', tool_input: { pattern: '**/*.yaml' } },
  { cwd: '/homeassistant', tool_name: 'Grep', tool_input: { pattern: 'light.kitchen', path: '/homeassistant' } },
  bash('grep -n "!secret" configuration.yaml automations.yaml'),
  bash('grep -rn "light.kitchen" /homeassistant'),
  bash('rg -n token /homeassistant/.storage'),
  bash('ls .storage'),
  bash('ls -la /backup /homeassistant/.cloud'),
  bash('jq . .storage/lovelace_dashboards'),
  bash('cat .storage/authx'),
  bash('cat auth'),
  bash('git status && git add -A && git commit -m "Add kitchen automation"'),
  bash('ha core check'),
  bash('ha backups new --name before-change && ha backups list'),
  bash('curl -s -H "Authorization: Bearer $SUPERVISOR_TOKEN" http://supervisor/core/api/config/config_entries/entry'),
  bash('npm install -g some-package'),
  { cwd: '/homeassistant', tool_name: 'mcp__home_assistant__GetLiveContext', tool_input: {} },
];

test('without AppArmor the hook refuses a call aimed at a protected file', () => {
  for (const event of AIMED) {
    const r = hook(event, LIST, 'cli-only');
    assert.strictEqual(r.status, 2, `not refused: ${JSON.stringify(event.tool_input)}`);
    assert.match(r.stderr, /^Blocked: .* holds Home Assistant credentials/, JSON.stringify(event.tool_input));
  }
});

test('with AppArmor the hook refuses nothing and tells the agent why the kernel will', () => {
  for (const event of AIMED) {
    const r = hook(event, LIST, 'kernel');
    assert.strictEqual(r.status, 0, `refused: ${JSON.stringify(event.tool_input)}`);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.match(out.hookSpecificOutput.additionalContext, /holds Home Assistant credentials/);
  }
  const secrets = JSON.parse(hook(bash('cat secrets.yaml'), LIST, 'kernel').stdout);
  assert.match(secrets.hookSpecificOutput.additionalContext, /exact line to add to secrets\.yaml/, 'says how a secret gets added');
  // A mention that reads nothing still goes through (a commit message).
  assert.strictEqual(hook(bash('git commit -m "Reference secrets.yaml"'), LIST, 'kernel').status, 0);
});

test('ordinary work goes through at every level, without a word', () => {
  for (const level of ['cli-only', 'kernel']) {
    for (const event of ORDINARY) {
      const r = hook(event, LIST, level);
      assert.strictEqual(r.status, 0, `${level} refused: ${JSON.stringify(event.tool_input)} ${r.stderr}`);
      assert.strictEqual(r.stdout, '', `${level} commented on: ${JSON.stringify(event.tool_input)}`);
    }
  }
});

test('a wildcard is aimed at a protected file only when that is all it expands to', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
  try {
    fs.mkdirSync(path.join(root, '.storage'));
    for (const f of ['secrets.yaml', 'configuration.yaml', '.storage/auth', '.storage/lovelace']) {
      fs.writeFileSync(path.join(root, f), 'x');
    }
    const list = path.join(root, 'list.txt');
    fs.writeFileSync(list, `${root}/secrets.yaml\n${root}/.storage/auth\n`);
    assert.strictEqual(hook(bash('cat secret?.yaml', root), list).status, 2);
    assert.strictEqual(hook(bash('cat .storage/au*', root), list).status, 2);
    // A search over a folder that holds one is not aimed at it — where the
    // kernel guards the file; where the hook is the only layer, it is refused.
    for (const cmd of ['grep token *.yaml', 'grep token .storage/*']) {
      assert.strictEqual(hook(bash(cmd, root), list, 'kernel').status, 0, cmd);
      assert.strictEqual(hook(bash(cmd, root), list, 'kernel').stdout, '', cmd);
      assert.strictEqual(hook(bash(cmd, root), list, 'cli-only').status, 2, cmd);
    }
    assert.strictEqual(hook(bash('cat conf*.yaml', root), list).status, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('with protect_secrets off the hook lets everything through', () => {
  for (const event of AIMED) assert.strictEqual(hook(event, LIST, 'off').status, 0);
});

test('Docker\'s health check runs nothing found through PATH', () => {
  const docker = fs.readFileSync(path.join(ADDON, 'Dockerfile'), 'utf8');
  const check = docker.match(/^HEALTHCHECK[^\n]*\\\n\s*CMD (\[.*\])$/m);
  assert.ok(check, 'no HEALTHCHECK CMD');
  assert.strictEqual(JSON.parse(check[1])[0], '/usr/bin/bash-static');
});

test('without AppArmor the hook refuses what it cannot read', () => {
  assert.strictEqual(hook('not json').status, 2);
  assert.strictEqual(hook(bash('ls'), '/nonexistent/list.txt').status, 2);
  // With it, the kernel still refuses the files: an unreadable call goes through.
  assert.strictEqual(hook('not json', LIST, 'kernel').status, 0);
});

// One matcher, fed from the list itself: every entry, made concrete the way
// AppArmor would match it, is refused by the hook — so a glob added to the
// list is enforced by both halves, or this fails.
function concrete(entry) {
  return entry.replace(/\*\*/g, 'sub/dir').replace(/\*/g, 'x').replace(/\?/g, 'x');
}

test('every list entry, made concrete, is refused by the hook', () => {
  for (const entry of listEntries()) {
    const example = concrete(entry.path);
    const r = hook(bash(`cat ${example}`, '/'));
    assert.strictEqual(r.status, 2, `${entry.path} -> ${example} not refused`);
  }
});

test('TLS keys are protected, certificates are not', () => {
  for (const p of ['/ssl/privkey.pem', '/ssl/privkey-old.pem', '/ssl/server.key', '/ssl/nginx/site.key', '/ssl/le/live/privkey1.pem']) {
    assert.strictEqual(hook(bash(`cat ${p}`, '/')).status, 2, `${p} not refused`);
  }
  for (const p of ['/ssl/fullchain.pem', '/ssl/cert.pem', '/ssl/le/live/chain.pem', '/ssl/keystore.p12']) {
    assert.strictEqual(hook(bash(`openssl x509 -in ${p} -noout -enddate`, '/')).status, 0, `${p} refused`);
  }
});

test('the guarded mode cannot rewrite what decides its next start', () => {
  const text = fs.readFileSync(APPARMOR, 'utf8');
  const child = text.slice(text.indexOf('profile guarded'));
  for (const p of ['/data/options.json', '/etc/s6-overlay{,/**}', '/run/service{,/**}',
    '/usr/share/agent-core{,/**}', '/etc/claude-code{,/**}', '/usr/bin/bash-static', '/command{,/**}', '/package{,/**}',
    '/usr/local/bin/secrets-guard*',
    '/{bin,data,etc,run,usr,usr/bin,usr/local,usr/local/bin}{,/}', '/usr/lib/*/{libc,libnss_*}.so*']) {
    assert.ok(child.includes(`deny ${p} wl,`), `${p} is writable from the guarded mode`);
  }
  const guard = fs.readFileSync(GUARD, 'utf8');
  assert.match(guard, /^#!\/usr\/bin\/bash-static\n/, 'a static shell, named by a path the guarded mode cannot write');
  // Builtins only before the exec: every command line in the script is one.
  const external = guard.split('\n').filter((l) => !l.trim().startsWith('#'))
    .filter((l) => /(^|[;|&(]\s*|\$\()(cat|jq|mkdir|ln|rm|grep|sed|date|env|bashio)\b/.test(l));
  assert.deepStrictEqual(external, [], 'secrets-guard runs a program found through PATH');
  // No AppArmor on the host: the hook alone, said loudly — an update must not
  // leave such an app dead. An AppArmor host without the guarded mode: refuse.
  // "No AppArmor" is the kernel's answer, never a label that failed to read.
  assert.match(guard, /read -r kernel <\/sys\/module\/apparmor\/parameters\/enabled[\s\S]*?!= "Y"[\s\S]*?PROTECT_SECRETS_LEVEL=cli-only[\s\S]*?return 0/);
  assert.match(guard, /read -r label <\/proc\/self\/attr\/current 2>\/dev\/null \|\| refuse /);
  assert.match(guard, /"" \| unconfined\) refuse /);
  assert.match(guard, /refuse "the running AppArmor profile/);
  for (const level of ['kernel', 'cli-only', 'off']) assert.ok(guard.includes(`PROTECT_SECRETS_LEVEL=${level}`));
});
