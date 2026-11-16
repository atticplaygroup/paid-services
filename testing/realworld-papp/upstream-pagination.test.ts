import { test, expect } from 'bun:test';
import { PrismaClient } from '../../examples/realworld-papp/baseapp/node_modules/@prisma/client';
import mysql from 'mysql2/promise';
import { readResolvers } from '../../examples/realworld-papp/frontend/adapters/reads';
// A live comparison against the original Prisma calls protects upstream cursor
// semantics independently from the library example's REST offset tests.
for (const tied of [false, true]) test.skipIf(!process.env.DATABASE_URL)(`pApp pagination matches upstream Prisma (timestamp ties: ${tied})`, async () => {
  const prisma = new PrismaClient();
  const connection = await mysql.createConnection({ uri: process.env.DATABASE_URL!, dateStrings: true });
  const username = 'pagination-' + crypto.randomUUID();
  const viewer = 'oidc|' + 'x'.repeat(190) + crypto.randomUUID();
  const reads = readResolvers(async q => ((await connection.execute(q.sql, [...q.parameters]))[0] as any[]).map(row => Object.fromEntries(Object.entries(row).map(([k,v]) => [k, v === null ? null : String(v)]))), viewer);
  try {
    await prisma.user.create({ data: { id: viewer, username } });
    for (let i = 0; i < 8; i++) await prisma.article.create({ data: { slug: username + '-' + i, title: 'page ' + i, description: 'pagination', body: 'body', authorId: viewer, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, (tied ? Math.floor(i / 2) : i))) } });
    const rows = await prisma.article.findMany({ where: { authorId: viewer }, orderBy: { createdAt: 'desc' } });
    await prisma.comment.create({ data: { articleId: rows[0].id, authorId: viewer, body: 'string-encoded SQL flag' } });
    expect((await reads.Query.comments(null, { articleId: rows[0].id }))[0].body).toBe('string-encoded SQL flag');
    for (const cursor of [undefined, rows[3].id, rows[0].id, rows[7].id, 2147483647]) {
      for (const offset of cursor ? [0, 1, -1, 3, -3] : [0, 1, 3]) {
        const limit = 2;
        const expected = await prisma.article.findMany({ where: { del: false, author: { username } }, skip: cursor && offset ? 1 : offset || undefined, take: cursor && offset ? offset > 0 ? limit : -limit : limit, cursor: cursor ? { id: cursor } : undefined, orderBy: { createdAt: 'desc' } });
        const actual = await reads.Query.articles(null, { author: username, cursor, offset, limit });
        expect(actual.map((a: any) => Number(a.id))).toEqual(expected.map(a => a.id));
      }
    }
  } finally {
    await prisma.comment.deleteMany({ where: { authorId: viewer } });
    await prisma.article.deleteMany({ where: { authorId: viewer } });
    await prisma.user.deleteMany({ where: { id: viewer } });
    await prisma.$disconnect(); await connection.end();
  }
});
