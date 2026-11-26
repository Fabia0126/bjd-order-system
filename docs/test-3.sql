begin; set local role anon;
create temp table r(k text, v text) on commit drop;
insert into r select 'anon_orders', count(*)::text from public.orders;
insert into r select 'anon_entries', count(*)::text from public.entries;
insert into r select 'anon_settings', count(*)::text from public.settings;
insert into r select 'replay', public.submit_entry(md5('req1')::uuid, repeat('tok001',10), '普',
  jsonb_build_object('campaign_id','T1','size','4fen','makeup','specified','addons',jsonb_build_array('睫毛'),
   'xianyu_id','鱼1','contact1','13900000001','size_label','四分','makeup_label','指定妆'))->>'replay';
insert into r select 'lookup_status', public.lookup_entry(repeat('tok005',10))->>'status';
insert into r select 'lookup_has_contact', (public.lookup_entry(repeat('tok005',10))->'payload' ? 'contact1')::text;
insert into r select 'status_close', public.campaign_status()->'campaign'->>'close_at';
select * from r;
commit;
