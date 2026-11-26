begin;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
create temp table r(k text, v text) on commit drop;
insert into r select 'is_admin', public.is_admin()::text;
insert into r select 'speed', public.confirm_win('T1','普',
  (select array_agg((x->>'entry_id')::uuid) from jsonb_array_elements(public.admin_pool('T1','普')) x where (x->>'rank')::int<=3),'speed')::text;
insert into r select 'speed_again_same', public.confirm_win('T1','普',
  (select array_agg((x->>'entry_id')::uuid) from jsonb_array_elements(public.admin_pool('T1','普')) x where (x->>'rank')::int<=1),'speed')::text;
insert into r select 'pick', public.confirm_win('T1','普',
  (select array_agg((x->>'entry_id')::uuid) from jsonb_array_elements(public.admin_pool('T1','普')) x where (x->>'rank')::int=7),'pick')::text;
insert into r select 'lock', public.lock_pool('T1','普')::text;
insert into r select 'draw', public.draw('T1','普','38627')::text;
insert into r select 'draw_again', (public.draw('T1','普','11111')->>'number');
insert into r select 'orders_now', (select string_agg(order_id||'/'||order_type,' ' order by order_id) from public.orders);
insert into r select 'not_selected', (select count(*)::text from public.entries where campaign_id='T1' and pool='普' and status='not_selected');
select * from r;
commit;
