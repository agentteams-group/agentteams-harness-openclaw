// Real Python recovery client, SDK SQLite and exec cancellation. The HTTP
// authority/Matrix/model boundaries are fixtures, not a real Task E2E.
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import { upsertSessionEntry, getSessionEntryAsync } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { createExecTool } from "/opt/openclaw/src/agents/bash-tools.exec-run.ts";
import { getMatrixRuntime } from "../../runtime.js";
import { installMatrixMonitorTestRuntime, resetMatrixTestStores } from "../../test-runtime.js";
import { AgentTeamsTaskRecovery } from "./agentteams-task-recovery.js";

let home: string;
let server: Server;
let recovery: AgentTeamsTaskRecovery;
let task: any;
let cfg: any;
let headers: Array<Record<string, unknown>>;
let sessionCache: Record<string, unknown> | null;
let configGeneration: number;
const identity = { task_id: "T", team_id: "team", generation: 2, instance_id: "container/new-start", process_id: "new-boot" };

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "at-openclaw-recovery-"));
  fs.writeFileSync(path.join(home, "token"), "fixture-worker-token", { mode: 0o600 });
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(home, ".openclaw"));
  vi.stubEnv("AGENTTEAMS_WORKER_HOME", home);
  vi.stubEnv("AGENTTEAMS_AUTH_TOKEN_FILE", path.join(home, "token"));
  vi.stubEnv("AGENTTEAMS_PROCESS_ID", "new-boot");
  vi.stubEnv("AGENTTEAMS_AGENT_ROLE", "worker");
  cfg = { agents: { defaults: { workspace: home } }, session: { reset: { mode: "idle", idleMinutes: 1 } } };
  installMatrixMonitorTestRuntime({ cfg, stateDir: path.join(home, ".openclaw") });
  task = { task_id: "T", status: "in_progress", room_id: "!task:example.org", title: "Three steps",
    execution: { generation: 2, instance_id: identity.instance_id, process_id: "new-boot", state: "active",
      checkpoint: { version: 4, completed_steps: ["one"], remaining_steps: ["two", "three"] } } };
  headers = [];
  sessionCache = null;
  configGeneration = 1;
  server = createServer(async (request, response) => {
    headers.push(request.headers);
    response.setHeader("Content-Type", "application/json");
    if (request.headers.authorization !== "Bearer fixture-worker-token"
        || request.headers["x-agentteams-process-id"] !== "new-boot") {
      response.writeHead(403).end(JSON.stringify({ error: "wrong identity" })); return;
    }
    if (request.url === "/api/v1/runtime/matrix") {
      response.end(JSON.stringify({ runtime: "openclaw", instance_id: identity.instance_id, etag: "" }));
      return;
    }
    if (request.url === "/api/v1/runtime/sessions?kind=task&team=team&task=T") {
      const current = { checkpoint_version: task.execution.checkpoint.version,
        checkpoint_digest: `checkpoint-${task.execution.checkpoint.version}`, config_generation: configGeneration };
      if (request.method === "PUT") {
        let body = "";
        for await (const chunk of request) body += chunk;
        const input = JSON.parse(body);
        expect(sessionCache ? request.headers["if-match"] : request.headers["if-none-match"]).toBe(sessionCache ? "cache" : "*");
        expect(input).toMatchObject({ ...current, process_id: identity.process_id, generation: identity.generation });
        sessionCache = { ...input, runtime: "openclaw" };
      }
      response.end(JSON.stringify({ ...current, runtime: "openclaw", work: { kind: "task", team_id: "team", task_id: "T" },
        cache: sessionCache, compatible: !!sessionCache && sessionCache.checkpoint_digest === current.checkpoint_digest
          && sessionCache.config_generation === configGeneration,
        etag: sessionCache ? "cache" : "", generation: identity.generation, instance_id: identity.instance_id }));
      return;
    }
    if (request.method === "GET" && request.url === "/api/v1/tasks/recoverable") {
      response.end(JSON.stringify({ instance_id: identity.instance_id,
        tasks: [{ team_id: "team", task, etag: '"v4"' }] })); return;
    }
    if (request.method !== "POST" || request.url !== "/api/v1/tasks/T/execution?team=team"
        || request.headers["if-match"] !== '"v4"') {
      response.writeHead(400).end(JSON.stringify({ error: "wrong scoped request" })); return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    if (input.action === "checkpoint") task.execution.checkpoint = input.checkpoint;
    response.end(JSON.stringify({ task, execution: task.execution, spec: "Continue steps two and three",
      saved_result: "authoritative saved report" }));
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  vi.stubEnv("AGENTTEAMS_CONTROLLER_URL", `http://127.0.0.1:${(server.address() as any).port}`);
});

afterEach(async () => {
  await recovery?.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await resetMatrixTestStores();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

function create(run: (params: any) => Promise<unknown> = async () => { throw new Error("must not infer"); }) {
  const runtime = getMatrixRuntime();
  const core = { ...runtime, channel: { ...runtime.channel,
    routing: { ...runtime.channel.routing, resolveAgentRoute: () => ({ agentId: "main" }) },
    inbound: { ...runtime.channel.inbound, buildContext: buildChannelInboundEventContext, run },
  } };
  const send = vi.fn(async (_room, _content, _txn, guard) => { await guard?.(); return "$reply"; });
  recovery = new AgentTeamsTaskRecovery({ core: core as never, cfg, accountId: "default", userId: "@worker:example.org",
    signal: new AbortController().signal, warn: vi.fn(),
    client: { getJoinedRooms: async () => [task.room_id], sendMessage: send } as never });
  return send;
}

async function seed(sessionKey: string, content = "step one persisted") {
  const sessionId = randomUUID();
  await upsertSessionEntry({ agentId: "main", sessionKey, entry: { sessionId, updatedAt: Date.now() } });
  await appendSessionTranscriptMessageByIdentity({ agentId: "main", sessionKey, sessionId,
    message: { role: "user", content } });
  return sessionId;
}

it("uses the shared scoped client and resends saved bytes without inference or external input", async () => {
  const run = vi.fn(); const send = create(run);
  Object.assign(task, { status: "submitted", result_path: "shared/tasks/T/report.md" });
  Object.assign(task.execution.checkpoint, { result: { key: "saved", size: 26, sha256: "fixture" },
    delivery: "pending", reply_txn: "original-transaction" });
  await recovery.scan();
  expect(run).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledOnce();
  expect(send.mock.calls[0][1].body).toBe("authoritative saved report");
  expect(send.mock.calls[0][2]).toBe("original-transaction");
  expect(task.execution.checkpoint.delivery).toBe("delivered");
  expect(task.execution.generation).toBe(2);
  expect(headers.length).toBeGreaterThan(3);
});

it("reuses only real fresh SQLite sessions matching the authoritative checkpoint and transcript", async () => {
  create();
  const selection = await recovery.selectSession("team", task, "main");
  const sessionKey = selection.sessionKey;
  const nativeId = await seed(sessionKey);
  await recovery.remember(identity, selection, "main");
  expect((await recovery.selectSession("team", task, "main")).sessionKey).toBe(sessionKey);
  expect(sessionCache).toMatchObject({ native_ref: sessionKey, checkpoint_version: 4, config_generation: 1 });
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 120000);
  expect((await recovery.selectSession("team", task, "main")).sessionKey).not.toBe(sessionKey);
  vi.restoreAllMocks();
  task.execution.checkpoint.version++;
  expect((await recovery.selectSession("team", task, "main")).sessionKey).not.toBe(sessionKey);
  task.execution.checkpoint.version--;
  configGeneration++;
  expect((await recovery.selectSession("team", task, "main")).sessionKey).not.toBe(sessionKey);
  await recovery.remember(identity, selection, "main");
  expect(sessionCache).toMatchObject({ config_generation: 1 });
  configGeneration--;
  await appendSessionTranscriptMessageByIdentity({ agentId: "main", sessionKey, sessionId: nativeId,
    message: { role: "assistant", content: "uncommitted newer native state" } });
  expect((await recovery.selectSession("team", task, "main")).sessionKey).not.toBe(sessionKey);
  expect((await getSessionEntryAsync({ agentId: "main", sessionKey }))?.sessionId).toBe(nativeId);
});

it("keeps source identity in the native context and delivers the authoritative report after native closure", async () => {
  task.execution.generation = 1;
  const run = vi.fn(async (params) => {
    const input = await params.adapter.ingest(params.raw);
    const turn = await params.adapter.resolveTurn(input, { kind: "message", canStartAgentTurn: true }, {});
    expect(turn.ctxPayload.MessageSid).toBe("$assignment-source");
    await turn.replyOptions.onAgentRunStart("native-run");
    await seed(turn.route.sessionKey, turn.ctxPayload.BodyForAgent);
    Object.assign(task, { status: "submitted", result_path: "shared/tasks/T/report.md" });
    Object.assign(task.execution.checkpoint, { result: { key: "saved", sha256: "fixture", size: 26 },
      delivery: "pending", reply_txn: "saved-report-txn" });
    await turn.delivery.deliver({ text: "native summary" }, { kind: "final" });
    return { dispatched: true };
  });
  const send = create(run);
  await recovery.acceptSource("T", task.room_id, "$assignment-source");
  await expect.poll(() => task.execution.checkpoint.delivery, { timeout: 20000 }).toBe("delivered");
  expect(send).toHaveBeenCalledOnce();
  expect(send.mock.calls[0][1].body).toBe("authoritative saved report");
  expect(sessionCache).toBeNull();
  await recovery.scan();
  expect(run).toHaveBeenCalledOnce();
});

it("automatically starts a claimed native turn and stops its real exec after ownership changes", async () => {
  const pidfile = path.join(home, "pid"); const marker = path.join(home, "must-not-run");
  const exec = createExecTool({ host: "gateway", security: "full", ask: "off", allowBackground: false, notifyOnExit: false });
  const run = vi.fn(async (params) => {
    const input = await params.adapter.ingest(params.raw);
    const turn = await params.adapter.resolveTurn(input, { kind: "message", canStartAgentTurn: true }, {});
    expect(turn.ctxPayload.BodyForAgent).toContain("Continue steps two and three");
    expect(turn.ctxPayload.BodyForAgent).toContain('"completed_steps": ["one"]');
    await turn.replyOptions.onAgentRunStart("native-run");
    await exec.execute("owned-task-tool", { command: `echo $$ > ${pidfile}; sleep 30; touch ${marker}`,
      timeoutSeconds: 40 }, turn.replyOptions.abortSignal);
    return { dispatched: true };
  });
  const send = create(run);
  await recovery.scan();
  await expect.poll(() => fs.existsSync(pidfile), { timeout: 20000 }).toBe(true);
  const pid = Number(fs.readFileSync(pidfile, "utf8").trim());
  task.execution.process_id = "successor";
  task.execution.generation++;
  await expect.poll(() => { try { process.kill(pid, 0); return false; } catch { return true; } },
                    { timeout: 20000 }).toBe(true);
  expect(fs.existsSync(marker)).toBe(false);
  expect(send).not.toHaveBeenCalled();
  expect(run).toHaveBeenCalledOnce();
});

it("retains a completed native admission across Matrix monitor reload in the same process", async () => {
  const run = vi.fn(async (params) => {
    const turn = await params.adapter.resolveTurn({}, {}, {});
    await turn.replyOptions.onAgentRunStart("native-progress");
    await seed(turn.route.sessionKey);
    Object.assign(task.execution.checkpoint, { result: { key: "progress", sha256: "fixture", size: 26 },
      delivery: "pending", reply_txn: "progress-transaction" });
    await turn.delivery.deliver({ text: "step one complete" }, { kind: "final" });
  });
  create(run);
  await recovery.scan();
  await expect.poll(() => sessionCache, { timeout: 20000 }).not.toBeNull();
  await recovery.stop();
  expect(task.status).toBe("in_progress");
  expect(task.execution.checkpoint.delivery).toBe("delivered");
  create(run);
  await recovery.scan();
  await recovery.stop();
  expect(run).toHaveBeenCalledOnce();
});

it("does not use a replayed assignment event as the native turn identity on recovery", async () => {
  let ids: string[] = [];
  const run = vi.fn(async (params) => {
    const input = await params.adapter.ingest(params.raw);
    const turn = await params.adapter.resolveTurn(input, {}, {});
    ids = [input.id, turn.ctxPayload.MessageSid];
    await turn.replyOptions.onAgentRunStart("native-recovery");
    Object.assign(task.execution.checkpoint, { result: { key: "saved", sha256: "fixture", size: 26 },
      delivery: "pending", reply_txn: "recovery-txn" });
    await turn.delivery.deliver({ text: "continued" }, { kind: "final" });
  });
  create(run);
  await recovery.acceptSource("T", task.room_id, "$assignment-source");
  await expect.poll(() => task.execution.checkpoint.delivery, { timeout: 4000 }).toBe("delivered");
  expect(ids).toEqual(["recovery:team/T:2", "recovery:team/T:2"]);
  expect(run).toHaveBeenCalledOnce();
});
