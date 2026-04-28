import { Worker } from "node:worker_threads";
import type { SoliditySourceUnit } from "@solidity-workbench/common";

/**
 * Result returned by a worker parse. Mirrors the worker's `ParseResponse`
 * shape minus the request id and the optional `workerError` channel.
 */
export interface PoolParseResult {
  sourceUnit: SoliditySourceUnit;
  errors: { message: string; range: unknown }[];
  text: string;
}

interface WorkerEnvelope {
  uri: string;
  sourceUnit?: SoliditySourceUnit;
  errors?: { message: string; range: unknown }[];
  text?: string;
  workerError?: string;
}

/**
 * Main-thread pool of parser workers.
 *
 * Maintains a fixed-size set of `Worker` instances and dispatches
 * `parse(uri, text)` requests to whichever worker is idle. When every
 * worker is busy, callers wait on a FIFO queue — the next worker to
 * finish hands itself directly to the longest-waiting caller.
 *
 * One worker handles one parse at a time. A worker only listens for
 * one in-flight request per call so a stale `message` from a
 * previously-cancelled parse can't leak into a later caller's promise
 * (we attach + remove `message` and `error` listeners per request).
 *
 * Bulk indexing fans out POOL_SIZE files via `Promise.all`, which
 * naturally maps to one parse per worker. Hovers, completions, and
 * other LSP requests stay on the main thread and don't touch the pool.
 */
export class ParserPool {
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly waiters: ((w: Worker) => void)[] = [];
  private terminated = false;

  constructor(workerPath: string, size: number) {
    if (size < 1) throw new Error(`ParserPool size must be >= 1, got ${size}`);
    for (let i = 0; i < size; i++) {
      const w = new Worker(workerPath);
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  get size(): number {
    return this.workers.length;
  }

  async parse(uri: string, text: string): Promise<PoolParseResult> {
    if (this.terminated) {
      throw new Error("ParserPool: parse() called after terminate()");
    }
    const worker = await this.acquire();
    try {
      return await this.runOnWorker(worker, uri, text);
    } finally {
      this.release(worker);
    }
  }

  async terminate(): Promise<void> {
    if (this.terminated) return;
    this.terminated = true;
    // Reject any pending waiters before tearing down the workers — they'd
    // otherwise hang forever waiting for a worker that's no longer coming.
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter(undefined as unknown as Worker);
    }
    await Promise.all(this.workers.map((w) => w.terminate()));
    this.workers.length = 0;
    this.idle.length = 0;
  }

  private acquire(): Promise<Worker> {
    const next = this.idle.pop();
    if (next !== undefined) return Promise.resolve(next);
    return new Promise<Worker>((resolve) => this.waiters.push(resolve));
  }

  private release(worker: Worker): void {
    if (this.terminated) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(worker);
    } else {
      this.idle.push(worker);
    }
  }

  private runOnWorker(w: Worker, uri: string, text: string): Promise<PoolParseResult> {
    return new Promise<PoolParseResult>((resolve, reject) => {
      const onMessage = (msg: WorkerEnvelope) => {
        cleanup();
        if (msg.uri !== uri) {
          // Should never happen since one parse = one worker = one
          // response, but guard against it anyway so a confused
          // worker can't fulfill the wrong promise.
          reject(new Error(`Worker returned uri=${msg.uri}, expected ${uri}`));
          return;
        }
        if (msg.workerError) {
          reject(new Error(msg.workerError));
          return;
        }
        if (msg.sourceUnit && msg.errors !== undefined && msg.text !== undefined) {
          resolve({ sourceUnit: msg.sourceUnit, errors: msg.errors, text: msg.text });
          return;
        }
        reject(new Error("Worker returned a malformed parse response"));
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        w.off("message", onMessage);
        w.off("error", onError);
      };
      w.on("message", onMessage);
      w.on("error", onError);
      w.postMessage({ uri, text });
    });
  }
}
