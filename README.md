# Godle
A daily fun math puzzle game. 

## Deploy custom hint colors

1. In the existing Supabase project's SQL editor, execute
   `supabase/migrations/202611050001_hint_color_preferences.sql` once.
2. Deploy the updated `index.html` using the current static hosting setup.
   No frontend build or new runtime dependency is required.

The migration uses the existing `public.puzzle_completions(user_id, puzzle_date)`
records and `auth.users`. It checks for three consecutive completed dates and
creates a permanent account preference row. It does not change completion records,
the existing streak calculations, authentication, puzzle rules, or difficulty ratings.
Historical qualifying accounts are backfilled using all their completion dates,
including dates beyond the existing display's 1,000-record limit. Future dates
do not establish eligibility.

RLS permits authenticated players to read only their own preferences. Column grants
allow updates only to their own circle and square colors. Guests and locked players
cannot insert an unlock, and clients cannot change the unlock or notification fields.
An account-scoped RPC atomically claims the one-time notification. Historical
backfills already count as notified; new unlocks receive the congratulatory dialog.
As with the existing streak display, eligibility trusts the existing completion
records and their current write policies.

In **Menu → Hint Color Settings**, unlocked players can independently choose seven
circle and square colors, preview them, and reset to yellow/green. Saving goes to
Supabase; no local cache grants eligibility. Failed saves restore the previous
colors and show an error. Logging out restores defaults immediately. The same
palette powers the grid, legend, preview, Copy Results, Facebook, X, Threads,
Reddit, and Bluesky. Final-code cells and unmarked cells keep their original styles.
Shared results retain their existing layout and exclude the final code row.

If the migration has not run or settings cannot be loaded, the game continues with
standard colors and the menu offers a retry. The migration has not been applied
to the live Supabase project as part of this change.

## Verify

```sh
npm ci
npx playwright install chromium
npm test
```

To use an existing Chromium installation, set `CHROMIUM_PATH` when running tests.
The PostgreSQL tests use PGlite and test the actual migration, triggers, grants,
and RLS in an isolated database. Browser tests use mocked Supabase responses and
exercise the real page: completing a puzzle, unlocking, saving, restoring on a
second browser context, sharing to each service, logout, error handling, light/dark
colors, mobile menu sizing, and submitting a difficulty rating. They do not log
into or modify production accounts or publish to social networks.

After deployment, verify with test accounts:

1. Open as a guest, then as an account with fewer than three consecutive daily
   completions. Settings should stay locked, with yellow circles and green squares.
2. With two preceding daily completions on a test account, solve today's puzzle.
   The congratulatory message should appear immediately. **Customize My Colors**
   should open the selectors. Reload or log in elsewhere: the message should not repeat.
3. Choose purple circles and blue squares. Check revealed hints, completed rows,
   the preview, Copy Results, and the X/Facebook share text. Unmarked cells and the
   final-code row should look as before. Facebook may omit its supplied quote;
   Copy Results provides the same text to paste into the post.
4. Sign into the same account on another device. The colors should restore. A
   later broken streak should leave the feature unlocked. A historical 3-day
   account should already have access after migration.
5. Reset to Default, then choose colors again and log out. Guests should always
   get standard colors. In a test environment, fail a preferences update and
   confirm that an error appears and the previous colors return.

Changed files: `index.html` (UI, account sync, shared palette), the SQL migration
(persistent unlock, RLS, notification), and development-only test/dependency files.
