import { NostrEvent } from '@nostrify/nostrify';
import { z } from 'zod';

import { AppController } from '@/app.ts';
import { Conf } from '@/config.ts';
import { Storages } from '@/storages.ts';
import { AdminSigner } from '@/signers/AdminSigner.ts';

const markerSchema = z.enum(['read', 'write']);

const relaySchema = z.object({
  url: z.string().url(),
  marker: markerSchema.optional(),
});

type RelayEntity = z.infer<typeof relaySchema>;

export const adminRelaysController: AppController = async (c) => {
  const [event] = await Storages.db.query([
    { kinds: [10002], authors: [Conf.pubkey], limit: 1 },
  ]);

  if (!event) {
    return c.json([]);
  }

  return c.json(renderRelays(event));
};

export const adminSetRelaysController: AppController = async (c) => {
  const relays = relaySchema.array().parse(await c.req.json());

  const event = await new AdminSigner().signEvent({
    kind: 10002,
    tags: relays.map(({ url, marker }) => marker ? ['r', url, marker] : ['r', url]),
    content: '',
    created_at: Math.floor(Date.now() / 1000),
  });

  await Storages.db.event(event);

  return c.json(renderRelays(event));
};

/** Render Ditto API relays from a NIP-65 event. */
function renderRelays(event: NostrEvent): RelayEntity[] {
  return event.tags.reduce((acc, [name, url, marker]) => {
    if (name === 'r') {
      const relay: RelayEntity = {
        url,
        marker: markerSchema.safeParse(marker).success ? marker as 'read' | 'write' : undefined,
      };
      acc.push(relay);
    }
    return acc;
  }, [] as RelayEntity[]);
}
