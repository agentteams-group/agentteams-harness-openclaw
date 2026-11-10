# agentteams-harness-openclaw

OpenClaw Worker runtime integration for
[AgentTeams](https://github.com/agentscope-ai/AgentTeams), migrated from `worker/`
at commit `67c8e807c4d210537b753f8121710181825bdfac` (Apache-2.0).
Upstream [OpenClaw](https://github.com/openclaw/openclaw) is MIT-licensed.

The entrypoint restores the existing Worker workspace from MinIO/OSS, migrates
OpenClaw configuration, refreshes platform credentials, starts file sync and
launches the gateway. Worker and Team Leader roles use the same image.
Environment variables and workspace paths are unchanged.

## Ownership

This repository owns the Worker Dockerfile, entrypoint, image checks and
independent image publication. AgentTeams consumes a fixed commit as its
`worker/` Git submodule, retaining its existing build paths and image names.

Manager bootstrap, the shared `openclaw-base/` image, Controller/CRDs, platform
plugins, role templates, Helm, installers and full-stack tests remain in
AgentTeams. This migration does not change the upstream OpenClaw version.
The default base pins OpenClaw `v2026.10.9` and the Node 24.22.1 floor; the
Controller CLI image defaults to `v1.2.6`. `versions.env` pins shared shell
libraries to the source AgentTeams commit.

## Build and validate

Docker BuildKit is required. No adjacent AgentTeams checkout is needed:

```sh
make test
make build
make smoke
```

For local shared-library changes:

```sh
make build SHARED_CONTEXT=../AgentTeams/shared/lib
```

Use `DOCKER_BUILD_ARGS` to override image inputs, for example
`--build-arg OPENCLAW_BASE_IMAGE=your-registry/openclaw-base:your-tag`.
CI builds the image and checks the installed OpenClaw pin, CLI commands,
bootstrap dependencies and configuration migration. Real Matrix/LLM delivery
continues to be covered by AgentTeams integration tests.

Version tags (`v*`) publish `linux/amd64` and `linux/arm64` images to
`ghcr.io/agentteams-group/agentteams-harness-openclaw` after the image checks pass.
`make push VERSION=v0.1.0` publishes the same image manually.

## Existing Workers

The runtime environment contract is documented in `scripts/worker-entrypoint.sh`.
Reuse the existing Worker name, storage prefix and workspace when replacing its
image. Allow active turns and workspace sync to finish before replacement.
This is a restart-based image upgrade; unsynced container-local data must be
preserved before removing the old container.
