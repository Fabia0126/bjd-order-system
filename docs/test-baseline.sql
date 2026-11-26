-- 测试库：复刻线上结构（2026-11-26 只读取证），全部假数据
create table public.orders (id uuid default gen_random_uuid() primary key, order_id text, status text default 'pending', order_type text, size text, makeup_type text, doll_info text, attribute text, gender text, color_scheme text, taboos text[], requirements text[], addons text[], free_items text[], glitter text, accessories text, xianyu_id text, receiver_name text, contact1 text, contact2 text, shipping text, total_price text, mianwen_price integer, submit_time timestamptz default now(), last_update timestamptz default now(), reject_reason text, reference_images text[], deposit_paid boolean, final_paid boolean, work_start_time timestamptz);
create table public.settings (id integer primary key default 1, normal_open boolean default true, normal_limit integer default 0, normal_open_time timestamptz, updated_at timestamptz default now(), premium_open boolean, premium_3x_open boolean);
insert into public.settings (id, normal_open, normal_limit, premium_open, premium_3x_open) values (1, true, 0, true, true);
alter table public.orders enable row level security; alter table public.settings enable row level security;
create policy "Allow all access to orders" on public.orders for all using (true) with check (true);
create policy "Allow all access to settings" on public.settings for all using (true) with check (true);
insert into storage.buckets (id, name, public) values ('reference-images','reference-images', true) on conflict do nothing;
create policy "Allow public read reference-images" on storage.objects for select using (bucket_id = 'reference-images');
create policy "Allow public upload to reference-images" on storage.objects for insert with check (bucket_id = 'reference-images');
insert into public.orders (order_id, status, order_type, size, makeup_type, xianyu_id, contact1, total_price) values
 ('BJD202611-009','working','普单','四分','指定妆','测试甲','13800000001','¥180'),
 ('BJD202611-010','approved','钞能力单','三分','COS妆','测试乙','13800000002','¥460'),
 ('BJD202611-011','pending','普单','四分','全自由妆','测试丙','13800000003','¥160');
