// Exercise durable idle scheduling, ordinary native transport and activity cancellation.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, configured, due, researchFixture, service, Banditbul } = require('./helpers.cjs');

test('construction is paused and idle checks precede every research request', async (t) => {
  const { engine } = fixture(t),
    calls = researchFixture(engine);
  assert.equal(engine.status().state, 'paused');
  engine.configure({ study_topics: [{ category: 'programming', queries: ['Rust ownership'] }] });
  await engine.tick();
  assert.equal(calls.length, 0);
  engine.resume();
  await engine.tick();
  assert.equal(calls.length, 0);
  due(engine);
  await engine.tick();
  assert.equal(calls.length, 1);
  assert.equal(engine.status().state, 'dormant');
  assert.equal(engine.history().length, 1);
  await engine.tick();
  assert.equal(calls.length, 1);
});

test('round-robin cursor and cooldown survive restart with duplicate-only summaries suppressed', async (t) => {
  const { engine, options, db } = fixture(t);
  configured(engine, ['Rust ownership', 'Rust concurrency']);
  const firstCalls = researchFixture(engine);
  await engine.tick();
  assert.deepEqual(firstCalls, ['Rust ownership']);
  assert.equal(engine.status().cursor, 1);
  const first = engine.getCycle(engine.history()[0].id).jobs[0];
  assert.equal(first.new_insights, 1);
  assert.ok(first.summary_id);
  const summary = JSON.parse(
    db.query('SELECT context FROM experiences WHERE id=?', [first.summary_id])[0].context,
  );
  assert.equal(summary.verified, false);
  assert.equal(summary.sources.length, 3);
  assert.ok(summary.claims[0].includes('memory safety'));
  await engine.close();
  const reopened = new Banditbul(options);
  try {
    assert.equal(reopened.status().cursor, 1);
    const secondCalls = researchFixture(reopened);
    await reopened.tick();
    assert.equal(secondCalls.length, 0);
    due(reopened);
    await reopened.tick();
    assert.deepEqual(secondCalls, ['Rust concurrency']);
    const second = reopened.getCycle(reopened.history()[0].id).jobs[0];
    assert.equal(second.new_insights, 0);
    assert.equal(second.summary_id, null);
    assert.equal(reopened.status().cursor, 0);
    assert.equal(
      reopened.store.db.query(
        "SELECT COUNT(*) AS count FROM experiences WHERE outcome='firefly'",
      )[0].count,
      1,
    );
  } finally {
    await reopened.close();
  }
});

test('normal native SearXNG research records empty learning without inventing a summary', async (t) => {
  let requests = 0;
  const searxngUrl = await service(t, (_, response) => {
    requests++;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ results: [] }));
  });
  const { engine, db } = fixture(t, { kraken: { searxngUrl } });
  configured(engine, ['Rust ownership'], { research: { engines: ['searxng'], max_results: 1 } });
  await engine.tick();
  assert.equal(requests, 1);
  const cycle = engine.getCycle(engine.history()[0].id);
  assert.equal(cycle.state, 'completed');
  assert.equal(cycle.jobs[0].new_insights, 0);
  assert.equal(cycle.jobs[0].summary_id, null);
  assert.equal(db.query('SELECT COUNT(*) AS count FROM kraken_learning')[0].count, 1);
  assert.equal(db.query('SELECT COUNT(*) AS count FROM insights')[0].count, 0);
});

test('activity cancels the real native request and retains an inspectable cancelled cycle', async (t) => {
  let arrived;
  const request = new Promise((resolve) => {
    arrived = resolve;
  });
  const searxngUrl = await service(t, () => arrived());
  const { engine, db } = fixture(t, { kraken: { searxngUrl } });
  configured(engine, ['Rust ownership'], { research: { engines: ['searxng'] } });
  const running = engine.tick();
  await request;
  assert.equal(engine.status().state, 'studying');
  engine.touch();
  await running;
  const cycle = engine.getCycle(engine.history()[0].id);
  assert.equal(cycle.state, 'cancelled');
  assert.equal(cycle.jobs[0].state, 'cancelled');
  assert.equal(engine.status().state, 'dormant');
  assert.equal(db.query('SELECT COUNT(*) AS count FROM insights')[0].count, 0);
  assert.equal(db.query('SELECT COUNT(*) AS count FROM banditbul_leases')[0].count, 0);
});

test('another instance can pause a running study while the lease excludes duplicate workers', async (t) => {
  let arrived;
  const request = new Promise((resolve) => {
    arrived = resolve;
  });
  let requests = 0;
  const searxngUrl = await service(t, () => {
    requests++;
    arrived();
  });
  const { engine, options } = fixture(t, { kraken: { searxngUrl } });
  configured(engine, ['Rust ownership'], { research: { engines: ['searxng'] } });
  const other = new Banditbul(options);
  try {
    const running = engine.tick();
    await request;
    assert.equal((await other.tick()).state, 'studying');
    assert.equal(requests, 1);
    other.pause();
    await running;
    assert.equal(engine.status().state, 'paused');
    assert.equal(engine.getCycle(engine.history()[0].id).state, 'cancelled');
  } finally {
    await other.close();
  }
});

test('closing cancels a real outstanding request before closing its database connections', async (t) => {
  let arrived;
  const request = new Promise((resolve) => {
    arrived = resolve;
  });
  const searxngUrl = await service(t, () => arrived());
  const { engine, options } = fixture(t, { kraken: { searxngUrl } });
  configured(engine, ['Rust ownership'], { research: { engines: ['searxng'] } });
  const running = engine.tick();
  await request;
  await engine.close();
  await running;
  assert.throws(() => engine.status(), /closed/);
  const reopened = new Banditbul(options);
  try {
    assert.equal(reopened.getCycle(reopened.history()[0].id).state, 'cancelled');
  } finally {
    await reopened.close();
  }
});

test('a failed topic does not skip later curriculum entries and reports partial failure', async (t) => {
  const { engine } = fixture(t);
  configured(engine, ['failed topic', 'Rust ownership'], { max_topics_per_cycle: 2 });
  const calls = researchFixture(engine),
    original = engine.kraken.research;
  engine.kraken.research = async (request) => {
    if (request.topic === 'failed topic') {
      calls.push(request.topic);
      throw new Error('fixture service error');
    }
    return original(request);
  };
  await engine.tick();
  assert.deepEqual(calls, ['failed topic', 'Rust ownership']);
  const cycle = engine.getCycle(engine.history()[0].id);
  assert.equal(cycle.state, 'failed');
  assert.deepEqual(
    cycle.jobs.map((job) => job.state),
    ['failed', 'completed'],
  );
  assert.equal(engine.status().state, 'error');
  assert.equal(cycle.jobs[0].error, 'research_failed');
  assert.equal(cycle.jobs[1].new_insights, 1);
});
