'use strict';

const { randomUUID } = require('node:crypto');
const nodemailer = require('nodemailer');
const createOveyonTransport = require('@oveyon/nodemailer-transport');

async function main() {
  const transport = nodemailer.createTransport(createOveyonTransport({
    apiKey: process.env.OVEYON_API_KEY,
    timeoutMs: 30000,
  }));
  const info = await transport.sendMail({
    from: process.env.OVEYON_FROM,
    to: process.env.OVEYON_TO,
    subject: 'Hello from Oveyon',
    text: 'This message was sent through the Oveyon JSON API.',
    // Persist this key with your own send operation if you may retry it later.
    oveyon: { idempotencyKey: randomUUID() },
  });
  console.log({ oveyonId: info.oveyonId, status: info.status });
}

main().catch(() => {
  // Nodemailer plugins and MIME compilation can produce unsanitized errors.
  console.error('Email submission failed. Check your application diagnostics securely.');
  process.exitCode = 1;
});
