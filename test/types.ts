import nodemailer = require('nodemailer');
import oveyon = require('..');

const transport = oveyon({ apiKey: 'synthetic-key', timeoutMs: 1000 });
const mailer = nodemailer.createTransport(transport);
const message: oveyon.MailOptions = {
  from: 'sender@example.com',
  to: { name: 'Recipient', address: 'recipient@example.net' },
  text: Buffer.from('Hello'),
  attachments: [{ filename: 'hello.txt', content: 'Hello', encoding: 'utf8' }],
  oveyon: { sandbox: true, hold: false, idempotencyKey: 'example-1', tier: 'transactional' },
};
mailer.sendMail(message).then(info => {
  const status: oveyon.Status = info.status;
  const uuid: string = info.oveyonId;
  console.log(status, uuid);
});
const bad: oveyon.MailOptions = {
  from: 'sender@example.com', to: 'recipient@example.net', text: 'Hello',
  // @ts-expect-error This transport cannot preserve a custom envelope.
  envelope: { from: 'other@example.com', to: ['recipient@example.net'] },
};
void bad;
