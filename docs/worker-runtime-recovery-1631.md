# Standard Worker startup (#1631)

Status: configuration startup implemented; full session/Task recovery incomplete.

When `runtime/runtime.yaml` is available, startup validates the common Worker
contract, derives a private `runtime/compat-config.json`, validates it through
the installed OpenClaw schema and points the SDK at it. A managed model does
not read the older `openclaw.json`. Missing bindings, wrong identity and native
validation failures stop publication/startup. Worker home remains the stable
Controller-supplied workspace, independent of `.openclaw` sessions.

The adapter projects Matrix policy/identity, model/gateway bindings, subagent
model selection and resolved heartbeat. The standard record remains authority;
the cache is mode 0600 and excluded from uploads by the shared Core sync/policy.
Heartbeat resolution preserves explicit Worker overrides and inherited Leader
cadence. Native-only options and all common settings/assets are not yet fully
represented by this adapter.

Once the SDK is ready, standard-mode synchronization fetches this record, not
the compatibility object. Invalid desired configuration terminates the running
gateway rather than continuing indefinitely under stale authority. Updates
retain a device token acquired during the same process only while Matrix
identity, endpoint and credential binding remain unchanged. Startup always
resolves its own bindings instead of using an older cache. This token rule is
covered locally; actual Matrix crypto/session continuation still needs E2E.

Older Controllers without the standard record keep their external compatibility
path. Older shared Manager records without transport also retain that path;
this change does not claim standardized Manager startup is complete.

Validation is separate from execution recovery: host tests exercise config
projection and the actual shell watcher with synthetic SDK/storage boundaries.
`make smoke` runs the installed OpenClaw config validator and reads effective
values back, with networking disabled. Neither is Task execution, native
inference, a real object-store producer flow or full gateway startup.

The native Matrix monitor now discovers self-scoped Tasks on startup and polls
them before admitting new assignments. Its JSON bridge delegates claims and
reply mutations to Core's shared recovery client. Native conversation selection
checks the actual SQLite entry/transcript, SDK expiration and shared checkpoint
digest. Missing or stale sessions get a new native conversation with Task and
checkpoint context; other Harnesses' sessions are never imported. Saved pending
results use their original Matrix transaction without inference. Ownership
conflicts abort the native run and its tools. Uncertain native failures preserve
the authoritative verification requirement. This requires the matching Controller
Task recovery API; unavailability defers admission rather than executing unfenced.

Four installed-SDK tests pass with the real Python HTTP client, SQLite transcript
and native exec cancellation, but fixture authority/Matrix/model boundaries.
Native mcporter also discovers the bundled ack/checkpoint/submit stdio tools.
These tests do not prove actual full-gateway model inference or Task E2E.

Remaining work includes all configuration/asset ownership and successful user
setting writes, real native crypto/cursor persistence and replacement snapshots,
and actual startup/source-event/model/tool/delivery integration. Real restart,
cross-Harness Task continuation and the full six-Harness/30-direction matrix
remain unaccepted for this adapter.
Track implementation and evidence in agentscope-ai/AgentTeams#1631.
