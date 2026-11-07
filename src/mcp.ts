// Nine scoped MCP tools expose scheduling controls and bounded history over one host-owned engine.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Banditbul } from './runner';
import { configuration } from './config';
import { identity } from './values';
const QUERY_PREVIEW_CHARS = 512;

export function createMcpServer(engine: Banditbul): McpServer {
  const server = new McpServer(
    { name: 'n2-banditbul', version: '1.0.0' },
    { maxToolInputElements: 2048 },
  );
  server.registerTool(
    'banditbul_status',
    {
      description:
        'Read idle-learning status and curriculum counts in the configured project and agent scope.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => result(() => statusPreview(engine)),
  );
  server.registerTool(
    'banditbul_configure',
    {
      description:
        'Replace the bounded curriculum and study settings. The current pause state is retained.',
      inputSchema: { config: configuration },
      annotations: { readOnlyHint: false },
    },
    async ({ config }) =>
      result(() => {
        engine.configure(config);
        return statusPreview(engine);
      }),
  );
  registerControl(server, engine);
  registerHistory(server, engine);
  registerTopics(server, engine);
  return server;
}
function registerControl(server: McpServer, engine: Banditbul): void {
  const controls = [
    [
      'banditbul_start',
      'Resume idle learning and start the background loop. The host must forward user activity.',
      () => {
        engine.resume();
        engine.start();
      },
    ],
    [
      'banditbul_pause',
      'Pause scheduled research and cancel the current request while retaining committed evidence.',
      () => engine.pause(),
    ],
    [
      'banditbul_touch',
      'Forward user activity, reset the idle timer and interrupt in-flight research.',
      () => engine.touch(),
    ],
  ] as const;
  for (const [name, description, execute] of controls)
    server.registerTool(
      name,
      { description, inputSchema: {}, annotations: { readOnlyHint: false } },
      async () =>
        result(() => {
          execute();
          return statusPreview(engine);
        }),
    );
  server.registerTool(
    'banditbul_tick',
    {
      description:
        'Process a due idle study or recover its previous receipts. Scheduling limits still apply.',
      inputSchema: {},
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (_, extra) =>
      result(async () => {
        await engine.tick(extra.signal);
        return statusPreview(engine);
      }),
  );
}
function registerHistory(server: McpServer, engine: Banditbul): void {
  server.registerTool(
    'banditbul_history',
    {
      description: 'List persisted cycle outcomes with bounded pagination.',
      inputSchema: {
        limit: z.int().min(1).max(100).default(20),
        offset: z.int().min(0).max(100000).default(0),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ limit, offset }) => result(() => engine.history(limit, offset)),
  );
  server.registerTool(
    'banditbul_read',
    {
      description:
        'Read cycle outcomes and source-report references. Query previews disclose omitted text.',
      inputSchema: { cycleId: identity },
      annotations: { readOnlyHint: true },
    },
    async ({ cycleId }) =>
      result(() => {
        const cycle = engine.getCycle(cycleId);
        if (!cycle) throw new Error('Cycle was not found in this project and agent scope');
        const { config, config_json, jobs, ...metadata } = cycle;
        return {
          ...metadata,
          jobs: jobs.map((job) => ({
            ...job,
            query: Array.from(job.query).slice(0, QUERY_PREVIEW_CHARS).join(''),
            queryTruncated: Array.from(job.query).length > QUERY_PREVIEW_CHARS,
          })),
        };
      }),
  );
}
function registerTopics(server: McpServer, engine: Banditbul): void {
  server.registerTool(
    'banditbul_topics',
    {
      description: 'Read configured curriculum queries with bounded previews and pagination.',
      inputSchema: {
        offset: z.int().min(0).max(256).default(0),
        limit: z.int().min(1).max(10).default(10),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ offset, limit }) =>
      result(() => {
        const topics = engine
          .status()
          .config.study_topics.flatMap((topic) =>
            topic.queries.map((query) => ({ category: topic.category, query })),
          );
        return {
          total: topics.length,
          offset,
          topics: topics.slice(offset, offset + limit).map((topic) => ({
            ...topic,
            query: Array.from(topic.query).slice(0, QUERY_PREVIEW_CHARS).join(''),
            queryTruncated: Array.from(topic.query).length > QUERY_PREVIEW_CHARS,
          })),
        };
      }),
  );
}
function statusPreview(engine: Banditbul) {
  const { config, ...state } = engine.status();
  return {
    ...state,
    config: { ...config, study_topics: undefined },
    topicGroups: config.study_topics.length,
    queries: config.study_topics.reduce((count, topic) => count + topic.queries.length, 0),
  };
}
async function result(operation: () => unknown | Promise<unknown>) {
  try {
    const text = JSON.stringify(await operation());
    if (Buffer.byteLength(text) > 60000) throw new Error('Tool result exceeds its byte limit');
    return { content: [{ type: 'text' as const, text }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ error: Array.from(message).slice(0, 1000).join('') }),
        },
      ],
    };
  }
}
