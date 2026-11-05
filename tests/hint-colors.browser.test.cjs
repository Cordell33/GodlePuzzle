const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

// Mock the Supabase transport, not the game's auth, rendering, solving or sharing.
// Database security/trigger behavior is exercised against PostgreSQL separately.
function installClient(initialUser) {
  let user = initialUser ? { id: initialUser, email: `${initialUser}@example.test` } : null;
  const callbacks = [];
  window.__setUser = id => {
    user = id ? { id, email: `${id}@example.test` } : null;
    for (const callback of callbacks) callback(id ? 'SIGNED_IN' : 'SIGNED_OUT', user ? { user } : null);
  };
  window.__oauth = [];
  class Query {
    constructor(table) { this.request = { table, action: 'select', filters: {} }; }
    select() { return this; }
    eq(key, value) { this.request.filters[key] = value; return this; }
    order() { return this; }
    limit() { return this; }
    maybeSingle() { this.request.single = true; return this; }
    single() { this.request.single = true; return this; }
    update(payload) { this.request.action = 'update'; this.request.payload = payload; return this; }
    upsert(payload) { this.request.action = 'upsert'; this.request.payload = payload; return this; }
    then(resolve, reject) { return window.__backend({ ...this.request, accountId: user?.id }).then(resolve, reject); }
  }
  window.__mockSb = {
    auth: {
      getSession: async () => ({ data: { session: user ? { user } : null }, error: null }),
      onAuthStateChange: callback => { callbacks.push(callback); },
      signOut: async () => { window.__setUser(null); return { error: null }; },
      signInWithOAuth: async options => { window.__oauth.push(options); return { error: null }; }
    },
    from: table => new Query(table),
    rpc: name => window.__backend({ action: 'rpc', name, accountId: user?.id })
  };
  window.__sharedUrls = [];
  window.open = url => { window.__sharedUrls.push(url); return {}; };
  window.alert = () => {};
  window.__copied = '';
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.__copied = text; } } });
}

test('hint colors in the browser', async t => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: ['--no-sandbox']
  });
  t.after(() => browser.close());
  const state = { prefs: {}, dates: {}, ratings: {}, failSave: false, failRead: false, holdSave: null, claims: 0 };
  const errors = [];
  const backend = async request => {
    const { accountId, table, action, filters, payload } = request;
    const ok = data => ({ data, error: null });
    if (action === 'rpc') {
      assert.equal(request.name, 'claim_hint_color_unlock_notification');
      const row = state.prefs[accountId];
      if (!row || row.notification_seen_at) return ok(false);
      row.notification_seen_at = 'seen'; state.claims += 1;
      return ok(true);
    }
    if (table === 'hint_color_preferences') {
      if (action === 'update') {
        if (state.holdSave) await state.holdSave;
        if (state.failSave) return { data: null, error: { message: 'Save failed' } };
        assert.equal(filters.user_id, accountId);
        Object.assign(state.prefs[accountId], payload);
      } else if (state.failRead) return { data: null, error: { message: 'Read failed' } };
      return ok(state.prefs[accountId] ? { ...state.prefs[accountId] } : null);
    }
    if (table === 'puzzle_completions') {
      if (action === 'upsert') {
        assert.equal(payload.user_id, accountId);
        state.dates[accountId] = [...new Set([...(state.dates[accountId] || []), payload.puzzle_date])];
        // This fixture starts with two preceding dates; the SQL test checks eligibility.
        if (state.dates[accountId].length === 3 && !state.prefs[accountId]) {
          state.prefs[accountId] = { circle_color: 'yellow', square_color: 'green', unlocked_at: 'unlocked', notification_seen_at: null };
        }
        return ok(null);
      }
      return ok((state.dates[filters.user_id] || []).map(puzzle_date => ({ puzzle_date })));
    }
    if (table === 'difficulty_ratings') {
      if (action === 'upsert') { state.ratings[accountId] = payload; return ok(null); }
      const rows = Object.values(state.ratings).filter(row => row.puzzle_date === filters.puzzle_date && (!filters.user_id || row.user_id === filters.user_id));
      return ok(request.single ? rows[0] || null : rows);
    }
    throw new Error(`Unexpected backend table: ${table}`);
  };
  const open = async (user, viewport = { width: 1100, height: 900 }) => {
    const context = await browser.newContext({ viewport, colorScheme: 'dark' });
    await context.exposeFunction('__backend', backend);
    await context.addInitScript(installClient, user);
    await context.route('**/*', route => {
      const url = route.request().url();
      if (url === 'http://localhost:8023/') return route.fulfill({ contentType: 'text/html', body: html });
      if (url.startsWith('https://esm.sh/')) return route.fulfill({ contentType: 'application/javascript', body: 'export function createClient() { return window.__mockSb; }' });
      return route.fulfill({ body: '' });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://localhost:8023/');
    await page.waitForFunction(() => !!window.sb);
    await page.waitForFunction(() => document.getElementById('hint-color-status').textContent !== 'Loading account colors…');
    return { context, page };
  };
  const openMenu = async page => {
    if (!await page.locator('body').evaluate(body => body.classList.contains('menu-open'))) await page.locator('#menu-toggle').click();
    await page.locator('#hint-color-heading').scrollIntoViewIfNeeded();
  };
  const selectColor = async (page, type, color) => {
    await page.locator(`#hint-${type}-options button[data-color="${color}"]`).click();
    await page.waitForFunction(() => document.getElementById('hint-color-status').textContent !== 'Saving colors…');
  };

  await t.test('guests and sub-three streaks remain locked; OAuth uses existing providers', async () => {
    for (const user of [null, 'below-three']) {
      const { context, page } = await open(user);
      await openMenu(page);
      assert.equal(await page.locator('#hint-colors-controls').isVisible(), false);
      assert.equal(await page.locator('#hint-colors-locked').isVisible(), true);
      assert.deepEqual(await page.evaluate(() => [getHintColor('circle').circle, getHintColor('square').square]), ['🟡', '🟩']);
      await page.evaluate(() => saveHintColors({ circle: 'red', square: 'blue' }));
      assert.equal(state.prefs[user], undefined);
      if (!user) {
        await page.locator('#github-login-button').click();
        await page.locator('#google-login').click();
        assert.deepEqual(await page.evaluate(() => window.__oauth.map(options => options.provider)), ['github', 'google']);
      }
      await context.close();
    }
  });

  await t.test('third win unlocks immediately, notifies once, and opens settings', async () => {
    const { context, page } = await open('player');
    state.dates.player = await page.evaluate(() => [shiftDateString(getPuzzleDate(), -2), shiftDateString(getPuzzleDate(), -1)]);
    await page.locator('#submit').click();
    for (let step = 0; step < 5; step += 1) {
      const answer = await page.evaluate(index => correctAnswers[index], step);
      const inputs = page.locator('#guess-container .cell.active');
      for (let i = 0; i < answer.length; i += 1) await inputs.nth(i).fill(String(answer[i]));
      await page.locator('#submit').click();
    }
    await page.locator('#hint-unlock-dialog').waitFor({ state: 'visible' });
    assert.equal(state.claims, 1);
    await page.locator('#hint-unlock-customize').click();
    assert.equal(await page.locator('#hint-colors-controls').isVisible(), true);
    await page.evaluate(() => refreshHintColors());
    assert.equal(await page.locator('#hint-unlock-dialog').isVisible(), false);
    assert.match(await page.locator('#streak').innerText(), /3-days streak/);
    assert.equal(await page.locator('#hint-circle-options button').count(), 7);
    assert.equal(await page.locator('#hint-square-options button').count(), 7);
    await selectColor(page, 'circle', 'purple');
    await selectColor(page, 'square', 'blue');
    assert.equal(await page.locator('[data-type="circle"][data-color="purple"]').getAttribute('aria-pressed'), 'true');
    assert.match(await page.locator('#hint-color-status').innerText(), /saved to your account/);

    // Inspect board styling and every share path without changing feedback semantics.
    const before = await page.locator('#guess-container .final-code .cell').first().evaluate(cell => getComputedStyle(cell).backgroundColor);
    await page.evaluate(() => {
      const cells = guessContainer.querySelectorAll('.row:not(.final-code) .cell');
      cells.forEach(cell => cell.classList.remove('green', 'yellow', 'gray'));
      cells[0].classList.add('green'); cells[1].classList.add('yellow');
    });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#guess-container .cell')).backgroundColor === 'rgb(41, 128, 185)');
    assert.match(await page.locator('#guess-container .cell').nth(1).evaluate(cell => getComputedStyle(cell).backgroundImage), /142, 68, 173/);
    assert.equal(await page.locator('#guess-container .final-code .cell').first().evaluate(cell => getComputedStyle(cell).backgroundColor), before);
    await page.evaluate(() => { copyResults(); shareTwitter(); shareFacebook(); shareThreads(); shareReddit(); shareBluesky(); });
    const text = await page.evaluate(() => buildShareText());
    assert.deepEqual(text.split('\n').slice(1, 5), ['🟦', '🟣⬛', '⬛⬛⬛', '⬛⬛⬛⬛']);
    assert.equal(await page.evaluate(() => window.__copied), text);
    const urls = await page.evaluate(() => window.__sharedUrls);
    assert.equal(urls.length, 5);
    assert.ok(urls.every(url => decodeURIComponent(url).includes(text)));
    assert.equal(await page.evaluate(() => buildShareText().includes(code.join(''))), false);
    // The preview cannot add cells to sharing, and gameplay feedback is unchanged.
    assert.deepEqual(await page.evaluate(() => colorFeedback([1, 1, 2, 3], [1, 2, 4, 5])), ['green', 'gray', 'yellow', 'gray']);
    await page.locator('label[for="theme-toggle"]').click();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#guess-container .cell')).backgroundColor === 'rgb(144, 202, 249)');
    await page.locator('#menu-toggle').click();
    await page.locator('#difficulty-slider').fill('3.7');
    await page.locator('#difficulty-submit').click();
    await page.waitForFunction(() => document.getElementById('difficulty-submit').textContent === 'Submitted ✓');
    assert.equal(state.ratings.player.rating, 3.7);
    await context.close();
  });

  await t.test('saved colors load on another device after streak resets; failed saves roll back; reset and logout restore defaults', async () => {
    state.dates.player = [];
    const { context, page } = await open('player', { width: 375, height: 812 });
    await openMenu(page);
    assert.deepEqual(await page.evaluate(() => [getHintColor('circle').circle, getHintColor('square').square]), ['🟣', '🟦']);
    assert.match(await page.locator('#streak').innerText(), /0-days streak/);
    assert.equal(await page.locator('#hint-unlock-dialog').isVisible(), false);
    state.failSave = true;
    await selectColor(page, 'circle', 'red');
    assert.match(await page.locator('#hint-color-status').innerText(), /Could not save/);
    assert.equal(await page.evaluate(() => getHintColor('circle').circle), '🟣');
    state.failSave = false;
    assert.equal(await page.locator('#side-menu').evaluate(menu => menu.scrollWidth <= menu.clientWidth), true);
    assert.equal(await page.locator('#hint-color-settings').evaluate(settings => {
      const rect = settings.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth;
    }), true);
    await page.locator('#hint-colors-reset').click();
    await page.waitForFunction(() => document.getElementById('hint-color-status').textContent === 'Colors saved to your account.');
    assert.equal(state.prefs.player.circle_color, 'yellow');
    assert.equal(state.prefs.player.square_color, 'green');
    await selectColor(page, 'circle', 'brown');
    await page.locator('#logout-button').click();
    assert.deepEqual(await page.evaluate(() => [getHintColor('circle').circle, getHintColor('square').square]), ['🟡', '🟩']);
    assert.equal(await page.locator('#hint-colors-controls').isVisible(), false);
    await context.close();
  });

  await t.test('load failures allow retry; a save finishing after logout cannot recolor guest UI', async () => {
    state.failRead = true;
    const { context, page } = await open('player');
    await openMenu(page);
    assert.match(await page.locator('#hint-color-status').innerText(), /Could not load/);
    state.failRead = false;
    await page.locator('#hint-colors-retry').click();
    await page.locator('#hint-colors-controls').waitFor({ state: 'visible' });
    let release;
    state.holdSave = new Promise(resolve => { release = resolve; });
    await page.evaluate(() => { window.__pendingSave = saveHintColors({ ...hintColors, square: 'purple' }); });
    await page.locator('#logout-button').click();
    release(); state.holdSave = null;
    await page.evaluate(() => window.__pendingSave);
    await page.waitForFunction(() => !currentSession);
    assert.deepEqual(await page.evaluate(() => [getHintColor('circle').circle, getHintColor('square').square]), ['🟡', '🟩']);
    assert.equal(await page.locator('#hint-color-status').innerText(), '');
    await context.close();
  });
  assert.deepEqual(errors, []);
});
