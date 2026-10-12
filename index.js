'use strict';

const { performance } = require('node:perf_hooks');
const normalize = require('./lib/normalize');
const request = require('./lib/request');
const OveyonTransportError = require('./lib/error');

function createOveyonTransport(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
    Object.keys(options).some(key => key !== 'apiKey' && key !== 'timeoutMs') ||
    typeof options.apiKey !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(options.apiKey)) {
    throw new OveyonTransportError('ECONFIG');
  }
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new OveyonTransportError('ECONFIG');
  // Capture the secret in a closure rather than a public transport.options property.
  const apiKey = options.apiKey;
  let mailer;
  return {
    name: 'Oveyon',
    version: '0.1.0',
    get mailer() { return mailer; },
    set mailer(value) {
      if (!value || !value.options || !value._defaults || typeof value._defaults !== 'object' ||
        Array.isArray(value._defaults) || typeof value.sendMail !== 'function') {
        throw new OveyonTransportError('ECONFIG');
      }
      mailer = value;
      // Nodemailer assigns this documented transport property before accepting messages.
      // Close its built-in content resolver too, including the earlier data-URL compile step.
      if (value && value.options) {
        value.options.disableFileAccess = true;
        value.options.disableUrlAccess = true;
      }
      if (value && typeof value.sendMail === 'function') {
        const sendMail = value.sendMail;
        value.sendMail = function guardedSendMail(data, callback) {
          try { normalize.preflight(this._defaults, data); }
          catch (error) {
            const safe = error instanceof OveyonTransportError ? error : new OveyonTransportError('EVALIDATION');
            if (typeof callback === 'function') {
              queueMicrotask(() => callback(safe));
              return;
            }
            return Promise.reject(safe);
          }
          return sendMail.call(this, data, callback);
        };
      }
    },
    send(mail, callback) {
      const deadline = performance.now() + timeoutMs;
      let finished = false;
      function done(error, info) {
        if (finished) return;
        finished = true;
        callback(error, info);
      }
      let message;
      try { message = normalize(mail); }
      catch (error) {
        const safe = error instanceof OveyonTransportError ? error : new OveyonTransportError('EVALIDATION');
        queueMicrotask(() => done(safe));
        return;
      }
      request(message, apiKey, deadline).then(result => done(null, {
        // This is the Oveyon queue UUID, not an RFC Message-ID. Never guess a Message-ID on a duplicate.
        messageId: result.id,
        oveyonId: result.id,
        status: result.status,
        envelope: message.envelope,
        accepted: result.status === 'duplicate' ? [] : message.envelope.to.slice(),
        rejected: [],
        pending: [],
        response: `Oveyon ${result.status}`,
      }), error => done(error instanceof OveyonTransportError ? error : new OveyonTransportError('ENETWORK')));
    },
  };
}

createOveyonTransport.OveyonTransportError = OveyonTransportError;
module.exports = createOveyonTransport;
