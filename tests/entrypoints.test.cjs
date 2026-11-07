// Normal executable and MCP entry points share the same scoped state and native search worker.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { fixture, configured, researchFixture, service } = require('./helpers.cjs');
const entry = path.resolve(__dirname, '../dist/index.js');

function command(options, args, input) {
  return spawnSync(
    process.execPath,
    [
      entry,
      ...args,
      '--db',
      options.dbPath,
      '--project',
      options.project,
      '--agent',
      options.agent,
    ],
    { input, encoding: 'utf8', timeout: 15000, windowsHide: true },
  );
}

test('CLI config, pause controls, history and cycle evidence use the published entry point', async (t) => {
  const { engine, options } = fixture(t);
  let result = command(
    options,
    ['configure'],
    JSON.stringify({
      idle_threshold_secs: 1,
      study_topics: [{ category: 'programming', queries: ['Rust ownership'] }],
    }),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).paused, true);
  assert.equal(command(options, ['resume']).status, 0);
  configured(engine);
  researchFixture(engine);
  await engine.tick();
  result = command(options, ['history', '--limit', '1']);
  assert.equal(result.status, 0, result.stderr);
  const history = JSON.parse(result.stdout);
  result = command(options, ['get', '--id', history[0].id]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).jobs[0].new_insights, 1);
  assert.equal(command(options, ['touch']).status, 0);
  assert.equal(command(options, ['pause']).status, 0);
  assert.equal(engine.status().paused, true);
});

test('CLI rejects duplicate, incompatible and malformed input before starting a study', (t) => {
  const { options } = fixture(t);
  for (const args of [
    ['status', '--id', 'invalid'],
    ['status', '--input', '{}'],
    ['status', '--unknown'],
    ['history', '--limit', '0'],
    ['status', '--project', 'duplicate'],
    ['get'],
  ]) {
    const result = command(options, args);
    assert.equal(result.status, 1, result.stdout);
    assert.ok(JSON.parse(result.stderr).error);
  }
  assert.equal(command(options, ['configure'], Buffer.from([0xff])).status, 1);
  assert.equal(command(options, ['configure'], 'x'.repeat(131073)).status, 1);
  const version = spawnSync(process.execPath, [entry, '--version'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), '1.0.0');
});

test('actual background timer waits for inactivity and starts the configured native search', async (t) => {
  let arrived;
  const request = new Promise((resolve) => {
    arrived = resolve;
  });
  const searxngUrl = await service(t, (_, response) => {
    response.setHeader('content-type', 'application/json');
    response.end('{"results":[]}');
    arrived(Date.now());
  });
  const { engine } = fixture(t, { kraken: { searxngUrl } });
  engine.configure({
    idle_threshold_secs: 1,
    study_interval_secs: 60,
    study_topics: [{ category: 'test', queries: ['Idle timer fixture'] }],
    research: { engines: ['searxng'] },
  });
  engine.resume();
  const started = Date.now();
  engine.start();
  const arrivedAt = await Promise.race([
    request,
    delay(10000, undefined, { ref: false }).then(() => {
      throw new Error('Idle loop did not start');
    }),
  ]);
  assert.ok(arrivedAt - started >= 900);
  for (let i = 0; i < 100 && engine.history()[0]?.state !== 'completed'; i++) await delay(20);
  assert.equal(engine.history()[0].state, 'completed');
  await engine.close();
});

test('actual stdio MCP configures and starts learning, then reports history through nine bounded tools', async (t) => {
  let requests = 0;
  const searxngUrl = await service(t, (_, response) => {
    requests++;
    response.setHeader('content-type', 'application/json');
    response.end('{"results":[]}');
  });
  const { options } = fixture(t);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      entry,
      'mcp',
      '--db',
      options.dbPath,
      '--project',
      options.project,
      '--agent',
      options.agent,
      '--searxng',
      searxngUrl,
    ],
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr.on('data', (data) => {
    stderr += data;
  });
  const client = new Client({ name: 'banditbul-fixture', version: '1.0.0' });
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const text = result.content[0].text;
    assert.ok(Buffer.byteLength(text) <= 60000);
    return JSON.parse(text);
  };
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 9);
    await call('banditbul_configure', {
      config: {
        idle_threshold_secs: 1,
        study_interval_secs: 60,
        study_topics: [{ category: 'test', queries: ['MCP learning fixture'] }],
        research: { engines: ['searxng'] },
      },
    });
    assert.equal((await call('banditbul_topics')).topics[0].query, 'MCP learning fixture');
    await call('banditbul_start');
    let history = [];
    for (let i = 0; i < 100; i++) {
      history = await call('banditbul_history');
      if (history[0]?.state === 'completed') break;
      await delay(50);
    }
    assert.equal(history[0]?.state, 'completed');
    assert.equal(requests, 1);
    assert.equal(
      (await call('banditbul_read', { cycleId: history[0].id })).jobs[0].new_insights,
      0,
    );
    await call('banditbul_touch');
    await call('banditbul_pause');
    assert.equal((await call('banditbul_tick')).state, 'paused');
    assert.equal((await call('banditbul_status')).paused, true);
    assert.equal(stderr, '');
  } finally {
    await client.close();
  }
});
