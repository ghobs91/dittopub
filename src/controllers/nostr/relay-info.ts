import { NSchema as n } from '@nostrify/nostrify';

import { AppController } from '@/app.ts';
import { Conf } from '@/config.ts';
import { serverMetaSchema } from '@/schemas/nostr.ts';
import { Storages } from '@/storages.ts';

const relayInfoController: AppController = async (c) => {
  const { signal } = c.req.raw;
  const [event] = await Storages.db.query([{ kinds: [0], authors: [Conf.pubkey], limit: 1 }], { signal });
  const meta = n.json().pipe(serverMetaSchema).catch({}).parse(event?.content);

  return c.json({
    name: meta.name ?? 'Ditto',
    description: meta.about ?? 'Nostr and the Fediverse.',
    pubkey: Conf.pubkey,
    contact: `mailto:${meta.email ?? `postmaster@${Conf.url.host}`}`,
    supported_nips: [1, 5, 9, 11, 16, 45, 50, 46, 98],
    software: 'Ditto',
    version: '0.0.0',
    limitation: {
      // TODO.
    },
  });
};

export { relayInfoController };
