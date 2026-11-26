-- 正式切换第 0 段：先关前台开关、拆旧放行策略，旧页面立刻无法写库（之后才跑迁移）
begin;
update public.settings set normal_open = false, premium_open = false, premium_3x_open = false where id = 1;
drop policy if exists "Allow all access to orders" on public.orders;
drop policy if exists "Allow all access to settings" on public.settings;
drop policy if exists "Allow public read reference-images" on storage.objects;
drop policy if exists "Allow public upload to reference-images" on storage.objects;
revoke all on public.orders, public.settings from anon;
commit;
