import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createExecTool } from '/opt/openclaw/src/agents/bash-tools.exec-run.ts';
import { installMatrixMonitorTestRuntime } from '../../test-runtime.js';
import { createMatrixHandlerTestHarness, createMatrixTextMessageEvent } from './handler.test-helpers.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

it('confirms Stop after the native exec exits', async () => {
  const action = 'stop';
  installMatrixMonitorTestRuntime();
  const directory = mkdtempSync(path.join(tmpdir(), 'at-dm-openclaw-'));
  directories.push(directory);
  const pidfile = path.join(directory, 'pid');
  const marker = path.join(directory, 'must-not-run');
  const sent = vi.fn(async () => '$status');
  const members = vi.fn(async () => ['@bot:example.org', '@user:example.org']);
  const inputs: string[] = [];
  const exec = createExecTool({ host: 'gateway', security: 'full', ask: 'off', allowBackground: false, notifyOnExit: false });
  const { handler } = createMatrixHandlerTestHarness({
    client: { getJoinedRoomMembers: members, sendMessage: sent } as never,
    dispatchInboundMessage: async ({ ctx, replyOptions }) => {
      inputs.push(String(ctx.BodyForAgent));
      await replyOptions?.onAgentRunStart?.('native-run');
      if (ctx.MessageSid === '$original') {
        await exec.execute('native-tool', { command: `echo $$ > ${pidfile}; sleep 30; touch ${marker}`, timeoutSeconds: 40 }, replyOptions?.abortSignal);
      }
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
    },
  });
  const original = handler('!room:example.org', createMatrixTextMessageEvent({ eventId: '$original', body: '原任务：分析订单' }));
  await expect.poll(() => existsSync(pidfile), { timeout: 20000 }).toBe(true);
  const control = createMatrixTextMessageEvent({ eventId: '$control', body: '新增杭州的数据' });
  control.content = { ...control.content, 'com.agentteams.control': { action, agent_id: '@bot:example.org', run_id: '$original' } } as never;
  members.mockResolvedValueOnce(['@bot:example.org', '@user:example.org', '@other:example.org']);
  await handler('!room:example.org', { ...control, event_id: '$denied' });
  expect(() => process.kill(Number(readFileSync(pidfile, 'utf8').trim()), 0)).not.toThrow();
  await handler('!room:example.org', control);
  await original;
  const pid = Number(readFileSync(pidfile, 'utf8').trim());
  await expect.poll(() => { try { process.kill(pid, 0); return false; } catch { return true; } }).toBe(true);
  expect(existsSync(marker)).toBe(false);
  const statuses = sent.mock.calls.map(call => (call[1] as Record<string, any>)['com.agentteams.execution']?.status).filter(Boolean);
  expect(statuses.slice(0, 3)).toEqual(['running', 'stopping', 'stopped']);
  expect(inputs).toHaveLength(1);
}, 30000);

it('routes consecutive supplements through native /steer while the original tool stays alive', async () => {
  installMatrixMonitorTestRuntime();
  const directory = mkdtempSync(path.join(tmpdir(), 'at-dm-openclaw-steer-'));
  directories.push(directory);
  const pidfile = path.join(directory, 'pid');
  const marker = path.join(directory, 'finished');
  const sent = vi.fn(async () => '$status');
  const members = vi.fn(async () => ['@bot:example.org', '@user:example.org']);
  const commands: string[] = [];
  const exec = createExecTool({ host: 'gateway', security: 'full', ask: 'off', allowBackground: false, notifyOnExit: false });
  const { handler } = createMatrixHandlerTestHarness({
    client: { getJoinedRoomMembers: members, sendMessage: sent } as never,
    dispatchInboundMessage: async ({ ctx, replyOptions }) => {
      if (ctx.MessageSid === '$original') {
        await replyOptions?.onAgentRunStart?.('native-run');
        await exec.execute('native-tool', { command: `echo $$ > ${pidfile}; sleep 3; touch ${marker}`, timeoutSeconds: 10 }, replyOptions?.abortSignal);
      } else {
        commands.push(String(ctx.CommandBody));
      }
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
    },
  });
  const original = handler('!room:example.org', createMatrixTextMessageEvent({ eventId: '$original', body: '原任务' }));
  await expect.poll(() => existsSync(pidfile), { timeout: 20000 }).toBe(true);
  for (let index = 0; index < 2; index++) {
    const control = createMatrixTextMessageEvent({ eventId: `$control-${index}`, body: `补充 ${index}` });
    control.content = { ...control.content, 'com.agentteams.control': { action: 'steer', agent_id: '@bot:example.org', run_id: '$original' } } as never;
    await handler('!room:example.org', control);
    expect(() => process.kill(Number(readFileSync(pidfile, 'utf8').trim()), 0)).not.toThrow();
  }
  expect(commands).toEqual(['/steer 补充 0', '/steer 补充 1']);
  const statuses = () => sent.mock.calls.map(call => (call[1] as Record<string, any>)['com.agentteams.execution']?.status).filter(Boolean);
  expect(statuses()).toEqual(['running']);
  await original;
  expect(existsSync(marker)).toBe(true);
  expect(statuses()).toEqual(['running', 'completed']);
}, 30000);
