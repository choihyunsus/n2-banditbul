// Exit immediately after Kraken commits, before Banditbul writes its summary or releases its lease.
const { Banditbul, researchFixture } = require('../helpers.cjs');
const engine = new Banditbul({ dbPath: process.argv[2], project: 'fixture', agent: 'learner' });
researchFixture(engine);
const learn = engine.kraken.learn.bind(engine.kraken);
engine.kraken.learn = async (...args) => {
  await learn(...args);
  process.exit(37);
};
engine.tick().then(
  () => process.exit(2),
  () => process.exit(3),
);
