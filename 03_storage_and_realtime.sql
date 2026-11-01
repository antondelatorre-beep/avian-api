-- =====================================================================
-- Avian Market PH — SQL Part 3 of 5: Storage buckets + Realtime
-- Run AFTER 02_rls_policies.sql
-- =====================================================================

-- ---------- BUCKETS ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('logo',               'logo',               true,  2097152,
     array['image/png','image/jpeg','image/webp']),
  ('chat-attachments',   'chat-attachments',   false, 10485760,
     array['image/jpeg','image/png','image/webp','application/pdf']),
  ('wildlife-documents', 'wildlife-documents', false, 15728640,
     array['image/jpeg','image/png','application/pdf']),
  ('payment-proofs',     'payment-proofs',     false, 5242880,
     array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do nothing;

-- ---------- logo (public read, super admin writes) ----------
create policy "logo public read" on storage.objects
  for select using (bucket_id = 'logo');
create policy "logo super admin write" on storage.objects
  for all to authenticated
  using (bucket_id = 'logo' and public.has_role('super_admin'))
  with check (bucket_id = 'logo' and public.has_role('super_admin'));

-- ---------- chat-attachments: files live in  <conversation_id>/<filename> ----------
create policy "chat files read" on storage.objects
  for select to authenticated
  using (bucket_id = 'chat-attachments' and (
    public.has_role('super_admin','customer_support','application_reviewer')
    or exists (select 1 from public.conversations c
               where c.id::text = (storage.foldername(name))[1]
                 and c.buyer_id = (select auth.uid()))));
create policy "chat files upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'chat-attachments' and (
    public.has_role('super_admin','customer_support','application_reviewer')
    or exists (select 1 from public.conversations c
               where c.id::text = (storage.foldername(name))[1]
                 and c.buyer_id = (select auth.uid()))));

-- ---------- wildlife-documents: admins only ----------
create policy "wildlife docs read" on storage.objects
  for select to authenticated
  using (bucket_id = 'wildlife-documents'
         and public.has_role('super_admin','inventory_manager'));
create policy "wildlife docs upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'wildlife-documents'
              and public.has_role('super_admin','inventory_manager'));
create policy "wildlife docs update" on storage.objects
  for update to authenticated
  using (bucket_id = 'wildlife-documents'
         and public.has_role('super_admin','inventory_manager'));

-- ---------- payment-proofs: files live in  <order_id>/<filename> ----------
create policy "payment proofs read" on storage.objects
  for select to authenticated
  using (bucket_id = 'payment-proofs' and (
    public.has_role('super_admin','customer_support')
    or exists (select 1 from public.orders o
               where o.id::text = (storage.foldername(name))[1]
                 and o.buyer_id = (select auth.uid()))));
create policy "payment proofs upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'payment-proofs'
    and exists (select 1 from public.orders o
                where o.id::text = (storage.foldername(name))[1]
                  and o.buyer_id = (select auth.uid())));

-- ---------- REALTIME (RLS still applies to what each person receives) ----------
alter publication supabase_realtime
  add table public.messages, public.conversations, public.notifications;
