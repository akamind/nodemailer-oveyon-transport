'use strict';

const MESSAGES = Object.freeze({
  ECONFIG: 'Invalid Oveyon transport configuration.',
  EUNSUPPORTED: 'This message uses a feature the Oveyon JSON API cannot preserve.',
  EVALIDATION: 'Invalid Oveyon message data.',
  ELIMIT: 'The message exceeds an Oveyon API limit.',
  ETIMEDOUT: 'The Oveyon request exceeded its total timeout; acceptance is unknown.',
  ENETWORK: 'The Oveyon request failed; acceptance is unknown.',
  ERESPONSE: 'Invalid Oveyon API response; acceptance is unknown.',
  EAPI: 'The Oveyon API rejected the request.',
});

class OveyonTransportError extends Error {
  constructor(code, details = {}) {
    super(MESSAGES[code] || MESSAGES.EAPI);
    this.name = 'OveyonTransportError';
    this.code = Object.hasOwn(MESSAGES, code) ? code : 'EAPI';
    if (Number.isInteger(details.statusCode)) this.statusCode = details.statusCode;
    if (Number.isFinite(details.retryAfter) && details.retryAfter >= 0) this.retryAfter = details.retryAfter;
  }
}

module.exports = OveyonTransportError;
