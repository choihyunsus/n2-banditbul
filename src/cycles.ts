// Persist a complete cycle before any external research and advance curriculum only when a job starts.
import { randomUUID } from 'node:crypto';
import type { BanditbulStore } from './store';
import type { StudyLease } from './lease';
import type { StoredState, StoredCycle, JobRow } from './types';
import { selectTopics } from './curriculum';

export function beginCycle(
  store: BanditbulStore,
  lease: StudyLease,
  state: StoredState,
): StoredCycle {
  return lease.mutate(() => {
    lease.assertWorking();
    const active = store.active();
    if (active) return active;
    const topics = selectTopics(store, state),
      id = randomUUID();
    store.db.execute('INSERT INTO banditbul_cycles VALUES(?,?,?,?,?,?,?,?,?,NULL)', [
      ...store.scope,
      id,
      state.config_json,
      state.config_hash,
      state.policy_id,
      state.revision,
      'running',
      Date.now(),
    ]);
    topics.forEach((topic, position) => {
      store.db.execute(
        "INSERT INTO banditbul_jobs VALUES(?,?,?,?,?,?,?,?,?,'queued',NULL,0,NULL,NULL)",
        [
          ...store.scope,
          id,
          position,
          `banditbul-${id}-${position}`,
          topic.category,
          topic.query,
          topic.topicKey,
          topic.nextCursor,
        ],
      );
    });
    store.db.execute(
      'UPDATE banditbul_state SET next_run_at=?,last_error=NULL WHERE project=? AND agent=?',
      [Date.now() + state.config.study_interval_secs * 1000, ...store.scope],
    );
    return store.cycle(id)!;
  });
}
export function startJob(store: BanditbulStore, lease: StudyLease, job: JobRow): void {
  lease.mutate(() => {
    lease.assertWorking();
    const changed = store.db.execute(
      `UPDATE banditbul_jobs SET state='running'
      WHERE project=? AND agent=? AND cycle_id=? AND position=? AND state='queued'`,
      [...store.scope, job.cycle_id, job.position],
    );
    if (changed && job.next_cursor !== null)
      store.db.execute('UPDATE banditbul_state SET cursor=? WHERE project=? AND agent=?', [
        job.next_cursor,
        ...store.scope,
      ]);
  });
}
export function failJob(
  store: BanditbulStore,
  lease: StudyLease,
  job: JobRow,
  error: string,
): void {
  lease.mutate(() =>
    store.db.execute(
      `UPDATE banditbul_jobs SET state='failed',error=?,finished_at=?
    WHERE project=? AND agent=? AND cycle_id=? AND position=? AND state IN('queued','running')`,
      [error, Date.now(), ...store.scope, job.cycle_id, job.position],
    ),
  );
}
export function finishCycle(
  store: BanditbulStore,
  lease: StudyLease,
  cycle: StoredCycle,
  cancelled: boolean,
): void {
  lease.mutate(() => {
    if (cancelled)
      store.db.execute(
        `UPDATE banditbul_jobs SET state='cancelled',finished_at=?
      WHERE project=? AND agent=? AND cycle_id=? AND state IN('queued','running')`,
        [Date.now(), ...store.scope, cycle.id],
      );
    const jobs = store.jobs(cycle.id);
    if (jobs.some((job) => job.state === 'queued' || job.state === 'running'))
      throw new Error('Cannot finish a cycle with pending jobs');
    const failed = jobs.some((job) => job.state === 'failed');
    const state = cancelled ? 'cancelled' : failed ? 'failed' : 'completed';
    store.db.execute(
      'UPDATE banditbul_cycles SET state=?,finished_at=? WHERE project=? AND agent=? AND id=?',
      [state, Date.now(), ...store.scope, cycle.id],
    );
    const config = store.state().config;
    store.db.execute(
      `UPDATE banditbul_state SET next_run_at=MAX(next_run_at,?),last_error=?
      WHERE project=? AND agent=?`,
      [
        Date.now() + config.study_interval_secs * 1000,
        failed
          ? 'One or more study topics failed. Inspect their history and configured services.'
          : null,
        ...store.scope,
      ],
    );
  });
}
