import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import path from 'node:path';
import { expect, it } from 'vitest';
import { installMatrixMonitorTestRuntime } from '../../test-runtime.js';
import { createMatrixHandlerTestHarness, createMatrixTextMessageEvent } from './handler.test-helpers.js';

it('admits authenticated main-task closure through the native channel without admitting self echoes', async () => {
  installMatrixMonitorTestRuntime();
  const temporary = mkdtempSync(path.join(tmpdir(), 'at-coordination-'));
  const token = path.join(temporary, 'token'); writeFileSync(token, 'test-token');
  const event = { id: 'a'.repeat(32), kind: 'main_task_ready', task_id: '', main_task_id: 'main', project_id: '', delivery_id: '', submission_id: '' };
  const control = { session_id: 'coordination-close-task:main', channel_meta: { sender_id: '@bot:example.org', agent_matrix_user_id: '@bot:example.org', room_id: '!room:example.org', teamharness_coordination: event }, input: [{ content: [{ text: 'Canonical accepted main task' }] }] };
  const receipt = { status: 'running', actor: '@bot:example.org', recipient: '@bot:example.org', room_id: '!room:example.org', control };
  let completed = true;
  const server = createServer((request, response) => {
    expect(request.headers.authorization).toBe('Bearer test-token');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.url?.includes('coordination/') ? receipt : { task_kind: 'main', status: 'in_progress', tasks: [{ task_id: 'child', status: completed ? 'completed' : 'submitted' }] }));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const old = { url: process.env.AGENTTEAMS_CONTROLLER_URL, token: process.env.AGENTTEAMS_AUTH_TOKEN_FILE, role: process.env.AGENTTEAMS_AGENT_ROLE };
  Object.assign(process.env, { AGENTTEAMS_CONTROLLER_URL: `http://127.0.0.1:${address.port}`, AGENTTEAMS_AUTH_TOKEN_FILE: token, AGENTTEAMS_AGENT_ROLE: 'leader' });
  const inputs: string[] = [];
  const sessions: string[] = [];
  const { handler } = createMatrixHandlerTestHarness({ logVerboseMessage: console.log, runtime: {error: console.error} as never, logger: {warn: console.warn, info: console.info, error: console.error, debug: console.log} as never, dispatchInboundMessage: async ({ ctx }) => {
    inputs.push(String(ctx.BodyForAgent));
    sessions.push(String(ctx.SessionKey));
    return { queuedFinal: false, counts: { final: 0, block: 0, tool: 0 } };
  } });
  try {
    const message = createMatrixTextMessageEvent({ eventId: '$closure', sender: '@bot:example.org', body: 'Visible projection' });
    message.content = { ...message.content, 'org.agentteams.coordination': structuredClone(control) } as never;
    await handler('!room:example.org', message);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toContain('Canonical accepted main task');
    expect(inputs[0]).not.toContain('Visible projection');
    expect(sessions[0]).toContain(encodeURIComponent(control.session_id));
    completed = false;
    await handler('!room:example.org', { ...message, event_id: '$stale' });
    expect(inputs).toHaveLength(1);
    const echo = createMatrixTextMessageEvent({ eventId: '$echo', sender: '@bot:example.org', body: 'Ordinary own echo' });
    await handler('!room:example.org', echo);
    expect(inputs).toHaveLength(1);
  } finally {
    server.close();
    for (const [key, value] of Object.entries({ AGENTTEAMS_CONTROLLER_URL: old.url, AGENTTEAMS_AUTH_TOKEN_FILE: old.token, AGENTTEAMS_AGENT_ROLE: old.role })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(temporary, { recursive: true, force: true });
  }
}, 30000);
