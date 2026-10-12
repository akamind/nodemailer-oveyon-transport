'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Readable } = require('node:stream');
const https = require('node:https');
const nodemailer = require('nodemailer');
const oveyon = require('..');
const UUID = '12345678-1234-4234-8234-123456789abc';
const base = () => ({ from: 'Sender <sender@example.com>', to: 'recipient@example.net', subject: 'Hello', text: 'Hello' });

function mockApi(t, plan = {}) {
  const calls = [];
  t.mock.method(https, 'request', (url, options, onResponse) => {
    const req = new EventEmitter();
    req.destroyed = false;
    req.destroy = () => { req.destroyed = true; };
    req.end = json => {
      calls.push({ url, options, body: JSON.parse(json), req });
      if (plan.requestError) return queueMicrotask(() => req.emit('error', new Error('SECRET raw network message')));
      if (plan.hang) return;
      queueMicrotask(() => {
        const response = new PassThrough();
        response.statusCode = plan.statusCode ?? 202;
        response.headers = { 'content-type': 'application/json', ...plan.headers };
        response.complete = true;
        onResponse(response);
        if (plan.abort) return response.emit('aborted');
        const data = plan.raw ?? JSON.stringify(plan.result ?? { id: UUID, status: 'accepted' });
        response.end(data);
      });
    };
    return req;
  });
  return calls;
}
function create(options = {}) { return nodemailer.createTransport(oveyon({ apiKey: 'synthetic-key', ...options })); }

test('real Nodemailer sendMail maps presentation, headers, UTF-8 buffers and binary attachments', async t => {
  const calls = mockApi(t);
  const mailer = create();
  const info = await mailer.sendMail({
    ...base(), from: { name: 'José "Example"', address: 'sender@example.com' },
    to: [{ name: 'Alice', address: 'alice@example.net' }, 'Bob <bob@example.net>'],
    cc: 'Carla <carla@example.net>', bcc: 'private@example.net',
    replyTo: { name: 'Support', address: 'support@example.com' },
    text: Buffer.from('Olá'), html: '<p>Olá</p>',
    inReplyTo: '<prior@example.net>', references: ['<one@example.net>', '<prior@example.net>'],
    headers: { 'X-Campaign': 'welcome' },
    attachments: [
      { filename: 'bytes.bin', content: Buffer.from([0, 255, 1]), contentType: 'application/octet-stream' },
      { filename: 'hello.txt', content: 'Hello', encoding: 'utf8' },
    ],
    oveyon: { idempotencyKey: 'synthetic-1', sandbox: true, hold: true, tier: 'transactional' },
  });
  assert.equal(calls.length, 1);
  const { url, options, body } = calls[0];
  assert.equal(url, 'https://api.oveyon.com/v1/send');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers.authorization, 'Bearer synthetic-key');
  assert.equal(options.headers['idempotency-key'], 'synthetic-1');
  assert.equal(options.rejectUnauthorized, undefined);
  assert.equal(body.from, '"José \\"Example\\"" <sender@example.com>');
  assert.deepEqual(body.to, ['"Alice" <alice@example.net>', '"Bob" <bob@example.net>']);
  assert.deepEqual(body.bcc, ['private@example.net']);
  assert.equal(body.text, 'Olá');
  assert.equal(body.headers['Reply-To'], '"Support" <support@example.com>');
  assert.equal(body.headers.References, '<one@example.net> <prior@example.net>');
  assert.deepEqual(Buffer.from(body.attachments[0].content, 'base64'), Buffer.from([0, 255, 1]));
  assert.equal(body.attachments[1].content, 'SGVsbG8=');
  assert.equal(body.sandbox, true);
  assert.equal(body.hold, true);
  assert.equal(body.idempotencyKey, undefined);
  assert.equal(info.messageId, UUID);
  assert.equal(info.oveyonId, UUID);
  assert.deepEqual(info.accepted, ['alice@example.net', 'bob@example.net', 'carla@example.net', 'private@example.net']);
  assert.equal(mailer.options.disableFileAccess, true);
  assert.equal(mailer.options.disableUrlAccess, true);
  assert.equal(require('node:util').inspect(mailer.transporter).includes('synthetic-key'), false);
});

test('normal text-only messages retain Nodemailer generated defaults without false rejection', async t => {
  const calls = mockApi(t);
  await create().sendMail(base());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.messageId, undefined);
  assert.equal(calls[0].body.date, undefined);
});

test('transport defaults merge through Nodemailer and retain safe custom headers', async t => {
  const calls = mockApi(t);
  const mailer = nodemailer.createTransport(oveyon({ apiKey: 'synthetic-key' }), {
    from: 'sender@example.com', headers: { 'X-Default': 'yes' }, oveyon: { sandbox: true },
  });
  await mailer.sendMail({ to: 'recipient@example.net', text: 'Hello' });
  assert.equal(calls[0].body.headers['X-Default'], 'yes');
  assert.equal(calls[0].body.sandbox, true);
});

test('HTTP 200 duplicate returns provider UUID without claiming new recipient acceptance', async t => {
  mockApi(t, { statusCode: 200, result: { id: UUID, status: 'duplicate', message: 'private body' } });
  const info = await create().sendMail(base());
  assert.equal(info.status, 'duplicate');
  assert.equal(info.messageId, UUID);
  assert.deepEqual(info.accepted, []);
  assert.equal(JSON.stringify(info).includes('private body'), false);
});

for (const status of ['sandbox', 'held']) test(`reports ${status} without claiming delivery`, async t => {
  mockApi(t, { result: { id: UUID, status } });
  const info = await create().sendMail(base());
  assert.equal(info.status, status);
  assert.equal(info.response, `Oveyon ${status}`);
});

test('limits total recipients before deduplication and requires visible To', async t => {
  const calls = mockApi(t);
  await assert.rejects(create().sendMail({ ...base(), to: Array(5).fill('recipient@example.net'), bcc: 'recipient@example.net' }), { code: 'ELIMIT' });
  await assert.rejects(create().sendMail({ ...base(), to: undefined, bcc: 'private@example.net' }), { code: 'EVALIDATION' });
  assert.equal(calls.length, 0);
});

test('deduplicates envelope case-insensitively while preserving To/Cc presentation', async t => {
  const calls = mockApi(t);
  const info = await create().sendMail({ ...base(), to: 'First <R@example.net>', cc: 'Second <r@example.net>' });
  assert.equal(info.envelope.to.length, 1);
  assert.equal(calls[0].body.to[0], '"First" <R@example.net>');
  assert.equal(calls[0].body.cc[0], '"Second" <r@example.net>');
});

test('unsupported MIME features fail before API I/O', async t => {
  const calls = mockApi(t);
  const variants = [
    { raw: 'From: sender@example.com\r\n\r\nraw' },
    { envelope: { from: 'other@example.com', to: ['recipient@example.net'] } },
    { sender: 'other@example.com' }, { dsn: { notify: ['success'] } },
    { alternatives: [] }, { amp: '<p>AMP</p>' }, { watchHtml: '<p>Watch</p>' },
    { icalEvent: { content: 'event' } }, { date: new Date() },
    { messageId: '<custom@example.com>' }, { priority: 'high' }, { list: {} },
    { normalizeHeaderKey: key => key }, { prepared: true },
    { attachments: [{ filename: 'x', content: Buffer.from('x'), cid: 'embedded' }] },
    { attachments: [{ filename: 'x', content: Buffer.from('x'), contentDisposition: 'inline' }] },
    { attachments: [{ filename: 'x', content: Buffer.from('x'), headers: {} }] },
    { attachments: [{ filename: 'x', path: '/not-opened' }] },
    { attachments: [{ filename: 'x', href: 'https://example.invalid/private' }] },
    { attachments: [{ filename: 'x', content: Readable.from('stream') }] },
    { text: { path: '/not-opened' } }, { html: { href: 'https://example.invalid/private' } },
    { text: Readable.from('stream') },
  ];
  for (const data of variants) {
    await assert.rejects(create().sendMail({ ...base(), ...data }), { code: 'EUNSUPPORTED' });
  }
  assert.equal(calls.length, 0);
});

test('Nodemailer data-URL compile resolver cannot open URL/file even if message asks to enable access', async t => {
  const calls = mockApi(t);
  for (const html of [{ href: 'https://example.invalid/private' }, { path: '/not-opened' }]) {
    await assert.rejects(create().sendMail({ ...base(), html, attachDataUrls: true, disableFileAccess: false, disableUrlAccess: false }));
  }
  assert.equal(calls.length, 0);
});

test('preflight prevents built-in compile consumption of streams and handles defaults and callbacks', async t => {
  const calls = mockApi(t);
  let reads = 0;
  const stream = new Readable({ read() { reads++; this.push('private'); this.push(null); } });
  await assert.rejects(create().sendMail({ ...base(), html: stream, attachDataUrls: true }), { code: 'EUNSUPPORTED' });
  const defaults = nodemailer.createTransport(oveyon({ apiKey: 'synthetic-key' }), { html: stream, attachDataUrls: true });
  await assert.rejects(defaults.sendMail(base()), { code: 'EUNSUPPORTED' });
  let callbacks = 0;
  await new Promise((resolve, reject) => create().sendMail({ ...base(), html: stream }, error => {
    callbacks++;
    try { assert.equal(error.code, 'EUNSUPPORTED'); resolve(); } catch (cause) { reject(cause); }
  }));
  assert.equal(callbacks, 1);
  assert.equal(reads, 0);
  assert.equal(calls.length, 0);
});

test('stream plugins and DKIM transforms are rejected rather than silently ignored', async t => {
  const calls = mockApi(t);
  const mailer = create();
  mailer.use('stream', (mail, callback) => { mail.message.processFunc(stream => stream); callback(); });
  await assert.rejects(mailer.sendMail(base()), { code: 'EUNSUPPORTED' });
  const signer = create();
  signer.dkim = { sign: stream => stream };
  await assert.rejects(signer.sendMail(base()), { code: 'EUNSUPPORTED' });
  assert.equal(calls.length, 0);
});

test('reserved, structured and duplicate custom headers are rejected', async t => {
  const calls = mockApi(t);
  for (const headers of [
    { 'X-Oveyon-Force-Ip': 'private' }, { 'Message-ID': '<not-preserved@example.com>' },
    { 'Authentication-Results': 'example.com; dkim=pass' },
    { 'Original-Authentication-Results': 'example.com; spf=pass' },
    { 'List-Unsubscribe': '<https://example.invalid/u>' }, { From: 'other@example.com' },
    { 'X-Value': { prepared: true, value: 'raw' } }, { 'Bad:Name': 'value' },
    { 'X-Value': 'secret\r\nBcc: private@example.net' }, { 'X-Name': 'one', 'x-name': 'two' },
  ]) await assert.rejects(create().sendMail({ ...base(), headers }));
  await assert.rejects(create().sendMail({ ...base(), headers: { 'Reply-To': 'one@example.net' }, replyTo: 'two@example.net' }));
  assert.equal(calls.length, 0);
});

test('attachment encoding and limits fail without corrupting content', async t => {
  const calls = mockApi(t);
  for (const attachment of [
    { filename: 'x', content: 'SGVsbG8=' },
    { filename: 'x', content: 'SGVsbG8=!', encoding: 'base64' },
    { filename: 'x', content: 'abc', encoding: 'hex' },
    { filename: 'x', content: '', encoding: 'utf8' },
    { filename: 'x', content: Buffer.alloc(15 * 1024 * 1024 + 1) },
  ]) await assert.rejects(create().sendMail({ ...base(), attachments: [attachment] }));
  await assert.rejects(create().sendMail({ ...base(), attachments: Array.from({ length: 21 }, () => ({ filename: 'x', content: Buffer.from('x') })) }), { code: 'ELIMIT' });
  await create().sendMail({ ...base(), attachments: [{ filename: 'x', content: 'AP8B', encoding: 'base64' }] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.attachments[0].content, 'AP8B');
});

test('subject, UTF-8 body, JSON byte and metadata limits are enforced', async t => {
  const calls = mockApi(t);
  await assert.rejects(create().sendMail({ ...base(), subject: 'x'.repeat(501) }), { code: 'ELIMIT' });
  await assert.rejects(create().sendMail({ ...base(), text: Buffer.from([255]) }), { code: 'EVALIDATION' });
  await assert.rejects(create().sendMail({ ...base(), text: '\0'.repeat(5 * 1024 * 1024) }), { code: 'ELIMIT' });
  for (const options of [{ tier: 'bulk' }, { sandbox: 'true' }, { hold: 1 }, { idempotencyKey: '\r\nunsafe' }, { token: 'private' }]) {
    await assert.rejects(create().sendMail({ ...base(), oveyon: options }));
  }
  assert.equal(calls.length, 0);
});

test('HTTP errors expose generic code/status/retry delay without leaking payload or secrets and never retry', async t => {
  const calls = mockApi(t, { statusCode: 429, headers: { 'retry-after': '42' }, raw: 'Bearer SECRET recipient@example.net <html>error</html>' });
  await assert.rejects(create().sendMail(base()), error => {
    assert.equal(error.code, 'EAPI');
    assert.equal(error.statusCode, 429);
    assert.equal(error.retryAfter, 42);
    assert.equal(error.cause, undefined);
    assert.equal(/SECRET|recipient@|html|synthetic-key/.test(error.message + JSON.stringify(error)), false);
    return true;
  });
  assert.equal(calls.length, 1);
});

test('redirects fail and never forward authorization to another endpoint', async t => {
  const calls = mockApi(t, { statusCode: 307, headers: { location: 'https://example.invalid/collect' }, raw: '' });
  await assert.rejects(create().sendMail(base()), { code: 'EAPI', statusCode: 307 });
  assert.equal(calls.length, 1);
});

for (const [name, plan] of [
  ['HTML success body', { raw: '<html>private</html>', headers: { 'content-type': 'text/html' } }],
  ['malformed JSON', { raw: '{secret' }],
  ['invalid ID', { result: { id: 'recipient@example.net', status: 'accepted' } }],
  ['invalid status', { result: { id: UUID, status: 'delivered' } }],
  ['200 nonduplicate', { statusCode: 200 }],
  ['oversized response', { raw: 'x'.repeat(65537) }],
]) test(`rejects ${name} with safe response error`, async t => {
  const calls = mockApi(t, plan);
  await assert.rejects(create().sendMail(base()), { code: 'ERESPONSE' });
  assert.equal(calls.length, 1);
});

test('network failure and aborted body produce sanitized errors without retries', async t => {
  const calls = mockApi(t, { requestError: true });
  await assert.rejects(create().sendMail(base()), error => error.code === 'ENETWORK' && !error.message.includes('SECRET'));
  assert.equal(calls.length, 1);
});

test('total timeout destroys request and calls the callback only once', async t => {
  const calls = mockApi(t, { hang: true });
  let callbacks = 0;
  await new Promise((resolve, reject) => create({ timeoutMs: 15 }).sendMail(base(), error => {
    callbacks++;
    try { assert.equal(error.code, 'ETIMEDOUT'); resolve(); } catch (cause) { reject(cause); }
  }));
  calls[0].req.emit('error', new Error('late SECRET'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(callbacks, 1);
  assert.equal(calls[0].req.destroyed, true);
});

test('normalization consumes the same deadline and expires before starting HTTP', async t => {
  const calls = mockApi(t);
  const transport = oveyon({ apiKey: 'synthetic-key', timeoutMs: 1 });
  const mail = {
    data: base(),
    message: { _processFuncs: [], _parseAddresses(value) {
      const stop = performance.now() + 5;
      while (performance.now() < stop) { /* Deliberately exercise the transport deadline. */ }
      return [{ address: value.includes('sender@') ? 'sender@example.com' : 'recipient@example.net', name: '' }];
    } },
  };
  await assert.rejects(new Promise((resolve, reject) => transport.send(mail, (error, info) => error ? reject(error) : resolve(info))), { code: 'ETIMEDOUT' });
  assert.equal(calls.length, 0);
});

test('configuration rejects endpoint overrides, unsafe API keys and unbounded timeouts', () => {
  for (const options of [undefined, {}, { apiKey: 'secret\r\nextra' }, { apiKey: 'x', baseUrl: 'https://example.invalid' }, { apiKey: 'x', timeoutMs: 0 }, { apiKey: 'x', timeoutMs: Infinity }]) {
    assert.throws(() => oveyon(options), { code: 'ECONFIG' });
  }
  const transport = oveyon({ apiKey: 'synthetic-key' });
  assert.throws(() => { transport.mailer = { options: {}, sendMail() {} }; }, { code: 'ECONFIG' });
});
