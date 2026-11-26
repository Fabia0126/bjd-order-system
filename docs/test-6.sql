begin;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select public.confirm_win('T2','普', (select array_agg((x->>'entry_id')::uuid) from jsonb_array_elements(public.admin_pool('T2','普')) x where (x->>'rank')::int=1),'speed');
commit;
