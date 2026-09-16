// Minimal HTTP/1.1 client over a unix socket, zero deps (Docker Engine API style).
// Completes on content-length or terminating chunk — the Engine keeps the
// connection open, so we must NOT wait for socket close.
import net from 'node:net';

export class SocketHttpError extends Error {
  constructor(message, { status = 0, body = '' } = {}) {
    super(message);
    this.name = 'SocketHttpError';
    this.status = status;
    this.body = body;
  }
}

/**
 * @param {string} socketPath
 * @param {string} method
 * @param {string} path already URL-encoded; may include query
 * @param {{headers?: Record<string,string>, body?: string|Buffer, timeoutMs?: number}} [opts]
 * @param {{raw?: boolean}} [mode] raw=true returns the body WITHOUT chunk-decoding
 *   (still framed to message boundaries; for Docker exec hijack streams)
 * @returns {Promise<{status: number, headers: Record<string,string>, body: Buffer}>}
 */
export function request(socketPath, method, path, opts = {}, mode = {}) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let headEnd = -1; // index after header terminator
    let headers = null;
    let status = 0;
    let settled = false;

    const sock = net.connect({ path: socketPath });
    sock.on('error', fail);

    const timer = setTimeout(() => {
      fail(new SocketHttpError(`request timeout ${method} ${path}`, { status: 0 }));
    }, opts.timeoutMs ?? 30_000);

    function cleanup() {
      clearTimeout(timer);
      sock.removeAllListeners('data');
      sock.removeAllListeners('end');
      sock.destroy();
    }
    function fail(err) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    }
    function done(bodyBuf) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ status, headers, body: bodyBuf });
    }

    sock.on('connect', () => {
      const payload = opts.body === undefined ? null : Buffer.from(opts.body);
      const headers2 = { Host: 'docker', Connection: 'close', ...opts.headers };
      if (payload) headers2['Content-Length'] = String(payload.length);
      const lines = [`${method} ${path} HTTP/1.1`];
      for (const [k, v] of Object.entries(headers2)) lines.push(`${k}: ${v}`);
      const head = Buffer.from(lines.join('\r\n') + '\r\n\r\n');
      sock.write(payload ? Buffer.concat([head, payload]) : head);
    });

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (headEnd === -1) {
        const sep = buf.indexOf('\r\n\r\n');
        if (sep === -1) return;
        headEnd = sep + 4;
        const headText = buf.subarray(0, sep).toString('latin1');
        const [statusLine, ...headerLines] = headText.split('\r\n');
        status = Number(statusLine.split(' ')[1]);
        headers = {};
        for (const l of headerLines) {
          const i = l.indexOf(':');
          if (i > 0) headers[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim();
        }
      }
      const bodyBuf = buf.subarray(headEnd);
      const isChunked = headers['transfer-encoding']?.toLowerCase().includes('chunked');
      let complete = null; // full decoded body when message complete, else null
      if (isChunked) {
        const r = dechunkPartial(bodyBuf);
        if (r.done) complete = r.body;
      } else {
        const want = Number(headers['content-length'] ?? 0);
        if (status === 204 || (status >= 100 && status < 200)) complete = Buffer.alloc(0);
        else if (bodyBuf.length >= want) complete = bodyBuf.subarray(0, want);
      }
      if (!complete) return;
      const err = status >= 400
        ? new SocketHttpError(`HTTP ${status} ${method} ${path}: ${complete.toString('utf8').slice(0, 400)}`, { status, body: complete.toString('utf8') })
        : null;
      if (err) fail(err);
      else done(complete);
    });

    sock.on('end', () => {
      // connection closed before message completed
      if (status && headers) {
        const bodyBuf = headEnd >= 0 ? buf.subarray(headEnd) : Buffer.alloc(0);
        if (status >= 400) {
          fail(new SocketHttpError(`HTTP ${status} ${method} ${path}: ${bodyBuf.toString('utf8').slice(0, 400)}`, { status, body: bodyBuf.toString('utf8') }));
        } else {
          done(bodyBuf);
        }
      } else {
        fail(new SocketHttpError(`connection closed before response: ${method} ${path}`));
      }
    });
  });
}

/**
 * Parse chunked framing; {done:false} while more data is needed.
 * @param {Buffer} buf
 * @returns {{done: boolean, body: Buffer}}
 */
export function dechunkPartial(buf) {
  const parts = [];
  let i = 0;
  for (;;) {
    const nl = buf.indexOf('\r\n', i);
    if (nl === -1) return { done: false, body: Buffer.alloc(0) };
    const size = parseInt(buf.subarray(i, nl).toString('latin1').split(';')[0], 16);
    if (Number.isNaN(size)) return { done: false, body: Buffer.alloc(0) };
    if (size === 0) return { done: true, body: Buffer.concat(parts) };
    if (buf.length < nl + 2 + size + 2) return { done: false, body: Buffer.alloc(0) };
    parts.push(buf.subarray(nl + 2, nl + 2 + size));
    i = nl + 2 + size + 2;
  }
}

/**
 * POST to the hijack endpoint /exec/{id}/start and collect the raw stream.
 * The Docker daemon answers with `application/vnd.docker.raw-stream`: after
 * the HTTP headers, multiplexed frames follow directly (no chunked framing),
 * and the daemon closes the connection when the exec exits.
 * @param {string} socketPath @param {string} execId @param {number} timeoutMs @param {string} [apiVersion]
 * @returns {Promise<Buffer>} raw framed stream
 */
export function execStartStream(socketPath, execId, timeoutMs, apiVersion = 'v1.47') {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let headEnd = -1;
    const sock = net.connect({ path: socketPath });
    const fail = (e) => { clearTimeout(timer); sock.destroy(); reject(e); };
    const timer = setTimeout(() => fail(new SocketHttpError(`exec stream timeout after ${timeoutMs}ms`, { status: 0 })), timeoutMs);
    sock.on('error', fail);
    sock.on('connect', () => {
      const body = JSON.stringify({ Detach: false });
      sock.write(
        `POST /${apiVersion}/exec/${execId}/start HTTP/1.1\r\nHost: docker\r\n` +
        `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      );
    });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (headEnd === -1) {
        const sep = buf.indexOf('\r\n\r\n');
        if (sep === -1) return;
        headEnd = sep + 4;
        const statusLine = buf.subarray(0, buf.indexOf('\r\n')).toString('latin1');
        const status = Number(statusLine.split(' ')[1]);
        if (status >= 400) {
          fail(new SocketHttpError(`HTTP ${status} exec start: ${buf.subarray(headEnd).toString('utf8').slice(0, 300)}`, { status }));
        }
      }
    });
    sock.on('end', () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(headEnd >= 0 ? buf.subarray(headEnd) : Buffer.alloc(0));
    });
  });
}

export function dechunk(buf) {
  return dechunkPartial(buf).body;
}

/**
 * Decode a Docker exec-stream (multiplexed frames: [type,0,0,0,len BE32][payload]).
 * @param {Buffer} buf
 * @returns {{stdout: string, stderr: string}}
 */
export function demuxExecStream(buf) {
  let stdout = '';
  let stderr = '';
  let i = 0;
  while (i + 8 <= buf.length) {
    const type = buf[i];
    const len = buf.readUInt32BE(i + 4);
    const payload = buf.subarray(i + 8, i + 8 + len);
    if (type === 1 || type === 0) stdout += payload.toString('utf8');
    else if (type === 2) stderr += payload.toString('utf8');
    i += 8 + len;
  }
  return { stdout, stderr };
}
