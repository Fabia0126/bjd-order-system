insert into auth.users (id, email, aud, role) values ('00000000-0000-0000-0000-0000000000a1','admin-test@example.com','authenticated','authenticated') on conflict do nothing;
insert into public.admins (user_id) values ('00000000-0000-0000-0000-0000000000a1') on conflict do nothing;
insert into public.campaigns (id, open_at, window_seconds, quotas) values ('T1', clock_timestamp() - interval '1 second', 20,
 '{"普":{"speed":3,"pick":1,"lottery":2},"钞":{"speed":3,"pick":1,"lottery":2}}');
begin;
set local role anon;
select 'anon_orders_visible' k, count(*)::text v from public.orders
union all select 'anon_settings', count(*)::text from public.settings
union all select 'anon_entries', count(*)::text from public.entries;
commit;
begin; set local role anon; update public.orders set status='hacked'; commit;
select 'after_anon_update_hacked_rows' k, count(*)::text v from public.orders where status='hacked';
