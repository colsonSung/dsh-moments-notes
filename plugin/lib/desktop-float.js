import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * Owns the native always-on-top capture window.
 *
 * The window is a small AppKit application that the Host starts as a child
 * process and drives over JSONL: the Host writes events to stdin, and the
 * window writes commands to stdout. It lives above ordinary windows on every
 * Space, which is what the in-page float cannot do.
 */
export class DesktopFloat {
  constructor(options = {}) {
    this.command = options.command || fileURLToPath(new URL('../native/bin/moments-float', import.meta.url));
    this.args = options.args || [];
    this.process = null;
    this.buffer = '';
    this.failure = '';
    this.handlers = new Set();
  }

  /** Register a listener for every command the window writes. */
  onCommand(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** Report whether the helper binary is present on this machine. */
  async available() {
    try {
      await access(this.command);
      return true;
    } catch {
      return false;
    }
  }

  /** Start the window. A window that is already open is kept. */
  async start() {
    if (this.isOpen()) return this.process;
    this.failure = '';
    const child = spawn(this.command, this.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.process = child;
    this.buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.consume(chunk));
    child.stderr.resume();
    child.once('error', (error) => {
      this.failure = error instanceof Error ? error.message : String(error);
    });
    child.once('close', () => {
      if (this.process === child) this.process = null;
    });
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        child.off('spawn', onSpawn);
        if (this.process === child) this.process = null;
        reject(error);
      };
      const onSpawn = () => {
        child.off('error', onError);
        resolve();
      };
      child.once('error', onError);
      child.once('spawn', onSpawn);
    });
    return child;
  }

  isOpen() {
    return Boolean(this.process && this.process.exitCode === null && !this.process.signalCode);
  }

  /** Send one event to the window. */
  async send(event) {
    const child = this.process;
    if (!child || child.exitCode !== null || child.signalCode || !child.stdin.writable) return false;
    child.stdin.write(JSON.stringify(event) + '\n');
    return true;
  }

  /** Close the window and wait for the process to leave. */
  async stop() {
    const child = this.process;
    if (!child) return;
    this.process = null;
    if (child.exitCode !== null || child.signalCode) return;
    if (child.stdin.writable) {
      child.stdin.write(JSON.stringify({ type: 'control', detail: 'close' }) + '\n');
      child.stdin.end();
    }
    const timer = setTimeout(() => child.kill('SIGTERM'), 1500);
    timer.unref();
    await Promise.race([
      new Promise((resolve) => child.once('close', resolve)),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
    clearTimeout(timer);
  }

  /** Split the stream into JSONL commands. */
  consume(chunk) {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.dispatch(line);
      index = this.buffer.indexOf('\n');
    }
  }

  dispatch(line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') return;
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // A broken listener must not take the window down.
      }
    }
  }
}
