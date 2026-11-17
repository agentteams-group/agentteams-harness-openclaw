// Native conversations are caches. The shared Python client owns Task protocol.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { finalizeInboundContext } from "openclaw/plugin-sdk/reply-runtime";
import {
  evaluateSessionFreshness, getSessionEntryAsync, loadTranscriptEventsSync,
  resolveChannelResetConfig, resolveSessionResetPolicy,
} from "openclaw/plugin-sdk/session-store-runtime";
import { getMatrixRuntime } from "../../runtime.js";
import type { CoreConfig } from "../../types.js";
import type { MatrixClient } from "../sdk.js";
import { resolveMatrixMonitorAccessState } from "./access-state.js";

type Identity = { task_id: string; team_id: string; generation: number; instance_id: string };
type Checkpoint = { delivery?: string; reply_txn?: string };
type Task = { task_id: string; room_id: string; status: string; title?: string; execution: {
  generation: number; instance_id: string; process_id: string; state: string; checkpoint?: Checkpoint;
} };
type Snapshot = { instance_id: string; tasks: Array<{ task: Task; team_id: string; etag: string }> };
type Claimed = { task: Task; saved_result: string; resume_text: string; checkpoint_digest: string };
type Cache = { runtime: "openclaw"; authority: string; session_key: string; session_id: string;
  checkpoint_digest: string; native_digest: string; expires_at: number };
type RPC = <T>(request: Record<string, unknown>) => Promise<T>;

export class RecoveryRPCError extends Error {
  constructor(public kind: string, message: string) { super(message); }
}

export const taskRecoveryRPC: RPC = (request) => new Promise((resolve, reject) => {
  const child = spawn("python3", ["/opt/agentteams/scripts/lib/task_recovery_rpc.py"], {
    stdio: ["pipe", "pipe", "ignore"], timeout: 20000,
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; if (output.length > 2 * 1024 * 1024) child.kill(); });
  child.on("error", () => reject(new RecoveryRPCError("unavailable", "Recovery client unavailable")));
  child.on("close", () => {
    try {
      const result = JSON.parse(output);
      if (result.error) reject(new RecoveryRPCError(result.error, result.message ?? "Recovery request failed"));
      else if (Object.hasOwn(result, "value")) resolve(result.value);
      else reject(new RecoveryRPCError("unavailable", "Recovery client returned no result"));
    } catch { reject(new RecoveryRPCError("unavailable", "Recovery client returned no result")); }
  });
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify(request));
});

const monitors = new Map<string, AgentTeamsTaskRecovery>();
export function getAgentTeamsTaskRecovery(accountId: string) { return monitors.get(accountId); }

export class AgentTeamsTaskRecovery {
  readonly ready: Promise<void>;
  private admitReady!: () => void;
  private scanning = false;
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;
  private admitted = new Set<string>();
  private sources = new Map<string, string>();
  private active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private cachePath: string;
  private authority: string;
  private rpc: RPC;

  constructor(private options: {
    core: ReturnType<typeof getMatrixRuntime>; client: MatrixClient; cfg: CoreConfig;
    accountId: string; userId: string; signal: AbortSignal;
    warn: (message: string) => void; rpc?: RPC;
  }) {
    this.rpc = options.rpc ?? taskRecoveryRPC;
    this.ready = new Promise((resolve) => { this.admitReady = resolve; });
    const home = process.env.AGENTTEAMS_WORKER_HOME ?? os.homedir();
    this.cachePath = path.join(home, "runtime", "openclaw-task-sessions.json");
    // An endpoint change invalidates this local cache, never the durable Task ID.
    this.authority = this.digest([process.env.AGENTTEAMS_CONTROLLER_URL, options.userId]);
  }

  private digest(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
  private key(team: string, task: string) { return this.digest([team, task]); }
  private readCache(): Record<string, Cache> {
    try {
      const value = JSON.parse(fs.readFileSync(this.cachePath, "utf8"));
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  }

  start() {
    const scan = () => { void this.scan().catch(() => this.options.warn("Task recovery deferred; authority unavailable")); };
    scan();
    this.timer = setInterval(scan, 10000);
    this.timer.unref();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const run of this.active.values()) run.controller.abort();
    await Promise.allSettled([...this.active.values()].map((run) => run.done));
    if (monitors.get(this.options.accountId) === this) monitors.delete(this.options.accountId);
    this.admitReady();
  }

  async acceptSource(task: string, room: string, event: string) {
    this.sources.set(this.key(room, task), event);
    await this.scan();
  }

  async selectSession(team: string, task: Task, checkpointDigest: string, agentId: string) {
    const prefix = `agent:${agentId}:agentteams-task:${this.key(team, task.task_id)}:`;
    const cached = this.readCache()[this.key(team, task.task_id)];
    if (cached?.runtime === "openclaw" && cached.authority === this.authority
        && typeof cached.session_key === "string" && cached.session_key.startsWith(prefix) && cached.expires_at > Date.now() / 1000
        && cached.checkpoint_digest === checkpointDigest) {
      const native = await this.native(cached.session_key, agentId);
      if (native && native.entry.sessionId === cached.session_id && native.digest === cached.native_digest) {
        return cached.session_key;
      }
    }
    return prefix + randomUUID();
  }

  private async native(sessionKey: string, agentId: string) {
    const entry = await getSessionEntryAsync({ sessionKey, agentId, readConsistency: "latest" });
    if (!entry || entry.abortedLastRun) return;
    const policy = resolveSessionResetPolicy({ sessionCfg: this.options.cfg.session, resetType: "group",
      resetOverride: resolveChannelResetConfig({ sessionCfg: this.options.cfg.session, channel: "matrix" }) });
    if (!evaluateSessionFreshness({ updatedAt: entry.updatedAt, now: Date.now(), policy }).fresh) return;
    const events = loadTranscriptEventsSync({ sessionKey, agentId, sessionId: entry.sessionId });
    if (!events.length) return;
    return { entry, digest: this.digest({ entry, events }) };
  }

  async remember(identity: Identity, sessionKey: string, agentId: string) {
    const current = await this.rpc<{ checkpoint_digest: string }>({ action: "current", identity });
    const native = await this.native(sessionKey, agentId);
    if (!native) return;
    const cache = this.readCache();
    cache[this.key(identity.team_id, identity.task_id)] = { runtime: "openclaw", authority: this.authority,
      session_key: sessionKey, session_id: native.entry.sessionId, native_digest: native.digest,
      checkpoint_digest: current.checkpoint_digest, expires_at: Date.now() / 1000 + 86400 };
    fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
    const pending = this.cachePath + "." + randomUUID();
    try {
      fs.writeFileSync(pending, JSON.stringify(cache), { mode: 0o600 });
      fs.renameSync(pending, this.cachePath);
    } finally { fs.rmSync(pending, { force: true }); }
  }

  async scan() {
    if (this.scanning || this.stopped || this.options.signal.aborted) return;
    this.scanning = true;
    try {
      const snapshot = await this.rpc<Snapshot>({ action: "discover" });
      const rooms = await this.options.client.getJoinedRooms();
      // Recover existing execution/delivery before starting newly assigned work.
      snapshot.tasks.sort((a, b) => Number(a.task.status === "assigned") - Number(b.task.status === "assigned"));
      for (const entry of snapshot.tasks) {
        if (this.stopped || this.options.signal.aborted) break;
        const key = this.key(entry.team_id, entry.task.task_id);
        if (this.active.has(key)) continue;
        const old = entry.task.execution;
        const admission = `${key}/${old?.instance_id}/${old?.generation}`;
        if (this.admitted.has(admission) && old?.checkpoint?.delivery !== "pending") continue;
        try {
          const claimed = await this.rpc<Claimed>({ action: "claim", snapshot, entry });
          if (this.stopped || this.options.signal.aborted) break;
          const task = claimed.task;
          const identity = { task_id: task.task_id, team_id: entry.team_id,
            generation: task.execution.generation, instance_id: task.execution.instance_id };
          if (!rooms.includes(task.room_id)) continue;
          if (task.execution.checkpoint?.delivery === "pending") {
            await this.deliver(identity, task.room_id, claimed.saved_result, task.execution.checkpoint);
            continue;
          }
          if (task.status === "submitted") continue;
          const admitted = `${key}/${identity.instance_id}/${identity.generation}`;
          if (this.admitted.has(admitted)) continue;
          const route = this.options.core.channel.routing.resolveAgentRoute({ cfg: this.options.cfg,
            channel: "matrix", accountId: this.options.accountId, peer: { kind: "channel", id: task.room_id } });
          const sessionKey = await this.selectSession(entry.team_id, task, claimed.checkpoint_digest, route.agentId);
          if (this.stopped || this.options.signal.aborted) break;
          const controller = new AbortController();
          this.admitted.add(admitted);
          const done = Promise.resolve().then(() => this.runNative(identity, task, claimed.resume_text,
            sessionKey, route.agentId, controller.signal)).catch(() => {
              this.options.warn("Task native turn ended; retain authoritative checkpoint for recovery");
            }).finally(() => this.active.delete(key));
          this.active.set(key, { controller, done });
        } catch (error) {
          if (!(error instanceof RecoveryRPCError && error.kind === "conflict")) {
            this.options.warn("Owned Task recovery deferred; keep its authoritative state");
          }
        }
      }
      this.admitReady();
    } finally { this.scanning = false; }
  }

  private async deliver(identity: Identity, room: string, text: string, cp: Checkpoint) {
    if (!cp.reply_txn) throw new Error("Saved reply has no durable transaction");
    const event = await this.options.client.sendMessage(room, { msgtype: "m.text", body: text,
      "org.agentteams.progress_only": true, "m.mentions": { user_ids: [] } }, cp.reply_txn,
      async () => { await this.rpc({ action: "current", identity }); });
    await this.rpc({ action: "delivered", identity, event_id: event });
  }

  private async runNative(identity: Identity, task: Task, text: string, sessionKey: string,
                          agentId: string, runSignal: AbortSignal) {
    const { core, cfg, client, userId, accountId, signal } = this.options;
    const abort = AbortSignal.any([signal, runSignal]);
    const controller = this.active.get(this.key(identity.team_id, identity.task_id))!.controller;
    let checking = false;
    const guard = setInterval(() => {
      if (checking) return;
      checking = true;
      void this.rpc({ action: "current", identity }).catch((error) => {
        if (error instanceof RecoveryRPCError && error.kind === "conflict") controller.abort();
      }).finally(() => { checking = false; });
    }, 1000);
    guard.unref();
    let nativeStarted = false;
    try {
      await this.rpc({ action: "current", identity });
      if (!(await client.getJoinedRooms()).includes(task.room_id)) throw new Error("Task room not joined yet");
      text += "\nYour Task tools are bundled as an MCP stdio server. Call them with your native terminal tool:\n"
        + "mcporter call --stdio python3 --stdio-arg /opt/agentteams/plugins/teamharness/mcp/server.py taskflow --args '<JSON arguments>'\n"
        + "Use this taskflow tool for ack_task, checkpoint_task and submit_task; preserve the current Task/team IDs. "
        + "Its scoped credentials and process identity are inherited. Do not replace it with raw Task metadata writes.\n";
      const messageId = this.sources.get(this.key(task.room_id, task.task_id))
        ?? `recovery:${identity.team_id}/${task.task_id}:${identity.generation}`;
      const access = await resolveMatrixMonitorAccessState({ accountId, senderId: userId, isRoom: true,
        conversationId: task.room_id, allowFrom: [userId], storeAllowFrom: [], groupPolicy: "allowlist",
        groupAllowFrom: [userId], roomUsers: [userId], dmPolicy: "disabled" });
      const ingress = await access.resolveMessageIngress({ agentId, sessionKey, nativeChannelId: task.room_id,
        messageId, inboundEventKind: "user_request" });
      const ctxPayload = core.channel.inbound.buildContext({ channel: "matrix", channelIngress: ingress,
        finalize: finalizeInboundContext, messageId, timestamp: Date.now(), from: `matrix:channel:${task.room_id}`,
        sender: { id: userId }, conversation: { kind: "channel", id: task.room_id, nativeChannelId: task.room_id },
        route: { agentId, sessionKey, routeSessionKey: sessionKey },
        reply: { to: `room:${task.room_id}`, nativeChannelId: task.room_id },
        message: { body: text, rawBody: text, bodyForAgent: text, commandBody: text },
        access: { commands: { authorized: false } }, extra: { GroupId: task.room_id, GroupSubject: task.title } });
      let finalText = "";
      await core.channel.inbound.run({ channel: "matrix", accountId, raw: task,
        adapter: {
          ingest: () => ({ id: messageId, rawText: text, textForAgent: text }),
          resolveTurn: () => ({ cfg, channel: "matrix", accountId, route: { agentId, sessionKey }, ctxPayload,
            record: { createIfMissing: true }, replyOptions: { abortSignal: abort,
              onAgentRunStart: () => { nativeStarted = true; } },
            delivery: { deliver: async (payload, info) => { if (info.kind === "final") finalText = payload.text ?? ""; } },
          }),
        },
      });
      if (abort.aborted) throw new Error("Task native execution stopped");
      const reply = await this.rpc<{ saved: { task?: Task; room_id?: string; execution: Task["execution"] }; text: string }>({
        action: "prepare_reply", identity, text: finalText });
      const cp = reply.saved.execution.checkpoint!;
      if (cp.delivery !== "delivered") await this.deliver(identity, task.room_id, reply.text, cp);
      await this.remember(identity, sessionKey, agentId);
    } catch (error) {
      // The native run promise settles after its tools; do not clear unknown effects.
      if (nativeStarted) await this.rpc({ action: "interrupted", identity }).catch(() => {});
      else this.admitted.delete(`${this.key(identity.team_id, identity.task_id)}/${identity.instance_id}/${identity.generation}`);
      throw error;
    } finally { clearInterval(guard); }
  }
}

export function createAgentTeamsTaskRecovery(options: ConstructorParameters<typeof AgentTeamsTaskRecovery>[0]) {
  if (!process.env.AGENTTEAMS_CONTROLLER_URL || !process.env.AGENTTEAMS_PROCESS_ID
      || !["standalone", "worker", "remote-member", "leader", "team_leader"].includes(process.env.AGENTTEAMS_AGENT_ROLE ?? "worker")) return;
  const recovery = new AgentTeamsTaskRecovery(options);
  monitors.set(options.accountId, recovery);
  return recovery;
}
