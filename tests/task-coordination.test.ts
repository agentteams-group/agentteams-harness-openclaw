import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { installMatrixMonitorTestRuntime } from '../../test-runtime.js';
import { createMatrixHandlerTestHarness, createMatrixTextMessageEvent } from './handler.test-helpers.js';

it('admits authenticated main-task closure through the native channel without admitting self echoes', async () => {
  installMatrixMonitorTestRuntime();
  const temporary = mkdtempSync(path.join(tmpdir(), 'at-coordination-'));
  const token = path.join(temporary, 'token'); writeFileSync(token, 'test-token');
  const event = { id: 'a'.repeat(32), kind: 'main_task_ready', task_id: '', main_task_id: 'main', project_id: '', delivery_id: '', submission_id: '' };
  const control = { session_id: 'coordination-close-task:main', channel_meta: { sender_id: '@bot:example.org', agent_matrix_user_id: '@bot:example.org', room_id: '!room:example.org', teamharness_coordination: event }, input: [{ content: [{ text: 'Canonical accepted main task' }] }] };
  const receipt = { native_id: 'matrix:$closure', status: 'running', actor: '@bot:example.org', recipient: '@bot:example.org', room_id: '!room:example.org', control };
  let completed = true;
  // Keep the real Python bridge and its scope validation; only public authority
  // and the CLI's read-only accepted-result snapshot are deterministic fixtures.
  const accepted = { task: { id: 'main', kind: 'main', status: 'in_progress',
    nodes: [{ taskId: 'child', status: 'completed' }], acceptedResults: [{
      id: 'child', mainTaskId: 'main', kind: 'execution', status: 'completed', submissionId: 'submission',
      candidate: { id: 'submission' }, review: { id: 'review', accepted: true, status: 'completed', submissionId: 'submission' },
    }] } };
  const cliReceipt = path.join(temporary, 'accepted.json');
  writeFileSync(cliReceipt, JSON.stringify(accepted));
  writeFileSync(path.join(temporary, 'agt'), `#!/usr/bin/env python3
import json, pathlib, sys
assert sys.argv[1:] == ['task', 'get', 'main'], sys.argv
print(pathlib.Path(${JSON.stringify(cliReceipt)}).read_text())
`, { mode: 0o755 });
  const admitted: string[] = [];
  const server = createServer(async (request, response) => {
    expect(request.headers.authorization).toBe('Bearer test-token');
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'POST' && request.url === `/api/v1/coordination/events/${event.id}/phase`) {
      let body = ''; for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      expect(input).toEqual({ action: 'begin', native_event_id: '$closure', process_id: 'native-process' });
      expect(request.headers['x-agentteams-process-id']).toBe('native-process');
      admitted.push(input.native_event_id);
      response.end(JSON.stringify({ active: true })); return;
    }
    if (request.url === `/api/v1/coordination/events/${event.id}`) {
      response.end(JSON.stringify(receipt)); return;
    }
    if (request.url === '/api/v1/tasks/main/meta') {
      response.end(JSON.stringify({ task_kind: 'main', status: 'in_progress', tasks: [{ task_id: 'child', status: completed ? 'completed' : 'submitted' }] })); return;
    }
    if (request.url === '/api/v1/teams/team') {
      response.end(JSON.stringify({ name: 'team', members: [{ name: 'worker', matrixUserID: '@worker:example.org' }] })); return;
    }
    response.writeHead(404).end(JSON.stringify({ error: 'unexpected public fixture route' }));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  vi.stubEnv('AGENTTEAMS_CONTROLLER_URL', `http://127.0.0.1:${address.port}`);
  vi.stubEnv('AGENTTEAMS_AUTH_TOKEN_FILE', token);
  vi.stubEnv('AGENTTEAMS_AGENT_ROLE', 'leader');
  vi.stubEnv('AGENTTEAMS_PROCESS_ID', 'native-process');
  vi.stubEnv('PATH', temporary + path.delimiter + process.env.PATH);
  const inputs: string[] = [];
  const sessions: string[] = [];
  const { handler } = createMatrixHandlerTestHarness({ cfg: { channels: { matrix: { dm: { allowFrom: ['*'] } } }, plugins: { entries: { 'agentteams-teamharness': { config: { team: 'team' } } } } }, logVerboseMessage: console.log, runtime: {error: console.error} as never, logger: {warn: console.warn, info: console.info, error: console.error, debug: console.log} as never, dispatchInboundMessage: async ({ ctx }) => {
    inputs.push(String(ctx.BodyForAgent));
    sessions.push(String(ctx.SessionKey));
    return { queuedFinal: false, counts: { final: 0, block: 0, tool: 0 } };
  } });
  try {
    const message = createMatrixTextMessageEvent({ eventId: '$closure', sender: '@bot:example.org', body: 'Visible projection' });
    message.content = { ...message.content, 'org.agentteams.coordination': structuredClone(control) } as never;
    await handler('!room:example.org', message);
    expect(admitted).toEqual(['$closure']);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toContain('Canonical accepted main task');
    expect(inputs[0]).not.toContain('Visible projection');
    expect(sessions[0]).toContain(encodeURIComponent(control.session_id));
    completed = false;
    receipt.native_id = 'matrix:$stale';
    await handler('!room:example.org', { ...message, event_id: '$stale' });
    expect(admitted).toEqual(['$closure']);
    expect(inputs).toHaveLength(1);
    const echo = createMatrixTextMessageEvent({ eventId: '$echo', sender: '@bot:example.org', body: 'Ordinary own echo' });
    await handler('!room:example.org', echo);
    expect(inputs).toHaveLength(1);
  } finally {
    server.close();
    vi.unstubAllEnvs();
    rmSync(temporary, { recursive: true, force: true });
  }
}, 30000);
