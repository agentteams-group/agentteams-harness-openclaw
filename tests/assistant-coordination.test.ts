import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createReplyDispatcherWithTyping } from '/opt/openclaw/src/auto-reply/reply/reply-dispatcher.ts';
import { isMainRestartRecoveryCandidate } from '/opt/openclaw/src/config/sessions/restart-recovery-state.ts';
import { installMatrixMonitorTestRuntime } from '../../test-runtime.js';
import { createMatrixHandlerTestHarness, createMatrixTextMessageEvent } from './handler.test-helpers.js';

it('admits an authenticated assistant reminder through the native Teams channel without a business Task', async () => {
  installMatrixMonitorTestRuntime();
  const temporary = mkdtempSync(path.join(tmpdir(), 'at-coordination-'));
  const token = path.join(temporary, 'token'); writeFileSync(token, 'test-token');
  const event = { id: 'a'.repeat(32), kind: 'assistant_digest', task_id: '', main_task_id: '', project_id: '', delivery_id: 'current-role-instance', submission_id: '' };
  const canonicalText = 'Canonical Controller-owned assistant reminder';
  const control = { session_id: 'coordination-assistant:' + event.id, channel_meta: { sender_id: '@bot:example.org', agent_matrix_user_id: '@bot:example.org', room_id: '!room:example.org', assistant_team: 'research', assistant_request_id: 'daily-1', teamharness_coordination: event }, input: [{ content: [{ text: canonicalText }] }] };
  const receipt = { status: 'running', native_id: 'matrix:$closure', actor: '@bot:example.org', recipient: '@bot:example.org', room_id: '!room:example.org', control };
  let completed = true;
  const rosterRequests: string[] = [];
  const server = createServer((request, response) => {
    expect(request.headers.authorization).toBe('Bearer test-token');
    if (request.url?.startsWith('/api/v1/teams/')) rosterRequests.push(request.url);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.url?.includes('coordination/') ? receipt : request.url === '/api/v1/teams/research' ? {name: 'research', members: []} : { owner: completed ? 'current-role-instance' : 'replaced', roomId: '!room:example.org', context: {enabled: true} }));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const old = { url: process.env.AGENTTEAMS_CONTROLLER_URL, token: process.env.AGENTTEAMS_AUTH_TOKEN_FILE, role: process.env.AGENTTEAMS_AGENT_ROLE };
  Object.assign(process.env, { AGENTTEAMS_CONTROLLER_URL: `http://127.0.0.1:${address.port}`, AGENTTEAMS_AUTH_TOKEN_FILE: token, AGENTTEAMS_AGENT_ROLE: 'leader' });
  const inputs: string[] = [];
  const sessions: string[] = [];
  const sent = vi.fn().mockResolvedValue('$unexpected');
  const errors = vi.fn();
  const { handler } = createMatrixHandlerTestHarness({ createReplyDispatcherWithTyping, client: {sendMessage: sent, getJoinedRoomMembers: async () => ['@bot:example.org', '@human:example.org']} as never, dmPolicy: 'allowlist', allowFrom: ['@human:example.org'], configuredBotUserIds: new Set(['@bot:example.org']), cfg: {plugins: {entries: {'agentteams-teamharness': {config: {team: 'OpenClaw 验收'}}}}}, logVerboseMessage: console.log, runtime: {error: errors} as never, logger: {warn: console.warn, info: console.info, error: console.error, debug: console.log} as never, dispatchInboundMessage: async ({ ctx, dispatcher, replyOptions }) => {
    expect((ctx.GatewayRunToolBindings as any)?.agentteamsTask?.prepared).toEqual({});
    inputs.push(String(ctx.BodyForAgent));
    sessions.push(String(ctx.SessionKey));
    await (replyOptions as any)?.onAgentRunStart?.();
    dispatcher.sendFinalReply({text: 'No usable new information'});
    return { queuedFinal: false, counts: { final: 0, block: 0, tool: 0 } };
  } });
  try {
    const message = createMatrixTextMessageEvent({ eventId: '$closure', sender: '@bot:example.org', body: 'Visible projection' });
    message.content = { ...message.content, msgtype: 'm.notice', 'org.agentteams.coordination': structuredClone(control) } as never;
    await handler('!room:example.org', message);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toContain(canonicalText);
    expect(inputs[0]).not.toContain('Visible projection');
    expect(sessions[0]).toContain(encodeURIComponent(control.session_id));
    expect(sent).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    expect(rosterRequests).toEqual([]);
    completed = false;
    receipt.native_id = 'matrix:$stale';
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

it('leaves managed assistant restart recovery to AT while retaining ordinary native recovery', () => {
  const old = process.env.AGENTTEAMS_CONTROLLER_URL;
  const key = 'agent:main:main:coordination-assistant%3A' + 'a'.repeat(32);
  try {
    process.env.AGENTTEAMS_CONTROLLER_URL = 'http://controller.test';
    expect(isMainRestartRecoveryCandidate({}, key)).toBe(false);
    expect(isMainRestartRecoveryCandidate({}, 'agent:main:matrix:direct:human')).toBe(true);
    delete process.env.AGENTTEAMS_CONTROLLER_URL;
    expect(isMainRestartRecoveryCandidate({}, key)).toBe(true);
  } finally {
    if (old === undefined) delete process.env.AGENTTEAMS_CONTROLLER_URL;
    else process.env.AGENTTEAMS_CONTROLLER_URL = old;
  }
});
