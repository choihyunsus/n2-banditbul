// The host explicitly starts scheduling and forwards activity; each scope runs one bounded cycle.
import { setTimeout as delay } from 'node:timers/promises';
import { Kraken, type KrakenOptions, type LearningPolicy } from 'n2-kraken';
import { BanditbulStore, type StoreOptions } from './store';
import { activity, configure, status } from './control';
import { StudyInterrupted } from './lease';
import { execute } from './execution';
import { identity } from './values';
import type { BanditbulConfig } from './config';

export interface BanditbulOptions extends StoreOptions {
  kraken?: Omit<KrakenOptions, keyof StoreOptions>;
  policy?: LearningPolicy;
}
export class Banditbul {
  private readonly store: BanditbulStore;
  private readonly kraken: Kraken;
  private readonly policy?: LearningPolicy;
  private readonly shutdown = new AbortController();
  private active?: AbortController;
  private pending?: Promise<ReturnType<typeof status>>;
  private loop?: Promise<void>;
  private closing?: Promise<void>;
  constructor(options: BanditbulOptions) {
    if (options.policy && typeof options.policy.screen !== 'function')
      throw new Error('A policy requires a screening function');
    this.policy = options.policy && {
      id: identity.parse(options.policy.id),
      screen: options.policy.screen.bind(options.policy),
    };
    if (this.policy?.id === 'source-agreement-v1')
      throw new Error('The default policy ID is reserved');
    this.store = new BanditbulStore(options);
    try {
      this.kraken = new Kraken({
        ...options.kraken,
        dbPath: this.store.dbPath,
        project: this.store.scope[0],
        agent: this.store.scope[1],
      });
    } catch (error) {
      this.store.close();
      throw error;
    }
  }
  configure(config: BanditbulConfig): void {
    this.assertOpen();
    configure(this.store, config, this.policy?.id ?? 'source-agreement-v1');
    this.interrupt();
  }
  touch(): void {
    this.assertOpen();
    activity(this.store);
    this.interrupt();
  }
  pause(): void {
    this.assertOpen();
    activity(this.store, true);
    this.interrupt();
  }
  resume(): void {
    this.assertOpen();
    activity(this.store, false);
    this.interrupt();
  }
  status() {
    this.assertOpen();
    return status(this.store);
  }
  history(limit = 20, offset = 0) {
    this.assertOpen();
    return this.store.history(limit, offset);
  }
  getCycle(id: string) {
    this.assertOpen();
    return this.store.db.transaction(() => {
      const cycle = this.store.cycle(id);
      return cycle && { ...cycle, jobs: this.store.jobs(id) };
    });
  }
  tick(signal?: AbortSignal): Promise<ReturnType<typeof status>> {
    this.assertOpen();
    signal?.throwIfAborted();
    if (this.pending) return this.pending;
    const controller = new AbortController();
    this.active = controller;
    const combined = AbortSignal.any([
      this.shutdown.signal,
      controller.signal,
      ...(signal ? [signal] : []),
    ]);
    this.pending = execute(this.store, this.kraken, this.policy, combined).finally(() => {
      this.pending = undefined;
      this.active = undefined;
    });
    return this.pending;
  }
  start(): void {
    this.assertOpen();
    if (this.loop) return;
    this.loop = this.schedule();
  }
  private async schedule(): Promise<void> {
    while (!this.shutdown.signal.aborted) {
      try {
        await this.tick();
      } catch {
        if (this.shutdown.signal.aborted) break;
      }
      try {
        await delay(1000, undefined, { signal: this.shutdown.signal });
      } catch {
        break;
      }
    }
  }
  private interrupt(): void {
    this.active?.abort(new StudyInterrupted('Host activity interrupted the study'));
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.shutdown.abort(new StudyInterrupted('Banditbul is closing'));
    return (this.closing = Promise.allSettled([this.loop, this.pending]).then(async () => {
      try {
        await this.kraken.close();
      } finally {
        this.store.close();
      }
    }));
  }
  private assertOpen(): void {
    if (this.shutdown.signal.aborted) throw new Error('Banditbul is closed');
  }
}
