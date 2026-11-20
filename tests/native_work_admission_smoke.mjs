import assert from 'node:assert/strict';
const watchdog = setTimeout(() => { console.error('Native Matrix admission did not settle'); process.exit(1); }, 15000);
const { createMatrixMonitorTaskRunner } = await import('/opt/openclaw/extensions/matrix/src/matrix/monitor/task-runner.ts');
const { tryBeginGatewayRootWorkAdmission, isGatewaySubordinateWorkAdmissionClosed, resetGatewayWorkAdmission } = await import('/opt/openclaw/src/process/gateway-work-admission.ts');
resetGatewayWorkAdmission();
const failures = [];
const runner = createMatrixMonitorTaskRunner({logger: {warn: (...args) => failures.push(args)}, logVerboseMessage() {}});
const admission = tryBeginGatewayRootWorkAdmission('native-matrix-test');
assert.ok(admission);
let executed = false;
await admission.run(async () => {
  admission.release();
  assert.equal(isGatewaySubordinateWorkAdmissionClosed(), true);
  await runner.runDetachedTask('retained Matrix callback', async () => {
    assert.equal(isGatewaySubordinateWorkAdmissionClosed(), false, 'a new Matrix event needs its own active root');
    executed = true;
  });
});
await runner.waitForIdle();
runner.close();
assert.deepEqual(failures, []);
assert.equal(executed, true);
await runner.runDetachedTask('after close', async () => assert.fail('closed monitor admitted new work'));
clearTimeout(watchdog);
console.log('Native Matrix work admission: PASS');
