// Prefer configured round-robin queries, otherwise inspect bounded, scoped low-frequency categories.
import type { BanditbulStore } from './store';
import type { StoredState, StudyJob } from './types';
import { digest, text } from './values';

export function selectTopics(store: BanditbulStore, state: StoredState): StudyJob[] {
  const configured = state.config.study_topics.flatMap((topic) =>
    topic.queries.map((query) => ({ category: topic.category, query })),
  );
  if (!configured.length) return knowledgeGaps(store, state.config.max_topics_per_cycle);
  const result: StudyJob[] = [];
  for (
    let offset = 0;
    offset < Math.min(configured.length, state.config.max_topics_per_cycle);
    offset++
  ) {
    const index = (state.cursor + offset) % configured.length,
      topic = configured[index]!;
    result.push({
      ...topic,
      topicKey: digest(topic.category.toLowerCase()),
      nextCursor: (index + 1) % configured.length,
    });
  }
  return result;
}
function knowledgeGaps(store: BanditbulStore, limit: number): StudyJob[] {
  const rows = store.db.query<{ category: unknown }>(
    `SELECT CASE WHEN length(CAST(category AS BLOB))<=512 THEN category ELSE NULL END AS category
      FROM (SELECT category,frequency,severity,outcome,created_at,id FROM experiences
        WHERE project=? AND agent=? ORDER BY created_at DESC,id DESC LIMIT 2000)
      WHERE frequency<=2 AND severity='info' AND outcome<>'firefly' AND category<>'web_source'
      GROUP BY category ORDER BY MAX(created_at) DESC,category LIMIT 256`,
    store.scope,
  );
  const result: StudyJob[] = [],
    seen = new Set<string>();
  for (const row of rows) {
    const category = text(512).parse(row.category),
      topicKey = digest(category.toLowerCase());
    if (seen.has(topicKey)) continue;
    seen.add(topicKey);
    const recent = store.db.query<{ found: number }>(
      `SELECT 1 AS found FROM banditbul_jobs WHERE project=? AND agent=? AND topic_key=?
        AND summary_id IS NOT NULL AND finished_at>? LIMIT 1`,
      [...store.scope, topicKey, Date.now() - 7 * 86400000],
    );
    if (recent.length) continue;
    result.push({ category, query: category, topicKey, nextCursor: null });
    if (result.length === limit) break;
  }
  return result;
}
