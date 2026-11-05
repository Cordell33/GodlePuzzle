const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const ids = Array.from({ length: 5 }, (_, i) => `00000000-0000-0000-0000-00000000000${i + 1}`);
const [historical, player, other, gaps, future] = ids;

test('Supabase migration: eligibility, permanence, notifications and account isolation', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    set time zone 'America/New_York';
    create role anon;
    create role authenticated;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    create table public.puzzle_completions (
      user_id uuid references auth.users(id), puzzle_date date,
      unique (user_id, puzzle_date)
    );
    insert into auth.users values ${ids.map(id => `('${id}')`).join(',')};
    insert into public.puzzle_completions values
      ('${historical}', '2010-01-01'), ('${historical}', '2010-01-02'), ('${historical}', '2010-01-03'),
      ('${player}', current_date - 2), ('${player}', current_date - 1),
      ('${gaps}', '2020-01-01'), ('${gaps}', '2020-01-03'), ('${gaps}', '2020-01-05'),
      ('${future}', current_date + 10), ('${future}', current_date + 11), ('${future}', current_date + 12);
    insert into public.puzzle_completions
      select '${historical}'::uuid, '2015-01-01'::date + n * 2 from generate_series(0, 1000) n;
  `);
  const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/202611050001_hint_color_preferences.sql'), 'utf8');
  await db.exec(migration);
  const settings = async id => (await db.query('select * from public.hint_color_preferences where user_id = $1', [id])).rows;
  const asRole = async (role, id, action) => {
    await db.exec(`set role ${role}`);
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id || '']);
    try { return await action(); } finally { await db.exec('reset role'); }
  };
  const denied = async action => assert.rejects(action, error => error.code === '42501');

  await t.test('backfills historical best streak beyond 1,000 records, with standard colors', async () => {
    const [row] = await settings(historical);
    assert.ok(row.unlocked_at);
    assert.ok(row.notification_seen_at);
    assert.equal(row.circle_color, 'yellow');
    assert.equal(row.square_color, 'green');
    for (const id of [player, other, gaps, future]) assert.equal((await settings(id)).length, 0);
  });

  await t.test('guest and locked account cannot create an unlock or access another account', async () => {
    await asRole('anon', null, async () => {
      await denied(() => db.query('select * from public.hint_color_preferences'));
      await denied(() => db.query('select public.claim_hint_color_unlock_notification()'));
    });
    await asRole('authenticated', player, async () => {
      assert.equal((await db.query('select * from public.hint_color_preferences')).rows.length, 0);
      await denied(() => db.query('insert into public.hint_color_preferences(user_id) values ($1)', [player]));
      await denied(() => db.query('select public.unlock_hint_colors_on_completion()'));
      assert.equal((await db.query("update public.hint_color_preferences set circle_color = 'red' returning *")).rows.length, 0);
    });
  });

  await t.test('third consecutive daily completion immediately creates a permanent unlock', async () => {
    await db.query('insert into public.puzzle_completions values ($1, current_date)', [player]);
    const [row] = await settings(player);
    assert.ok(row.unlocked_at);
    assert.equal(row.notification_seen_at, null);
    await db.query('delete from public.puzzle_completions where user_id = $1', [player]);
    assert.deepEqual((await settings(player))[0].unlocked_at, row.unlocked_at);
  });

  await t.test('only own color columns can change; all seven colors are accepted', async () => {
    await asRole('authenticated', player, async () => {
      for (const color of ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'brown']) {
        await db.query('update public.hint_color_preferences set circle_color = $1, square_color = $1 where user_id = $2', [color, player]);
      }
      await db.query("update public.hint_color_preferences set circle_color = 'purple', square_color = 'blue' where user_id = $1", [player]);
      assert.equal((await db.query("update public.hint_color_preferences set square_color = 'red' where user_id = $1 returning *", [historical])).rows.length, 0);
      await denied(() => db.query('update public.hint_color_preferences set unlocked_at = now()'));
      await denied(() => db.query('update public.hint_color_preferences set notification_seen_at = null'));
      await denied(() => db.query('update public.hint_color_preferences set user_id = $1', [other]));
      await denied(() => db.query('delete from public.hint_color_preferences'));
      await assert.rejects(() => db.query("update public.hint_color_preferences set circle_color = 'invalid'"), error => error.code === '23514');
    });
    await asRole('authenticated', player, async () => {
      const { rows } = await db.query('select circle_color, square_color from public.hint_color_preferences');
      assert.deepEqual(rows, [{ circle_color: 'purple', square_color: 'blue' }]);
    });
  });

  await t.test('notification is claimed once per account and cannot be claimed by another player', async () => {
    await asRole('authenticated', other, async () => {
      assert.equal((await db.query('select public.claim_hint_color_unlock_notification() as claimed')).rows[0].claimed, false);
    });
    await asRole('authenticated', player, async () => {
      assert.equal((await db.query('select public.claim_hint_color_unlock_notification() as claimed')).rows[0].claimed, true);
      assert.equal((await db.query('select public.claim_hint_color_unlock_notification() as claimed')).rows[0].claimed, false);
    });
    await asRole('authenticated', historical, async () => {
      assert.equal((await db.query('select public.claim_hint_color_unlock_notification() as claimed')).rows[0].claimed, false);
    });
  });
});
