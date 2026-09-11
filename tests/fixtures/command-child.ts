import { spawn } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';

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

if (args.has('--spawn-holder')) {
  const holder = spawn(
    process.execPath,
    [
      new URL('./command-child.ts', import.meta.url).pathname,
      '--hold',
      '--ignore-term',
    ],
    { stdio: 'inherit' },
  );
  holder.unref();
}
process.on('SIGTERM', () => {
  if (!args.has('--ignore-term')) process.exit(143);
});
if (args.has('--hold')) setInterval(() => undefined, 1_000);
else await waitForMarker();
const requested = Number(
  valueAfter('--exit') ?? process.env.PI_WATCH_COMMAND_EXIT ?? '0',
);
process.exit(Number.isInteger(requested) ? requested : 0);
