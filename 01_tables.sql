-- =====================================================================
-- Avian Market PH — SQL Part 1 of 5: Tables, triggers, helper functions
-- Paste into Supabase > SQL Editor > New query, then press Run.
-- Run the 5 parts IN ORDER (01, 02, 03, 04, 05).
-- =====================================================================

-- ---------- PROFILES ----------
create table public.admin_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  email text not null,
  role text not null check (role in
    ('super_admin','inventory_manager','application_reviewer','customer_support','read_only_analyst')),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.buyer_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  email text,
  contact_number text,
  preferred_language text not null default 'en' check (preferred_language in ('en','fil')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- BIRDS ----------
create table public.birds (
  id uuid primary key default gen_random_uuid(),
  listing_name text not null unique,          -- local name, always the main name
  species_common text,
  scientific_name text,
  species_note text,
  description text,
  price_php numeric(10,2) not null check (price_php >= 0),
  image_url text,
  image_attribution_text text,
  image_photographer text,
  image_source_page text,
  image_license text,
  image_license_url text,
  image_license_verified boolean not null default false,
  status text not null default 'Draft' check (status in
    ('Draft','Pending Verification','Available','Reserved','Sold','Archived')),
  identity_verified boolean not null default false,
  documentation_status text not null default 'Not Started' check (documentation_status in
    ('Not Started','In Review','Verified','Rejected')),
  provenance_info text,
  care_info text,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  -- A bird can only be public if identity AND documentation are verified:
  constraint published_requires_verification check (
    status not in ('Available','Reserved')
    or (identity_verified and documentation_status = 'Verified')
  )
);

create table public.bird_documents (
  id uuid primary key default gen_random_uuid(),
  bird_id uuid not null references public.birds(id) on delete cascade,
  doc_type text not null check (doc_type in
    ('species_identification','source_provenance','captive_bred','ownership',
     'denr_permit','commercial_authorization','transport_permit','other')),
  title text not null,
  file_path text,                              -- path inside private bucket wildlife-documents
  issuing_authority text,
  reference_number text,
  issued_on date,
  expires_on date,
  verification_status text not null default 'Pending' check (verification_status in
    ('Pending','Verified','Rejected','Expired')),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  verification_notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- APPLICATIONS ----------
create table public.applications (
  id uuid primary key default gen_random_uuid(),
  buyer_id uuid not null references public.buyer_profiles(id),
  bird_id uuid not null references public.birds(id),
  buyer_name text not null,
  email text not null,
  contact_number text not null,
  handling_experience text,
  previous_ownership text,
  current_ownership text,
  care_experience text,
  additional_info text,
  status text not null default 'Not Reviewed' check (status in
    ('Not Reviewed','Chat in Progress','Additional Information Required',
     'Suitable','Not Suitable','Final Review')),
  assigned_to uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index one_open_application_per_bird
  on public.applications (buyer_id, bird_id) where status <> 'Not Suitable';

create table public.application_notes (        -- INTERNAL, never visible to buyers
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications(id) on delete cascade,
  author_id uuid not null references auth.users(id),
  note text not null,
  created_at timestamptz not null default now()
);

-- ---------- CONVERSATIONS & MESSAGES ----------
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null unique references public.applications(id) on delete cascade,
  buyer_id uuid not null references public.buyer_profiles(id),
  assigned_to uuid references auth.users(id) on delete set null,
  status text not null default 'Open' check (status in ('Open','Closed')),
  last_message_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references auth.users(id),
  sender_type text not null check (sender_type in ('buyer','admin')),
  body text check (char_length(body) <= 4000),
  read_at timestamptz,                         -- read receipt
  created_at timestamptz not null default now()
);

create table public.message_attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages(id) on delete cascade,
  file_path text not null,                     -- path in private bucket chat-attachments
  file_name text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0),
  created_at timestamptz not null default now()
);

-- ---------- ORDERS, PAYMENTS, DELIVERY ----------
create sequence public.order_number_seq;

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique default
    ('APH-' || to_char(now(),'YYYYMMDD') || '-' || lpad(nextval('public.order_number_seq')::text, 4, '0')),
  application_id uuid not null unique references public.applications(id),
  buyer_id uuid not null references public.buyer_profiles(id),
  bird_id uuid not null references public.birds(id),
  price_php numeric(10,2) not null,            -- copied from the bird by a trigger, never from the buyer
  order_status text not null default 'Pending' check (order_status in
    ('Pending','Confirmed','Completed','Cancelled')),
  payment_status text not null default 'Not Yet Coordinated' check (payment_status in
    ('Not Yet Coordinated','Awaiting Payment','Submitted for Verification',
     'Confirmed','Rejected','Refunded')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id),
  amount_php numeric(10,2) not null check (amount_php >= 0),
  method text,
  reference_number text,
  proof_path text,                             -- path in private bucket payment-proofs
  status text not null default 'Awaiting Payment' check (status in
    ('Not Yet Coordinated','Awaiting Payment','Submitted for Verification',
     'Confirmed','Rejected','Refunded')),
  internal_notes text,
  submitted_at timestamptz,
  verified_by uuid references auth.users(id) on delete set null,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.deliveries (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders(id),
  recipient_name text,
  contact_number text,
  address text,
  instructions text,
  latitude double precision check (latitude between -90 and 90),
  longitude double precision check (longitude between -180 and 180),
  status text not null default 'Not Arranged' check (status in
    ('Not Arranged','Awaiting Verification','Transport Coordination',
     'Ready for Dispatch','In Transit','Delivered','Cancelled')),
  transport_provider text,
  transport_authorization_verified boolean not null default false,
  tracking_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- NOTIFICATIONS, AUDIT, SETTINGS ----------
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null,
  title text not null,
  body text,
  link text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  entity_type text,
  entity_id text,
  details jsonb,
  ip_address text,
  created_at timestamptz not null default now()
);

create table public.settings (
  key text primary key,
  value jsonb not null,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

-- ---------- INDEXES ----------
create index on public.messages (conversation_id, created_at);
create index on public.applications (buyer_id);
create index on public.applications (status);
create index on public.orders (buyer_id);
create index on public.conversations (buyer_id);
create index on public.bird_documents (bird_id);
create index on public.notifications (user_id, read_at);

-- ---------- HELPER FUNCTIONS ----------
create or replace function public.has_role(variadic allowed text[])
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.admin_profiles
    where id = (select auth.uid()) and is_active and role = any(allowed)
  );
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.admin_profiles
    where id = (select auth.uid()) and is_active
  );
$$;

-- ---------- TRIGGERS ----------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create trigger trg_buyer_profiles_updated before update on public.buyer_profiles
  for each row execute function public.set_updated_at();
create trigger trg_birds_updated before update on public.birds
  for each row execute function public.set_updated_at();
create trigger trg_bird_documents_updated before update on public.bird_documents
  for each row execute function public.set_updated_at();
create trigger trg_applications_updated before update on public.applications
  for each row execute function public.set_updated_at();
create trigger trg_orders_updated before update on public.orders
  for each row execute function public.set_updated_at();
create trigger trg_payments_updated before update on public.payments
  for each row execute function public.set_updated_at();
create trigger trg_deliveries_updated before update on public.deliveries
  for each row execute function public.set_updated_at();

-- New sign-up -> buyer profile (names come from sign-up form; NEVER used for roles)
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.buyer_profiles (id, email, full_name, contact_number)
  values (new.id, new.email,
          new.raw_user_meta_data->>'full_name',
          new.raw_user_meta_data->>'contact_number')
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- New application -> private conversation automatically
create or replace function public.create_conversation_for_application()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.conversations (application_id, buyer_id)
  values (new.id, new.buyer_id);
  return new;
end $$;

create trigger trg_application_conversation after insert on public.applications
  for each row execute function public.create_conversation_for_application();

-- New message -> update conversation activity time
create or replace function public.touch_conversation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.conversations set last_message_at = new.created_at where id = new.conversation_id;
  return new;
end $$;

create trigger trg_message_touch after insert on public.messages
  for each row execute function public.touch_conversation();

-- Orders: only from a "Suitable" application; price copied from the bird
create or replace function public.guard_new_order()
returns trigger language plpgsql security definer set search_path = public as $$
declare app public.applications%rowtype;
begin
  select * into app from public.applications where id = new.application_id;
  if app.id is null or app.status <> 'Suitable' then
    raise exception 'An order can only be created from an application marked Suitable';
  end if;
  new.buyer_id := app.buyer_id;
  new.bird_id := app.bird_id;
  select price_php into new.price_php from public.birds where id = app.bird_id;
  new.order_status := 'Pending';
  new.payment_status := 'Not Yet Coordinated';
  return new;
end $$;

create trigger trg_guard_new_order before insert on public.orders
  for each row execute function public.guard_new_order();

-- Orders: cannot be completed unless payment is Confirmed
create or replace function public.guard_order_update()
returns trigger language plpgsql as $$
begin
  if new.order_status = 'Completed'
     and old.order_status is distinct from 'Completed'
     and new.payment_status <> 'Confirmed' then
    raise exception 'An order cannot be completed until payment is Confirmed';
  end if;
  if new.order_status = 'Completed' and new.completed_at is null then
    new.completed_at := now();
  end if;
  return new;
end $$;

create trigger trg_guard_order_update before update on public.orders
  for each row execute function public.guard_order_update();

-- Payment status is mirrored onto the order
create or replace function public.sync_order_payment_status()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.orders set payment_status = new.status where id = new.order_id;
  return new;
end $$;

create trigger trg_sync_payment after insert or update of status on public.payments
  for each row execute function public.sync_order_payment_status();

-- Read receipts: marks the OTHER side's messages as read
create or replace function public.mark_conversation_read(p_conversation_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.conversations
             where id = p_conversation_id and buyer_id = auth.uid()) then
    update public.messages set read_at = now()
      where conversation_id = p_conversation_id and sender_type = 'admin' and read_at is null;
  elsif public.has_role('super_admin','customer_support','application_reviewer') then
    update public.messages set read_at = now()
      where conversation_id = p_conversation_id and sender_type = 'buyer' and read_at is null;
  end if;
end $$;

revoke execute on function public.mark_conversation_read(uuid) from public, anon;
grant execute on function public.mark_conversation_read(uuid) to authenticated;

-- ---------- VIEWS ----------
-- What the PUBLIC catalog may see: only Available/Reserved birds, and an image
-- only after its license has been verified by an admin.
create view public.public_birds as
select id, listing_name, species_common, scientific_name, species_note, description,
       price_php, status, provenance_info, care_info, sort_order,
       case when image_license_verified then image_url end as image_url,
       case when image_license_verified then image_attribution_text end as image_attribution_text,
       case when image_license_verified then image_photographer end as image_photographer,
       case when image_license_verified then image_source_page end as image_source_page,
       case when image_license_verified then image_license end as image_license,
       case when image_license_verified then image_license_url end as image_license_url
from public.birds
where status in ('Available','Reserved');

-- Revenue = completed orders with confirmed payment ONLY
create view public.confirmed_revenue_orders with (security_invoker = true) as
select * from public.orders
where order_status = 'Completed' and payment_status = 'Confirmed';
