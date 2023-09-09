import { db } from '@/db.ts';
import { type Event, SqliteError } from '@/deps.ts';
import { isParameterizedReplaceableKind } from '@/kinds.ts';
import { jsonMetaContentSchema } from '@/schemas/nostr.ts';
import { EventData } from '@/types.ts';
import { isNostrId, isURL } from '@/utils.ts';

import type { DittoFilter, GetFiltersOpts } from '@/filter.ts';

/** Function to decide whether or not to index a tag. */
type TagCondition = ({ event, count, value }: {
  event: Event;
  data: EventData;
  count: number;
  value: string;
}) => boolean;

/** Conditions for when to index certain tags. */
const tagConditions: Record<string, TagCondition> = {
  'd': ({ event, count }) => count === 0 && isParameterizedReplaceableKind(event.kind),
  'e': ({ count, value }) => count < 15 && isNostrId(value),
  'media': ({ count, value, data }) => (data.user || count < 4) && isURL(value),
  'p': ({ event, count, value }) => (count < 15 || event.kind === 3) && isNostrId(value),
  'proxy': ({ count, value }) => count === 0 && isURL(value),
  'q': ({ event, count, value }) => count === 0 && event.kind === 1 && isNostrId(value),
  't': ({ count, value }) => count < 5 && value.length < 50,
};

/** Insert an event (and its tags) into the database. */
function insertEvent(event: Event, data: EventData): Promise<void> {
  return db.transaction().execute(async (trx) => {
    /** Insert the event into the database. */
    async function addEvent() {
      await trx.insertInto('events')
        .values({ ...event, tags: JSON.stringify(event.tags) })
        .execute();
    }

    /** Add search data to the FTS table. */
    async function indexSearch() {
      const searchContent = buildSearchContent(event);
      if (!searchContent) return;
      await trx.insertInto('events_fts')
        .values({ id: event.id, content: searchContent.substring(0, 1000) })
        .execute();
    }

    /** Index event tags depending on the conditions defined above. */
    async function indexTags() {
      const tags = filterIndexableTags(event, data);
      const rows = tags.map(([tag, value]) => ({ event_id: event.id, tag, value }));

      if (!tags.length) return;
      await trx.insertInto('tags')
        .values(rows)
        .execute();
    }

    // Run the queries.
    await Promise.all([
      addEvent(),
      indexTags(),
      indexSearch(),
    ]);
  }).catch((error) => {
    // Don't throw for duplicate events.
    if (error instanceof SqliteError && error.code === 19) {
      return;
    } else {
      throw error;
    }
  });
}

/** Build the query for a filter. */
function getFilterQuery(filter: DittoFilter) {
  let query = db
    .selectFrom('events')
    .select([
      'events.id',
      'events.kind',
      'events.pubkey',
      'events.content',
      'events.tags',
      'events.created_at',
      'events.sig',
    ])
    .orderBy('events.created_at', 'desc');

  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined) continue;

    switch (key as keyof DittoFilter) {
      case 'ids':
        query = query.where('events.id', 'in', filter.ids!);
        break;
      case 'kinds':
        query = query.where('events.kind', 'in', filter.kinds!);
        break;
      case 'authors':
        query = query.where('events.pubkey', 'in', filter.authors!);
        break;
      case 'since':
        query = query.where('events.created_at', '>=', filter.since!);
        break;
      case 'until':
        query = query.where('events.created_at', '<=', filter.until!);
        break;
      case 'limit':
        query = query.limit(filter.limit!);
        break;
    }

    if (key.startsWith('#')) {
      const tag = key.replace(/^#/, '');
      const value = filter[key as `#${string}`] as string[];
      query = query
        .leftJoin('tags', 'tags.event_id', 'events.id')
        .where('tags.tag', '=', tag)
        .where('tags.value', 'in', value) as typeof query;
    }
  }

  if (typeof filter.local === 'boolean') {
    query = filter.local
      ? query.innerJoin('users', 'users.pubkey', 'events.pubkey') as typeof query
      : query.leftJoin('users', 'users.pubkey', 'events.pubkey').where('users.pubkey', 'is', null) as typeof query;
  }

  if (filter.search) {
    query = query
      .innerJoin('events_fts', 'events_fts.id', 'events.id')
      .where('events_fts.content', 'match', JSON.stringify(filter.search));
  }

  return query;
}

/** Combine filter queries into a single union query. */
function getFiltersQuery(filters: DittoFilter[]) {
  return filters
    .map(getFilterQuery)
    .reduce((result, query) => result.union(query));
}

/** Get events for filters from the database. */
async function getFilters<K extends number>(
  filters: DittoFilter<K>[],
  opts: GetFiltersOpts = {},
): Promise<Event<K>[]> {
  if (!filters.length) return Promise.resolve([]);
  let query = getFiltersQuery(filters);

  if (typeof opts.limit === 'number') {
    query = query.limit(opts.limit);
  }

  return (await query.execute()).map((event) => (
    { ...event, tags: JSON.parse(event.tags) } as Event<K>
  ));
}

/** Delete events based on filters from the database. */
function deleteFilters<K extends number>(filters: DittoFilter<K>[]) {
  if (!filters.length) return Promise.resolve([]);

  return db.transaction().execute(async (trx) => {
    const query = getFiltersQuery(filters).clearSelect().select('id');

    await trx.deleteFrom('events_fts')
      .where('id', 'in', () => query)
      .execute();

    return trx.deleteFrom('events')
      .where('id', 'in', () => query)
      .execute();
  });
}

/** Get number of events that would be returned by filters. */
async function countFilters<K extends number>(filters: DittoFilter<K>[]): Promise<number> {
  if (!filters.length) return Promise.resolve(0);
  const query = getFiltersQuery(filters);

  const [{ count }] = await query
    .clearSelect()
    .select((eb) => eb.fn.count('id').as('count'))
    .execute();

  return Number(count);
}

/** Return only the tags that should be indexed. */
function filterIndexableTags(event: Event, data: EventData): string[][] {
  const tagCounts: Record<string, number> = {};

  return event.tags.reduce<string[][]>((results, tag) => {
    const [name, value] = tag;
    tagCounts[name] = (tagCounts[name] || 0) + 1;

    const shouldIndex = tagConditions[name]?.({
      event,
      data,
      count: tagCounts[name] - 1,
      value,
    });

    if (value && value.length < 200 && shouldIndex) {
      results.push(tag);
    }

    return results;
  }, []);
}

/** Build a search index from the event. */
function buildSearchContent(event: Event): string {
  switch (event.kind) {
    case 0:
      return buildUserSearchContent(event as Event<0>);
    case 1:
      return event.content;
    default:
      return '';
  }
}

/** Build search content for a user. */
function buildUserSearchContent(event: Event<0>): string {
  const { name, nip05, about } = jsonMetaContentSchema.parse(event.content);
  return [name, nip05, about].filter(Boolean).join('\n');
}

export { countFilters, deleteFilters, getFilters, insertEvent };
