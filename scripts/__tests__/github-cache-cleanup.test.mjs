import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const workflow = require('yaml').parse(fs.readFileSync(new URL('../../.github/workflows/cache-cleanup.yml', import.meta.url), 'utf8'));
const script = workflow.jobs.cleanup.steps[0].run.split("python3 - <<'PY'\n")[1].split('\nPY')[0];
const prefix = 'android-public-downloads-v1-';
const nativePath = '.github/workflows/android-build.yml';
const pythonAvailable = spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0;
const pythonTest = (name, fn) => test(name, { skip: !pythonAvailable }, fn);
const cache = (id, version, overrides = {}) => ({
  id, ref: `refs/tags/v${version}`, key: `${prefix}fixture-${id}`,
  created_at: '2026-10-22T12:00:00Z', size_in_bytes: 1024 ** 3, ...overrides,
});

function runCleanup(caches, options = {}, envOverrides = {}) {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.ci-cache-cleanup-test-'));
  try {
    const stateFile = path.join(dir, 'state.json');
    const summaryFile = path.join(dir, 'summary.md');
    fs.writeFileSync(stateFile, JSON.stringify({ caches, calls: [], deleted: [], runQueries: 0, ...options }));
    fs.writeFileSync(path.join(dir, 'gh'), `#!/usr/bin/env python3
import json, os, pathlib, sys
p=pathlib.Path(os.environ['FAKE_GH_STATE']);s=json.loads(p.read_text());args=sys.argv[1:]
s['calls'].append(args);p.write_text(json.dumps(s))
if len(args)==4 and args[:3]==['api','--paginate','--slurp']:
    endpoint=args[3]
    if s.get('readDenied'): sys.exit('HTTP 403: API read denied')
    if '/actions/runs?' in endpoint:
        s['runQueries']+=1;p.write_text(json.dumps(s))
        active=(s.get('activeStatus') and 'status='+s['activeStatus']+'&' in endpoint) or (s.get('becomesActive') and s['runQueries']>5)
        run={'path':s.get('activePath','${nativePath}')+'@refs/tags/v1.0.12'}
        print(json.dumps([{'workflow_runs':[run] if active else []}]))
    elif '/actions/caches?' in endpoint:
        assert endpoint.startswith('repos/example/wallet/actions/caches?')
        assert 'key=${prefix}' in endpoint and 'per_page=100' in endpoint
        items=s['caches'];size=s.get('pageSize',100)
        pages=[{'actions_caches':items[i:i+size]} for i in range(0,len(items),size)] or [{'actions_caches':[]}]
        print(json.dumps({} if s.get('invalidListing') else pages))
    else: sys.exit('Unexpected read endpoint: '+endpoint)
elif len(args)==4 and args[:3]==['api','--method','DELETE']:
    endpoint=args[3];prefix='repos/example/wallet/actions/caches/'
    assert endpoint.startswith(prefix)
    suffix=endpoint[len(prefix):];assert suffix.isdigit();cache_id=int(suffix)
    if cache_id==s.get('deleteErrorId'):
        if s.get('deleteErrorStatus')==404:
            s['caches']=[c for c in s['caches'] if c['id']!=cache_id];p.write_text(json.dumps(s))
        sys.exit('HTTP '+str(s.get('deleteErrorStatus',403))+': deletion failed')
    assert cache_id in [c['id'] for c in s['caches']]
    s['deleted'].append(cache_id);s['caches']=[c for c in s['caches'] if c['id']!=cache_id]
    p.write_text(json.dumps(s))
else: sys.exit('Unexpected gh command: '+str(args))
`, { mode: 0o700 });
    const result = spawnSync('python3', ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH, REPOSITORY: 'example/wallet', DRY_RUN: 'false', GITHUB_STEP_SUMMARY: summaryFile, FAKE_GH_STATE: stateFile, GH_TOKEN: 'test-only', ...envOverrides },
    });
    return { ...result, state: JSON.parse(fs.readFileSync(stateFile, 'utf8')), summary: fs.existsSync(summaryFile) ? fs.readFileSync(summaryFile, 'utf8') : '' };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('cleanup runs after native builds of every conclusion with a separate cache-only API job', () => {
  assert.deepEqual(workflow.on.workflow_run, { workflows: ['Public Android APK', 'iOS IPA', 'Main tests'], types: ['completed'] });
  assert.equal(workflow.on.workflow_dispatch.inputs.dry_run.default, false);
  assert.equal(workflow.on.schedule, undefined);
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.jobs.cleanup.permissions, { actions: 'write' });
  assert.deepEqual(workflow.concurrency, { group: 'build-cache-cleanup', 'cancel-in-progress': false });
  assert.match(workflow.jobs.cleanup.if, /github[.]ref == 'refs\/heads\/main'/);
  assert.match(workflow.jobs.cleanup.if, /head_repository[.]full_name == github[.]repository/);
  assert.doesNotMatch(workflow.jobs.cleanup.if, /conclusion/);
  assert.equal(workflow.jobs.cleanup.steps.length, 1);
  assert.equal(workflow.jobs.cleanup.steps[0].env.GH_TOKEN, '${{ github.token }}');
  assert.doesNotMatch(JSON.stringify(workflow), /"uses"|secrets[.]|id-token|attestations|checkout|npm |node |pip |actions\/artifacts\//);
  const runner = fs.readFileSync(new URL('../run-tests.cjs', import.meta.url), 'utf8');
  assert.match(runner, /github-cache-cleanup[.]test[.]mjs/);
});

pythonTest('keeps the highest numeric version even when an older tag was rerun later; leaves unrelated caches alone', () => {
  const fixtures = [
    cache(1, '1.0.9'), cache(80, '1.0.10', { created_at: '2030-01-01T00:00:00Z' }),
    cache(3, '1.0.11'), cache(4, '1.0.11', { ref: 'refs/heads/refs/tags/v1.0.11' }),
    cache(5, '99.0.0', { key: 'unrelated-cache' }), cache(6, '9.0.0', { ref: 'refs/pull/6/merge' }),
    cache(7, '99.0.0', { ref: 'refs/heads/main' }), cache(8, '1.0.12-rc.1'), cache(9, '01.0.12'),
  ];
  const result = runCleanup(fixtures);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.state.deleted, [1, 80, 3]);
  assert.deepEqual(result.state.caches.map(c => c.id), [4, 5, 6, 7, 8, 9]);
  assert.match(result.summary, /Keep cache 4 for v1[.]0[.]11/);
  assert.match(result.summary, /freed 3[.]00 GiB/);
});

pythonTest('empty inventory and repeated cleanup with only the retained cache perform no deletions', () => {
  for (const fixtures of [[], [cache(1, '1.0.11')]]) {
    const result = runCleanup(fixtures);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.state.deleted, []);
  }
});

pythonTest('defers for queued, running, waiting, pending or requested native builds and rechecks before deleting', () => {
  for (const options of ['queued', 'in_progress', 'waiting', 'pending', 'requested'].map(activeStatus => ({ activeStatus })).concat([{ becomesActive: true }])) {
    const result = runCleanup([cache(1, '1.0.10'), cache(2, '1.0.11')], options);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.state.deleted, []);
    assert.match(result.summary, /Cleanup deferred/);
  }
  const unrelated = runCleanup([cache(1, '1.0.10'), cache(2, '1.0.11')], { activeStatus: 'in_progress', activePath: '.github/workflows/cache-cleanup.yml' });
  assert.equal(unrelated.status, 0, unrelated.stderr);
  assert.deepEqual(unrelated.state.deleted, [1]);
});

pythonTest('includes every API page when choosing the version to retain', () => {
  const result = runCleanup([cache(1, '1.99.99'), cache(2, '2.0.0')], { pageSize: 1 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.state.deleted, [1]);
  assert.deepEqual(result.state.caches.map(c => c.id), [2]);
});

pythonTest('dry run reports the plan without issuing DELETE requests', () => {
  const result = runCleanup([cache(1, '1.0.10'), cache(2, '1.0.11')], {}, { DRY_RUN: 'true' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.state.deleted, []);
  assert.match(result.summary, /Dry run: would delete 1 obsolete/);
});

pythonTest('tolerates a cache already evicted by GitHub but stops on permission failures', () => {
  const fixtures = [cache(1, '1.0.9'), cache(2, '1.0.10'), cache(3, '1.0.11')];
  const expired = runCleanup(fixtures, { deleteErrorId: 1, deleteErrorStatus: 404 });
  assert.equal(expired.status, 0, expired.stderr);
  assert.deepEqual(expired.state.deleted, [2]);
  assert.deepEqual(expired.state.caches.map(c => c.id), [3]);
  const denied = runCleanup(fixtures, { deleteErrorId: 1, deleteErrorStatus: 403 });
  assert.notEqual(denied.status, 0);
  assert.deepEqual(denied.state.deleted, []);
  assert.match(denied.stderr, /Could not delete cache 1/);
});

pythonTest('invalid repository, flag, metadata, API response or read permissions cannot lead to deletion', () => {
  const fixtures = [cache(1, '1.0.10'), cache(2, '1.0.11')];
  for (const [items, options, env] of [
    [fixtures, {}, { REPOSITORY: 'example/wallet/../../other' }],
    [fixtures, {}, { DRY_RUN: 'yes' }],
    [[cache(0, '1.0.10'), cache(2, '1.0.11')], {}, {}],
    [[cache(1, '1.0.10', { created_at: 'invalid' }), cache(2, '1.0.11')], {}, {}],
    [fixtures, { invalidListing: true }, {}], [fixtures, { readDenied: true }, {}],
  ]) {
    const result = runCleanup(items, options, env);
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.state.deleted, []);
  }
});
