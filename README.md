# N2 Banditbul

[한국어](README.ko.md)

Idle-time research and durable learning for a local agent. Banditbul selects a curriculum topic or a low-frequency memory category, asks Kraken to retrieve and compare sources, and records new source-backed knowledge in the shared Soul/Mimir database.

Learning produces experiences, unverified insights and inspectable source receipts. Soul/Mimir retrieval makes those records available to an agent's later work.

## Install

Requires Node.js 22 or newer and a writable SQLite database file.

```sh
npm install https://github.com/choihyunsus/n2-banditbul/releases/download/v1.0.0/n2-banditbul-1.0.0.tgz
```

This release uses GitHub-hosted Kraken 1.0.0 and Mimir 3.0.3 artifacts. Kraken includes workers for Windows x64, Linux x64 and macOS arm64. Its Linux worker requires glibc 2.39 or newer and the system C++ runtime. Other environments can build Kraken's included native source. Chrome is used when a page requires browser rendering. Semantic comparison uses an explicitly configured Ollama embedding model.

## Lifecycle

The engine checks host-reported inactivity and the study interval, selects up to ten topics, and processes them sequentially. A research job has a durable request ID. Source retrieval, comparison and learning run through Kraken's public library. Only newly created insight references earn a firefly summary. Duplicate-only, empty or rejected studies retain their receipts.

New project/agent scopes begin paused. `resume()` enables studies and resets the idle timer. `start()` starts the background loop using the persisted pause state. `tick()` processes one due cycle or reconciles pending receipts. `touch()` forwards activity and cancels the active request. `pause()` also persists the paused state. `close()` waits for owned requests and closes the two database connections.

The host should forward keyboard, mouse, dialogue or other relevant activity. The scheduler polls shared state once per second while running. A second process can pause or signal activity through the same database scope. Shutdown and activity preserve knowledge committed before cancellation.

```js
const { Banditbul } = require('n2-banditbul');

const learner = new Banditbul({
  dbPath: './data/mimir.db',
  project: 'my-project',
  agent: 'researcher',
});

// Configure once, or when intentionally replacing the curriculum.
learner.configure({
  study_topics: [{
    category: 'programming',
    queries: ['Rust ownership patterns', 'TypeScript error handling'],
  }],
});
learner.resume();
learner.start();

// The embedding application forwards each relevant activity event.
// learner.touch();

// During application shutdown, await the owned worker cleanup.
// await learner.close();
```

On subsequent starts, reuse the same file, project and agent. The curriculum cursor, interval, pause state and history are stored in SQLite. Calling `configure()` replaces the configuration, resets the cursor and idle timer, and records the current host policy ID. Start the loop with the existing configuration when resuming ordinary operation.

## Configuration

The library and CLI accept the same configuration fields. Invalid or unknown fields produce an error.

| Field | Default | Supported range |
| --- | --- | --- |
| `idle_threshold_secs` | 120 | 1–86,400 |
| `study_interval_secs` | 1,800 | 60–604,800 |
| `max_topics_per_cycle` | 3 | 1–10 |
| `study_topics` | Empty | Up to 64 groups and 256 total queries |
| `semantic` | `false` | Boolean |
| `research` | Kraken defaults | Validated search, crawl and timeout settings |

Each topic group contains `category`, optional `description`, and 1–32 `queries`. Categories accept 512 UTF-8 bytes, descriptions 1,024 bytes and queries 4,096 bytes. The complete resolved configuration is bounded to 128 KiB. Project and agent IDs accept up to 128 UTF-8 bytes and exclude whitespace and control characters.

Configured queries run round-robin. The cursor advances when a job starts, so cancellation preserves unstarted curriculum positions. Without configured topics, Banditbul inspects the most recent 2,000 experiences in its project and agent scope. It considers up to 256 low-frequency categories, skips research-source and firefly records, and applies a seven-day cooldown to categories that produced a summary.

The `research` object accepts `max_results`, `max_crawl_pages`, `min_confidence`, `max_content_length`, `timeout_ms`, `total_timeout_ms`, `time_range` and `engines`. Defaults match Kraken. Search results are bounded to 1–40, crawled pages to 1–20, and one research request to at most 600 seconds. Topics have a five-second pause between them. A failed topic is recorded and the remaining bounded curriculum continues. The next cycle waits for the configured interval.

Trusted service addresses belong to constructor options.

```js
const learner = new Banditbul({
  dbPath: './data/mimir.db',
  project: 'my-project',
  agent: 'researcher',
  kraken: {
    searxngUrl: 'http://127.0.0.1:8080',
    ollama: { endpoint: 'http://127.0.0.1:11434', model: 'nomic-embed-text' },
    // workerPath and chromePath optionally select installed executables.
  },
});
```

## Host screening

A versioned `LearningPolicy` can narrow Kraken's eligible source-agreement candidates. Supply it when constructing the engine and configure the curriculum with that host instance. Changed screening behavior requires a new policy ID and intentional configuration update.

```js
const learner = new Banditbul({
  dbPath: './data/mimir.db', project: 'my-project', agent: 'researcher',
  policy: {
    id: 'complete-sources-v1',
    screen({ facts, pages }, signal) {
      signal.throwIfAborted();
      return facts.filter(({ fact }) =>
        fact.sources.every(url => pages.some(page => page.url === url && !page.truncated))
      ).map(({ index }) => index);
    },
  },
});
```

Screening has Kraken's 30-second asynchronous deadline. Synchronous callbacks must return promptly. Restarted pending research requires its configured callback. Committed learning receipts can be recovered using the saved policy ID even when that callback or the original worker is unavailable. Existing curriculum files can retain the scheduling and topic fields above. Move application-specific screening settings into the host policy.

## Recovery and shared storage

Use the same SQLite file as the standalone Soul and Mimir packages. Banditbul uses explicit `project` and `agent` ownership and records the cycle ID in a summary experience's `session_id`. Its module tables are `banditbul_state`, `banditbul_cycles`, `banditbul_jobs` and `banditbul_leases`, with `meta.banditbul_schema_version = 1`.

A 30-second nonce lease fences scheduler writes and is renewed every ten seconds. Another worker can recover an exited or expired owner. Completed Kraken research is reused. After a lost learning response, the durable `created` flags identify newly created insight references. Unknown legacy creation flags remain unknown. A firefly summary and its job receipt commit in one Mimir transaction, so a storage failure can be retried without duplicating the summary. Changing the curriculum first reconciles old committed learning and then cancels unfinished old jobs.

Summaries are historical records with an explicit unverified flag, the learning time, report hash, policy ID, insight references and bounded claim/source previews. Preview omissions are counted. Inspect the underlying Kraken report and current Mimir evidence when deciding whether to reuse a claim. Source agreement and matching scores require independent factual verification.

`status()`, `history(limit, offset)` and `getCycle(id)` expose pause state, next eligible time, durable errors, per-topic outcomes, request IDs and summary IDs. A failed cycle reports an error state. Pending storage/recovery failures retain their jobs and receive the configured retry delay. History and source records remain available for operator-managed archival. The library initializes the module tables and scope when opening a database.

## CLI and MCP

```sh
n2-banditbul configure --db ./data/mimir.db --project demo --agent researcher < curriculum.json
n2-banditbul run --db ./data/mimir.db --project demo --agent researcher
n2-banditbul touch --db ./data/mimir.db --project demo --agent researcher
n2-banditbul status --db ./data/mimir.db --project demo --agent researcher
n2-banditbul history --db ./data/mimir.db --project demo --agent researcher --limit 20
n2-banditbul get --db ./data/mimir.db --project demo --agent researcher --id <cycle-id>
n2-banditbul mcp --db ./data/mimir.db --project demo --agent researcher
```

The CLI also provides `resume`, `pause` and `tick`. `configure` accepts stdin JSON or `--input`. `run` resumes the scope and schedules until interrupted. It prints JSON status at startup and shutdown. Host executable and service flags are `--worker`, `--chrome`, `--searxng`, `--ollama-endpoint` and `--ollama-model`. Custom screening callbacks are supplied through the library. Exit codes are 0 for successful commands, 1 for input or execution errors, and 2 when a `tick` completes with an error status.

The stdio server exposes nine tools, `banditbul_status`, `banditbul_configure`, `banditbul_start`, `banditbul_pause`, `banditbul_touch`, `banditbul_tick`, `banditbul_history`, `banditbul_read` and `banditbul_topics`. Starting the MCP server opens the scope in its persisted state. `banditbul_start` explicitly resumes the background loop. Tool output is bounded to 60,000 bytes and query previews indicate truncation.

## Development and licensing

```sh
npm ci
npm test
npm run typecheck
npm audit --omit=dev
npm pack --dry-run
```

Tests exercise actual native SearXNG transport, timer-driven start, activity and shutdown cancellation, SQLite rollback, an exited process after a learning commit, custom-policy recovery, scope isolation, malformed stored data, CLI and stdio MCP. Deterministic positive-claim fixtures use the actual Kraken learning and Mimir storage paths.

Banditbul source uses MIT. Kraken and Mimir retain their dependency licenses. Mimir's published non-commercial/commercial terms are included in `LICENSE-N2-MIMIR`, with additional attribution in `THIRD-PARTY-NOTICES`.
