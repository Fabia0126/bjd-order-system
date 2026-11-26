begin;
set local role anon;
select i, public.submit_entry(md5('req'||i)::uuid, repeat('tok'||lpad(i::text,3,'0'),10), case when i<=10 then '普' else '钞' end,
  jsonb_build_object('campaign_id','T1','size','4fen','makeup','specified','addons',jsonb_build_array('睫毛'),
   'xianyu_id','鱼'||i,'contact1','1390000'||lpad(i::text,4,'0'),'size_label','四分','makeup_label','指定妆'))->>'status' s
from generate_series(1,16) i;
commit;
