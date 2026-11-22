begin;

create table if not exists public.contact_records (
  id text primary key check (length(btrim(id)) > 0),
  name text not null default '',
  address text not null default '',
  phone_number text not null default '',
  comments text not null default '',
  owner_id uuid references auth.users(id) on delete set null
);

alter table public.contact_records
  add column if not exists owner_id uuid;

alter table public.contact_records
  alter column owner_id drop not null;

alter table public.contact_records
  drop constraint if exists contact_records_owner_id_fkey;

alter table public.contact_records
  add constraint contact_records_owner_id_fkey
  foreign key (owner_id) references auth.users(id) on delete set null;

create unique index if not exists contact_records_id_normalized_unique
  on public.contact_records (lower(btrim(id)));

alter table public.contact_records enable row level security;

revoke all on table public.contact_records from anon, authenticated;
grant select, insert, update, delete on table public.contact_records to authenticated;

drop policy if exists "Users can read their own contact records"
  on public.contact_records;
drop policy if exists "Users can insert their own contact records"
  on public.contact_records;
drop policy if exists "Users can update their own contact records"
  on public.contact_records;
drop policy if exists "Users can delete their own contact records"
  on public.contact_records;
drop policy if exists contact_records_select_own on public.contact_records;
drop policy if exists contact_records_insert_own on public.contact_records;
drop policy if exists contact_records_update_own on public.contact_records;
drop policy if exists contact_records_delete_own on public.contact_records;
drop policy if exists contact_records_select_authenticated on public.contact_records;
drop policy if exists contact_records_insert_authenticated on public.contact_records;
drop policy if exists contact_records_update_authenticated on public.contact_records;
drop policy if exists contact_records_delete_authenticated on public.contact_records;

create policy contact_records_select_authenticated
  on public.contact_records for select to authenticated
  using (true);

create policy contact_records_insert_authenticated
  on public.contact_records for insert to authenticated
  with check (true);

create policy contact_records_update_authenticated
  on public.contact_records for update to authenticated
  using (true)
  with check (true);

create policy contact_records_delete_authenticated
  on public.contact_records for delete to authenticated
  using (true);

create or replace function public.import_contact_records(input_records jsonb)
returns table (added_records jsonb, duplicate_ids jsonb)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  inserted_ids text[];
begin
  if auth.uid() is null then
    raise exception 'Authentication is required';
  end if;

  if jsonb_typeof(input_records) is distinct from 'array' then
    raise exception 'input_records must be a JSON array';
  end if;

  if exists (
    select 1
      from jsonb_array_elements(input_records) as item(value)
     where nullif(btrim(coalesce(value ->> 'id', '')), '') is null
  ) then
    raise exception 'Every imported record must have a non-empty ID';
  end if;

  with incoming as (
    select
      btrim(value ->> 'id') as id,
      ordinality,
      row_number() over (
        partition by lower(btrim(value ->> 'id'))
        order by ordinality
      ) as occurrence
    from jsonb_array_elements(input_records) with ordinality as item(value, ordinality)
  )
  select coalesce(
    jsonb_agg(to_jsonb(incoming.id) order by incoming.ordinality)
      filter (
        where incoming.occurrence > 1
           or exists (
             select 1
               from public.contact_records as existing
              where lower(btrim(existing.id)) = lower(incoming.id)
           )
      ),
    '[]'::jsonb
  )
  into duplicate_ids
  from incoming;

  with incoming as (
    select
      btrim(value ->> 'id') as id,
      btrim(coalesce(value ->> 'name', '')) as name,
      btrim(coalesce(value ->> 'address', '')) as address,
      btrim(coalesce(value ->> 'phone_number', '')) as phone_number,
      btrim(coalesce(value ->> 'comments', '')) as comments,
      ordinality
    from jsonb_array_elements(input_records) with ordinality as item(value, ordinality)
  ),
  unique_incoming as (
    select distinct on (lower(incoming.id))
      incoming.id,
      incoming.name,
      incoming.address,
      incoming.phone_number,
      incoming.comments
    from incoming
    order by lower(incoming.id), incoming.ordinality
  ),
  inserted as (
    insert into public.contact_records as contact (
      id,
      name,
      address,
      phone_number,
      comments,
      owner_id
    )
    select
      incoming.id,
      incoming.name,
      incoming.address,
      incoming.phone_number,
      incoming.comments,
      (select auth.uid())
    from unique_incoming as incoming
    order by incoming.id
    on conflict do nothing
    returning contact.id
  )
  select coalesce(array_agg(inserted.id), array[]::text[])
    into inserted_ids
    from inserted;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', contact.id,
        'name', contact.name,
        'address', contact.address,
        'phoneNumber', contact.phone_number,
        'comments', contact.comments
      )
      order by contact.id
    ),
    '[]'::jsonb
  )
  into added_records
  from public.contact_records as contact
  where contact.id = any(inserted_ids);

  return next;
end;
$$;

revoke all on function public.import_contact_records(jsonb)
  from public, anon, authenticated;
grant execute on function public.import_contact_records(jsonb)
  to authenticated;

commit;
