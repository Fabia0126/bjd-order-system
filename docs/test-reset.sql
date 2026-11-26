-- 只用于测试库：清掉迁移和复刻的一切，回到空库
drop table if exists public.upload_tickets, public.lottery_pools, public.entries, public.campaigns, public.admins, public.orders, public.settings cascade;
do $$ declare r record; begin
  for r in select p.oid::regprocedure f from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' loop
    execute 'drop function if exists ' || r.f || ' cascade'; end loop;
  for r in select policyname from pg_policies where schemaname='storage' and tablename='objects' loop
    execute format('drop policy if exists %I on storage.objects', r.policyname); end loop;
end $$;
update storage.buckets set public=true, file_size_limit=null, allowed_mime_types=null where id='reference-images';  -- 旧对象留着（只能走 Storage API 删），桶设置还原成线上样子
delete from auth.users where email in ('admin-test@example.com');
