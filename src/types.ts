// Durable rows are validated when read and keep the common Soul ownership fields.
import { z } from 'zod';
import { hash, identity, text, timestamp, utf8 } from './values';
import type { ResolvedConfig } from './config';

export const stateRow = z.object({
  config_json: utf8(131072),
  config_hash: hash,
  policy_id: identity,
  revision: timestamp,
  cursor: z.int().min(0).max(255),
  last_activity_at: timestamp,
  next_run_at: timestamp,
  paused: z.union([z.literal(0), z.literal(1)]),
  last_error: utf8(512).nullable(),
});
export const cycleRow = z.object({
  id: identity,
  config_json: utf8(131072),
  config_hash: hash,
  policy_id: identity,
  activity_revision: timestamp,
  state: z.enum(['running', 'completed', 'cancelled', 'failed']),
  created_at: timestamp,
  finished_at: timestamp.nullable(),
});
export const jobRow = z.object({
  cycle_id: identity,
  position: z.int().min(0).max(9),
  request_id: identity,
  category: text(512),
  query: text(4096),
  topic_key: hash,
  next_cursor: z.int().min(0).max(255).nullable(),
  state: z.enum(['queued', 'running', 'completed', 'cancelled', 'failed']),
  summary_id: z.string().uuid().nullable(),
  new_insights: z.int().min(0).max(300),
  error: utf8(512).nullable(),
  finished_at: timestamp.nullable(),
});
export type StateRow = z.output<typeof stateRow>;
export type CycleRow = z.output<typeof cycleRow>;
export type JobRow = z.output<typeof jobRow>;
export interface StudyJob {
  category: string;
  query: string;
  topicKey: string;
  nextCursor: number | null;
}
export interface StoredState extends StateRow {
  config: ResolvedConfig;
}
export interface StoredCycle extends CycleRow {
  config: ResolvedConfig;
}
export interface BanditbulStatus {
  state: 'paused' | 'dormant' | 'studying' | 'error';
  paused: boolean;
  nextEligibleAt: number;
  lastActivityAt: number;
  cursor: number;
  lastError: string | null;
  activeCycleId: string | null;
  policyId: string;
  config: ResolvedConfig;
}
