// Invalid configuration and stored corruption fail explicitly while source data remains available.
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveConfig } = require('../dist/config');
const { selectTopics } = require('../dist/curriculum');
const { fixture, configured, researchFixture, due, Banditbul } = require('./helpers.cjs');

test('class-based host policies retain their receiver and configured policy identity', async (t) => {
  class OperatorPolicy {
    id = 'class-policy-v1';
    enabled = true;
    screen({ facts }) {
      return this.enabled ? facts.map((fact) => fact.index) : [];
    }
  }
  const { engine } = fixture(t, { policy: new OperatorPolicy() });
  configured(engine);
  researchFixture(engine);
  await engine.tick();
  const cycle = engine.getCycle(engine.history()[0].id);
  assert.equal(cycle.policy_id, 'class-policy-v1');
  assert.equal(cycle.jobs[0].new_insights, 1);
});

test('stored identifiers retain embedded NULs for rejection instead of silently clipping them', async (t) => {
  const { engine, db } = fixture(t);
  configured(engine);
  researchFixture(engine);
  await engine.tick();
  const cycleId = engine.history()[0].id;
  db.execute('UPDATE banditbul_jobs SET category=?', ['programming\0altered']);
  assert.throws(() => engine.getCycle(cycleId));
  assert.equal(db.query('SELECT category FROM banditbul_jobs')[0].category, 'programming\0altered');
  db.execute('UPDATE banditbul_state SET policy_id=?', ['source-agreement-v1\0altered']);
  assert.throws(() => engine.status());
  assert.equal(
    db.query('SELECT policy_id FROM banditbul_state')[0].policy_id,
    'source-agreement-v1\0altered',
  );
});

test('future and unversioned module schemas require explicit migration while retaining their rows', (t) => {
  const { options, db } = fixture(t);
  db.execute("UPDATE meta SET value='2' WHERE key='banditbul_schema_version'");
  assert.throws(() => new Banditbul(options), /Unsupported/);
  assert.equal(db.query('SELECT COUNT(*) AS count FROM banditbul_state')[0].count, 1);
  db.execute("DELETE FROM meta WHERE key='banditbul_schema_version'");
  assert.throws(() => new Banditbul(options), /Unversioned/);
  assert.equal(db.query('SELECT COUNT(*) AS count FROM banditbul_state')[0].count, 1);
});

test('configuration rejects unknown keys, malformed text and unsupported scheduling or research limits', () => {
  for (const value of [
    { idle_threshold_secs: 0 },
    { study_interval_secs: 59 },
    { max_topics_per_cycle: 11 },
    { eir_threshold: 70 },
    { semantic: 'true' },
    { research: { max_results: 0 } },
    { research: { engines: ['ddg', 'ddg'] } },
    { research: { total_timeout_ms: 600001 } },
    { study_topics: [{ category: 'test', queries: ['bad\nquery'] }] },
    { study_topics: [{ category: '\ud800', queries: ['Rust'] }] },
    { study_topics: [{ category: 'test', queries: [] }] },
    {
      study_topics: Array.from({ length: 9 }, () => ({
        category: 'test',
        queries: Array(32).fill('Rust'),
      })),
    },
    {
      study_topics: Array.from({ length: 2 }, () => ({
        category: 'test',
        queries: Array(32).fill('x'.repeat(4096)),
      })),
    },
  ])
    assert.throws(() => resolveConfig(value));
  assert.equal(resolveConfig({ research: { max_results: 1 } }).research.max_crawl_pages, 5);
  assert.throws(() => new Banditbul({ dbPath: ':memory:', project: 'test', agent: 'worker' }));
});

test('unconfigured curriculum uses scoped low-frequency categories and a seven-day summary cooldown', async (t) => {
  const { engine } = fixture(t);
  for (const [category, agent, count] of [
    ['Rust', 'learner', 1],
    ['Foreign', 'other', 1],
    ['Frequent', 'learner', 3],
  ]) {
    const entry = engine.store.memory.insertExperience({
      agent,
      project: 'fixture',
      type: 'pattern',
      category,
      context: 'fixture',
      action: 'observe',
      outcome: 'observed',
    });
    engine.store.db.execute('UPDATE experiences SET frequency=? WHERE id=?', [count, entry.id]);
  }
  engine.configure({ idle_threshold_secs: 1, study_interval_secs: 60 });
  engine.resume();
  due(engine);
  const calls = researchFixture(engine);
  await engine.tick();
  assert.deepEqual(calls, ['Rust']);
  due(engine);
  await engine.tick();
  assert.deepEqual(calls, ['Rust']);
  assert.equal(engine.history().length, 2);
  assert.equal(engine.getCycle(engine.history()[0].id).jobs.length, 0);
});

test('malformed source categories and corrupt configuration fail without overwriting stored bytes', (t) => {
  const { engine, db } = fixture(t);
  const entry = engine.store.memory.insertExperience({
    agent: 'learner',
    project: 'fixture',
    type: 'pattern',
    category: 'bad\ncategory',
    context: 'fixture',
    action: 'observe',
    outcome: 'observed',
  });
  assert.throws(() => selectTopics(engine.store, engine.store.state()));
  assert.equal(
    db.query('SELECT category FROM experiences WHERE id=?', [entry.id])[0].category,
    'bad\ncategory',
  );
  db.execute("UPDATE banditbul_state SET config_json='{}'");
  assert.throws(() => engine.status(), /digest/);
  assert.equal(db.query('SELECT config_json FROM banditbul_state')[0].config_json, '{}');
});

test('host screening can reject all agreement candidates without creating a firefly summary', async (t) => {
  const { engine, db } = fixture(t, { policy: { id: 'reject-v1', screen: () => [] } });
  configured(engine);
  researchFixture(engine);
  await engine.tick();
  assert.equal(engine.getCycle(engine.history()[0].id).jobs[0].new_insights, 0);
  assert.equal(db.query('SELECT COUNT(*) AS count FROM experiences')[0].count, 0);
});
