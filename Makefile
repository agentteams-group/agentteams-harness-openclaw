include versions.env

IMAGE ?= ghcr.io/agentteams-group/agentteams-harness-openclaw
VERSION ?= dev
PLATFORMS ?= linux/amd64,linux/arm64
SHARED_CONTEXT ?= https://github.com/agentscope-ai/AgentTeams.git\#$(AT_REF):shared/lib
BUILD_ARGS = --build-context shared=$(SHARED_CONTEXT)

.PHONY: build push test smoke
build:
	docker build $(BUILD_ARGS) $(DOCKER_BUILD_ARGS) -t $(IMAGE):$(VERSION) .

push:
	docker buildx build --platform $(PLATFORMS) $(BUILD_ARGS) $(DOCKER_BUILD_ARGS) -t $(IMAGE):$(VERSION) --push .

test:
	bash -n scripts/worker-entrypoint.sh
	python3 -m unittest discover -s tests -p 'test_*.py'

smoke:
	docker run --rm --entrypoint bash -v "$(CURDIR)/tests/image-smoke.sh:/tmp/image-smoke.sh:ro" $(IMAGE):$(VERSION) /tmp/image-smoke.sh

direct-control-smoke:
	docker run --rm --entrypoint bash -v "$(CURDIR)/tests:/dm:ro" $(IMAGE):$(VERSION) -ec 'cd /opt/openclaw; git archive HEAD test | tar -x; cp /dm/direct-control.test.ts extensions/matrix/src/matrix/monitor/agentteams-direct-control.test.ts; pnpm exec vitest run --config /dm/direct-control.vitest.config.ts extensions/matrix/src/matrix/monitor/agentteams-direct-control.test.ts'
