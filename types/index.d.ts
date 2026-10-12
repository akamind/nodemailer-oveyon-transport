import type { Transport, SendMailOptions, SentMessageInfo } from 'nodemailer';

declare function createOveyonTransport(options: createOveyonTransport.Options): Transport<createOveyonTransport.SentInfo>;

declare namespace createOveyonTransport {
  interface Options {
    /** Oveyon API key with permission to send. Never commit this value. */
    apiKey: string;
    /** Total transport normalization + request + response timeout; 1..120000 ms, default 30000. */
    timeoutMs?: number;
  }
  interface MessageOptions {
    /** Account-scoped /v1/send deduplication for 24 hours from the first claim. */
    idempotencyKey?: string;
    tier?: 'transactional';
    /** Accepted and frozen by the service; quota/rate limits still apply. */
    sandbox?: boolean;
    /** Request human approval. The final status can also be affected by account policies. */
    hold?: boolean;
  }
  interface Attachment {
    filename: string;
    content: Buffer | string;
    /** Required for string content; omit for a Buffer. */
    encoding?: 'utf8' | 'utf-8' | 'base64' | 'hex' | 'ascii' | 'latin1';
    contentType?: string;
  }
  type MailOptions = Omit<SendMailOptions,
    'raw' | 'envelope' | 'dkim' | 'sender' | 'dsn' | 'alternatives' | 'amp' |
    'watchHtml' | 'icalEvent' | 'attachDataUrls' | 'messageId' | 'date' | 'priority' |
    'list' | 'encoding' | 'textEncoding' | 'newline' | 'keepBcc' | 'xMailer' |
    'baseBoundary' | 'boundaryPrefix' | 'attachments' | 'text' | 'html' | 'headers' |
    'auth' | 'ses' | 'requireTLSExtensionEnabled' | '_dkim' | 'normalizeHeaderKey' | 'contentTransferEncoding'> & {
      text?: string | Buffer;
      html?: string | Buffer;
      headers?: Record<string, string>;
      attachments?: Attachment[];
      oveyon?: MessageOptions;
    };
  type Status = 'accepted' | 'sandbox' | 'held' | 'duplicate';
  interface SentInfo extends SentMessageInfo {
    /** Oveyon queue UUID. This is NOT the RFC Message-ID header. */
    messageId: string;
    oveyonId: string;
    status: Status;
    envelope: { from: string; to: string[] };
    /** Empty on duplicate because the API does not return the original envelope. */
    accepted: string[];
    rejected: string[];
    pending: string[];
    response: string;
  }
  class OveyonTransportError extends Error {
    name: 'OveyonTransportError';
    code: 'ECONFIG' | 'EUNSUPPORTED' | 'EVALIDATION' | 'ELIMIT' | 'ETIMEDOUT' | 'ENETWORK' | 'ERESPONSE' | 'EAPI';
    statusCode?: number;
    /** Retry-After delay in seconds, when supplied as an integer by the API. No automatic retry. */
    retryAfter?: number;
  }
}

export = createOveyonTransport;
