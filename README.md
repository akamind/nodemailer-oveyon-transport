# @oveyon/nodemailer-transport

Send email with Nodemailer through the [Oveyon](https://oveyon.com) HTTPS JSON API. The transport submits to `https://api.oveyon.com/v1/send`; Oveyon composes the final MIME message, assigns its Message-ID and signs it with the verified sending domain's DKIM configuration.

[Português brasileiro](README.pt-BR.md)

## Installation

Requires Node.js 22 or later and Nodemailer 10.1.0 or a compatible later 10.x version. Integration tests run against Nodemailer 10.1.0. This package has no runtime dependencies; Nodemailer is a peer dependency.

```sh
npm install @oveyon/nodemailer-transport nodemailer
```

Create an Oveyon API key authorized to send email and verify your sending domain in Oveyon. Supply the key from your application's secret configuration.

## Usage

```js
const nodemailer = require('nodemailer');
const createOveyonTransport = require('@oveyon/nodemailer-transport');

async function main() {
  const mailer = nodemailer.createTransport(createOveyonTransport({
    apiKey: process.env.OVEYON_API_KEY,
    timeoutMs: 30000,
  }));

  const info = await mailer.sendMail({
    from: 'Your App <hello@your-verified-domain.example>',
    to: { name: 'Recipient', address: 'recipient@example.net' },
    subject: 'Your account is ready',
    text: 'Welcome to our application.',
    html: '<p>Welcome to our application.</p>',
    oveyon: { idempotencyKey: 'account-welcome-123' },
  });

  console.log(info.oveyonId, info.status);
}

main().catch(() => {
  console.error('Email submission failed. Check your application diagnostics securely.');
  process.exitCode = 1;
});
```

ES modules can use `import createOveyonTransport from '@oveyon/nodemailer-transport'`. Both Nodemailer's Promise and callback `sendMail` APIs work. See [CommonJS](examples/send.js) and [ES module](examples/send.mjs) examples. Those examples submit real email when executed with valid configuration; the package test suite uses simulated HTTPS only.

## Supported message fields

| Field | Behavior |
| --- | --- |
| `from` | One address, with an optional display name. |
| `to`, `cc`, `bcc` | Address strings or address objects, including flat arrays. At least one `to` address is required. At most five total recipients before deduplication. Display names and field roles are preserved; Oveyon keeps Bcc out of the final headers. Address groups are unsupported. |
| `subject` | String, up to 500 JavaScript string units. |
| `text`, `html` | In-memory string or valid UTF-8 Buffer. At least one must be nonempty. |
| `replyTo`, `inReplyTo`, `references` | Converted to `Reply-To`, `In-Reply-To`, and `References` custom headers. `references` also accepts an array of strings. |
| `headers` | A plain object of header names to string values. Duplicate names, line breaks, structured/prepared values, MIME/envelope headers and server-reserved headers are rejected. |
| `attachments` | Up to 20 in-memory attachments and 15 MiB of decoded attachment data combined. Each requires a nonempty `filename` and nonempty `content`; `contentType` is optional. |

For attachment `content`, use a Buffer, or a string with an explicit `encoding`: `utf8`, `utf-8`, `base64`, `hex`, `ascii`, or `latin1`. Base64 must be canonical and padded where required; hex must contain complete bytes. Omit `encoding` when supplying a Buffer. The complete JSON request is limited to 25 MiB.

```js
await mailer.sendMail({
  from: 'hello@your-verified-domain.example',
  to: 'recipient@example.net',
  text: 'Your receipt is attached.',
  attachments: [{
    filename: 'receipt.txt',
    content: Buffer.from('Receipt #123', 'utf8'),
    contentType: 'text/plain',
  }],
});
```

Address strings/objects, filenames and display names have a 4096-character input limit; custom headers are limited to 100 entries, 256 characters per name and 65536 characters per value. Reference arrays have at most 100 entries. Server authentication, account policies, domain verification, recipient checks, quota, rate limits and other Oveyon restrictions still apply.

## Oveyon options

The message's `oveyon` object accepts only:

| Option | Behavior |
| --- | --- |
| `idempotencyKey` | Optional visible ASCII string of 1–255 characters, sent as `Idempotency-Key`. Deduplication is scoped to the Oveyon account and `/v1/send`, for 24 hours from the first claim. Reusing it after expiration can create another message. |
| `tier` | `transactional`, or omit to use your account/key settings. |
| `sandbox` | Boolean. Requests acceptance with the message frozen; quota and rate limits still apply. |
| `hold` | Boolean. Requests human approval before delivery. Account policies can also affect retention and the returned status. |

There are no automatic retries. A timeout or network failure can occur after the service accepted the message. Persist your idempotency key with the business operation, inspect the message in Oveyon, and reuse the same key if you explicitly retry within its retention period. A duplicate response does not establish that the current payload matches the original request.

## Result and errors

`info.oveyonId` is the Oveyon queue UUID. For compatibility with Nodemailer's result shape, `info.messageId` contains the same UUID: **it is not the RFC Message-ID header**. Do not use it as a conversation header. The API does not return the original RFC Message-ID on duplicates, and this package does not invent one from the retried sender.

`info.status` is `accepted`, `sandbox`, `held`, or `duplicate`. Acceptance is not delivery. `info.envelope` describes the submitted envelope, deduplicated case-insensitively. For a fresh acceptance, `accepted` lists those submitted recipients; `rejected` and `pending` are empty because this API accepts or rejects the whole request. On `duplicate`, `accepted` is empty: the API does not return the original envelope, and the submitted envelope may differ from the original request. Check delivery through Oveyon's message API, dashboard or webhooks.

Errors produced by this transport are instances of `createOveyonTransport.OveyonTransportError`, with a generic `message`, `code`, and optional `statusCode`/`retryAfter` (seconds). Codes are `ECONFIG`, `EUNSUPPORTED`, `EVALIDATION`, `ELIMIT`, `ETIMEDOUT`, `ENETWORK`, `ERESPONSE`, and `EAPI`. Provider response bodies and raw network exceptions are not included. Nodemailer's earlier MIME compilation and your own plugins can produce other errors containing message data: sanitize those before logging or displaying them.

The default timeout is 30 seconds, configurable from 1 to 120000 ms. Its deadline covers normalization inside `transport.send`, the HTTPS request and the response body. It does not cover Nodemailer's earlier compilation or plugin execution. Certificate verification uses Node.js defaults; redirects are rejected, the response body is capped at 64 KiB, and no configurable endpoint or proxy is exposed.

## MIME and plugin limitations

The JSON API reconstructs MIME. Explicit `raw`, a custom `envelope`, `sender`, local DKIM, DSN, `messageId`, `date`, MIME encoding/boundary options, priority/list/xMailer options, alternative parts, AMP/Watch HTML/iCalendar, CID/inline dispositions, attachment headers and unknown message fields are rejected before this transport makes an API request. Stream plugins and registered MIME transforms are rejected. Do not use plugins that only modify the compiled MIME tree: this transport reads supported message fields, not that tree. Compile plugins may update supported `mail.data` fields; their own code runs before the transport and remains your application's responsibility.

File paths, URLs, streams and data descriptors are not supported for bodies or attachments. When Nodemailer assigns the transport's `mailer` property, this package wraps that mailer's `sendMail` method to preflight explicit message data and merged defaults before compilation. It also closes Nodemailer's built-in file/URL resolver. This prevents the default `attachDataUrls` compile step from consuming an unsupported stream or descriptor. Both callback and Promise behavior are preserved. This does not sandbox arbitrary user plugins. The transport currently relies on the compiled peer's address parser, transform list and defaults storage; upgrading the Nodemailer major requires a compatibility review.

The service's reserved headers include `X-Oveyon-*`, `List-Unsubscribe`, `List-Unsubscribe-Post` and `X-Report-Abuse`. This package rejects them rather than silently losing caller intent. Oveyon's server may add tracking, unsubscribe and policy-related content according to your account settings.

## TypeScript and development

Declarations are bundled; use the exported `createOveyonTransport.MailOptions` type for supported message fields and `createOveyonTransport.SentInfo` for results. Node TypeScript projects also need their usual `@types/node` configuration. This first version supports Nodemailer's native 10.x declarations.

```sh
npm ci --ignore-scripts
npm test
npm run check
npm run pack:check
```

Tests exercise the real Nodemailer pipeline against a simulated API, including errors, limits, timeouts and CJS/ESM consumers of the packed archive. They do not send email or authenticate against production.

MIT © 2026 Akamind Inc. The license covers this package's files; it does not license the remote Oveyon service or its server source code. [Website](https://oveyon.com) · [Issues](https://github.com/akamind/nodemailer-oveyon-transport/issues)
