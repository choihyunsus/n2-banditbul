// Parse explicit ownership and trusted services separately from bounded curriculum JSON.
import { parseArgs } from 'node:util';
import type { BanditbulOptions } from './runner';
import { identity, utf8 } from './values';

export function argumentsForCli(args: string[]) {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    tokens: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
      db: { type: 'string' },
      project: { type: 'string' },
      agent: { type: 'string' },
      worker: { type: 'string' },
      chrome: { type: 'string' },
      searxng: { type: 'string' },
      'ollama-endpoint': { type: 'string' },
      'ollama-model': { type: 'string' },
      input: { type: 'string' },
      id: { type: 'string' },
      limit: { type: 'string' },
      offset: { type: 'string' },
    },
  });
  const seen = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind !== 'option') continue;
    if (seen.has(token.name)) throw new Error(`Duplicate option --${token.name}`);
    seen.add(token.name);
  }
  const command = parsed.positionals[0],
    values = parsed.values;
  if (values.input !== undefined && command !== 'configure')
    throw new Error('--input requires configure');
  if (values.id !== undefined && command !== 'get') throw new Error('--id requires get');
  if ((values.limit !== undefined || values.offset !== undefined) && command !== 'history')
    throw new Error('--limit and --offset require history');
  return parsed;
}
export type CliArguments = ReturnType<typeof argumentsForCli>;
export function engineOptions(values: CliArguments['values']): BanditbulOptions {
  const ollama =
    values['ollama-endpoint'] || values['ollama-model']
      ? {
          endpoint: values['ollama-endpoint'] ?? 'http://127.0.0.1:11434',
          model: values['ollama-model'] ?? 'nomic-embed-text',
        }
      : undefined;
  return {
    dbPath: utf8(8192).min(1).parse(values.db),
    project: identity.parse(values.project),
    agent: identity.parse(values.agent),
    kraken: {
      workerPath: values.worker,
      chromePath: values.chrome,
      searxngUrl: values.searxng,
      ollama,
    },
  };
}
export async function readInput(value: string | undefined, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  if (value !== undefined) return JSON.parse(utf8(131072).parse(value));
  if (process.stdin.isTTY) throw new Error('Supply configuration JSON through stdin or --input');
  const chunks: Buffer[] = [];
  let size = 0;
  const abort = () => process.stdin.destroy(new Error('Configuration input was cancelled'));
  signal.addEventListener('abort', abort, { once: true });
  try {
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 131072) throw new Error('Configuration input exceeds 128 KiB');
      chunks.push(bytes);
    }
  } finally {
    signal.removeEventListener('abort', abort);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
}
export const HELP = `n2-banditbul <configure|resume|pause|touch|status|tick|history|get|run|mcp>
  --db <mimir.db> --project <project> --agent <agent>
  [--worker <executable>] [--chrome <executable>] [--searxng <trusted-service-url>]
  [--ollama-endpoint <trusted-service-url>] [--ollama-model <model>]
configure reads curriculum JSON from stdin or --input <json>.
get requires --id <cycle-id>. history accepts --limit and --offset.
New scopes are paused. run resumes scheduling until interrupted.
The host must send touch events during user activity. Study results retain source evidence.
`;
