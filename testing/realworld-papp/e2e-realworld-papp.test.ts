import { test, expect } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { generateKeyPair } from 'dpop';
import { importJWK, SignJWT } from 'jose';
import { keyFromFile, fund, index, storage } from '../routing/helpers.ts';
import { setupPapp } from './papp-fixture.ts';
import { launchBrowser, selectedPappBrowser } from '../shared/browsers.ts';
import { captureBrowserErrors } from '../shared/browser-errors.ts';
import { refreshRealworldAdvertisements } from './refresh.ts';
import { graphql, pappMutationOrigin, replicaOrigin, replicaReads, until } from './papp-helpers.ts';

test('browser error capture detects uncaught exceptions and unhandled rejections', async () => {
  const browser = await launchBrowser(selectedPappBrowser());
  try {
    const page = await browser.context.newPage();
    const errors = await captureBrowserErrors(page);
    const document = (script: string) => 'data:text/html,' + encodeURIComponent(`<script>${script}</script>`);
    await page.goto(document("setTimeout(() => { throw new Error('uncaught sentinel'); }, 0)"));
    await browserExpect.poll(() => errors).toEqual(['uncaught sentinel']);
    await page.goto(document("void Promise.reject(new Error('rejection sentinel'))"));
    await browserExpect.poll(() => errors).toEqual(['uncaught sentinel', 'rejection sentinel']);
    await page.goto(document("Promise.reject(new Error('handled sentinel')).catch(() => {})"));
    expect(errors).toEqual(['uncaught sentinel', 'rejection sentinel']);
  } finally { await browser.close(); }
}, 30000);

async function fixture() {
  const config = await Bun.file('/etc/realworld-papp/fixture.json').json();
  await refreshRealworldAdvertisements(config);
  await fund(await keyFromFile('pusher'), storage, '1000000000000000');
  const customer = await generateKeyPair('ES256', { extractable: true });
  for (const origin of [index, storage, replicaOrigin]) await fund(customer, origin, '100000000000000');
  return { config, customer };
}

test('base Next.js app and independent pApp: public reads, OIDC, mutations, links, navigation and reloads', async () => {
  const { config, customer } = await fixture();
  const guestAuthor = 'guest-' + crypto.randomUUID().slice(0, 8);
  const guestKey = await importJWK(await Bun.file('/etc/dpop-keys/pusher.json').json(), 'ES256');
  const guestToken = await new SignJWT({ preferred_username: guestAuthor }).setProtectedHeader({ alg: 'ES256', kid: 'fixture' }).setSubject(guestAuthor).setIssuer(config.issuer).setAudience('realworld').setIssuedAt().setExpirationTime('1h').sign(guestKey);
  expect((await fetch(pappMutationOrigin + '/api/session', { method: 'POST', headers: { authorization: 'Bearer ' + guestToken, 'content-type': 'application/json' }, body: '{}' })).status).toBe(200);
  const guestTitle = 'Public read ' + guestAuthor;
  const guestArticle = (await graphql(guestToken, 'mutation($input: ArticleInput!) { createArticle(input: $input) { slug } }', { input: { title: guestTitle, description: 'guest reads', body: 'Public browser content', tagList: ['paid', guestAuthor] } })).createArticle;
  const guestReads = replicaReads(customer);
  await until(async () => !!await guestReads.Query.article(null, { slug: guestArticle.slug }), 'guest fixture publication');
  const papp = await setupPapp(config, customer, pappMutationOrigin);
  const username = 'split-' + crypto.randomUUID().slice(0, 8);
  let sharedSubject: string | undefined;
  try {
    for (const mode of ['traditional', 'kubo', 'paid']) {
      console.info(`UI scenario: ${mode}`);
      const base = mode === 'traditional' ? 'https://localhost:3004' : papp.base;
      papp.setMode(mode === 'traditional' ? 'paid' : mode);
      const browser = await launchBrowser(selectedPappBrowser(), { ca: papp.ca, spki: papp.spki });
      const page = await browser.context.newPage();
      const errors = await captureBrowserErrors(page);
      const remotePublicQueries: string[] = [];
      page.on('request', request => {
        const url = new URL(request.url());
        if (url.pathname === '/api' && ['GET', 'POST'].includes(request.method())) {
          // Upstream Apollo uses GET for persisted query hashes once any browser
          // has warmed the shared server cache; those requests omit query text.
          const body = request.method() === 'GET' ? Object.fromEntries(url.searchParams) : request.postDataJSON();
          const publicOperation = ['Article', 'ArticleMeta', 'Comments', 'EditArticle', 'Tags', 'Articles', 'ArticlesCount', 'Feed', 'FeedCount', 'Profile'].includes(body.operationName);
          if (publicOperation || (/^\s*query\b/.test(body.query ?? '') && !['CurrentUser', 'CheckUsername'].includes(body.operationName))) remotePublicQueries.push(body.query ?? body.operationName);
        }
      });
      try {
        if (mode === 'traditional') {
          await page.goto(base);
          await browserExpect(page.getByRole('link', { name: 'Global Feed', exact: true })).toBeVisible();
          const response = await page.goto(base + '/article/' + guestArticle.slug);
          expect(response?.status()).toBe(200);
          const html = await response!.text();
          expect(html).toContain('Public browser content');
        } else await papp.bootstrap(page);
        await browserExpect(page.locator('#navbar-default').getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
        // Scope this fixture's list so concurrent browsers do not push its article off the first page.
        await page.goto(base + '/?tag=' + guestAuthor);
        await browserExpect(page.getByRole('heading', { name: guestTitle, exact: true })).toBeVisible({ timeout: 60000 });
        await page.getByRole('heading', { name: guestTitle, exact: true }).click();
        await page.waitForURL('**/article/' + guestArticle.slug);
        await browserExpect(page.getByText('Public browser content', { exact: true })).toBeVisible();
        await page.goto(base + '/login');
        await page.getByRole('button', { name: 'Sign in with identity provider' }).click();
        await page.getByLabel('Email', { exact: true }).fill(username + '@example.test');
        await page.getByLabel('Password', { exact: true }).fill('fixture-password');
        if (mode === 'traditional') {
          await page.getByLabel('Username (registration)').fill(username);
          await page.getByRole('button', { name: 'Register', exact: true }).click();
        } else await page.getByRole('button', { name: 'Log in', exact: true }).click();
        await browserExpect(page.locator('#navbar-default').getByRole('link', { name: username, exact: true })).toBeVisible({ timeout: 30000 });
        const token = await page.evaluate(() => JSON.parse(localStorage.getItem('token')!));
        const subject = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;
        if (sharedSubject) expect(subject).toBe(sharedSubject);
        else sharedSubject = subject;
        const reads = replicaReads(customer, subject);
        const title = 'Upstream article ' + mode + ' ' + username;
        await page.getByRole('link', { name: /New Article$/ }).click();
        await page.getByPlaceholder('Article title').fill(title);
        await page.getByPlaceholder("What's this article about?").fill('Migrated upstream editor');
        await page.getByPlaceholder('Write your article (in markdown)').fill('Browser rendering **markdown** and 你好.');
        await page.getByPlaceholder('Enter tags').fill('paid');
        await page.getByPlaceholder('Enter tags').press('Enter');
        await page.getByRole('button', { name: 'Publish Article', exact: true }).click();
        await page.waitForURL('**/article/**');
        const articleUrl = page.url(), slug = new URL(articleUrl).pathname.split('/').pop()!;
        // Upstream redirects immediately; delayed replica publication may show
        // its normal 404. Wait in the fixture, then exercise a direct reload.
        await until(async () => !!await reads.Query.article(null, { slug }), 'new article publication');
        await page.reload();
        await browserExpect(page.getByRole('heading', { name: title, exact: true })).toBeVisible({ timeout: 60000 });
        await browserExpect(page.locator('strong')).toHaveText('markdown');
        await page.getByRole('button', { name: /Edit$/ }).first().click();
        await browserExpect(page.getByPlaceholder('Article title')).toHaveValue(title);
        await page.getByPlaceholder('Article title').fill(title + ' edited');
        await page.getByRole('button', { name: 'Publish Article', exact: true }).click();
        await page.waitForURL('**/article/**');
        const editedSlug = new URL(page.url()).pathname.split('/').pop()!;
        await until(async () => (await reads.Query.article(null, { slug: editedSlug }))?.title === title + ' edited', 'edit publication');
        await page.reload();
        await browserExpect(page.getByRole('heading', { name: title + ' edited', exact: true })).toBeVisible({ timeout: 60000 });
        await browserExpect(page.getByRole('status')).toHaveCount(0, { timeout: 60000 });
        await page.getByPlaceholder('Write a comment...').fill('Upstream cached comment');
        await page.getByRole('button', { name: 'Post Comment', exact: true }).click();
        await browserExpect(page.getByText('Upstream cached comment', { exact: true })).toBeVisible();
        await page.locator('[aria-label^="Delete comment #"]').click();
        await browserExpect(page.getByText('Upstream cached comment', { exact: true })).toHaveCount(0);
        await page.getByRole('link', { name: username, exact: true }).first().click();
        await page.waitForURL('**/profile/**');
        await browserExpect(page.getByRole('heading', { name: username, exact: true })).toBeVisible();
        await page.reload();
        await browserExpect(page.getByRole('heading', { name: username, exact: true })).toBeVisible();
        await page.getByRole('link', { name: /Settings$/ }).click();
        await page.getByPlaceholder('Short bio about you').fill('OIDC subject account');
        await page.getByRole('button', { name: 'Update Settings', exact: true }).click();
        await browserExpect(page.getByText('user updated!', { exact: true })).toBeVisible();
        const me = await graphql(token, 'query { currentUser { id username bio } }');
        expect(me.currentUser).toEqual({ id: subject, username, bio: 'OIDC subject account' });
        // A second fixture author exercises upstream favorite/follow controls.
        const other = username + '-' + mode + '-other';
        const signingKey = await importJWK(await Bun.file('/etc/dpop-keys/pusher.json').json(), 'ES256');
        const otherToken = await new SignJWT({ preferred_username: other }).setProtectedHeader({ alg: 'ES256', kid: 'fixture' }).setSubject(other).setIssuer(config.issuer).setAudience('realworld').setIssuedAt().setExpirationTime('1h').sign(signingKey);
        expect((await fetch(pappMutationOrigin + '/api/session', { method: 'POST', headers: { authorization: 'Bearer ' + otherToken, 'content-type': 'application/json' }, body: '{}' })).status).toBe(200);
        const otherArticle = (await graphql(otherToken, 'mutation($input: ArticleInput!) { createArticle(input: $input) { id slug } }', { input: { title: 'Followed ' + other, description: 'feed', body: 'Public article', tagList: ['paid'] } })).createArticle;
        await until(async () => !!await reads.Query.article(null, { slug: otherArticle.slug }), 'other article publication');
        await page.goto(base + '/article/' + otherArticle.slug);
        await page.getByRole('button', { name: 'Toggle Favorite', exact: true }).first().click();
        await browserExpect(page.getByRole('button', { name: 'Toggle Favorite', exact: true }).first()).toContainText('(1)');
        await browserExpect(page.getByRole('button', { name: 'Toggle Favorite', exact: true }).first()).toBeEnabled();
        const otherRow = await reads.Query.article(null, { slug: otherArticle.slug });
        await until(async () => await reads.Article.favorited(otherRow), 'favorite publication');
        // Upstream SSR loads article props as a guest. Preserve its cached mutation
        // state here; the pApp separately verifies personalized replica reloads.
        if (mode !== 'traditional') await page.reload();
        await page.getByRole('button', { name: 'Toggle Favorite', exact: true }).first().click();
        await browserExpect(page.getByRole('button', { name: 'Toggle Favorite', exact: true }).first()).toContainText('(0)');
        await until(async () => !await reads.Article.favorited(otherRow), 'unfavorite publication');
        await page.reload();
        await page.getByRole('button', { name: /Follow$/ }).first().click();
        await browserExpect(page.getByRole('button', { name: /Unfollow$/ }).first()).toBeVisible();
        await until(async () => await reads.Profile.following(await reads.Query.profile(null, { username: other })), 'follow publication');
        await page.goto(base + '/?feed=true');
        await browserExpect(page.getByRole('heading', { name: 'Followed ' + other, exact: true })).toBeVisible({ timeout: 60000 });
        await page.goto(base + '/profile/' + other);
        await page.getByRole('button', { name: /Unfollow$/ }).click();
        await browserExpect(page.getByRole('button', { name: /Follow$/ })).toBeVisible();
        await until(async () => !await reads.Profile.following(await reads.Query.profile(null, { username: other })), 'unfollow publication');
        await page.goto(base + '/article/' + editedSlug);
        await page.getByRole('button', { name: /Delete$/ }).first().click();
        await page.waitForURL(base + '/');
        await page.getByRole('link', { name: /Settings$/ }).click();
        await page.getByRole('button', { name: /click here to logout/ }).click();
        await page.getByRole('link', { name: 'Sign in', exact: true }).click();
        await page.getByRole('button', { name: 'Sign in with identity provider' }).click();
        await page.getByLabel('Email', { exact: true }).fill(username + '@example.test');
        await page.getByLabel('Password', { exact: true }).fill('fixture-password');
        await page.getByRole('button', { name: 'Log in', exact: true }).click();
        await browserExpect(page.locator('#navbar-default').getByRole('link', { name: username, exact: true })).toBeVisible({ timeout: 30000 });
        if (mode === 'traditional') expect(remotePublicQueries.length).toBeGreaterThan(0);
        else expect(remotePublicQueries).toEqual([]);
        expect(errors).toEqual([]);
        console.info(`UI scenario passed: ${mode}`);
      } catch (error) {
        await page.screenshot({ path: `/tmp/realworld-${mode}-failure.png`, fullPage: true, timeout: 5000 }).catch(() => {});
        console.error(`UI failure at ${page.url()}`, errors);
        throw error;
      } finally { await browser.close(); }
    }
    for (const call of papp.calls.filter(c => c.authorization && c.method !== 'OPTIONS')) {
      const claims = JSON.parse(Buffer.from(call.authorization!.split('.')[1], 'base64url').toString());
      if (call.url.startsWith(pappMutationOrigin)) {
        expect(claims.iss).toBe(config.issuer); expect(claims.htu).toBeUndefined();
      } else if ([index, storage, replicaOrigin].some(origin => call.url.startsWith(origin))) {
        expect(claims.htu).toBe(call.url.split('?')[0]); expect(claims.htm).toBe(call.method);
      }
    }
  } finally { await papp.close(); }
}, 3600000);

test('pApp upstream cursor and offset pagination through the paid replica', async () => {
  const { config, customer } = await fixture();
  const username = 'cursor-' + crypto.randomUUID();
  const key = await importJWK(await Bun.file('/etc/dpop-keys/pusher.json').json(), 'ES256');
  const token = await new SignJWT({ preferred_username: username }).setProtectedHeader({ alg: 'ES256', kid: 'fixture' }).setSubject(username).setIssuer(config.issuer).setAudience('realworld').setIssuedAt().setExpirationTime('1h').sign(key);
  const response = await fetch(pappMutationOrigin + '/api/session', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: '{}' });
  expect(response.status).toBe(200);
  const articles = [];
  const create = 'mutation($input: ArticleInput!) { createArticle(input: $input) { id slug } }';
  const reads = replicaReads(customer, username);
  try {
    for (let i = 0; i < 4; i++) {
      articles.push((await graphql(token, create, { input: { title: username + '-' + i, description: 'pagination', body: 'page', tagList: ['cursor'] } })).createArticle);
      await Bun.sleep(20);
    }
    const args = { author: username, limit: 2 };
    await until(async () => await reads.Query.articlesCount(null, args) === 4, 'cursor fixtures publication');
    const ids = (rows: any[]) => rows.map(r => Number(r.id));
    expect(ids(await reads.Query.articles(null, { ...args, offset: 0 }))).toEqual([articles[3].id, articles[2].id]);
    expect(ids(await reads.Query.articles(null, { ...args, offset: 2 }))).toEqual([articles[1].id, articles[0].id]);
    expect(ids(await reads.Query.articles(null, { ...args, cursor: articles[2].id, offset: 0 }))).toEqual([articles[2].id, articles[1].id]);
    expect(ids(await reads.Query.articles(null, { ...args, cursor: articles[2].id, offset: 1 }))).toEqual([articles[1].id, articles[0].id]);
    expect(ids(await reads.Query.articles(null, { ...args, cursor: articles[1].id, offset: -1 }))).toEqual([articles[3].id, articles[2].id]);
  } finally {
    for (const article of articles) await graphql(token, 'mutation($slug: String!) { deleteArticle(slug: $slug) { id } }', { slug: article.slug });
  }
}, 300000);
