# @oveyon/nodemailer-transport

Envie e-mails com Nodemailer pela API JSON HTTPS do [Oveyon](https://oveyon.com). O transporte envia para `https://api.oveyon.com/v1/send`; o Oveyon compõe o MIME final, define o Message-ID e assina com o DKIM configurado no domínio de envio verificado.

[English](README.md)

## Instalação

Requer Node.js 22 ou superior e Nodemailer 10.1.0 ou versão 10.x posterior compatível. Os testes de integração usam Nodemailer 10.1.0. Este pacote não tem dependências de execução; Nodemailer é uma dependência peer.

```sh
npm install @oveyon/nodemailer-transport nodemailer
```

Crie uma chave de API do Oveyon com permissão de envio e verifique seu domínio no Oveyon. Forneça a chave pela configuração de segredos da aplicação.

## Uso

```js
const nodemailer = require('nodemailer');
const createOveyonTransport = require('@oveyon/nodemailer-transport');

async function main() {
  const mailer = nodemailer.createTransport(createOveyonTransport({
    apiKey: process.env.OVEYON_API_KEY,
    timeoutMs: 30000,
  }));

  const info = await mailer.sendMail({
    from: 'Sua aplicação <ola@seu-dominio-verificado.example>',
    to: { name: 'Destinatário', address: 'recipient@example.net' },
    subject: 'Sua conta está pronta',
    text: 'Bem-vindo à nossa aplicação.',
    html: '<p>Bem-vindo à nossa aplicação.</p>',
    oveyon: { idempotencyKey: 'boas-vindas-conta-123' },
  });

  console.log(info.oveyonId, info.status);
}

main().catch(() => {
  console.error('Falha no envio. Confira os diagnósticos da aplicação com segurança.');
  process.exitCode = 1;
});
```

Em módulos ESM, use `import createOveyonTransport from '@oveyon/nodemailer-transport'`. O `sendMail` aceita Promise ou callback. Exemplos: [CommonJS](examples/send.js) e [ESM](examples/send.mjs). Executar esses exemplos com configuração válida envia e-mails reais; a suíte de testes usa somente HTTPS simulado.

## Campos aceitos

| Campo | Comportamento |
| --- | --- |
| `from` | Um endereço, com nome de exibição opcional. |
| `to`, `cc`, `bcc` | Strings ou objetos de endereço, incluindo arrays planos. Exige pelo menos um `to`. Limite de cinco destinatários somando os campos antes da deduplicação. Preserva nomes e funções dos campos; o Oveyon mantém Bcc fora dos cabeçalhos finais. Grupos de endereços não são suportados. |
| `subject` | String de até 500 unidades de string JavaScript. |
| `text`, `html` | String em memória ou Buffer UTF-8 válido. Pelo menos um deve ter conteúdo. |
| `replyTo`, `inReplyTo`, `references` | Convertidos para os cabeçalhos `Reply-To`, `In-Reply-To` e `References`. `references` também aceita array de strings. |
| `headers` | Objeto simples de nomes para valores string. Recusa nomes duplicados, quebras de linha, valores estruturados/preparados e cabeçalhos reservados ao MIME, envelope ou serviço. |
| `attachments` | Até 20 anexos em memória e 15 MiB de dados decodificados somados. Cada anexo exige `filename` e `content` não vazios; `contentType` é opcional. |

Em `attachments[].content`, use Buffer, ou string com `encoding` explícito: `utf8`, `utf-8`, `base64`, `hex`, `ascii` ou `latin1`. Base64 deve ser canônico, com padding quando necessário; hex exige bytes completos. Omita `encoding` para Buffer. O JSON inteiro da requisição tem limite de 25 MiB.

```js
await mailer.sendMail({
  from: 'ola@seu-dominio-verificado.example',
  to: 'recipient@example.net',
  text: 'Seu recibo está anexado.',
  attachments: [{
    filename: 'recibo.txt',
    content: Buffer.from('Recibo #123', 'utf8'),
    contentType: 'text/plain',
  }],
});
```

Strings/objetos de endereço, nomes de exibição e nomes de arquivo têm limite de entrada de 4096 caracteres; cabeçalhos extras têm limite de 100 entradas, 256 caracteres por nome e 65536 por valor. Arrays de referências aceitam até 100 entradas. Autenticação, políticas da conta, verificação de domínio/destinatário, cotas e limites do Oveyon continuam valendo.

## Opções do Oveyon

O objeto `oveyon` da mensagem aceita somente:

| Opção | Comportamento |
| --- | --- |
| `idempotencyKey` | String ASCII visível opcional de 1–255 caracteres, enviada em `Idempotency-Key`. Deduplicação por conta e por `/v1/send`, durante 24 horas a partir da primeira reserva. Reutilizar depois desse prazo pode criar outra mensagem. |
| `tier` | `transactional`, ou omita para usar as configurações da conta/chave. |
| `sandbox` | Booleano. Solicita aceite com a mensagem congelada; continua consumindo cota/rate. |
| `hold` | Booleano. Solicita aprovação humana antes da entrega. Políticas da conta também podem afetar retenção e status retornado. |

Não há retentativas automáticas. Timeout ou falha de rede podem acontecer depois do aceite pelo serviço. Guarde a chave de idempotência junto à operação da aplicação, consulte a mensagem no Oveyon e reutilize a mesma chave se decidir repetir dentro do prazo. A resposta `duplicate` não comprova que o payload atual é igual ao original.

## Resultado e erros

`info.oveyonId` é o UUID da fila do Oveyon. Para compatibilidade com o formato de resultado do Nodemailer, `info.messageId` contém esse mesmo UUID: **ele não é o cabeçalho RFC Message-ID**. Não o use como cabeçalho de conversa. A API não retorna o Message-ID RFC original numa duplicata, e este pacote não inventa um a partir do remetente da retentativa.

`info.status` pode ser `accepted`, `sandbox`, `held` ou `duplicate`. Aceite não significa entrega. `info.envelope` descreve o envelope apresentado, deduplicado sem diferenciar maiúsculas/minúsculas. Em um aceite novo, `accepted` lista esses destinatários; `rejected` e `pending` ficam vazios porque a API aceita ou rejeita toda a requisição. Em `duplicate`, `accepted` fica vazio: a API não retorna o envelope original, e o envelope apresentado pode ser diferente. Acompanhe a entrega pela API de mensagens, painel ou webhooks do Oveyon.

Erros produzidos pelo transporte são instâncias de `createOveyonTransport.OveyonTransportError`, com `message` genérica, `code` e `statusCode`/`retryAfter` opcionais (segundos). Códigos: `ECONFIG`, `EUNSUPPORTED`, `EVALIDATION`, `ELIMIT`, `ETIMEDOUT`, `ENETWORK`, `ERESPONSE` e `EAPI`. Não incluem corpo da resposta do provedor nem exceção de rede bruta. A compilação MIME anterior do Nodemailer e seus plugins podem produzir outros erros contendo dados da mensagem; sanitize-os antes de registrar ou exibir.

O timeout padrão é 30 segundos, configurável de 1 a 120000 ms. O prazo cobre a normalização dentro de `transport.send`, a requisição HTTPS e o corpo da resposta. Não cobre compilação nem plugins anteriores do Nodemailer. A verificação de certificado usa os padrões do Node.js; redirecionamentos são recusados, a resposta é limitada a 64 KiB, e não há endpoint nem proxy configurável.

## Limitações de MIME e plugins

A API JSON recompõe o MIME. Recusa `raw`, envelope personalizado, `sender`, DKIM local, DSN, `messageId`, `date`, opções de encoding/boundary MIME, prioridade/list/xMailer, partes alternativas, AMP/Watch HTML/iCalendar, CID/disposição inline, cabeçalhos de anexo e campos desconhecidos antes de o transporte chamar a API. Plugins de stream e transformações MIME registradas são recusados. Evite plugins que alteram somente a árvore MIME compilada: este transporte lê os campos suportados da mensagem. Plugins de compilação podem atualizar campos suportados em `mail.data`; seu próprio código roda antes do transporte e fica sob responsabilidade da aplicação.

Não suporta arquivos, URLs, streams nem descritores de dados em corpos ou anexos. Quando Nodemailer atribui a propriedade `mailer` do transporte, este pacote envolve o método `sendMail` para validar previamente dados explícitos e defaults combinados, antes da compilação. Também fecha o resolver interno de arquivos/URLs do Nodemailer. Assim o conversor padrão `attachDataUrls` não consome streams/descritores recusados. Preserva callback e Promise. Isso não cria uma sandbox para plugins arbitrários. O transporte usa o parser de endereços, lista de transformações e armazenamento de defaults do peer; mudança de major do Nodemailer exige revisão de compatibilidade.

Cabeçalhos reservados incluem `X-Oveyon-*`, `List-Unsubscribe`, `List-Unsubscribe-Post` e `X-Report-Abuse`. O pacote os recusa para preservar a intenção do chamador. O serviço pode acrescentar tracking, unsubscribe e conteúdo de políticas conforme as configurações da conta.

## TypeScript e desenvolvimento

As declarações estão incluídas. Use `createOveyonTransport.MailOptions` para os campos suportados e `createOveyonTransport.SentInfo` para o resultado. Projetos Node com TypeScript precisam da configuração usual de `@types/node`. Esta versão suporta as declarações nativas do Nodemailer 10.x.

```sh
npm ci --ignore-scripts
npm test
npm run check
npm run pack:check
```

Os testes exercitam Nodemailer real contra API simulada, incluindo erros, limites, timeout e consumidores CJS/ESM do arquivo empacotado. Não enviam e-mail nem autenticam em produção.

MIT © 2026 Akamind Inc. A licença cobre os arquivos deste pacote; não licencia o serviço remoto Oveyon nem seu código-fonte de servidor. [Site](https://oveyon.com) · [Issues](https://github.com/akamind/nodemailer-oveyon-transport/issues)
