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

Remaining work includes all configuration/asset ownership and successful user
setting writes, native crypto/cursor persistence (including the existing Matrix
reset/re-login flow), startup room and Task discovery, process-bound execution
admission, checkpoint-aware session reuse/rebuild, automatic continuation without
new Matrix input, result delivery and unknown-effect verification. Stop/tool
termination and the full six-Harness/30-direction matrix remain unaccepted.
Track implementation and evidence in agentscope-ai/AgentTeams#1631.
