# Contact Records

This React app is deployed as a static site and connects directly to Supabase using Supabase Auth and row-level security (RLS). The browser uses only the Supabase project URL and publishable/anon key. Never put a Supabase `service_role` key in this app.

## Secure the existing Supabase table

The app expects your existing `public.contact_records` table to have `id`, `name`, `address`, `phone_number`, and `comments` columns. Run the updated [`supabase/schema.sql`](./supabase/schema.sql) in **Supabase → SQL Editor → New query**. It:

- Enables RLS and lets every signed-in user read, add, edit, and delete all records.
- Adds the database function used for duplicate-safe Excel imports.

Before running the SQL, create an email/password user for each person who should use the app under **Authentication → Users → Add user**. Run the full script; it no longer requires a particular email address. Existing rows remain available to all signed-in users.

This shared-access setup allows any authenticated account to change or delete any record. Only create accounts for people you trust, and disable public sign-ups in Supabase Auth if users should not be able to register themselves. The existing `owner_id` column is retained only for compatibility and attribution; it does not restrict access. Never expose a Supabase `service_role` key.

## Configure and deploy the Render Static Site

1. Push the updated project to GitHub.
2. In Render, choose **New + → Blueprint**, select this app repository, and apply `render.yaml`. The service is configured as a Static Site with `dist` as its publish directory.
3. In the static site's **Environment** settings, add:
   - `VITE_SUPABASE_URL`: your Supabase Project URL.
   - `VITE_SUPABASE_ANON_KEY`: your Supabase publishable key (or legacy anon/public key).
4. Save the settings and trigger a new deploy so Vite includes these public configuration values in the static build.
5. In Supabase **Authentication → URL Configuration**, set the Site URL to the Render static-site URL. Add that URL to the redirect allow list if you later enable password reset or email links.
6. Open the Render URL and sign in with the Supabase Auth user's email and password.
7. Add a test record, refresh the page, then verify it appears in Supabase **Table Editor → contact_records**. Test an Excel import and duplicate ID as well.

Render Static Sites do not sleep when idle. Static frontend configuration values are embedded at build time, so redeploy after changing them.

## Run locally

Create a `.env.local` file from `.env.example`, then fill in the Supabase Project URL and publishable/anon key. These two frontend values are designed to be public; security comes from Supabase Auth and RLS. Do not put a service-role key in `.env.local`, any `VITE_` variable, or frontend code.

```powershell
npm install
npm run dev
```

Sign in with the Auth user created in Supabase. Excel uploads, record edits, and deletes go directly from the browser to Supabase, protected by that user's session and RLS.
