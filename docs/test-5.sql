insert into public.campaigns (id, open_at, window_seconds, quotas) values ('T2', clock_timestamp() - interval '1 second', 8,
 '{"普":{"speed":3,"pick":1,"lottery":2},"钞":{"speed":3,"pick":1,"lottery":0}}');
create or replace function pg_temp.tk(i int) returns text language sql as $$ select translate(rtrim(encode(extensions.digest('t2-'||i,'sha256'),'base64'),'='),'+/','-_') $$;
begin; set local role anon;
select count(*) filter (where s='received') rec, count(*) filter (where s='reviewing') rev from (
 select public.submit_entry(md5('t2req'||i)::uuid, pg_temp.tk(i), case when i<=12 then '普' when i<=18 then '钞' else '三倍钞' end,
  jsonb_build_object('campaign_id','T2','size','3fen','makeup','cos','addons',jsonb_build_array('睫毛','睫毛','加急'),
   'xianyu_id','T2鱼'||i,'contact1','1390000'||lpad(i::text,4,'0'),'receiver_name','测'||i,'size_label','乱写','evil','<script>'))->>'status' s
 from generate_series(1,19) i) x;
commit;
