import { spawn } from 'node:child_process';

export interface ProcessResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export interface ProcessOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string;
  readonly shell?: boolean;
  readonly maxOutputBytes?: number;
}

const DEFAULT_MAX_OUTPUT = 2 * 1024 * 1024;

export async function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  const started = Date.now();
  const limit = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: options.shell ?? false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
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
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({
        status: code ?? -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        durationMs: Date.now() - started,
      });
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}
