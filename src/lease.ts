// Fence scheduler writes and propagate activity from other processes during a running cycle.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { identity, timestamp } from './values';
import type { BanditbulStore } from './store';

const LEASE_MS = 30000;
const leaseRow = z.object({
  nonce: identity,
  process_id: z.int().min(1).max(2147483647),
  expires_at: timestamp,
});
type LeaseRow = z.output<typeof leaseRow>;
export class LeaseBusy extends Error {}
export class StudyInterrupted extends Error {}

export class StudyLease {
  readonly nonce = randomUUID();
  readonly controller = new AbortController();
  private readonly timer: NodeJS.Timeout;
  private renewedAt = Date.now();
  constructor(
    private readonly store: BanditbulStore,
    readonly revision: number,
  ) {
    store.db.transaction(() => {
      const row = this.current();
      if (row && row.expires_at > Date.now() && processAlive(row.process_id))
        throw new LeaseBusy('This agent already has a running study');
      store.db.execute('INSERT OR REPLACE INTO banditbul_leases VALUES(?,?,?,?,?)', [
        ...store.scope,
        this.nonce,
        process.pid,
        Date.now() + LEASE_MS,
      ]);
    });
    this.timer = setInterval(() => this.heartbeat(), 1000);
    this.timer.unref();
  }
  private current(): LeaseRow | undefined {
    return readLease(this.store);
  }
  assert(): void {
    const row = this.current();
    if (!row || row.nonce !== this.nonce || row.expires_at <= Date.now())
      throw new Error('Study lease was lost or expired');
  }
  assertWorking(): void {
    this.assert();
    this.controller.signal.throwIfAborted();
    const state = this.store.state();
    if (state.paused || state.revision !== this.revision)
      throw new StudyInterrupted('Activity or configuration interrupted this study');
  }
  mutate<T>(work: () => T): T {
    return this.store.db.transaction(() => {
      this.assert();
      return work();
    });
  }
  private heartbeat(): void {
    try {
      this.store.db.transaction(() => {
        this.assert();
        const state = this.store.state();
        if (state.paused || state.revision !== this.revision)
          this.controller.abort(
            new StudyInterrupted('Activity or configuration interrupted this study'),
          );
        if (Date.now() - this.renewedAt < LEASE_MS / 3) return;
        this.store.db.execute(
          'UPDATE banditbul_leases SET expires_at=? WHERE project=? AND agent=? AND nonce=?',
          [Date.now() + LEASE_MS, ...this.store.scope, this.nonce],
        );
        this.renewedAt = Date.now();
      });
    } catch (error) {
      clearInterval(this.timer);
      this.controller.abort(error);
    }
  }
  release(): void {
    clearInterval(this.timer);
    this.controller.abort(new StudyInterrupted('Study ended'));
    this.store.db.execute('DELETE FROM banditbul_leases WHERE project=? AND agent=? AND nonce=?', [
      ...this.store.scope,
      this.nonce,
    ]);
  }
}
export function hasActiveLease(store: BanditbulStore): boolean {
  const row = readLease(store);
  return !!row && row.expires_at > Date.now() && processAlive(row.process_id);
}
function readLease(store: BanditbulStore): LeaseRow | undefined {
  const row = store.db.query<Record<string, unknown>>(
    `SELECT CASE WHEN length(CAST(nonce AS BLOB))<=128 THEN nonce ELSE NULL END AS nonce,
      process_id,expires_at FROM banditbul_leases WHERE project=? AND agent=?`,
    store.scope,
  )[0];
  return row ? leaseRow.parse(row) : undefined;
}
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
