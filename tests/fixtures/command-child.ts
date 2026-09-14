import { spawn } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';

async function emit(
  stream: NodeJS.WritableStream,
  byte: string,
  count: number,
) {
  const chunk = byte.repeat(Math.min(count, 64 * 1024));
  let remaining = count;
  while (remaining > 0) {
    const value = chunk.slice(0, Math.min(chunk.length, remaining));
    remaining -= value.length;
    if (!stream.write(value))
      await new Promise<void>((resolve) => stream.once('drain', resolve));
  }
}

const positional = process.argv.slice(2);
const args = new Set(positional);
const valueAfter = (name: string): string | undefined => {
  const index = positional.indexOf(name);
  return index < 0 ? undefined : positional[index + 1];
};
if (positional.includes('--ps-garbage')) {
  process.stdout.write('not-a-process-group\\n');
  process.exit(0);
}
if (positional.includes('--ps-large')) {
  process.stdout.write('x'.repeat(8192));
  process.exit(0);
}
if (positional.includes('--ps-hang')) {
  setInterval(() => undefined, 1_000);
}
const marker = valueAfter('--marker') ?? process.env.PI_WATCH_COMMAND_MARKER;
const output =
  valueAfter('--env-file') ?? process.env.PI_WATCH_COMMAND_ENV_FILE;
if (output !== undefined)
  appendFileSync(
    output,
    `${Object.keys(process.env)
      .sort()
      .map((key) => `${key}=${process.env[key] ?? ''}`)
      .join('\n')}\n`,
  );

const waitForMarker = (): Promise<void> =>
  new Promise((resolve) => {
    if (marker === undefined) return resolve();
    const timer = setInterval(() => {
      if (existsSync(marker)) {
        clearInterval(timer);
        resolve();
      }
    }, 25);
  });
const holderReadyFile = valueAfter('--holder-ready-file');
const waitForHolderReady = async (): Promise<void> => {
  if (holderReadyFile === undefined || !args.has('--spawn-holder')) return;
  const deadline = Date.now() + 5_000;
  while (!existsSync(holderReadyFile)) {
    if (Date.now() >= deadline) {
      process.stderr.write('holder readiness timed out\n');
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

if (args.has('--spawn-holder')) {
  const holderArgs = [
    new URL('./command-child.ts', import.meta.url).pathname,
    '--hold',
    '--ignore-term',
  ];
  for (const option of [
    '--hold-ms',
    '--heartbeat-file',
    '--heartbeat-ms',
    '--holder-ready-file',
  ]) {
    const value = valueAfter(option);
    if (value !== undefined) holderArgs.push(option, value);
  }
  const holder = spawn(process.execPath, holderArgs, { stdio: 'inherit' });
  const pidFile = valueAfter('--holder-pid-file');
  if (pidFile !== undefined && holder.pid !== undefined)
    appendFileSync(pidFile, `${holder.pid}\n`);
  holder.unref();
}
process.on('SIGTERM', () => {
  if (!args.has('--ignore-term')) process.exit(143);
});
if (args.has('--hold') && holderReadyFile !== undefined)
  appendFileSync(holderReadyFile, 'r');

const STDOUT_TEXT_LIMIT_BYTES = 4_096;
const stdoutText = valueAfter('--stdout-text');
if (stdoutText !== undefined) {
  if (Buffer.byteLength(stdoutText, 'utf8') > STDOUT_TEXT_LIMIT_BYTES) {
    process.stderr.write('stdout text exceeds the fixture limit\n');
    process.exit(1);
  }
  process.stdout.write(stdoutText);
}
await emit(process.stdout, 'o', Number(valueAfter('--stdout-bytes') ?? 0));
await emit(process.stderr, 'e', Number(valueAfter('--stderr-bytes') ?? 0));
const sideEffect = valueAfter('--side-effect');
if (sideEffect !== undefined) appendFileSync(sideEffect, 'x');
await waitForHolderReady();

if (args.has('--hold')) {
  const heartbeatFile = valueAfter('--heartbeat-file');
  const heartbeatMs = Number(valueAfter('--heartbeat-ms') ?? 0);
  if (heartbeatFile !== undefined && heartbeatMs > 0)
    setTimeout(() => appendFileSync(heartbeatFile, 'h'), heartbeatMs);
  const holdMs = Number(valueAfter('--hold-ms') ?? 0);
  if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs));
  else
    await new Promise(() => {
      setInterval(() => undefined, 1_000);
    });
} else {
  await waitForMarker();
}
const requested = Number(
  valueAfter('--exit') ?? process.env.PI_WATCH_COMMAND_EXIT ?? '0',
);
process.exitCode = Number.isInteger(requested) ? requested : 0;
