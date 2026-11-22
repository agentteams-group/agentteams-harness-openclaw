// Preserve the upstream qaRuntime owner, cache, cleanup and postbuild sequence.
import assert from 'node:assert/strict';
import { resolveBuildAllSteps, runBuildAllSteps } from '/opt/openclaw/scripts/build-all.mts';
import { withDistArtifactOwnership } from '/opt/openclaw/scripts/lib/dist-artifact-ownership.mts';
import { runLegacySourceUpdateBuild } from '/opt/openclaw/scripts/lib/source-update-build.mts';

function serialSteps(env = process.env) {
  const official = resolveBuildAllSteps('qaRuntime', env);
  assert.equal(official.filter(step => step.label === 'tsdown').length, 1);
  const steps = official.map(step => step.label === 'tsdown'
    ? { ...step, args: [...step.args, '--concurrency', '1'] } : step);
  assert.equal(steps.length, official.length);
  for (let i = 0; i < official.length; i++) {
    assert.deepEqual({ ...steps[i], args: official[i].args }, official[i]);
    assert.deepEqual(steps[i].args, official[i].label === 'tsdown'
      ? [...official[i].args, '--concurrency', '1'] : official[i].args);
  }
  return steps;
}

const steps = serialSteps();
if (process.argv.includes('--plan')) {
  console.log(JSON.stringify({ profile: 'qaRuntime', completeOfficialSequence: true,
    changes: 'tsdown --concurrency 1 only', steps: steps.map(({label, args, env}) => ({label, args, env})) }, null, 2));
} else {
  const run = (env: NodeJS.ProcessEnv) => runBuildAllSteps('qaRuntime', { env, steps: serialSteps(env) });
  const legacyExit = await runLegacySourceUpdateBuild('qaRuntime', run);
  process.exitCode = legacyExit ?? (await withDistArtifactOwnership(process.cwd(), () => run(process.env))).exitCode;
}
