include versions.env

IMAGE ?= ghcr.io/agentteams-group/agentteams-harness-openclaw
VERSION ?= dev
PLATFORMS ?= linux/amd64,linux/arm64
AT_SOURCE ?= .deps/AgentTeams
SHARED_CONTEXT ?= https://github.com/agentscope-ai/AgentTeams.git\#$(AT_REF):shared/lib
TEAMHARNESS_CONTEXT ?= https://github.com/agentscope-ai/AgentTeams.git\#$(AT_REF):plugins/teamharness
AT_CONTEXT ?= https://github.com/agentscope-ai/AgentTeams.git\#$(AT_REF)
BUILD_ARGS = --build-context agentteams=$(AT_CONTEXT) --build-context shared=$(SHARED_CONTEXT) --build-context teamharness=$(TEAMHARNESS_CONTEXT)

.PHONY: build push test smoke direct-control-smoke matrix-restart-smoke task-recovery-smoke task-protocol-smoke observability-smoke
build:
	docker build $(BUILD_ARGS) $(DOCKER_BUILD_ARGS) -t $(IMAGE):$(VERSION) .

push:
	docker buildx build --platform $(PLATFORMS) $(BUILD_ARGS) $(DOCKER_BUILD_ARGS) -t $(IMAGE):$(VERSION) --push .

test:
	bash -n scripts/worker-entrypoint.sh
	AT_SOURCE=$(abspath $(AT_SOURCE)) AGENTTEAMS_LOG_LIB_DIR=$(abspath $(AT_SOURCE))/shared/lib python3 -m unittest discover -s tests -p 'test_*.py'

smoke:
	docker run --rm --entrypoint bash -v "$(CURDIR)/tests/image-smoke.sh:/tmp/image-smoke.sh:ro" $(IMAGE):$(VERSION) /tmp/image-smoke.sh
	docker run --rm --network none --entrypoint python3 -v "$(CURDIR)/tests/native_runtime_config_smoke.py:/tmp/native_runtime_config_smoke.py:ro" $(IMAGE):$(VERSION) /tmp/native_runtime_config_smoke.py

direct-control-smoke:
	docker run --rm --entrypoint bash -v "$(CURDIR)/tests:/dm:ro" $(IMAGE):$(VERSION) -ec 'cd /opt/openclaw; git archive HEAD test | tar -x; cp /dm/direct-control.test.ts extensions/matrix/src/matrix/monitor/agentteams-direct-control.test.ts; cp /dm/task-coordination.test.ts extensions/matrix/src/matrix/monitor/agentteams-task-coordination.test.ts; cp /dm/assistant-coordination.test.ts extensions/matrix/src/matrix/monitor/agentteams-assistant-coordination.test.ts; pnpm exec vitest run --config /dm/direct-control.vitest.config.ts extensions/matrix/src/matrix/monitor/agentteams-direct-control.test.ts extensions/matrix/src/matrix/monitor/agentteams-task-coordination.test.ts extensions/matrix/src/matrix/monitor/agentteams-assistant-coordination.test.ts'

matrix-restart-smoke:
	docker run --rm --network none --entrypoint bash -v "$(CURDIR)/tests:/dm:ro" $(IMAGE):$(VERSION) -ec 'cd /opt/openclaw; git archive HEAD test | tar -x; cp /dm/matrix-restart.test.ts extensions/matrix/src/matrix/monitor/agentteams-matrix-restart.test.ts; pnpm exec vitest run --config /dm/direct-control.vitest.config.ts extensions/matrix/src/matrix/monitor/agentteams-matrix-restart.test.ts'

task-recovery-smoke:
	docker run --rm --entrypoint bash -v "$(CURDIR)/tests:/dm:ro" $(IMAGE):$(VERSION) -ec 'cd /opt/openclaw; git archive HEAD test | tar -x; cp /dm/task-recovery.test.ts extensions/matrix/src/matrix/monitor/agentteams-task-recovery.test.ts; pnpm exec vitest run --config /dm/direct-control.vitest.config.ts extensions/matrix/src/matrix/monitor/agentteams-task-recovery.test.ts'
	docker run --rm --network none --entrypoint python3 -v "$(CURDIR)/tests/native_task_tools_smoke.py:/tmp/native_task_tools_smoke.py:ro" $(IMAGE):$(VERSION) /tmp/native_task_tools_smoke.py

observability-smoke:
	docker run --rm --entrypoint bash -v "$(CURDIR)/tests:/dm:ro" $(IMAGE):$(VERSION) -ec 'cd /opt/openclaw; git archive HEAD test | tar -x; cp /dm/observability.test.ts extensions/diagnostics-otel/src/agentteams-observability.test.ts; pnpm exec vitest run --config /dm/direct-control.vitest.config.ts extensions/diagnostics-otel/src/agentteams-observability.test.ts'


task-protocol-smoke:
	docker run --rm --network none --entrypoint bash -v "$(CURDIR)/tests:/dm:ro" $(IMAGE):$(VERSION) -ec 'cd /opt/openclaw; git archive HEAD test | tar -x; for name in task-protocol task-checkpoint task-journal task-queue task-terminal; do cp /dm/$$name.test.ts src/agents/agentteams-$$name.test.ts; done; pnpm exec vitest run --config /dm/direct-control.vitest.config.ts src/agents/agentteams-task-protocol.test.ts src/agents/agentteams-task-checkpoint.test.ts src/agents/agentteams-task-journal.test.ts src/agents/agentteams-task-queue.test.ts src/agents/agentteams-task-terminal.test.ts'
