-- 应急回滚：恢复旧前台能用的放行策略（= 恢复旧漏洞），只为保开单。新表/函数不删。
begin;
drop policy if exists orders_admin on public.orders;
drop policy if exists settings_admin on public.settings;
create policy "Allow all access to orders" on public.orders for all using (true) with check (true);
create policy "Allow all access to settings" on public.settings for all using (true) with check (true);
grant select, insert, update, delete on public.orders, public.settings to anon;
update storage.buckets set public = true, file_size_limit = null, allowed_mime_types = null where id = 'reference-images';
create policy "Allow public read reference-images" on storage.objects for select using (bucket_id = 'reference-images');
create policy "Allow public upload to reference-images" on storage.objects for insert with check (bucket_id = 'reference-images');
commit;
