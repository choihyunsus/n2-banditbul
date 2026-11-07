// Add module-owned tables without renaming or replacing common Soul memory fields.
import type { SqlConnection } from './store';

export function initializeSchema(db: SqlConnection): void {
  db.transaction(() => {
    const version = db.query<{ value: unknown }>(
      "SELECT value FROM meta WHERE key='banditbul_schema_version'",
    )[0]?.value;
    const existing = db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'banditbul_*'",
    );
    if (version !== undefined && version !== '1')
      throw new Error('Unsupported Banditbul schema version');
    if (existing.length && version === undefined)
      throw new Error('Unversioned Banditbul tables require migration');
    for (const table of existing) {
      const columns = db.query<{ name: string }>('SELECT name FROM pragma_table_info(?)', [
        table.name,
      ]);
      if (COLUMNS[table.name]?.join(',') !== columns.map((column) => column.name).join(','))
        throw new Error('Existing Banditbul tables have an incompatible schema');
    }
    for (const sql of STATEMENTS) db.execute(sql);
    db.execute("INSERT OR IGNORE INTO meta(key,value) VALUES('banditbul_schema_version','1')");
  });
}
const COLUMNS: Record<string, string[]> = {
  banditbul_state: [
    'project',
    'agent',
    'config_json',
    'config_hash',
    'policy_id',
    'revision',
    'cursor',
    'last_activity_at',
    'next_run_at',
    'paused',
    'last_error',
  ],
  banditbul_cycles: [
    'project',
    'agent',
    'id',
    'config_json',
    'config_hash',
    'policy_id',
    'activity_revision',
    'state',
    'created_at',
    'finished_at',
  ],
  banditbul_jobs: [
    'project',
    'agent',
    'cycle_id',
    'position',
    'request_id',
    'category',
    'query',
    'topic_key',
    'next_cursor',
    'state',
    'summary_id',
    'new_insights',
    'error',
    'finished_at',
  ],
  banditbul_leases: ['project', 'agent', 'nonce', 'process_id', 'expires_at'],
};
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS banditbul_state (
    project TEXT NOT NULL, agent TEXT NOT NULL, config_json TEXT NOT NULL,
    config_hash TEXT NOT NULL, policy_id TEXT NOT NULL, revision INTEGER NOT NULL,
    cursor INTEGER NOT NULL, last_activity_at INTEGER NOT NULL, next_run_at INTEGER NOT NULL,
    paused INTEGER NOT NULL CHECK(paused IN(0,1)), last_error TEXT, PRIMARY KEY(project,agent))`,
  `CREATE TABLE IF NOT EXISTS banditbul_cycles (
    project TEXT NOT NULL, agent TEXT NOT NULL, id TEXT NOT NULL, config_json TEXT NOT NULL,
    config_hash TEXT NOT NULL, policy_id TEXT NOT NULL, activity_revision INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN('running','completed','cancelled','failed')),
    created_at INTEGER NOT NULL, finished_at INTEGER, PRIMARY KEY(project,agent,id))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_banditbul_active
    ON banditbul_cycles(project,agent) WHERE state='running'`,
  `CREATE INDEX IF NOT EXISTS idx_banditbul_history
    ON banditbul_cycles(project,agent,created_at DESC,id)`,
  `CREATE TABLE IF NOT EXISTS banditbul_jobs (
    project TEXT NOT NULL, agent TEXT NOT NULL, cycle_id TEXT NOT NULL, position INTEGER NOT NULL,
    request_id TEXT NOT NULL, category TEXT NOT NULL, query TEXT NOT NULL, topic_key TEXT NOT NULL,
    next_cursor INTEGER, state TEXT NOT NULL CHECK(state IN('queued','running','completed','cancelled','failed')),
    summary_id TEXT, new_insights INTEGER NOT NULL DEFAULT 0, error TEXT, finished_at INTEGER,
    PRIMARY KEY(project,agent,cycle_id,position), UNIQUE(project,agent,request_id),
    FOREIGN KEY(project,agent,cycle_id) REFERENCES banditbul_cycles(project,agent,id))`,
  `CREATE INDEX IF NOT EXISTS idx_banditbul_cooldown
    ON banditbul_jobs(project,agent,topic_key,finished_at DESC) WHERE summary_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS banditbul_leases (
    project TEXT NOT NULL, agent TEXT NOT NULL, nonce TEXT NOT NULL,
    process_id INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(project,agent))`,
];
