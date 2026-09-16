// Minimal ustar tar writer (zero deps) — used by copyIn via /containers/{id}/archive.

/** @param {string} name @param {Buffer|string} content @param {number} mode */
export function tarFile(name, content, mode = 0o644) {
  const body = Buffer.from(content);
  const header = Buffer.alloc(512);
  const enc = (str, off, len) => header.write(str.slice(0, len), off, 'latin1');
  enc(name, 0, 100);
  header.write(mode.toString(8).padStart(7, '0') + '\0 ', 100, 8, 'latin1'); // mode octal + NUL + space
  enc('0000000', 108, 8); // uid
  enc('0000000', 116, 8); // gid
  header.write(body.length.toString(8).padStart(11, '0') + '\0 ', 124, 12, 'latin1'); // size
  header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0 ', 136, 12, 'latin1'); // mtime
  enc('        ', 148, 8); // checksum placeholder (spaces while computing)
  header[156] = 0x30; // '0' regular file
  enc('ustar\0', 257, 6);
  enc('00', 263, 2);
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'latin1');
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, pad]);
}

/**
 * Build a tar archive from [{name, content}] entries.
 * @param {Array<{name: string, content: string|Buffer}>} entries
 */
export function tarCreate(entries) {
  const bufs = entries.map((e) => tarFile(e.name, e.content));
  bufs.push(Buffer.alloc(1024)); // two zero blocks = terminator
  return Buffer.concat(bufs);
}
