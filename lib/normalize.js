'use strict';

const { isUtf8 } = require('node:buffer');
const OveyonTransportError = require('./error');
const MAX_JSON = 25 * 1024 * 1024;
const MAX_ATTACHMENTS = 15 * 1024 * 1024;
const ADDRESS = /^[^\s<>@,;]+@[^\s<>@,;]+$/;
const FIELD_NAME = /^[\x21-\x39\x3b-\x7e]+$/;
const UNSUPPORTED = [
  'raw', 'envelope', 'dkim', 'sender', 'dsn', 'alternatives', 'amp', 'watchHtml',
  'icalEvent', 'attachDataUrls', 'messageId', 'date', 'priority', 'list', 'encoding',
  'textEncoding', 'newline', 'keepBcc', 'xMailer', 'baseBoundary', 'boundaryPrefix',
  'contentTransferEncoding', 'auth', 'ses', 'requireTLSExtensionEnabled', '_dkim',
  'normalizeHeaderKey', 'prepared',
];
const RESERVED = new Set([
  'from', 'to', 'cc', 'bcc', 'sender', 'subject', 'date', 'message-id', 'return-path',
  'mime-version', 'content-type', 'content-transfer-encoding', 'content-disposition',
  'content-id', 'dkim-signature', 'list-unsubscribe', 'list-unsubscribe-post', 'x-report-abuse',
  'authentication-results', 'original-authentication-results',
]);
const MESSAGE_FIELDS = new Set([
  'from', 'to', 'cc', 'bcc', 'subject', 'text', 'html', 'headers', 'replyTo',
  'inReplyTo', 'references', 'attachments', 'oveyon', 'disableFileAccess',
  'disableUrlAccess', 'maxRecipients',
]);

function fail(code = 'EVALIDATION') { throw new OveyonTransportError(code); }
function plain(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function headerString(value) {
  if (typeof value !== 'string' || /[\r\n\0]/.test(value)) fail();
  if (Buffer.byteLength(value) > MAX_JSON) fail('ELIMIT');
  return value;
}
function body(value) {
  if (value == null) return undefined;
  if (Buffer.isBuffer(value)) {
    if (value.length > MAX_JSON) fail('ELIMIT');
    if (!isUtf8(value)) fail();
    return value.toString('utf8');
  }
  if (typeof value !== 'string') fail('EUNSUPPORTED');
  if (Buffer.byteLength(value) > MAX_JSON) fail('ELIMIT');
  return value;
}

function addresses(value, message, single = false) {
  if (value == null) return [];
  const inputs = Array.isArray(value) ? value : [value];
  if (inputs.length > 5) fail('ELIMIT');
  for (const input of inputs) {
    if (typeof input === 'string') {
      headerString(input);
      if (input.length > 4096) fail('ELIMIT');
    } else if (plain(input) && typeof input.address === 'string' &&
      Object.keys(input).every(key => key === 'address' || key === 'name')) {
      headerString(input.address);
      if (!ADDRESS.test(input.address)) fail();
      if (input.name != null) headerString(input.name);
      if (input.address.length > 4096 || (input.name && input.name.length > 4096)) fail('ELIMIT');
    } else fail();
  }
  if (!message || typeof message._parseAddresses !== 'function') fail('EUNSUPPORTED');
  const parsed = message._parseAddresses(value);
  if (!parsed.length || parsed.length > (single ? 1 : 5)) fail();
  return parsed.map(entry => {
    if (!entry || entry.group || typeof entry.address !== 'string' || !ADDRESS.test(entry.address)) fail();
    const name = entry.name || '';
    headerString(name);
    const presentation = name ? `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" <${entry.address}>` : entry.address;
    return { address: entry.address, presentation };
  });
}

function attachment(item) {
  if (!plain(item)) fail('EUNSUPPORTED');
  const allowed = new Set(['filename', 'content', 'contentType', 'encoding']);
  if (Object.keys(item).some(key => !allowed.has(key))) fail('EUNSUPPORTED');
  if (typeof item.filename !== 'string' || !item.filename || /[\r\n\0]/.test(item.filename)) fail();
  if (item.filename.length > 4096) fail('ELIMIT');
  let buffer;
  if (Buffer.isBuffer(item.content)) {
    if (item.encoding != null) fail('EUNSUPPORTED');
    buffer = item.content;
  } else if (typeof item.content === 'string') {
    // A string must name its encoding; guessing can corrupt a binary attachment.
    const enc = item.encoding;
    if (!['utf8', 'utf-8', 'base64', 'hex', 'ascii', 'latin1'].includes(enc)) fail();
    if (item.content.length > MAX_JSON) fail('ELIMIT');
    if (enc === 'base64' && (item.content.length % 4 || /[^A-Za-z0-9+/=]/.test(item.content))) fail();
    if (enc === 'hex' && (item.content.length % 2 || /[^a-f\d]/i.test(item.content))) fail();
    if (enc === 'ascii' && /[^\x00-\x7f]/.test(item.content)) fail();
    if (enc === 'latin1' && /[^\x00-\xff]/.test(item.content)) fail();
    buffer = Buffer.from(item.content, enc);
    if (enc === 'base64' && buffer.toString('base64') !== item.content) fail();
  } else fail('EUNSUPPORTED');
  if (!buffer.length) fail();
  if (buffer.length > MAX_ATTACHMENTS) fail('ELIMIT');
  const out = { filename: item.filename, content: buffer.toString('base64') };
  if (item.contentType != null) {
    if (typeof item.contentType !== 'string' || !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(item.contentType)) fail();
    out.contentType = item.contentType;
  }
  return { out, size: buffer.length };
}

function preflight(defaults, input) {
  if (input != null && !plain(input)) fail();
  const data = { ...(defaults || {}), ...(input || {}) };
  if (defaults?.headers && input?.headers && plain(defaults.headers) && plain(input.headers)) {
    data.headers = { ...defaults.headers, ...input.headers };
  } else if (defaults?.headers && !input?.headers) data.headers = defaults.headers;
  for (const key of UNSUPPORTED) if (data[key] != null) fail('EUNSUPPORTED');
  for (const key of Object.keys(data)) if (data[key] != null && !MESSAGE_FIELDS.has(key)) fail('EUNSUPPORTED');
  for (const field of ['from', 'to', 'cc', 'bcc', 'replyTo']) {
    if (data[field] == null) continue;
    const entries = Array.isArray(data[field]) ? data[field] : [data[field]];
    if (entries.length > 5) fail('ELIMIT');
    for (const entry of entries) {
      if (typeof entry === 'string') {
        if (entry.length > 4096) fail('ELIMIT');
        headerString(entry);
      } else if (plain(entry) && typeof entry.address === 'string') {
        if (Object.keys(entry).some(key => key !== 'address' && key !== 'name')) fail('EUNSUPPORTED');
        if (entry.address.length > 4096 || (typeof entry.name === 'string' && entry.name.length > 4096)) fail('ELIMIT');
        headerString(entry.address);
        if (entry.name != null) headerString(entry.name);
      } else fail();
    }
  }
  if (data.subject != null) {
    if (typeof data.subject !== 'string') fail();
    if (data.subject.length > 500) fail('ELIMIT');
    headerString(data.subject);
  }
  for (const key of ['text', 'html']) {
    if (data[key] != null && typeof data[key] !== 'string' && !Buffer.isBuffer(data[key])) fail('EUNSUPPORTED');
    if (data[key] != null && Buffer.byteLength(data[key]) > MAX_JSON) fail('ELIMIT');
  }
  if (data.headers != null) {
    if (!plain(data.headers)) fail('EUNSUPPORTED');
    let count = 0;
    for (const name in data.headers) {
      if (!Object.hasOwn(data.headers, name)) continue;
      if (++count > 100 || name.length > 256) fail('ELIMIT');
      const value = data.headers[name];
      if (typeof value !== 'string') fail('EUNSUPPORTED');
      if (value.length > 65536) fail('ELIMIT');
      headerString(value);
    }
  }
  for (const field of ['inReplyTo', 'references']) {
    if (data[field] == null) continue;
    const values = Array.isArray(data[field]) ? data[field] : [data[field]];
    if (values.length > 100) fail('ELIMIT');
    for (const value of values) {
      headerString(value);
      if (value.length > 65536) fail('ELIMIT');
    }
  }
  if (data.attachments != null) {
    if (!Array.isArray(data.attachments)) fail('EUNSUPPORTED');
    if (data.attachments.length > 20) fail('ELIMIT');
    for (const item of data.attachments) {
      if (!plain(item) || Object.keys(item).some(key => !['filename', 'content', 'contentType', 'encoding'].includes(key)) ||
        (typeof item.content !== 'string' && !Buffer.isBuffer(item.content))) fail('EUNSUPPORTED');
      if (typeof item.filename !== 'string' || !item.filename || /[\r\n\0]/.test(item.filename)) fail();
      if (item.filename.length > 4096 || Buffer.byteLength(item.content) > MAX_JSON) fail('ELIMIT');
    }
  }
}

function normalize(mail) {
  const data = mail && mail.data;
  if (!plain(data)) fail();
  preflight({}, data);
  for (const key of UNSUPPORTED) if (data[key] != null) fail('EUNSUPPORTED');
  for (const key of Object.keys(data)) if (data[key] != null && !MESSAGE_FIELDS.has(key)) fail('EUNSUPPORTED');
  if (mail.mailer && (mail.mailer.dkim || mail.mailer._userPlugins?.stream?.length)) fail('EUNSUPPORTED');
  if (!Array.isArray(mail.message?._processFuncs) || mail.message._processFuncs.length) fail('EUNSUPPORTED');
  const from = addresses(data.from, mail.message, true);
  const to = addresses(data.to, mail.message);
  const cc = addresses(data.cc, mail.message);
  const bcc = addresses(data.bcc, mail.message);
  if (from.length !== 1 || !to.length) fail();
  if (to.length + cc.length + bcc.length > 5) fail('ELIMIT');
  const payload = { from: from[0].presentation, to: to.map(entry => entry.presentation) };
  if (cc.length) payload.cc = cc.map(entry => entry.presentation);
  if (bcc.length) payload.bcc = bcc.map(entry => entry.presentation);
  if (data.subject != null) {
    payload.subject = headerString(data.subject);
    if (payload.subject.length > 500) fail('ELIMIT');
  }
  const text = body(data.text);
  const html = body(data.html);
  if (!text && !html) fail();
  if (text != null) payload.text = text;
  if (html != null) payload.html = html;

  const headers = Object.create(null);
  const seen = new Set();
  function addHeader(name, value) {
    const lower = name.toLowerCase();
    if (!FIELD_NAME.test(name) || RESERVED.has(lower) || lower.startsWith('x-oveyon-')) fail('EUNSUPPORTED');
    if (seen.has(lower)) fail();
    seen.add(lower);
    headers[name] = headerString(value);
  }
  if (data.headers != null) {
    if (!plain(data.headers)) fail('EUNSUPPORTED');
    if (Object.keys(data.headers).length > 100) fail('ELIMIT');
    for (const [name, value] of Object.entries(data.headers)) addHeader(name, value);
  }
  if (data.replyTo != null) addHeader('Reply-To', addresses(data.replyTo, mail.message).map(entry => entry.presentation).join(', '));
  if (data.inReplyTo != null) addHeader('In-Reply-To', data.inReplyTo);
  if (data.references != null) {
    const refs = Array.isArray(data.references) ? data.references : [data.references];
    if (refs.some(value => typeof value !== 'string')) fail();
    addHeader('References', refs.join(' '));
  }
  if (seen.size) payload.headers = headers;

  if (data.attachments != null) {
    if (!Array.isArray(data.attachments)) fail('EUNSUPPORTED');
    if (data.attachments.length > 20) fail('ELIMIT');
    let total = 0;
    payload.attachments = data.attachments.map(item => {
      const result = attachment(item);
      total += result.size;
      if (total > MAX_ATTACHMENTS) fail('ELIMIT');
      return result.out;
    });
  }
  let idempotencyKey;
  if (data.oveyon != null) {
    if (!plain(data.oveyon)) fail();
    const allowed = new Set(['idempotencyKey', 'tier', 'sandbox', 'hold']);
    if (Object.keys(data.oveyon).some(key => !allowed.has(key))) fail('EUNSUPPORTED');
    const options = data.oveyon;
    if (options.idempotencyKey != null) {
      if (typeof options.idempotencyKey !== 'string' || !/^[\x21-\x7e]{1,255}$/.test(options.idempotencyKey)) fail();
      idempotencyKey = options.idempotencyKey;
    }
    if (options.tier != null) {
      if (options.tier !== 'transactional') fail();
      payload.tier = options.tier;
    }
    for (const field of ['sandbox', 'hold']) if (options[field] != null) {
      if (typeof options[field] !== 'boolean') fail();
      payload[field] = options[field];
    }
  }
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json) > MAX_JSON) fail('ELIMIT');
  const recipients = [...new Set([...to, ...cc, ...bcc].map(entry => entry.address.toLowerCase()))];
  return { json, idempotencyKey, envelope: { from: from[0].address, to: recipients } };
}

module.exports = normalize;
module.exports.preflight = preflight;
