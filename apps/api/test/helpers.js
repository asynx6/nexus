// Test helpers: fake SandboxRuntime + tiny http client against the dispatch fn.
// We never hit the real network — the dispatch handler is invoked directly
// via a stub IncomingMessage + ServerResponse pair (no Node http server).

import { Readable } from "node:stream";

class StubRes {
  constructor() {
    this.statusCode = 200;
    this.headers = {};
    this.body = [];
    this.headersSent = false;
    this._writableEnded = false;
  }
  get writableEnded() { return this._writableEnded; }
  _write(chunk, _enc, cb) { this.body.push(Buffer.from(chunk)); cb(); }
  setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; }
  getHeader(k) { return this.headers[k.toLowerCase()]; }
  removeHeader(k) { delete this.headers[k.toLowerCase()]; }
  writeHead(s, h) {
    this.statusCode = s;
    if (h) for (const [k, v] of Object.entries(h)) this.setHeader(k, v);
    this.headersSent = true;
    return this;
  }
  write(chunk) {
    this.headersSent = true;
    this.body.push(Buffer.from(typeof chunk === "string" ? chunk : chunk));
    return true;
  }
  end(chunk) {
    if (chunk) this.write(chunk);
    this._writableEnded = true;
    return this;
  }
  json() { return JSON.parse(Buffer.concat(this.body).toString("utf8") || "{}"); }
  text() { return Buffer.concat(this.body).toString("utf8"); }
  on() { return this; }
  once() { return this; }
  emit() { return true; }
  destroy() {}
}

function stubReq({ method = "GET", url = "/", headers = {}, body = null }) {
  const req = new Readable({ read() {} });
  req.method = method;
  req.url = url;
  req.headers = headers;
  if (body !== null) {
    const buf = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    process.nextTick(() => { req.push(buf); req.push(null); });
  } else {
    process.nextTick(() => req.push(null));
  }
  return req;
}

export async function callApi(dispatch, { method = "GET", url = "/", headers = {}, body = null }) {
  const req = stubReq({ method, url, headers, body });
  const res = new StubRes();
  await dispatch(req, res);
  await new Promise((r) => setImmediate(r));
  return {
    status: res.statusCode,
    headers: res.headers,
    json: () => res.json(),
    text: () => res.text(),
    ended: () => res.writableEnded,
  };
}

export class FakeRuntime {
  created = [];
  started = new Set();
  #counter = 0;
  async create(spec) {
    const id = "sbx-fake-" + (++this.#counter).toString().padStart(4, "0");
    this.created.push({ id, spec });
    return id;
  }
  async start(id) { this.started.add(id); }
  async exec() { return { exitCode: 0, stdout: "", stderr: "", timedOut: false }; }
  async copyIn() {}
  async stop() {}
  async rm() {}
  async cleanupOrphans() { return []; }
}
