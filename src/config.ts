// Retain the original curriculum fields and validate independent scheduling and research budgets.
import { z } from 'zod';
import { encode, text, utf8 } from './values';

const studyTopic = z.strictObject({
  category: text(512),
  description: utf8(1024).default(''),
  queries: z.array(text(4096)).min(1).max(32),
});
const research = z.strictObject({
  max_results: z.int().min(1).max(40).default(10),
  max_crawl_pages: z.int().min(1).max(20).default(5),
  min_confidence: z.number().min(0.5).max(1).default(0.6),
  max_content_length: z.int().min(50).max(100000).default(5000),
  timeout_ms: z.int().min(100).max(120000).default(30000),
  total_timeout_ms: z.int().min(100).max(600000).default(180000),
  time_range: z.enum(['', '1w', '1m', '3m', '6m', '1y']).default('3m'),
  engines: z
    .array(z.enum(['ddg', 'bing', 'naver', 'google', 'searxng']))
    .min(1)
    .max(5)
    .refine((value) => new Set(value).size === value.length)
    .default(['ddg', 'bing', 'naver']),
});
export const configuration = z
  .strictObject({
    idle_threshold_secs: z.int().min(1).max(86400).default(120),
    study_interval_secs: z.int().min(60).max(604800).default(1800),
    max_topics_per_cycle: z.int().min(1).max(10).default(3),
    study_topics: z.array(studyTopic).max(64).default([]),
    research: research.prefault({}),
    semantic: z.boolean().default(false),
  })
  .refine(
    (value) => value.study_topics.reduce((count, topic) => count + topic.queries.length, 0) <= 256,
    'A curriculum supports at most 256 queries',
  );
export type BanditbulConfig = z.input<typeof configuration>;
export type ResolvedConfig = z.output<typeof configuration>;

export function resolveConfig(input: unknown): ResolvedConfig {
  const result = configuration.parse(input);
  encode(result);
  return result;
}
