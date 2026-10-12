import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import createOveyonTransport from '@oveyon/nodemailer-transport';

try {
  const transport = nodemailer.createTransport(createOveyonTransport({ apiKey: process.env.OVEYON_API_KEY }));
  const info = await transport.sendMail({
    from: process.env.OVEYON_FROM,
    to: process.env.OVEYON_TO,
    subject: 'Hello from Oveyon',
    text: 'This message was sent through the Oveyon JSON API.',
    oveyon: { idempotencyKey: randomUUID() },
  });
  console.log({ oveyonId: info.oveyonId, status: info.status });
} catch {
  console.error('Email submission failed. Check your application diagnostics securely.');
  process.exitCode = 1;
}
