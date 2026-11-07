import {
  Banditbul,
  createMcpServer,
  type BanditbulConfig,
  type LearningPolicy,
} from 'n2-banditbul';

const config: BanditbulConfig = {
  study_topics: [{ category: 'code', queries: ['Rust ownership'] }],
};
const policy: LearningPolicy = {
  id: 'consumer-v1',
  screen: ({ facts }, signal) => {
    signal.throwIfAborted();
    return facts.map((fact) => fact.index);
  },
};
const learner = new Banditbul({
  dbPath: './consumer.db',
  project: 'consumer',
  agent: 'reader',
  policy,
});
learner.configure(config);
const state: 'paused' | 'dormant' | 'studying' | 'error' = learner.status().state;
const history: Array<{ id: string; state: 'running' | 'completed' | 'cancelled' | 'failed' }> =
  learner.history();
const cycle = learner.getCycle('request');
const count: number | undefined = cycle?.jobs[0]?.new_insights;
const server = createMcpServer(learner);
void [state, history, count, server, learner.close()];
