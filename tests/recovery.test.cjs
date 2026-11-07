// Verify recovery across the Kraken commit boundary and fenced, atomic scheduler bookkeeping.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, configured, due, researchFixture, Banditbul } = require('./helpers.cjs');
const { StudyLease } = require('../dist/lease');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('an exited process leaves committed learning recoverable without its worker or a duplicate summary', async (t) => {
  const { engine, options, db } = fixture(t);
  configured(engine);
  const child = spawnSync(
    process.execPath,
    [path.join(__dirname, 'fixtures/crash.cjs'), options.dbPath],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 },
  );
  assert.equal(child.status, 37, child.stderr);
  assert.equal(db.query('SELECT COUNT(*) AS count FROM insights')[0].count, 1);
  assert.equal(
    db.query("SELECT COUNT(*) AS count FROM experiences WHERE outcome='firefly'")[0].count,
    0,
  );
  const id = engine.history()[0].id;
  assert.equal(engine.status().state, 'dormant');
  await engine.close();
  const reopened = new Banditbul({ ...options, kraken: { workerPath: 'missing-worker' } });
  try {
    await reopened.tick();
    assert.equal(reopened.getCycle(id).state, 'completed');
    assert.equal(reopened.getCycle(id).jobs[0].new_insights, 1);
    assert.equal(
      reopened.store.db.query(
        "SELECT COUNT(*) AS count FROM experiences WHERE outcome='firefly'",
      )[0].count,
      1,
    );
    assert.equal(
      reopened.store.db.query('SELECT COUNT(*) AS count FROM banditbul_leases')[0].count,
      0,
    );
  } finally {
    await reopened.close();
  }
});

test('late job receipt failure rolls back its summary and restart recovers committed custom-policy learning', async (t) => {
  let screenings = 0;
  const policy = {
    id: 'operator-v1',
    screen: ({ facts }) => {
      screenings++;
      return facts.map((fact) => fact.index);
    },
  };
  const { engine, db, options } = fixture(t, { policy });
  configured(engine);
  researchFixture(engine);
  db.execute(`CREATE TRIGGER fail_receipt BEFORE UPDATE ON banditbul_jobs WHEN NEW.state='completed'
    BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END`);
  await assert.rejects(engine.tick(), /receipt failure/);
  assert.equal(screenings, 1);
  assert.equal(db.query('SELECT COUNT(*) AS count FROM insights')[0].count, 1);
  assert.equal(
    db.query("SELECT COUNT(*) AS count FROM experiences WHERE outcome='firefly'")[0].count,
    0,
  );
  const cycleId = engine.history()[0].id;
  assert.equal(engine.getCycle(cycleId).jobs[0].state, 'running');
  db.execute('DROP TRIGGER fail_receipt');
  await engine.close();
  const reopened = new Banditbul({
    ...options,
    policy: undefined,
    kraken: { workerPath: 'missing-worker' },
  });
  try {
    due(reopened);
    await reopened.tick();
    const cycle = reopened.getCycle(cycleId);
    assert.equal(cycle.state, 'completed');
    assert.equal(cycle.jobs[0].new_insights, 1);
    assert.ok(cycle.jobs[0].summary_id);
    assert.equal(screenings, 1);
    const count = () =>
      reopened.store.db.query(
        "SELECT COUNT(*) AS count FROM experiences WHERE outcome='firefly'",
      )[0].count;
    assert.equal(count(), 1);
    await reopened.tick();
    assert.equal(count(), 1);
  } finally {
    await reopened.close();
  }
});

test('a new configuration reconciles old committed learning before cancelling its remaining jobs', async (t) => {
  const policy = { id: 'old-policy-v1', screen: ({ facts }) => facts.map((fact) => fact.index) };
  const { engine, db, options } = fixture(t, { policy });
  configured(engine, ['Rust ownership', 'unstarted topic'], { max_topics_per_cycle: 2 });
  researchFixture(engine);
  db.execute(`CREATE TRIGGER fail_summary BEFORE INSERT ON experiences WHEN NEW.outcome='firefly'
    BEGIN SELECT RAISE(ABORT,'fixture summary failure'); END`);
  await assert.rejects(engine.tick(), /summary failure/);
  const cycleId = engine.history()[0].id;
  db.execute('DROP TRIGGER fail_summary');
  await engine.close();
  const reopened = new Banditbul({
    ...options,
    policy: undefined,
    kraken: { workerPath: 'missing-worker' },
  });
  try {
    reopened.configure({
      study_topics: [{ category: 'new curriculum', queries: ['Different topic'] }],
    });
    await reopened.tick();
    const cycle = reopened.getCycle(cycleId);
    assert.equal(cycle.state, 'cancelled');
    assert.equal(cycle.jobs[0].state, 'completed');
    assert.equal(cycle.jobs[0].new_insights, 1);
    assert.equal(cycle.jobs[1].state, 'cancelled');
    assert.equal(reopened.status().cursor, 0);
    assert.equal(reopened.status().config.study_topics[0].category, 'new curriculum');
  } finally {
    await reopened.close();
  }
});

test('activity after a knowledge commit preserves its summary and does not advance unstarted topics', async (t) => {
  const { engine } = fixture(t);
  configured(engine, ['Rust ownership', 'Rust concurrency'], { max_topics_per_cycle: 2 });
  researchFixture(engine);
  const learn = engine.kraken.learn.bind(engine.kraken);
  engine.kraken.learn = async (...args) => {
    const receipt = await learn(...args);
    engine.touch();
    return receipt;
  };
  await engine.tick();
  const cycle = engine.getCycle(engine.history()[0].id);
  assert.equal(cycle.state, 'cancelled');
  assert.equal(cycle.jobs[0].state, 'completed');
  assert.equal(cycle.jobs[1].state, 'cancelled');
  assert.equal(engine.status().cursor, 1);
  assert.ok(cycle.jobs[0].summary_id);
});

test('lease fencing rejects stale publication and preserves a replacement owners lease', (t) => {
  const { engine, db } = fixture(t);
  const lease = new StudyLease(engine.store, engine.store.state().revision);
  db.execute(
    "UPDATE banditbul_leases SET nonce='replacement' WHERE project=? AND agent=?",
    engine.store.scope,
  );
  assert.throws(() => lease.mutate(() => db.execute('DELETE FROM banditbul_state')), /lost/);
  lease.release();
  assert.equal(db.query('SELECT COUNT(*) AS count FROM banditbul_state')[0].count, 1);
  assert.equal(db.query('SELECT nonce FROM banditbul_leases')[0].nonce, 'replacement');
});

test('project and agent scopes isolate state, history, summaries and curriculum selection', async (t) => {
  const { engine, options } = fixture(t);
  configured(engine);
  researchFixture(engine);
  await engine.tick();
  const other = new Banditbul({ ...options, agent: 'other' });
  try {
    assert.equal(other.status().state, 'paused');
    assert.equal(other.history().length, 0);
    assert.equal(other.getCycle(engine.history()[0].id), undefined);
    other.pause();
    assert.equal(engine.status().paused, false);
  } finally {
    await other.close();
  }
});
