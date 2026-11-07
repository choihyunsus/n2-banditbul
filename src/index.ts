#!/usr/bin/env node
// CLI and stdio MCP own the same learning engine and await its cancellation before shutdown.
import { Banditbul } from './runner';
import { argumentsForCli, engineOptions, readInput, HELP, type CliArguments } from './cli-options';
import { identity } from './values';
import type { BanditbulConfig } from './config';

async function main(): Promise<void> {
  const input = argumentsForCli(process.argv.slice(2)),
    command = input.positionals[0];
  if (input.values.version) {
    process.stdout.write('1.0.0\n');
    return;
  }
  if (input.values.help || !command) {
    process.stdout.write(HELP);
    return;
  }
  if (
    input.positionals.length !== 1 ||
    ![
      'configure',
      'resume',
      'pause',
      'touch',
      'status',
      'tick',
      'history',
      'get',
      'run',
      'mcp',
    ].includes(command)
  )
    throw new Error('Unknown command; use --help');
  const engine = new Banditbul(engineOptions(input.values));
  if (command === 'mcp') {
    await serve(engine);
    return;
  }
  const controller = new AbortController(),
    stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const result = await execute(engine, command, input.values, controller.signal);
    process.stdout.write(JSON.stringify(result) + '\n');
    if (command === 'tick' && engine.status().state === 'error') process.exitCode = 2;
  } finally {
    await engine.close();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
async function execute(
  engine: Banditbul,
  command: string,
  values: CliArguments['values'],
  signal: AbortSignal,
) {
  switch (command) {
    case 'configure':
      engine.configure((await readInput(values.input, signal)) as BanditbulConfig);
      break;
    case 'resume':
      engine.resume();
      break;
    case 'pause':
      engine.pause();
      break;
    case 'touch':
      engine.touch();
      break;
    case 'tick':
      return engine.tick(signal);
    case 'history':
      return engine.history(Number(values.limit ?? 20), Number(values.offset ?? 0));
    case 'get': {
      const cycle = engine.getCycle(identity.parse(values.id));
      if (!cycle) throw new Error('Cycle was not found in this project and agent scope');
      return cycle;
    }
    case 'run':
      await run(engine, signal);
      break;
    case 'status':
      break;
    default:
      throw new Error('Unsupported command');
  }
  return engine.status();
}
async function run(engine: Banditbul, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  engine.resume();
  engine.start();
  process.stdout.write(JSON.stringify(engine.status()) + '\n');
  await new Promise<void>((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );
}
async function serve(engine: Banditbul): Promise<void> {
  const { createMcpServer } = await import('./mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const server = createMcpServer(engine);
  const stop = () => {
    void server
      .close()
      .catch(reportFailure)
      .finally(() => engine.close())
      .catch(reportFailure);
  };
  server.server.onclose = () => {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    void engine.close().catch(reportFailure);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await server.connect(new StdioServerTransport());
  } catch (error) {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await engine.close();
    throw error;
  }
}
function reportFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    JSON.stringify({ error: Array.from(message).slice(0, 1000).join('') }) + '\n',
  );
  process.exitCode = 1;
}
main().catch(reportFailure);
