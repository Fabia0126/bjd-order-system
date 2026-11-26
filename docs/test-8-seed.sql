insert into public.campaigns (id, open_at, window_seconds, quotas) values ('UI2', clock_timestamp() - interval '1 second', 6,
 '{"普":{"speed":3,"pick":1,"lottery":2},"钞":{"speed":3,"pick":1,"lottery":2}}');
create or replace function pg_temp.tk(i int) returns text language sql as $$ select translate(rtrim(encode(extensions.digest('ui2-'||i,'sha256'),'base64'),'='),'+/','-_') $$;
begin; set local role anon;
select count(*) from (select public.submit_entry(md5('ui2'||i)::uuid, pg_temp.tk(i), case when i<=14 then '普' when i<=19 then '钞' else '三倍钞' end,
  jsonb_build_object('campaign_id','UI2','size',case when i%2=0 then '3fen' else '4fen' end,'makeup',(array['free','specified','cos'])[1+i%3],
   'xianyu_id',(array['小月亮','糯米团','青柠','雾岛','阿蛮','栗子','Mochi','白桃乌龙','鹿鹿','七七','小满','苏打','绵绵','橘子汽水','夜航星','Luna','十一','木木','初雪','三倍姐姐'])[i],
   'contact1','1390000'||lpad(i::text,4,'0'),'receiver_name','测'||i)) from generate_series(1,20) i) x;
commit;
