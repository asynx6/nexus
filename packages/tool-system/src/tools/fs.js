// Filesystem tools — always operate INSIDE the sandbox via SandboxRuntime,
// never on the host (plan §5: the agent's files live in the container).
// read/exec use `exec`; write uses copyIn (tar upload); edit is a
// read-modify-write with exact-match semantics, like a disciplined sed.
import { EVENTS } from '@nexus/shared';
import { makeEvent } from '@nexus/event-system';
import { requireSandbox, safePath } from './_sandbox.js';

const MAX_BYTES = 1_048_576; // 1 MiB per read/write — keeps tool payloads sane
const MAX_BIN_BASE64 = 11_010_000; // 8 MiB decoded — binary transfer cap for upload/download

function emit(ctx, name, data) {
  if (ctx.bus) ctx.bus.emit(makeEvent(name, data, ctx.agentId ?? null));
}

export function fsTools() {
  return [
    {
      name: 'fs.read',
      description: 'Read a text file inside the sandbox (max 1 MiB).',
      permission: 'fs.read',
      timeoutMs: 10_000,
      schema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'absolute path inside the sandbox' } },
        required: ['path'],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const { runtime, sandboxId } = requireSandbox(ctx);
        const p = safePath(args.path);
        const st = await runtime.exec(sandboxId, ['test', '-f', p]);
        if (st.exitCode !== 0) throw new Error(`no such file: ${p}`);
        const size = await runtime.exec(sandboxId, ['wc', '-c', p]);
        const bytes = parseInt(size.stdout.trim(), 10) || 0;
        if (bytes > MAX_BYTES) throw new Error(`file too large (${bytes} > ${MAX_BYTES} bytes)`);
        const r = await runtime.exec(sandboxId, ['cat', p]);
        if (r.exitCode !== 0) throw new Error(`read failed: ${r.stderr.trim() || r.exitCode}`);
        return { path: p, bytes, content: r.stdout };
      },
    },
    {
      name: 'fs.write',
      description: 'Create or overwrite a text file inside the sandbox (max 1 MiB). Parent directory must exist.',
      permission: 'fs.write',
      timeoutMs: 10_000,
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const { runtime, sandboxId } = requireSandbox(ctx);
        const p = safePath(args.path);
        if (Buffer.byteLength(args.content, 'utf8') > MAX_BYTES) throw new Error('content exceeds 1 MiB');
        const exists = (await runtime.exec(sandboxId, ['test', '-f', p])).exitCode === 0;
        // copyIn needs the parent dir; create it (absolute canonical path,
        // already permission-checked, so the mkdir stays inside allowed roots)
        await runtime.exec(sandboxId, ['mkdir', '-p', p.slice(0, p.lastIndexOf('/')) || '/']);
        await runtime.copyIn(sandboxId, [{ path: p, content: args.content }]);
        emit(ctx, exists ? EVENTS.FILE_MODIFIED : EVENTS.FILE_CREATED, { path: p, bytes: Buffer.byteLength(args.content, 'utf8') });
        return { path: p, created: !exists, bytes: Buffer.byteLength(args.content, 'utf8') };
      },
    },
    {
      name: 'fs.edit',
      description: 'Replace an exact string in a sandbox file. old_text must match exactly once unless all=true.',
      permission: 'fs.write',
      timeoutMs: 10_000,
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_text: { type: 'string' },
          new_text: { type: 'string' },
          all: { type: 'boolean', description: 'replace every occurrence (default false)' },
        },
        required: ['path', 'old_text', 'new_text'],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const { runtime, sandboxId } = requireSandbox(ctx);
        const p = safePath(args.path);
        const rd = await fsReadAt(runtime, sandboxId, p);
        const count = splitCount(rd, args.old_text);
        if (count === 0) throw new Error('old_text not found in file');
        if (count > 1 && !args.all) throw new Error(`old_text matches ${count} times; pass all=true or add context`);
        const updated = args.all ? rd.split(args.old_text).join(args.new_text)
          : rd.slice(0, rd.indexOf(args.old_text)) + args.new_text + rd.slice(rd.indexOf(args.old_text) + args.old_text.length);
        if (Buffer.byteLength(updated, 'utf8') > MAX_BYTES) throw new Error('result exceeds 1 MiB');
        await runtime.copyIn(sandboxId, [{ path: p, content: updated }]);
        emit(ctx, EVENTS.FILE_MODIFIED, { path: p, replacements: count });
        return { path: p, replacements: count };
      },
    },
    {
      name: 'fs.download',
      description: 'Fetch a file from the sandbox as base64 (binary-safe, max 8 MiB). Use for images, archives, audio.',
      permission: 'fs.read',
      timeoutMs: 30_000,
      schema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'absolute path inside the sandbox' } },
        required: ['path'],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const { runtime, sandboxId } = requireSandbox(ctx);
        const p = safePath(args.path);
        if (!p) throw new Error('invalid path');
        const st = await runtime.exec(sandboxId, ['test', '-f', p]);
        if (st.exitCode !== 0) throw new Error(`no such file: ${p}`);
        const r = await runtime.exec(sandboxId, ['base64', '-w0', p]);
        if (r.exitCode !== 0) throw new Error(`download failed: ${r.stderr.trim() || r.exitCode}`);
        if (r.stdout.length > MAX_BIN_BASE64) throw new Error('file exceeds 8 MiB download cap');
        emit(ctx, EVENTS.FILE_READ, { path: p, bytes: Math.floor(r.stdout.length * 3 / 4) });
        return { path: p, encoding: 'base64', content: r.stdout };
      },
    },
    {
      name: 'fs.upload',
      description: 'Write base64 content to a path in the sandbox (binary-safe, max 8 MiB). Use for images, archives, audio.',
      permission: 'fs.write',
      timeoutMs: 30_000,
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'absolute destination path inside the sandbox' },
          content: { type: 'string', description: 'base64-encoded file content' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      handler: async (args, ctx) => {
        const { runtime, sandboxId } = requireSandbox(ctx);
        const p = safePath(args.path);
        if (!p) throw new Error('invalid path');
        if (typeof args.content !== 'string' || args.content.length === 0) throw new Error('content is required (base64)');
        if (args.content.length > MAX_BIN_BASE64) throw new Error('content exceeds 8 MiB upload cap');
        // decode host-side, copy the raw bytes in — copyIn handles binary.
        const buf = Buffer.from(args.content, 'base64');
        await runtime.copyIn(sandboxId, [{ path: p, content: buf }]);
        emit(ctx, EVENTS.FILE_MODIFIED, { path: p, bytes: buf.length });
        return { path: p, bytes: buf.length };
      },
    },
  ];
}

async function fsReadAt(runtime, sandboxId, p) {
  const st = await runtime.exec(sandboxId, ['test', '-f', p]);
  if (st.exitCode !== 0) throw new Error(`no such file: ${p}`);
  const r = await runtime.exec(sandboxId, ['cat', p]);
  if (r.exitCode !== 0) throw new Error(`read failed: ${r.stderr.trim() || r.exitCode}`);
  return r.stdout;
}

function splitCount(hay, needle) {
  if (!needle) return 0;
  return hay.split(needle).length - 1;
}
