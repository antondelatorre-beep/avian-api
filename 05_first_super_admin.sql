-- =====================================================================
-- Avian Market PH — SQL Part 5 of 5: Make YOU the first Super Admin
-- FIRST create your login (see instructions), THEN edit the 2 lines below
-- (your real name and the same email), and run.
-- =====================================================================

insert into public.admin_profiles (id, full_name, email, role)
select id, 'YOUR FULL NAME HERE', email, 'super_admin'
from auth.users
where email = 'YOUR_EMAIL_HERE';

-- Check it worked (should show 1 row):
select id, full_name, email, role, is_active from public.admin_profiles;
