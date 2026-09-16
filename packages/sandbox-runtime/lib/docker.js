// DockerRuntime — SandboxRuntime implementation over the Docker Engine API,
// raw HTTP on the unix socket (no SDK, no external deps).
import { request, execStartStream, demuxExecStream, SocketHttpError } from './sockhttp.js';
import { tarCreate } from './tar.js';
import { randomUUID } from 'node:crypto';

export const LABEL_MANAGED_BY = 'nexus.managed-by';
export const LABEL_MANAGED_VALUE = 'nexus-sandbox-runtime';

/**
 * Contract every SandboxRuntime implementation must satisfy.
 * @typedef {Object} SandboxRuntime
 * @property {(spec: CreateSpec) => Promise<string>} create   returns sandbox id
 * @property {(id: string) => Promise<void>} start
 * @property {(id: string, cmd: string[], opts?: ExecOpts) => Promise<ExecResult>} exec
 * @property {(id: string, files: Array<{path: string, content: string|Buffer}>) => Promise<void>} copyIn
 * @property {(id: string, timeoutMs?: number) => Promise<void>} stop
 * @property {(id: string) => Promise<void>} rm
 * @property {() => Promise<string[]>} cleanupOrphans
 */

/**
 * @typedef {Object} CreateSpec
 * @property {string} [image] default python:3.12-slim
 * @property {number} [cpus] CPU limit, cores (e.g. 0.5)
 * @property {number} [memoryMb] RAM limit in MiB
 * @property {number} [pidsLimit] max processes
 * @property {'bridge'|'none'} [network] default 'none' (deny by default)
 * @property {Record<string,string>} [env]
 * @property {string} [name]
 * @property {Record<string,string>} [labels]
 */

/**
 * @typedef {Object} ExecOpts
 * @property {number} [timeoutMs] hard timeout, kills the exec stream on expiry
 * @property {Record<string,string>} [env] injected at exec time only (secret isolation)
 * @property {string} [workdir]
 */

/**
 * @typedef {Object} ExecResult
 * @property {number} exitCode -1 when timed out
 * @property {string} stdout
 * @property {string} stderr
 * @property {boolean} timedOut
 */

const DEFAULT_IMAGE = 'python:3.12-slim';

export class DockerRuntime {
  /** @param {{socketPath?: string, apiVersion?: string}} [opts] */
  constructor(opts = {}) {
    this.socketPath = opts.socketPath ?? '/var/run/docker.sock';
    this.apiVersion = opts.apiVersion ?? 'v1.47';
    /** @type {Map<string,string>} sandbox id -> docker container id */
    this.containers = new Map();
    this.names = new Set();
  }

  /** @param {string} p @param {string} method @param {object} [o] @param {object} [m] */
  #api(p, method, o, m) {
    return request(this.socketPath, method, `/${this.apiVersion}${p}`, o, m);
  }

  /** @param {CreateSpec} spec @returns {Promise<string>} */
  async create(spec = {}) {
    const id = `sbx-${randomUUID().slice(0, 8)}`;
    const name = spec.name ?? id;
    const body = {
      Image: spec.image ?? DEFAULT_IMAGE,
      Cmd: ['tail', '-f', '/dev/null'],
      Env: Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${v}`),
      Labels: { [LABEL_MANAGED_BY]: LABEL_MANAGED_VALUE, 'nexus.sandbox-id': id, ...(spec.labels ?? {}) },
      HostConfig: {
        NanoCpus: spec.cpus != null ? Math.round(spec.cpus * 1e9) : undefined,
        Memory: spec.memoryMb != null ? spec.memoryMb * 1024 * 1024 : undefined,
        PidsLimit: spec.pidsLimit ?? 128,
        NetworkMode: spec.network === 'bridge' ? 'bridge' : 'none',
        AutoRemove: false,
        Dns: spec.network === 'bridge' ? undefined : [],
      },
      // filesystem stays inside the container layer; no host binds by default
    };
    // disk limit: docker needs a storage-capable driver; surfaced via exec test if set
    if (spec.diskMb != null) {
      body.HostConfig.StorageOpt = { 'size': `${spec.diskMb}m` };
    }
    const res = await this.#api(`/containers/create?name=${encodeURIComponent(name)}`, 'POST', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    this.containers.set(id, res.body.toString().trim() ? JSON.parse(res.body).Id : '');
    this.names.add(name);
    return id;
  }

  /**
   * Pull an image if the daemon doesn't have it yet. The Engine answers
   * /images/create with a chunked progress stream that terminates when the
   * pull is done, so the plain request() wait works (content-length absent,
   * dechunk sees the 0-size terminator).
   * @param {string} ref e.g. 'alpine:3.20' or 'python:3.12-slim'
   */
  async ensureImage(ref, timeoutMs = 180_000) {
    const exists = await this.#api(`/images/${encodeURIComponent(ref)}/json`, 'GET')
      .then(() => true)
      .catch((err) => {
        if (err instanceof SocketHttpError && err.status === 404) return false;
        throw err;
      });
    if (exists) return;
    // split tag: ':' counts only if the part after it has no '/' (registry:5000/x)
    const ci = ref.lastIndexOf(':');
    const hasTag = ci > -1 && !ref.slice(ci + 1).includes('/');
    const name = hasTag ? ref.slice(0, ci) : ref;
    const tag = hasTag ? ref.slice(ci + 1) : 'latest';
    const q = `fromImage=${encodeURIComponent(name)}&tag=${encodeURIComponent(tag)}`;
    await this.#api(`/images/create?${q}`, 'POST', { timeoutMs });
  }

  /** @param {string} id */
  async start(id) {
    const cid = this.#cid(id);
    await this.#api(`/containers/${cid}/start`, 'POST');
  }

  /** @param {string} id @param {string[]} cmd @param {ExecOpts} [opts] @returns {Promise<ExecResult>} */
  async exec(id, cmd, opts = {}) {
    const cid = this.#cid(id);
    const createRes = await this.#api(`/containers/${cid}/exec`, 'POST', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        AttachStdout: true, AttachStderr: true, Cmd: cmd,
        Env: Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`),
        WorkingDir: opts.workdir ?? undefined,
      }),
    });
    const execId = JSON.parse(createRes.body).Id;
    const timeoutMs = opts.timeoutMs ?? 30_000;
    try {
      const raw = await execStartStream(this.socketPath, execId, timeoutMs, this.apiVersion);
      const { stdout, stderr } = demuxExecStream(raw);
      // Exec may still be running when the stream closes; poll until done.
      let inspect = JSON.parse((await this.#api(`/exec/${execId}/json`, 'GET')).body);
      const deadline = Date.now() + 10_000;
      while (inspect.Running && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
        inspect = JSON.parse((await this.#api(`/exec/${execId}/json`, 'GET')).body);
      }
      return { exitCode: inspect.ExitCode ?? -1, stdout, stderr, timedOut: false };
    } catch (err) {
      if (err instanceof SocketHttpError && err.status === 0) {
        return { exitCode: -1, stdout: '', stderr: `hard timeout after ${timeoutMs}ms`, timedOut: true };
      }
      throw err;
    }
  }

  /**
   * Copy files into the sandbox. `files: [{path, content}]` — path is absolute
   * inside the container (its dirname must exist).
   * @param {string} id @param {Array<{path: string, content: string|Buffer}>} files
   */
  async copyIn(id, files) {
    const cid = this.#cid(id);
    for (const f of files) {
      const rel = f.path.replace(/^\/+/, '');
      const dir = '/' + (rel.split('/').slice(0, -1).join('/'));
      const tar = tarCreate([{ name: rel.split('/').pop(), content: f.content }]);
      await this.#api(`/containers/${cid}/archive?path=${encodeURIComponent(dir)}`, 'PUT', {
        headers: { 'Content-Type': 'application/x-tar' },
        body: tar,
      });
    }
  }

  /** @param {string} id @param {number} [timeoutMs] stop grace period */
  async stop(id, timeoutMs = 3000) {
    const cid = this.#cid(id);
    const t = Math.max(0, Math.ceil(timeoutMs / 1000));
    try {
      await this.#api(`/containers/${cid}/stop?t=${t}`, 'POST', { timeoutMs: timeoutMs + 10_000 });
    } catch (err) {
      if (!(err instanceof SocketHttpError && (err.status === 304 || err.status === 404))) throw err;
    }
  }

  /** @param {string} id */
  async rm(id) {
    const cid = this.#cid(id);
    try {
      await this.#api(`/containers/${cid}?force=true&v=true`, 'DELETE');
    } catch (err) {
      if (!(err instanceof SocketHttpError && err.status === 404)) throw err;
    }
    this.containers.delete(id);
  }

  /**
   * Remove managed containers not tracked by this runtime (crashed cron runs,
   * leaked sandboxes). Returns removed sandbox names.
   */
  async cleanupOrphans() {
    const res = await this.#api(
      '/containers/json?all=true&filters=' +
      encodeURIComponent(JSON.stringify({ label: [`${LABEL_MANAGED_BY}=${LABEL_MANAGED_VALUE}`] })),
      'GET',
    );
    const tracked = new Set(this.containers.values());
    const removed = [];
    for (const c of JSON.parse(res.body)) {
      if (tracked.has(c.Id)) continue;
      try {
        await this.#api(`/containers/${c.Id}?force=true&v=true`, 'DELETE');
        removed.push(c.Names?.[0]?.replace(/^\//, '') ?? c.Id.slice(0, 12));
      } catch { /* raced with another cleaner — fine */ }
    }
    return removed;
  }

  /** @param {string} id @returns {string} */
  #cid(id) {
    const cid = this.containers.get(id);
    if (!cid) throw new Error(`unknown sandbox id: ${id}`);
    return cid;
  }
}
