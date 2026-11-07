// Each case owns a temporary database; source fixtures exercise real Kraken and Mimir publication.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { Banditbul } = require('../dist/library');
const { storeResearch } = require('n2-kraken/dist/research-store');
const sha = (value) => createHash('sha256').update(value).digest('hex');

function fixture(t, extra = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'banditbul-test-'));
  const options = {
    dbPath: path.join(directory, 'mimir.db'),
    project: 'fixture',
    agent: 'learner',
    ...extra,
  };
  const engine = new Banditbul(options);
  t.after(async () => {
    await engine.close();
    const resolved = fs.realpathSync.native(directory),
      root = fs.realpathSync.native(os.tmpdir());
    if (path.dirname(resolved) !== root || !path.basename(resolved).startsWith('banditbul-test-'))
      throw new Error('Fixture ownership changed');
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { engine, options, directory, db: engine.store.db };
}
function configured(engine, queries = ['Rust ownership'], extra = {}) {
  engine.configure({
    idle_threshold_secs: 1,
    study_interval_secs: 60,
    max_topics_per_cycle: 1,
    study_topics: [{ category: 'programming', queries }],
    ...extra,
  });
  engine.resume();
  due(engine);
}
function due(engine) {
  engine.store.db.execute(
    'UPDATE banditbul_state SET last_activity_at=?,next_run_at=0 WHERE project=? AND agent=?',
    [Date.now() - 86400001, ...engine.store.scope],
  );
}
function seedResearch(engine, request) {
  const content = 'Rust is a programming language with memory safety and reliable concurrency.';
  const pages = ['one', 'two', 'three'].map((name) => ({
    url: `https://${name}.example/article`,
    title: 'Fixture source',
    content,
    content_length: Buffer.byteLength(content),
    content_hash: sha(content),
    fetched_at: '1700000000',
    truncated: false,
  }));
  return storeResearch(
    engine.kraken.store,
    request.requestId,
    sha(request.topic),
    sha('fixture-worker'),
    {
      summary: {
        topic: request.topic,
        semantic_mode: false,
        search_results: 3,
        pages_crawled: 3,
        claims_extracted: 3,
        facts_verified: 1,
        facts_pending: 0,
        facts_rejected: 0,
      },
      pages,
      failures: [],
      facts: [
        {
          claim: content,
          confidence: 1,
          sources: pages.map((page) => page.url),
          status: 'Verified',
          contradiction: null,
        },
      ],
    },
  );
}
function researchFixture(engine, calls = []) {
  engine.kraken.research = async (request) => {
    calls.push(request.topic);
    return seedResearch(engine, request);
  };
  return calls;
}
async function service(t, handler) {
  const server = http.createServer(handler).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}
module.exports = { fixture, configured, due, seedResearch, researchFixture, service, Banditbul };
