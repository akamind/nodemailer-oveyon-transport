'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const project = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'oveyon-transport-pack-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
function run(command, args, cwd = project) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
}

try {
  const manifest = JSON.parse(run(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', temp]))[0];
  const permitted = /^(?:package\.json|index\.js|LICENSE|README(?:\.pt-BR)?\.md|lib\/[\w.-]+\.js|types\/index\.d\.ts|examples\/[\w.-]+\.(?:js|mjs))$/;
  for (const file of manifest.files) assert.match(file.path, permitted);
  const names = new Set(manifest.files.map(file => file.path));
  for (const expected of ['index.js', 'lib/normalize.js', 'lib/request.js', 'lib/error.js', 'types/index.d.ts', 'LICENSE', 'README.md', 'README.pt-BR.md']) assert.ok(names.has(expected));
  fs.writeFileSync(path.join(temp, 'package.json'), JSON.stringify({ name: 'oveyon-pack-consumer', private: true }));
  run(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', path.join(temp, manifest.filename), 'nodemailer@10.1.0'], temp);
  const consumer = `
    const assert = require('node:assert/strict');
    const { EventEmitter } = require('node:events');
    const { PassThrough } = require('node:stream');
    const https = require('node:https');
    let requests = 0;
    https.request = (url, options, callback) => {
      assert.equal(url, 'https://api.oveyon.com/v1/send');
      requests++;
      const req = new EventEmitter(); req.destroy = () => {};
      req.end = body => { assert.equal(JSON.parse(body).text, 'Offline package test'); queueMicrotask(() => {
        const res = new PassThrough(); res.statusCode = 202; res.complete = true;
        res.headers = { 'content-type': 'application/json' }; callback(res);
        res.end(JSON.stringify({ id: '12345678-1234-4234-8234-123456789abc', status: 'accepted' }));
      }); }; return req;
    };
    const create = require('@oveyon/nodemailer-transport');
    const nodemailer = require('nodemailer');
    (async () => {
      const esm = await import('@oveyon/nodemailer-transport');
      assert.equal(esm.default, create);
      const info = await nodemailer.createTransport(create({ apiKey: 'synthetic-key' })).sendMail({
        from: 'sender@example.com', to: 'recipient@example.net', text: 'Offline package test'
      });
      assert.equal(info.status, 'accepted'); assert.equal(requests, 1);
      assert.equal(info.oveyonId, '12345678-1234-4234-8234-123456789abc');
      console.log('CJS + ESM imports and real Nodemailer packed send: PASS (simulated HTTPS only)');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  fs.writeFileSync(path.join(temp, 'consumer.cjs'), consumer);
  process.stdout.write(run(process.execPath, ['consumer.cjs'], temp));
  console.log(`Package allowlist: PASS (${manifest.files.length} files; ${manifest.size} bytes)`);
  console.log(`Package integrity: ${manifest.integrity}`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
