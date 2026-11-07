// Recover committed learning before repeating research or cancelling an interrupted curriculum.
import { setTimeout as delay } from 'node:timers/promises';
import type { Kraken, LearningPolicy } from 'n2-kraken';
import type { BanditbulStore } from './store';
import { StudyInterrupted, type StudyLease } from './lease';
import type { StoredCycle, JobRow } from './types';
import { failJob, finishCycle, startJob } from './cycles';
import { finishLearning } from './summary';

export interface StudyContext {
  store: BanditbulStore;
  lease: StudyLease;
  kraken: Kraken;
  cycle: StoredCycle;
  policy?: LearningPolicy;
  signal: AbortSignal;
}
export async function studyCycle(context: StudyContext, allowResearch: boolean): Promise<void> {
  const { store, cycle, lease } = context;
  reconcileLearning(context);
  const state = store.state();
  if (
    cycle.config_hash !== state.config_hash ||
    cycle.policy_id !== state.policy_id ||
    cycle.activity_revision !== state.revision ||
    state.paused
  ) {
    finishCycle(store, lease, cycle, true);
    return;
  }
  const pending = store
    .jobs(cycle.id)
    .filter((job) => job.state === 'queued' || job.state === 'running');
  if (pending.length && !allowResearch) return;
  if (pending.length && cycle.policy_id !== (context.policy?.id ?? 'source-agreement-v1'))
    throw new Error('Supply the configured learning policy before resuming pending research');
  try {
    for (let index = 0; index < pending.length; index++) {
      context.signal.throwIfAborted();
      lease.assertWorking();
      await studyTopic(context, pending[index]!);
      if (index + 1 < pending.length) await delay(5000, undefined, { signal: context.signal });
    }
    finishCycle(store, lease, cycle, false);
  } catch (error) {
    if (!context.signal.aborted && !(error instanceof StudyInterrupted)) throw error;
    reconcileLearning(context);
    finishCycle(store, lease, cycle, true);
  }
}
export function reconcileLearning(context: StudyContext): void {
  for (const job of context.store.jobs(context.cycle.id)) {
    if (job.state === 'queued' || job.state === 'running') recoverJob(context, job);
  }
}
function recoverJob(context: StudyContext, job: JobRow): boolean {
  const receipt = context.kraken.getLearning(job.request_id, context.cycle.policy_id);
  if (!receipt) return false;
  const research = context.kraken.getResearch(job.request_id);
  if (!research) throw new Error('Committed learning is missing its source report');
  finishLearning(context.store, context.lease, job, research, receipt);
  return true;
}
async function studyTopic(context: StudyContext, job: JobRow): Promise<void> {
  const { store, lease, cycle, kraken, policy, signal } = context;
  startJob(store, lease, job);
  let stage = 'research_failed';
  try {
    const research =
      kraken.getResearch(job.request_id) ??
      (await kraken.research(
        {
          requestId: job.request_id,
          topic: job.query,
          config: cycle.config.research,
          semantic: cycle.config.semantic,
        },
        signal,
      ));
    signal.throwIfAborted();
    lease.assertWorking();
    if (research.report.summary.topic !== job.query) throw new Error('Research topic differs');
    stage = 'learning_failed';
    const receipt = await kraken.learn(job.request_id, { policy, signal });
    finishLearning(store, lease, job, research, receipt);
  } catch (error) {
    if (recoverJob(context, job)) return;
    if (signal.aborted || error instanceof StudyInterrupted) throw error;
    failJob(store, lease, job, stage);
  }
}
