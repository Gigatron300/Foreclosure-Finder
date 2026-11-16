#!/usr/bin/env node
// build-helper-zip.js
// Packs the Court Docs Helper on its own, for someone who does not have this project:
//   Court Docs Helper.zip   (in the project folder, to send to whoever needs it)
// Run it again whenever the helper or the puller changes:   npm run build-helper

const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'court-docs-helper-'));
const out = path.join(stage, 'Court Docs Helper');
const zip = path.join(root, 'Court Docs Helper.zip');

const copy = (from, to) => {
  fs.mkdirSync(path.dirname(path.join(out, to)), { recursive: true });
  fs.copyFileSync(path.join(root, from), path.join(out, to));
};

copy('scripts/court-docs-helper.js', 'scripts/court-docs-helper.js');
copy('scripts/pull-court-docs.js', 'scripts/pull-court-docs.js');
copy('helper-package/scripts/setup.ps1', 'scripts/setup.ps1');
copy('helper-package/Setup.bat', 'Setup.bat');
copy('helper-package/package.json', 'package.json');
copy('helper-package/README.txt', 'README.txt');
copy('Start Court Docs Helper.bat', 'Start Court Docs Helper.bat');

fs.mkdirSync(path.dirname(zip), { recursive: true });
fs.rmSync(zip, { force: true });
// Written here rather than with PowerShell, whose zips use backslash paths that some unzip
// tools mishandle. Plain deflate entries, forward-slash names.
const zlib = require('zlib');
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const locals = [], centrals = [];
let offset = 0;
for (const file of walk(stage).sort()) {
  const name = Buffer.from(path.relative(stage, file).split(path.sep).join('/'));
  const data = fs.readFileSync(file);
  const packed = zlib.deflateRawSync(data, { level: 9 });
  const head = Buffer.alloc(26);              // the fields shared by the local and central records
  head.writeUInt16LE(20, 0);                  // version needed
  head.writeUInt16LE(0x0800, 2);              // names are UTF-8
  head.writeUInt16LE(8, 4);                   // deflate
  head.writeUInt16LE(0, 6);                   // time
  head.writeUInt16LE(0x5821, 8);              // date: 2024-01-01
  head.writeUInt32LE(zlib.crc32(data), 10);
  head.writeUInt32LE(packed.length, 14);
  head.writeUInt32LE(data.length, 18);
  head.writeUInt16LE(name.length, 22);
  head.writeUInt16LE(0, 24);                  // no extra field
  const local = Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), head, name, packed]);
  const tail = Buffer.alloc(14);              // comment len, disk, attrs (zeros), then local offset
  tail.writeUInt32LE(offset, 10);
  centrals.push(Buffer.concat([Buffer.from([0x50, 0x4b, 1, 2, 20, 0]), head, tail, name]));
  locals.push(local);
  offset += local.length;
}
const central = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(centrals.length, 8);
end.writeUInt16LE(centrals.length, 10);
end.writeUInt32LE(central.length, 12);
end.writeUInt32LE(offset, 16);
fs.writeFileSync(zip, Buffer.concat([...locals, central, end]));
fs.rmSync(stage, { recursive: true, force: true });
console.log(`Built ${path.relative(root, zip)}  (${(fs.statSync(zip).size / 1024).toFixed(0)} KB)`);
