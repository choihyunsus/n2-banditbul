// Summaries retain creation receipts and bounded source previews without promoting web agreement.
import type { LearningReceipt, StoredResearch } from 'n2-kraken';
import type { BanditbulStore } from './store';
import type { StudyLease } from './lease';
import type { JobRow } from './types';
import { encode } from './values';

export function finishLearning(
  store: BanditbulStore,
  lease: StudyLease,
  job: JobRow,
  research: StoredResearch,
  receipt: LearningReceipt,
): void {
  if (
    receipt.requestId !== job.request_id ||
    research.requestId !== job.request_id ||
    receipt.reportHash !== research.reportHash ||
    research.report.summary.topic !== job.query
  )
    throw new Error('Learning evidence does not match the scheduled topic');
  const created = receipt.insights.filter((insight) => insight.created === true);
  const content = created.length ? summaryContent(job, research, receipt) : undefined;
  lease.mutate(() => {
    const current = store.jobs(job.cycle_id).find((row) => row.position === job.position);
    if (!current || current.request_id !== job.request_id) throw new Error('Study job changed');
    if (current.state === 'completed') return;
    if (current.state !== 'queued' && current.state !== 'running')
      throw new Error('Study job is already terminal');
    const summary =
      content &&
      store.memory.insertExperience({
        project: store.scope[0],
        agent: store.scope[1],
        sessionId: job.cycle_id,
        type: 'pattern',
        category: job.category,
        severity: 'info',
        context: content,
        action: 'auto_study',
        outcome: 'firefly',
        sourceRef: `banditbul:${job.request_id}`,
      });
    store.db.execute(
      `UPDATE banditbul_jobs SET state='completed',summary_id=?,new_insights=?,error=NULL,finished_at=?
      WHERE project=? AND agent=? AND cycle_id=? AND position=?`,
      [
        summary ? summary.id : null,
        created.length,
        Date.now(),
        ...store.scope,
        job.cycle_id,
        job.position,
      ],
    );
  });
}
function summaryContent(job: JobRow, research: StoredResearch, receipt: LearningReceipt): string {
  const created = receipt.insights.filter((insight) => insight.created === true);
  const allClaims = created.map((insight) => {
    const fact = research.report.facts[insight.index];
    if (!fact || fact.status !== 'Verified')
      throw new Error('Learning receipt has no eligible source claim');
    return fact.claim;
  });
  const allSources = receipt.sources.map((source) => source.url);
  const content = {
    kind: 'firefly',
    verified: false,
    topic: job.query,
    requestId: job.request_id,
    reportHash: receipt.reportHash,
    policyId: receipt.policyId,
    learnedAt: receipt.learnedAt,
    newInsights: created,
    claims: preview(allClaims, 24576),
    sources: preview(allSources, 16384),
    omittedClaims: 0,
    omittedSources: 0,
  };
  content.omittedClaims = allClaims.length - content.claims.length;
  content.omittedSources = allSources.length - content.sources.length;
  while (Buffer.byteLength(JSON.stringify(content)) > 65536) {
    if (content.sources.length) {
      content.sources.pop();
      content.omittedSources++;
    } else if (content.claims.length) {
      content.claims.pop();
      content.omittedClaims++;
    } else throw new Error('Summary references exceed their byte limit');
  }
  return encode(content, 65536);
}
function preview(values: string[], budget: number): string[] {
  const shown: string[] = [];
  for (const value of values) {
    const bytes = Buffer.byteLength(JSON.stringify(value)) + 1;
    if (bytes > budget) break;
    budget -= bytes;
    shown.push(value);
  }
  return shown;
}
