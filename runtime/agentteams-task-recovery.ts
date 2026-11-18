// Native conversations are caches. The shared Python client owns Task protocol.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { finalizeInboundContext } from "openclaw/plugin-sdk/reply-runtime";
import {
  evaluateSessionFreshness, getSessionEntryAsync, loadTranscriptEventsSync,
  resolveChannelResetConfig, resolveSessionResetPolicy,
} from "openclaw/plugin-sdk/session-store-runtime";
import { getMatrixRuntime } from "../../runtime.js";
import type { CoreConfig } from "../../types.js";
import type { MatrixClient } from "../sdk.js";
import { resolveMatrixMonitorAccessState } from "./access-state.js";
import { registerTaskTraceContext } from "./agentteams-trace-context.js";

type Identity = { task_id: string; team_id: string; generation: number; instance_id: string; process_id: string };
type Checkpoint = { delivery?: string; reply_txn?: string };
type Task = { task_id: string; room_id: string; status: string; title?: string; execution: {
  generation: number; instance_id: string; process_id: string; state: string; checkpoint?: Checkpoint;
} };
type Snapshot = { instance_id: string; tasks: Array<{ task: Task; team_id: string; etag: string }> };
type Claimed = { task: Task; saved_result: string; resume_text: string };
type SessionWork = { kind: "task"; team_id: string; task_id: string };
type SessionView = { compatible: boolean; config_generation: number;
  cache?: { native_ref: string } | null };
type SessionSelection = { sessionKey: string; configGeneration?: number };
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
// Channel/plugin reload is not a new Worker execution generation.
const admissionSlot = Symbol.for("agentteams.openclaw.task-admissions");
const processState = globalThis as typeof globalThis & { [admissionSlot]?: Map<string, Set<string>> };
const processAdmissions = processState[admissionSlot] ??= new Map<string, Set<string>>();
export function getAgentTeamsTaskRecovery(accountId: string) { return monitors.get(accountId); }

export class AgentTeamsTaskRecovery {
  readonly ready: Promise<void>;
  private admitReady!: () => void;
  private scanning = false;
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;
  private admitted: Set<string>;
  private sources = new Map<string, string>();
  private active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private registered = false;
  private rpc: RPC;

  constructor(private options: {
    core: ReturnType<typeof getMatrixRuntime>; client: MatrixClient; cfg: CoreConfig;
    accountId: string; userId: string; signal: AbortSignal;
    warn: (message: string) => void; rpc?: RPC;
  }) {
    this.rpc = options.rpc ?? taskRecoveryRPC;
    this.ready = new Promise((resolve) => { this.admitReady = resolve; });
    const scope = this.digest([process.env.AGENTTEAMS_CONTROLLER_URL, options.userId, options.accountId,
      process.env.AGENTTEAMS_PROCESS_ID]);
    this.admitted = processAdmissions.get(scope) ?? new Set<string>();
    processAdmissions.set(scope, this.admitted);
  }

  private digest(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
  private key(team: string, task: string) { return this.digest([team, task]); }
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

  private async sessionView(work: SessionWork) {
    try {
      return await this.rpc<SessionView>({ action: "session.load", runtime: "openclaw", work });
    } catch (error) {
      // Unresolved effects still go through the authority's recovery path.
      if (error instanceof RecoveryRPCError && error.kind === "conflict") return;
      throw error;
    }
  }

  async selectSession(team: string, task: Task, agentId: string): Promise<SessionSelection> {
    const prefix = `agent:${agentId}:agentteams-task:${this.key(team, task.task_id)}:`;
    const view = await this.sessionView({ kind: "task", team_id: team, task_id: task.task_id });
    const cached = view?.cache?.native_ref;
    if (view?.compatible && cached?.startsWith(prefix)) {
      const digest = await this.native(cached, agentId);
      if (digest && await this.rpc<boolean>({ action: "session.usable", runtime: "openclaw",
        snapshot: view, native_ref: cached, native_digest: digest })) {
        return { sessionKey: cached, configGeneration: view.config_generation };
      }
    }
    return { sessionKey: prefix + randomUUID(), configGeneration: view?.config_generation };
  }

  private async native(sessionKey: string, agentId: string) {
    const entry = await getSessionEntryAsync({ sessionKey, agentId, readConsistency: "latest" });
    if (!entry || entry.abortedLastRun) return;
    const policy = resolveSessionResetPolicy({ sessionCfg: this.options.cfg.session, resetType: "group",
      resetOverride: resolveChannelResetConfig({ sessionCfg: this.options.cfg.session, channel: "matrix" }) });
    if (!evaluateSessionFreshness({ updatedAt: entry.updatedAt, now: Date.now(), policy }).fresh) return;
    const events = loadTranscriptEventsSync({ sessionKey, agentId, sessionId: entry.sessionId });
    if (!events.length) return;
    return this.digest({ sessionId: entry.sessionId, events });
  }

  async remember(identity: Identity, selection: SessionSelection, agentId: string) {
    if (selection.configGeneration === undefined) return;
    const work: SessionWork = { kind: "task", team_id: identity.team_id, task_id: identity.task_id };
    const snapshot = await this.sessionView(work);
    if (!snapshot || snapshot.config_generation !== selection.configGeneration) return;
    const digest = await this.native(selection.sessionKey, agentId);
    if (!digest) return;
    await this.rpc({ action: "session.remember", runtime: "openclaw", work, snapshot, identity,
      native_ref: selection.sessionKey, native_digest: digest, expires_at: Math.floor(Date.now() / 1000) + 86400 });
  }

  async scan() {
    if (this.scanning || this.stopped || this.options.signal.aborted) return;
    this.scanning = true;
    try {
      if (!this.registered) {
        await this.rpc({ action: "matrix.start", runtime: "openclaw" });
        this.registered = true;
      }
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
            generation: task.execution.generation, instance_id: task.execution.instance_id, process_id: task.execution.process_id };
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
          const selection = await this.selectSession(entry.team_id, task, route.agentId);
          if (this.stopped || this.options.signal.aborted) break;
          const controller = new AbortController();
          this.admitted.add(admitted);
          const done = Promise.resolve().then(() => this.runNative(identity, task, claimed.resume_text,
            selection, route.agentId, controller.signal)).catch(() => {
              this.options.warn("Task native turn ended; retain authoritative checkpoint for recovery");
            }).finally(() => this.active.delete(key));
          this.active.set(key, { controller, done });
        } catch (error) {
          if (!(error instanceof RecoveryRPCError && error.kind === "conflict")) {
            this.options.warn("Owned Task recovery deferred; keep its authoritative state");
          }
        }
      }
      await this.rpc({ action: "recovery.scanned" });
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

  private async runNative(identity: Identity, task: Task, text: string, selection: SessionSelection,
                          agentId: string, runSignal: AbortSignal) {
    const { sessionKey } = selection;
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
      registerTaskTraceContext(sessionKey, { "agentteams.task.id": identity.task_id,
        "agentteams.team.id": identity.team_id, "agentteams.room.id": task.room_id,
        "agentteams.execution.generation": identity.generation, "agentteams.event.id": messageId });
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
      if (reply.saved.task?.status === "in_progress") await this.remember(identity, selection, agentId);
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
