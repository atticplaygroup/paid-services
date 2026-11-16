import { GraphQLError } from 'graphql';
import { Kysely, DummyDriver, MysqlAdapter, MysqlIntrospector, MysqlQueryCompiler, sql } from 'kysely';
export type Execute = (query: { sql: string; parameters: readonly unknown[] }) => Promise<any[]>;
const db = new Kysely<any>({ dialect: { createDriver: () => new DummyDriver(), createAdapter: () => new MysqlAdapter(), createIntrospector: d => new MysqlIntrospector(d), createQueryCompiler: () => new MysqlQueryCompiler() } }).withSchema('realworld');

// Prisma's upstream pagination uses the cursor row inclusively unless both
// cursor and nonzero offset are supplied. Negative offset selects backwards.
export async function paginate(query: any, args: any, direction: 'asc' | 'desc', execute: Execute, table: string) {
  const { cursor, offset = 0, limit = 10 } = args;
  if (!Number.isInteger(limit) || limit <= 0 || limit > 100 || !Number.isInteger(offset) || (cursor != null && (!Number.isInteger(cursor) || cursor <= 0))) throw new Error('Invalid pagination');
  const backwards = !!cursor && !!offset && offset < 0;
  const order = backwards ? (direction === 'asc' ? 'desc' : 'asc') : direction;
  if (cursor) {
    const [anchor] = await execute(db.selectFrom(table).select(['id', 'created_at']).where('id', '=', cursor).compile());
    if (!anchor) return [];
    const op = order === 'asc' ? '>=' : '<=';
    query = query.where('created_at', op, anchor.created_at);
  }
  query = query.orderBy('created_at', order);
  if (cursor) {
    // Prisma applies cursor positioning in memory when ordering by a
    // non-unique field. Locate the actual row, including timestamp ties.
    const candidates = await execute(query.compile());
    const start = candidates.findIndex((row: any) => Number(row.id) === cursor);
    if (start < 0) return [];
    const rows = candidates.slice(start + (offset ? 1 : 0), start + (offset ? 1 : 0) + limit);
    return backwards ? rows.reverse() : rows;
  }
  const rows = await execute(query.limit(limit).offset(offset).compile());
  return rows;
}

export function readResolvers(execute: Execute, viewer = '') {
  const required = (value: string, name: string) => { if (!value) throw new GraphQLError(`${name} is a required field`, { extensions: { code: 'BAD_USER_INPUT' } }); return value; };
  const run = (q: any) => execute(q.compile());
  const one = async (q: any) => (await run(q))[0] ?? null;
  const user = (id: string) => one(db.selectFrom('blog_user').selectAll().where('id', '=', id));
  const profile = (_: any, { username }: any) => one(db.selectFrom('blog_user').selectAll().where('username', '=', required(username, 'username')));
  function articlesQuery(args: any, feed = false) {
    let q = db.selectFrom('blog_article').selectAll().where('del', '=', 0);
    if (args.author != null) q = q.where('id', 'in', db.selectFrom('blog_article as t0').innerJoin('blog_user as j0', 'j0.id', 't0.author_id').select('t0.id').where('j0.username', '=', args.author).where('t0.id', 'is not', null));
    if (args.tag) q = q.where('id', 'in', db.selectFrom('blog_articles_tags as at').innerJoin('blog_tag as t', 't.id', 'at.tag_id').select('at.article_id').where('t.name', '=', args.tag));
    if (args.favorited) q = q.where('id', 'in', db.selectFrom('blog_favorites as f').innerJoin('blog_user as u', 'u.id', 'f.user_id').select('f.article_id').where('u.username', '=', args.favorited));
    if (feed) {
      if (!viewer) throw new GraphQLError('unauthorized', { extensions: { code: 'UNAUTHENTICATED' } });
      // Feed filter does not include the articleQueryFilter tag predicate.
      q = db.selectFrom('blog_article').selectAll().where('del', '=', 0).where('author_id', 'in', db.selectFrom('blog_follows').select('following_id').where('follower_id', '=', viewer));
    }
    return q;
  }
  const count = async (q: any) => Number((await one(q.clearSelect().select(sql`count(*)`.as('n')))).n);
  const date = (v: any) => new Date(typeof v === 'string' && !/[TZ]/.test(v) ? v.replace(' ', 'T') + 'Z' : v).toISOString();
  return {
    Query: {
      profile,
      article: (_: any, { slug }: any) => one(db.selectFrom('blog_article').selectAll().where('slug', '=', required(slug, 'slug'))),
      articles: (_: any, args: any) => paginate(articlesQuery(args), args, 'desc', execute, 'blog_article'),
      articlesCount: (_: any, args: any) => count(articlesQuery(args)),
      feed: (_: any, args: any) => paginate(articlesQuery(args, true), args, 'desc', execute, 'blog_article'),
      feedCount: () => count(articlesQuery({}, true)),
      comments: async (_: any, args: any) => {
        const article = await one(db.selectFrom('blog_article').selectAll().where('id', '=', args.articleId));
        if (!article || Number(article.del) !== 0) throw new Error('Article not found');
        return paginate(db.selectFrom('blog_comment').selectAll().where('del', '=', 0).where('article_id', '=', article.id), { limit: 20, ...args }, 'asc', execute, 'blog_comment');
      },
      tags: async () => (await run(db.selectFrom('blog_tag as t').innerJoin('blog_articles_tags as at', 'at.tag_id', 't.id').select('t.name').groupBy(['t.id', 't.name']).orderBy(sql`count(*)`, 'desc').limit(27))).map(r => r.name),
    },
    Article: {
      author: (a: any) => user(a.author_id),
      createdAt: (a: any) => date(a.created_at), updatedAt: (a: any) => date(a.updated_at),
      favoritesCount: (a: any) => Number(a.favorites_count),
      favorited: async (a: any) => !!viewer && !!await one(db.selectFrom('blog_favorites').select('user_id').where('article_id', '=', a.id).where('user_id', '=', viewer)),
      tagList: async (a: any) => (await run(db.selectFrom('blog_articles_tags as at').innerJoin('blog_tag as t', 't.id', 'at.tag_id').select('t.name').where('at.article_id', '=', a.id))).map(r => r.name),
    },
    Comment: { author: (c: any) => user(c.author_id), createdAt: (c: any) => date(c.created_at), updatedAt: (c: any) => date(c.updated_at) },
    Profile: { following: async (u: any) => !!viewer && !!await one(db.selectFrom('blog_follows').select('follower_id').where('following_id', '=', u.id).where('follower_id', '=', viewer)) },
  };
}
