// Explicit host activity and pause controls survive process restarts.
import type { BanditbulStore } from './store';
import { resolveConfig } from './config';
import { digest, encode, identity } from './values';
import type { BanditbulStatus } from './types';
import { hasActiveLease } from './lease';

export function configure(store: BanditbulStore, input: unknown, policyId: string): void {
  const json = encode(resolveConfig(input));
  identity.parse(policyId);
  store.db.transaction(() => {
    store.state();
    store.db.execute(
      `UPDATE banditbul_state SET config_json=?,config_hash=?,policy_id=?,
      revision=revision+1,cursor=0,last_activity_at=?,last_error=NULL WHERE project=? AND agent=?`,
      [json, digest(json), policyId, Date.now(), ...store.scope],
    );
  });
}
export function activity(store: BanditbulStore, paused?: boolean): void {
  store.db.transaction(() => {
    const state = store.state();
    store.db.execute(
      `UPDATE banditbul_state SET revision=revision+1,last_activity_at=?,paused=?
      WHERE project=? AND agent=?`,
      [Date.now(), paused === undefined ? state.paused : Number(paused), ...store.scope],
    );
  });
}
export function status(store: BanditbulStore): BanditbulStatus {
  return store.db.transaction(() => {
    const state = store.state(),
      active = store.active(),
      studying = !!active && hasActiveLease(store);
    return {
      state: state.paused
        ? 'paused'
        : studying
          ? 'studying'
          : state.last_error
            ? 'error'
            : 'dormant',
      paused: !!state.paused,
      nextEligibleAt: Math.max(
        state.next_run_at,
        state.last_activity_at + state.config.idle_threshold_secs * 1000,
      ),
      lastActivityAt: state.last_activity_at,
      cursor: state.cursor,
      lastError: state.last_error,
      activeCycleId: active?.id ?? null,
      policyId: state.policy_id,
      config: state.config,
    };
  });
}
