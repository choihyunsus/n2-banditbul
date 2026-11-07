// Schedule checks precede lease acquisition, and recovery errors receive a durable retry delay.
import type { Kraken, LearningPolicy } from 'n2-kraken';
import type { BanditbulStore } from './store';
import { status } from './control';
import { beginCycle } from './cycles';
import { LeaseBusy, StudyInterrupted, StudyLease } from './lease';
import { studyCycle } from './study';

export async function execute(
  store: BanditbulStore,
  kraken: Kraken,
  policy: LearningPolicy | undefined,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const state = store.state(),
    previous = store.active();
  const due =
    !state.paused &&
    Date.now() >= state.last_activity_at + state.config.idle_threshold_secs * 1000 &&
    Date.now() >= state.next_run_at;
  if (!due && (!previous || state.last_error)) return status(store);
  let lease: StudyLease;
  try {
    lease = new StudyLease(store, state.revision);
  } catch (error) {
    if (error instanceof LeaseBusy) return status(store);
    throw error;
  }
  try {
    const cycle = previous ?? beginCycle(store, lease, state);
    await studyCycle(
      {
        store,
        kraken,
        lease,
        cycle,
        policy,
        signal: AbortSignal.any([signal, lease.controller.signal]),
      },
      due,
    );
  } catch (error) {
    if (!signal.aborted && !(error instanceof StudyInterrupted)) recordError(store, lease);
    throw error;
  } finally {
    lease.release();
  }
  return status(store);
}
function recordError(store: BanditbulStore, lease: StudyLease): void {
  lease.mutate(() => {
    const config = store.state().config;
    store.db.execute(
      `UPDATE banditbul_state SET last_error=?,next_run_at=? WHERE project=? AND agent=?`,
      [
        'Study recovery or storage failed. Inspect the pending cycle before retrying.',
        Date.now() + config.study_interval_secs * 1000,
        ...store.scope,
      ],
    );
  });
}
