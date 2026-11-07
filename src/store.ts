// All scheduler mutations share one scoped Mimir connection and synchronous transactions.
import fs from 'node:fs';
import path from 'node:path';
import { MimirDatabase } from 'n2-mimir/storage';
import { z } from 'zod';
import { digest, encode, identity, utf8 } from './values';
import { resolveConfig } from './config';
import { initializeSchema } from './schema';
import { stateRow, cycleRow, jobRow } from './types';
import type { StoredState, StoredCycle, JobRow } from './types';

export type SqlConnection = MimirDatabase['reasoning']['connection'];
export interface StoreOptions {
  dbPath: string;
  project: string;
  agent: string;
}
export class BanditbulStore {
  readonly memory: MimirDatabase;
  readonly db: SqlConnection;
  readonly scope: [string, string];
  readonly dbPath: string;
  constructor(options: StoreOptions) {
    this.scope = [identity.parse(options.project), identity.parse(options.agent)];
    const filename = utf8(8192)
      .min(1)
      .refine((value) => !value.includes('\0') && value !== ':memory:')
      .parse(options.dbPath);
    this.dbPath = path.resolve(filename);
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.memory = new MimirDatabase(this.dbPath);
    this.db = this.memory.reasoning.connection;
    try {
      initializeSchema(this.db);
      this.initializeState();
    } catch (error) {
      this.memory.close();
      throw error;
    }
  }
  private initializeState(): void {
    const json = encode(resolveConfig({}));
    this.db.execute(`INSERT OR IGNORE INTO banditbul_state VALUES(?,?,?,?,?,0,0,?,0,1,NULL)`, [
      ...this.scope,
      json,
      digest(json),
      'source-agreement-v1',
      Date.now(),
    ]);
  }
  state(): StoredState {
    const row = stateRow.parse(
      this.db.query<Record<string, unknown>>(
        `SELECT CASE WHEN length(CAST(config_json AS BLOB))<=131072 THEN config_json ELSE NULL END AS config_json,
          CASE WHEN length(CAST(config_hash AS BLOB))<=64 THEN config_hash ELSE NULL END AS config_hash,
          CASE WHEN length(CAST(policy_id AS BLOB))<=128 THEN policy_id ELSE NULL END AS policy_id,
          revision,cursor,last_activity_at,next_run_at,paused,
          CASE WHEN length(CAST(last_error AS BLOB))>512 THEN 0 ELSE last_error END AS last_error
          FROM banditbul_state WHERE project=? AND agent=?`,
        this.scope,
      )[0],
    );
    if (digest(row.config_json) !== row.config_hash)
      throw new Error('Stored configuration digest differs');
    return { ...row, config: resolveConfig(JSON.parse(row.config_json)) };
  }
  cycle(id: string): StoredCycle | undefined {
    const raw = this.db.query<Record<string, unknown>>(
      `SELECT id,CASE WHEN length(CAST(config_json AS BLOB))<=131072 THEN config_json ELSE NULL END AS config_json,
        CASE WHEN length(CAST(config_hash AS BLOB))<=64 THEN config_hash ELSE NULL END AS config_hash,
        CASE WHEN length(CAST(policy_id AS BLOB))<=128 THEN policy_id ELSE NULL END AS policy_id,
        activity_revision,CASE WHEN length(CAST(state AS BLOB))<=16 THEN state ELSE NULL END AS state,created_at,finished_at
        FROM banditbul_cycles WHERE project=? AND agent=? AND id=?`,
      [...this.scope, identity.parse(id)],
    )[0];
    if (!raw) return undefined;
    const row = cycleRow.parse(raw);
    if (digest(row.config_json) !== row.config_hash) throw new Error('Stored cycle digest differs');
    return { ...row, config: resolveConfig(JSON.parse(row.config_json)) };
  }
  active(): StoredCycle | undefined {
    const row = this.db.query<{ id: string }>(
      `SELECT CASE WHEN length(CAST(id AS BLOB))<=128 THEN id ELSE NULL END AS id
        FROM banditbul_cycles WHERE project=? AND agent=? AND state='running'`,
      this.scope,
    )[0];
    return row && this.cycle(row.id);
  }
  jobs(id: string): JobRow[] {
    const rows = this.db.query<Record<string, unknown>>(
      `SELECT cycle_id,position,
        CASE WHEN length(CAST(request_id AS BLOB))<=128 THEN request_id ELSE NULL END AS request_id,
        CASE WHEN length(CAST(category AS BLOB))<=512 THEN category ELSE NULL END AS category,
        CASE WHEN length(CAST(query AS BLOB))<=4096 THEN query ELSE NULL END AS query,
        CASE WHEN length(CAST(topic_key AS BLOB))<=64 THEN topic_key ELSE NULL END AS topic_key,next_cursor,
        CASE WHEN length(CAST(state AS BLOB))<=16 THEN state ELSE NULL END AS state,
        CASE WHEN length(CAST(summary_id AS BLOB))>36 THEN 0 ELSE summary_id END AS summary_id,new_insights,
        CASE WHEN length(CAST(error AS BLOB))>512 THEN 0 ELSE error END AS error,finished_at FROM banditbul_jobs
        WHERE project=? AND agent=? AND cycle_id=? ORDER BY position LIMIT 11`,
      [...this.scope, identity.parse(id)],
    );
    return z.array(jobRow).max(10).parse(rows);
  }
  history(limit = 20, offset = 0) {
    z.int().min(1).max(100).parse(limit);
    z.int().min(0).max(100000).parse(offset);
    const rows = this.db.query<Record<string, unknown>>(
      `SELECT CASE WHEN length(CAST(id AS BLOB))<=128 THEN id ELSE NULL END AS id,
      CASE WHEN length(CAST(state AS BLOB))<=16 THEN state ELSE NULL END AS state,created_at,finished_at
      FROM banditbul_cycles WHERE project=? AND agent=?
      ORDER BY created_at DESC,id LIMIT ? OFFSET ?`,
      [...this.scope, limit, offset],
    );
    return z
      .array(cycleRow.pick({ id: true, state: true, created_at: true, finished_at: true }))
      .max(100)
      .parse(rows);
  }
  close(): void {
    this.memory.close();
  }
}
