import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { utilityPaths } from '../src/test-seams.ts';

const root = join(process.cwd(), 'dist');
const guardian = join(root, 'guardian.js');
const utilities = utilityPaths();
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function waitForGone(pid: number, timeout = 5_000): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (!processExists(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`process ${pid} did not exit`);
}
function killChildGroup(child: ReturnType<typeof spawn>): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already exited */
    }
  }
}
test('guardian refuses direct launch without IPC', {
  timeout: 10_000,
}, async () => {
  const child = spawn(process.execPath, [guardian, '--job', 'fixture'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const status = await new Promise<number>((resolve) =>
    child.once('exit', (code) => resolve(code ?? 1)),
  );
  assert.notEqual(status, 0);
});

test('guardian rejects early, duplicate, and late grants but launches once', {
  timeout: 20_000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-watch-guardian-protocol-'));
  const marker = join(dir, 'marker');
  const child = spawn(process.execPath, [guardian], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc', 'pipe', 'pipe'],
  });
  const messages: Array<Record<string, unknown>> = [];
  const waitMessage = async (
    type: string,
  ): Promise<Record<string, unknown>> => {
    const end = Date.now() + 10_000;
    while (Date.now() < end) {
      const found = messages.findIndex((message) => message.type === type);
      if (found >= 0)
        return messages.splice(found, 1)[0] as Record<string, unknown>;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail(`timed out waiting for ${type}`);
  };
  child.on('message', (message: unknown) => {
    if (typeof message === 'object' && message !== null)
      messages.push(message as Record<string, unknown>);
  });
  try {
    const hello = await waitMessage('hello');
    child.send({ type: 'grant' });
    await waitMessage('protocol_violation');
    child.send({
      type: 'hello_reply',
      runnerPid: process.pid,
      command: `printf x >> ${marker}`,
      cwd: dir,
      deadlineAtMs: Date.now() + 20_000,
      psPath: utilities.ps,
      shPath: utilities.sh,
    });
    await waitMessage('topology');
    child.send({ type: 'grant' });
    await waitMessage('shell_spawned');
    child.send({ type: 'grant' });
    await waitMessage('protocol_violation');
    child.send({ type: 'grant' });
    await waitMessage('protocol_violation');
    await waitMessage('shell_exit');
    assert.equal(readFileSync(marker, 'utf8'), 'x');
    void hello;
  } finally {
    killChildGroup(child);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('guardian exits at readiness timeout when hello is never answered', {
  timeout: 10_000,
}, async () => {
  const child = spawn(process.execPath, [guardian], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc', 'pipe', 'pipe'],
  });
  try {
    const status = await new Promise<number>((resolve) =>
      child.once('exit', (code) => resolve(code ?? 1)),
    );
    assert.notEqual(status, 0);
  } finally {
    killChildGroup(child);
  }
});

test('guardian disconnect stops an in-flight topology probe', {
  timeout: 10_000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-watch-guardian-probe-'));
  const probeLog = join(dir, 'probe.pid');
  const fifo = join(dir, 'probe.fifo');
  const ps = join(dir, 'ps-ignore-term.sh');
  writeFileSync(
    ps,
    `#!/bin/sh
trap '' TERM
mkfifo ${JSON.stringify(fifo)}
exec 3<>${JSON.stringify(fifo)}
rm -f ${JSON.stringify(fifo)}
printf '%s\\n' "$$" > ${JSON.stringify(probeLog)}
read line <&3
`,
  );
  chmodSync(ps, 0o700);
  const child = spawn(process.execPath, [guardian], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc', 'pipe', 'pipe'],
  });
  let probePid: number | undefined;
  try {
    const hello = await new Promise<{ type?: unknown }>((resolve) =>
      child.once('message', resolve),
    );
    assert.equal(hello.type, 'hello');
    child.send({
      type: 'hello_reply',
      runnerPid: process.pid,
      command: 'exit 0',
      cwd: dir,
      deadlineAtMs: Date.now() + 10_000,
      psPath: ps,
      shPath: utilities.sh,
    });
    const end = Date.now() + 5_000;
    while (!existsSync(probeLog) && Date.now() < end)
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(existsSync(probeLog), true);
    probePid = Number(readFileSync(probeLog, 'utf8').trim());
    assert.ok(Number.isInteger(probePid));
    const exited = new Promise<void>((resolve) =>
      child.once('exit', () => resolve()),
    );
    child.disconnect();
    await exited;
    await waitForGone(probePid);
  } finally {
    if (probePid !== undefined && processExists(probePid)) {
      try {
        process.kill(probePid, 'SIGKILL');
      } catch {
        /* already exited */
      }
    }
    killChildGroup(child);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('guardian does not launch before grant', { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-watch-guardian-'));
  const child = spawn(process.execPath, [guardian], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc', 'pipe', 'pipe'],
  });
  try {
    const hello = await new Promise<{ type?: unknown }>((resolve) =>
      child.once('message', resolve),
    );
    assert.equal(hello.type, 'hello');
    const topology = new Promise<{ type?: unknown }>((resolve) => {
      const onMessage = (message: unknown): void => {
        if (
          typeof message === 'object' &&
          message !== null &&
          (message as { type?: unknown }).type === 'topology'
        ) {
          child.off('message', onMessage);
          resolve(message as { type?: unknown });
        }
      };
      child.on('message', onMessage);
    });
    child.send({
      type: 'hello_reply',
      runnerPid: process.pid,
      command: `printf x >> ${join(dir, 'marker')}`,
      cwd: dir,
      deadlineAtMs: Date.now() + 10_000,
      psPath: utilities.ps,
      shPath: utilities.sh,
    });
    assert.equal((await topology).type, 'topology');
    const exited = new Promise<void>((resolve) =>
      child.once('exit', () => resolve()),
    );
    child.disconnect();
    await exited;
    const markerPath = join(dir, 'marker');
    assert.equal(
      existsSync(markerPath) ? readFileSync(markerPath, 'utf8') : '',
      '',
    );
  } finally {
    killChildGroup(child);
    rmSync(dir, { recursive: true, force: true });
  }
});
