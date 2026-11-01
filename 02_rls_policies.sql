-- =====================================================================
-- Avian Market PH — SQL Part 2 of 5: Row Level Security policies
-- Run AFTER 01_tables.sql
-- =====================================================================

-- Turn RLS on for every table
alter table public.admin_profiles      enable row level security;
alter table public.buyer_profiles      enable row level security;
alter table public.birds               enable row level security;
alter table public.bird_documents      enable row level security;
alter table public.applications        enable row level security;
alter table public.application_notes   enable row level security;
alter table public.conversations       enable row level security;
alter table public.messages            enable row level security;
alter table public.message_attachments enable row level security;
alter table public.orders              enable row level security;
alter table public.payments            enable row level security;
alter table public.deliveries          enable row level security;
alter table public.notifications       enable row level security;
alter table public.audit_logs          enable row level security;
alter table public.settings            enable row level security;

-- Logged-out visitors get NOTHING from tables; only the safe public_birds view.
revoke all on all tables in schema public from anon;
grant select on public.public_birds to anon, authenticated;

-- ---------- admin_profiles ----------
create policy "admin sees own profile" on public.admin_profiles
  for select to authenticated using (id = (select auth.uid()));
create policy "super admin reads admins" on public.admin_profiles
  for select to authenticated using (public.has_role('super_admin'));
create policy "super admin manages admins" on public.admin_profiles
  for all to authenticated
  using (public.has_role('super_admin')) with check (public.has_role('super_admin'));

-- ---------- buyer_profiles ----------
create policy "buyer reads own profile" on public.buyer_profiles
  for select to authenticated using (id = (select auth.uid()));
create policy "buyer updates own profile" on public.buyer_profiles
  for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy "staff read buyers" on public.buyer_profiles
  for select to authenticated
  using (public.has_role('super_admin','customer_support','application_reviewer'));

-- ---------- birds (no delete policy: archive instead) ----------
create policy "admins read all birds" on public.birds
  for select to authenticated using (public.is_admin());
create policy "inventory adds birds" on public.birds
  for insert to authenticated
  with check (public.has_role('super_admin','inventory_manager'));
create policy "inventory edits birds" on public.birds
  for update to authenticated
  using (public.has_role('super_admin','inventory_manager'))
  with check (public.has_role('super_admin','inventory_manager'));

-- ---------- bird_documents (private wildlife records) ----------
create policy "docs read" on public.bird_documents
  for select to authenticated
  using (public.has_role('super_admin','inventory_manager','read_only_analyst'));
create policy "docs write" on public.bird_documents
  for all to authenticated
  using (public.has_role('super_admin','inventory_manager'))
  with check (public.has_role('super_admin','inventory_manager'));

-- ---------- applications (buyers submit through the API) ----------
create policy "buyer reads own applications" on public.applications
  for select to authenticated using (buyer_id = (select auth.uid()));
create policy "staff read applications" on public.applications
  for select to authenticated
  using (public.has_role('super_admin','application_reviewer','customer_support'));
create policy "reviewers update applications" on public.applications
  for update to authenticated
  using (public.has_role('super_admin','application_reviewer'))
  with check (public.has_role('super_admin','application_reviewer'));

-- ---------- application_notes: staff only, buyers never ----------
create policy "staff read notes" on public.application_notes
  for select to authenticated
  using (public.has_role('super_admin','application_reviewer','customer_support'));
create policy "staff add notes" on public.application_notes
  for insert to authenticated
  with check (author_id = (select auth.uid())
    and public.has_role('super_admin','application_reviewer','customer_support'));

-- ---------- conversations ----------
create policy "buyer reads own conversations" on public.conversations
  for select to authenticated using (buyer_id = (select auth.uid()));
create policy "staff read conversations" on public.conversations
  for select to authenticated
  using (public.has_role('super_admin','customer_support','application_reviewer'));
create policy "staff update conversations" on public.conversations
  for update to authenticated
  using (public.has_role('super_admin','customer_support','application_reviewer'))
  with check (public.has_role('super_admin','customer_support','application_reviewer'));

-- ---------- messages ----------
create policy "buyer reads own messages" on public.messages
  for select to authenticated
  using (exists (select 1 from public.conversations c
                 where c.id = conversation_id and c.buyer_id = (select auth.uid())));
create policy "staff read messages" on public.messages
  for select to authenticated
  using (public.has_role('super_admin','customer_support','application_reviewer'));
create policy "buyer sends message" on public.messages
  for insert to authenticated
  with check (sender_type = 'buyer' and sender_id = (select auth.uid())
    and exists (select 1 from public.conversations c
                where c.id = conversation_id and c.buyer_id = (select auth.uid())
                  and c.status = 'Open'));
create policy "staff sends message" on public.messages
  for insert to authenticated
  with check (sender_type = 'admin' and sender_id = (select auth.uid())
    and public.has_role('super_admin','customer_support','application_reviewer'));

-- ---------- message_attachments ----------
create policy "buyer reads own attachments" on public.message_attachments
  for select to authenticated
  using (exists (select 1 from public.messages m
                 join public.conversations c on c.id = m.conversation_id
                 where m.id = message_id and c.buyer_id = (select auth.uid())));
create policy "staff read attachments" on public.message_attachments
  for select to authenticated
  using (public.has_role('super_admin','customer_support','application_reviewer'));
create policy "sender adds attachment" on public.message_attachments
  for insert to authenticated
  with check (exists (select 1 from public.messages m
                      where m.id = message_id and m.sender_id = (select auth.uid())));

-- ---------- orders ----------
create policy "buyer reads own orders" on public.orders
  for select to authenticated using (buyer_id = (select auth.uid()));
create policy "staff read orders" on public.orders
  for select to authenticated
  using (public.has_role('super_admin','customer_support','inventory_manager'));
create policy "staff create orders" on public.orders
  for insert to authenticated
  with check (public.has_role('super_admin','customer_support'));
create policy "staff update orders" on public.orders
  for update to authenticated
  using (public.has_role('super_admin','customer_support'))
  with check (public.has_role('super_admin','customer_support'));

-- ---------- payments (buyers see payment status on the order, not this table) ----------
create policy "staff read payments" on public.payments
  for select to authenticated
  using (public.has_role('super_admin','customer_support'));
create policy "staff record payments" on public.payments
  for insert to authenticated
  with check (public.has_role('super_admin','customer_support'));
create policy "only super admin confirms payments" on public.payments
  for update to authenticated
  using (public.has_role('super_admin')) with check (public.has_role('super_admin'));

-- ---------- deliveries (exact address: owner + super admin / support only) ----------
create policy "buyer reads own delivery" on public.deliveries
  for select to authenticated
  using (exists (select 1 from public.orders o
                 where o.id = order_id and o.buyer_id = (select auth.uid())));
create policy "staff read deliveries" on public.deliveries
  for select to authenticated
  using (public.has_role('super_admin','customer_support'));
create policy "staff write deliveries" on public.deliveries
  for all to authenticated
  using (public.has_role('super_admin','customer_support'))
  with check (public.has_role('super_admin','customer_support'));

-- ---------- notifications ----------
create policy "own notifications read" on public.notifications
  for select to authenticated using (user_id = (select auth.uid()));
create policy "own notifications update" on public.notifications
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- ---------- audit_logs: super admin can read; only the API can write ----------
create policy "super admin reads audit" on public.audit_logs
  for select to authenticated using (public.has_role('super_admin'));

-- ---------- settings ----------
create policy "admins read settings" on public.settings
  for select to authenticated using (public.is_admin());
create policy "super admin writes settings" on public.settings
  for all to authenticated
  using (public.has_role('super_admin')) with check (public.has_role('super_admin'));
