'use strict';

const https = require('node:https');
const { performance } = require('node:perf_hooks');
const OveyonTransportError = require('./error');
const RESPONSE_LIMIT = 64 * 1024;

function request(message, apiKey, deadline) {
  return new Promise((resolve, reject) => {
    let req;
    let response;
    let settled = false;
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        response?.destroy();
        req?.destroy();
      } else resolve(value);
    };
    const remaining = deadline - performance.now();
    if (remaining <= 0) return finish(new OveyonTransportError('ETIMEDOUT'));
    timer = setTimeout(() => finish(new OveyonTransportError('ETIMEDOUT')), remaining);
    try {
      const headers = {
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(message.json),
        'user-agent': '@oveyon/nodemailer-transport/0.1.1',
      };
      if (message.idempotencyKey) headers['idempotency-key'] = message.idempotencyKey;
      req = https.request('https://api.oveyon.com/v1/send', { method: 'POST', headers }, res => {
        response = res;
        if (settled) return res.destroy();
        const statusCode = res.statusCode;
        const chunks = [];
        let bytes = 0;
        res.on('error', () => finish(new OveyonTransportError('ENETWORK')));
        res.on('aborted', () => finish(new OveyonTransportError('ENETWORK')));
        res.on('close', () => {
          if (!res.complete) finish(new OveyonTransportError('ENETWORK'));
        });
        res.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > RESPONSE_LIMIT) return finish(new OveyonTransportError('ERESPONSE', { statusCode }));
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (settled) return;
          if (performance.now() >= deadline) return finish(new OveyonTransportError('ETIMEDOUT'));
          if (statusCode !== 200 && statusCode !== 202) {
            // Provider bodies may contain recipient addresses, keys, or HTML; never expose them.
            const retryHeader = res.headers['retry-after'];
            const retryAfter = typeof retryHeader === 'string' && /^\d+$/.test(retryHeader) ? Number(retryHeader) : undefined;
            return finish(new OveyonTransportError('EAPI', { statusCode, retryAfter }));
          }
          const contentType = res.headers['content-type'];
          if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|\s*$)/i.test(contentType)) {
            return finish(new OveyonTransportError('ERESPONSE', { statusCode }));
          }
          let result;
          try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch { return finish(new OveyonTransportError('ERESPONSE', { statusCode })); }
          if (!result || typeof result !== 'object' ||
            typeof result.id !== 'string' || !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(result.id) ||
            !(statusCode === 200 ? result.status === 'duplicate' : ['accepted', 'sandbox', 'held'].includes(result.status))) {
            return finish(new OveyonTransportError('ERESPONSE', { statusCode }));
          }
          finish(null, { id: result.id, status: result.status });
        });
      });
      req.on('error', () => finish(new OveyonTransportError('ENETWORK')));
      req.end(message.json);
    } catch { finish(new OveyonTransportError('ENETWORK')); }
  });
}

module.exports = request;
