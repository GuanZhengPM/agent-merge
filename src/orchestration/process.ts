import { spawn } from 'node:child_process';

export interface ProcessResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly aborted: boolean;
}

export interface ProcessOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string;
  readonly shell?: boolean;
  readonly maxOutputBytes?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

const DEFAULT_MAX_OUTPUT = 2 * 1024 * 1024;

export async function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  const started = Date.now();
  const limit = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new RangeError('timeoutMs must be a positive finite number');
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: options.shell ?? false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
      forceTimer = setTimeout(() => {
        try {
          if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }, 1_000);
      forceTimer.unref();
    };
    const onAbort = (): void => {
      aborted = true;
      terminate();
    };
    const timeout = options.timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    timeout?.unref();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutBytes >= limit) return;
      const remaining = limit - stdoutBytes;
      stdout.push(chunk.subarray(0, remaining));
      stdoutBytes += Math.min(chunk.length, remaining);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= limit) return;
      const remaining = limit - stderrBytes;
      stderr.push(chunk.subarray(0, remaining));
      stderrBytes += Math.min(chunk.length, remaining);
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        status: code ?? -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        durationMs: Date.now() - started,
        timedOut,
        aborted,
      });
    });
    if (options.signal?.aborted === true) onAbort();
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}
