-- afamakeup 开单抽奖 + 安全收紧 · 数据库迁移草案 v0.1（陆循，2026-11-26）
-- 先在测试项目执行；正式库执行前必须：线上结构快照 → 阿序复核 → 阿发同意。
-- 约定：所有函数 SET search_path = ''，对象名全限定；匿名只走 RPC，不直接碰表。

begin;

-- ========== 0. 管理员 ==========
create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;
-- 不建任何策略：anon/authenticated 都不能读写；只能在 SQL Editor 里由项目所有者加人。

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.admins a where a.user_id = auth.uid());
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- ========== 1. 批次 ==========
create table if not exists public.campaigns (
  id              text primary key,                 -- 例 '1128'
  open_at         timestamptz not null,
  window_seconds  int not null default 5 check (window_seconds between 1 and 600),
  quotas          jsonb not null,                   -- {"普":{"speed":3,"pick":1,"lottery":2},"钞":{...}}
  lottery_source  text,                             -- 例 '2026-11-28 排列5'
  lottery_number  text,                             -- 开奖号，阿发填
  created_at      timestamptz not null default now()
);
alter table public.campaigns enable row level security;

-- ========== 2. 投递 ==========
create table if not exists public.entries (
  id            uuid primary key default gen_random_uuid(),
  seq           bigint generated always as identity unique,
  campaign_id   text references public.campaigns(id),   -- 三倍钞为 null
  pool          text not null check (pool in ('普','钞','三倍钞')),
  request_id    uuid not null unique,
  token_hash    bytea not null,
  payload_hash  bytea not null,
  payload       jsonb not null,
  price         int not null,
  xianyu_id     text not null,
  contact_last4 text,
  received_at   timestamptz not null,
  status        text not null check (status in ('received','reviewing','won','not_selected','rejected')),
  win_type      text check (win_type in ('speed','pick','lottery','direct')),
  lottery_pos   int,
  order_id      text unique,                             -- 正式 BJD 号，只有中签/通过才有
  images        text[] not null default '{}',
  upload_until  timestamptz,
  purged_at     timestamptz
);
create index if not exists entries_rank on public.entries (campaign_id, pool, received_at, seq);
alter table public.entries enable row level security;
create policy entries_admin on public.entries for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- 摇号池快照：生成即锁死
create table if not exists public.lottery_pools (
  campaign_id text not null references public.campaigns(id),
  pool        text not null check (pool in ('普','钞')),
  locked_at   timestamptz not null default clock_timestamp(),
  members     uuid[] not null,          -- 按 1..M 顺序的 entry id
  drawn_at    timestamptz,
  draw_detail jsonb,
  primary key (campaign_id, pool)
);
alter table public.lottery_pools enable row level security;
create policy lottery_admin on public.lottery_pools for select to authenticated using (public.is_admin());

-- 上传凭证
create table if not exists public.upload_tickets (
  id         uuid primary key default gen_random_uuid(),
  entry_id   uuid not null references public.entries(id) on delete cascade,
  prefix     text not null unique,      -- entries/{entry_id}/{ticket_id}/
  expires_at timestamptz not null
);
alter table public.upload_tickets enable row level security;

-- ========== 3. 工具函数 ==========
create or replace function public._hash(p text)
returns bytea language sql immutable set search_path = '' as $$
  select extensions.digest(convert_to(p, 'UTF8'), 'sha256');
$$;
revoke all on function public._hash(text) from public, anon, authenticated;

-- 价格：只认选项，服务端算
create or replace function public.compute_price(p_pool text, p jsonb)
returns int language plpgsql immutable set search_path = '' as $$
declare
  base int; addon int := 0; a text; qty int;
begin
  base := case p->>'size'
    when '3fen' then case p->>'makeup' when 'free' then 190 when 'specified' then 210 when 'cos' then 230 end
    when '4fen' then case p->>'makeup' when 'free' then 160 when 'specified' then 180 when 'cos' then 200 end
  end;
  if base is null then raise exception 'invalid_payload'; end if;
  base := base * case p_pool when '普' then 1 when '钞' then 2 when '三倍钞' then 3 end;
  for a in select jsonb_array_elements_text(coalesce(p->'addons','[]')) loop
    addon := addon + case a
      when '卸妆' then 30 when '睫毛' then 5 when 'Pan粉去黄' then 30 when '面罩' then 5
      when '疤痕' then 25 when '重肌理' then 30 when '面纹' then 0 when '加急' then 100
      when '口配' then 15 * greatest(1, least(coalesce((p->>'koupei_qty')::int,1), 10))
      else null end;
    if addon is null then raise exception 'invalid_payload'; end if;
  end loop;
  return base + addon;
end $$;
revoke all on function public.compute_price(text, jsonb) from public, anon;

-- 正式编号：BJD{YYYYMM}-{NNN}，与旧 orders 共用一条线
create or replace function public._next_order_id()
returns text language plpgsql security definer set search_path = '' as $$
declare prefix text; n int;
begin
  perform pg_advisory_xact_lock(hashtext('afamakeup_order_id'));
  prefix := 'BJD' || to_char(now() at time zone 'Asia/Shanghai', 'YYYYMM') || '-';
  select coalesce(max(substring(x from length(prefix)+1)::int), 0) + 1 into n from (
    select order_id x from public.orders  where order_id like prefix || '%'
    union all
    select order_id   from public.entries where order_id like prefix || '%'
  ) t where x ~ ('^' || prefix || '[0-9]+$');
  return prefix || lpad(n::text, 3, '0');
end $$;
revoke all on function public._next_order_id() from public, anon, authenticated;

-- ========== 4. 匿名 RPC ==========
create or replace function public.campaign_status()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'server_time', clock_timestamp(),
    'campaign', (select jsonb_build_object('id', c.id, 'open_at', c.open_at,
                   'close_at', c.open_at + make_interval(secs => c.window_seconds),
                   'quotas', c.quotas)
                 from public.campaigns c order by c.open_at desc limit 1),
    'triple_open', coalesce((select s.premium_3x_open from public.settings s where s.id = 1), false)
  );
$$;

create or replace function public.submit_entry(p_request_id uuid, p_token text, p_pool text, p_payload jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  t_recv timestamptz := clock_timestamp();   -- 收到时间：函数一进来就取，在任何锁之前
  v_th bytea; v_ph bytea; v_c public.campaigns; v_e public.entries; v_price int;
begin
  if p_token is null or length(p_token) < 40 then raise exception 'invalid_token'; end if;
  if p_pool not in ('普','钞','三倍钞') then raise exception 'invalid_pool'; end if;
  v_th := public._hash(p_token);
  v_ph := public._hash(p_pool || '|' || coalesce(p_payload->>'campaign_id','') || '|' || p_payload::text);

  -- 幂等：同一请求重试，凭据和内容都对得上才返回原回执；放在时间窗检查之前
  select * into v_e from public.entries where request_id = p_request_id;
  if found then
    if v_e.token_hash = v_th and v_e.payload_hash = v_ph then
      return jsonb_build_object('ok', true, 'entry_id', v_e.id, 'status', v_e.status,
        'received_at', v_e.received_at, 'price', v_e.price, 'replay', true);
    end if;
    raise exception 'conflict';
  end if;

  if coalesce(trim(p_payload->>'xianyu_id'),'') = '' or length(p_payload->>'xianyu_id') > 64 then
    raise exception 'invalid_payload';
  end if;
  v_price := public.compute_price(p_pool, p_payload);

  if p_pool = '三倍钞' then
    if not coalesce((select s.premium_3x_open from public.settings s where s.id = 1), false) then
      raise exception 'closed';
    end if;
  else
    select * into v_c from public.campaigns where id = p_payload->>'campaign_id';
    if not found then raise exception 'invalid_payload'; end if;
    if t_recv < v_c.open_at then raise exception 'not_open'; end if;
    if t_recv >= v_c.open_at + make_interval(secs => v_c.window_seconds) then raise exception 'closed'; end if;
  end if;

  insert into public.entries (campaign_id, pool, request_id, token_hash, payload_hash, payload, price,
    xianyu_id, contact_last4, received_at, status, upload_until)
  values (case when p_pool = '三倍钞' then null else v_c.id end, p_pool, p_request_id, v_th, v_ph,
    p_payload, v_price, trim(p_payload->>'xianyu_id'), right(regexp_replace(coalesce(p_payload->>'contact1',''), '\D', '', 'g'), 4),
    t_recv, case when p_pool = '三倍钞' then 'reviewing' else 'received' end, t_recv + interval '30 minutes')
  returning * into v_e;

  return jsonb_build_object('ok', true, 'entry_id', v_e.id, 'status', v_e.status,
    'received_at', v_e.received_at, 'price', v_e.price, 'replay', false);
exception when unique_violation then
  raise exception 'conflict';
end $$;

create or replace function public.request_upload(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_e public.entries; v_t public.upload_tickets;
begin
  select * into v_e from public.entries where token_hash = public._hash(p_token);
  if not found then raise exception 'invalid_token'; end if;
  if clock_timestamp() > v_e.upload_until then raise exception 'closed'; end if;
  insert into public.upload_tickets (entry_id, prefix, expires_at)
  values (v_e.id, 'entries/' || v_e.id || '/' || gen_random_uuid() || '/', least(v_e.upload_until, clock_timestamp() + interval '10 minutes'))
  returning * into v_t;
  return jsonb_build_object('bucket', 'reference-images', 'prefix', v_t.prefix, 'expires_at', v_t.expires_at,
    'max_files', 6, 'max_bytes', 5242880, 'mime', jsonb_build_array('image/jpeg','image/png','image/webp'));
end $$;

-- storage 写入策略调用：路径必须落在未过期的凭证前缀下
create or replace function public.can_upload(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.upload_tickets t
                 where p_name like t.prefix || '%' and position('/' in substring(p_name from length(t.prefix)+1)) = 0
                   and clock_timestamp() < t.expires_at);
$$;

create or replace function public.attach_images(p_token text, p_paths text[])
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_e public.entries; p text;
begin
  select * into v_e from public.entries where token_hash = public._hash(p_token);
  if not found then raise exception 'invalid_token'; end if;
  if clock_timestamp() > v_e.upload_until then raise exception 'closed'; end if;
  if coalesce(array_length(p_paths,1),0) > 6 then raise exception 'invalid_payload'; end if;
  foreach p in array coalesce(p_paths, '{}') loop
    if p not like 'entries/' || v_e.id || '/%' then raise exception 'invalid_payload'; end if;
    if not exists (select 1 from storage.objects o where o.bucket_id = 'reference-images' and o.name = p) then
      raise exception 'invalid_payload';
    end if;
  end loop;
  update public.entries set images = p_paths where id = v_e.id;
  return jsonb_build_object('ok', true, 'images', coalesce(array_length(p_paths,1),0));
end $$;

create or replace function public.lookup_entry(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_e public.entries; o record;
begin
  select * into v_e from public.entries where token_hash = public._hash(p_token);
  if not found then raise exception 'invalid_token'; end if;
  select status, last_update into o from public.orders where order_id = v_e.order_id;
  return jsonb_build_object('entry_id', v_e.id, 'pool', v_e.pool, 'campaign_id', v_e.campaign_id,
    'status', v_e.status, 'win_type', v_e.win_type, 'order_id', v_e.order_id,
    'order_status', o.status, 'received_at', v_e.received_at, 'price', v_e.price,
    'payload', case when v_e.purged_at is null then v_e.payload - 'contact1' - 'contact2' - 'receiver_name' else null end);
end $$;

revoke all on function public.campaign_status(), public.submit_entry(uuid,text,text,jsonb),
  public.request_upload(text), public.attach_images(text,text[]), public.lookup_entry(text),
  public.can_upload(text) from public;
grant execute on function public.campaign_status(), public.submit_entry(uuid,text,text,jsonb),
  public.request_upload(text), public.attach_images(text,text[]), public.lookup_entry(text),
  public.can_upload(text) to anon, authenticated;

-- ========== 5. 管理员 RPC（开奖） ==========
create or replace function public._assert_admin() returns void language plpgsql stable security definer set search_path = '' as $$
begin if not public.is_admin() then raise exception 'forbidden'; end if; end $$;

-- 中签 → 写入正式 orders，沿用原后台流程
create or replace function public._win(p_entry uuid, p_type text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_e public.entries; v_id text; p jsonb;
begin
  select * into v_e from public.entries where id = p_entry for update;
  if v_e.order_id is not null then return v_e.order_id; end if;          -- 重复点击不重复发号
  if v_e.status not in ('received','reviewing') then raise exception 'invalid_state'; end if;
  v_id := public._next_order_id(); p := v_e.payload;
  insert into public.orders (order_id, status, order_type, size, makeup_type, doll_info, attribute, gender,
    color_scheme, taboos, requirements, addons, free_items, glitter, accessories, xianyu_id,
    receiver_name, contact1, contact2, shipping, total_price, reference_images, submit_time, last_update)
  values (v_id, 'approved',
    case v_e.pool when '普' then '普单' when '钞' then '钞能力单' else '三倍超' end,
    p->>'size_label', p->>'makeup_label', p->>'doll_info', p->>'attribute', p->>'gender', p->>'color_scheme',
    array(select jsonb_array_elements_text(coalesce(p->'taboos','[]'))),
    array(select jsonb_array_elements_text(coalesce(p->'requirements','[]'))),
    array(select jsonb_array_elements_text(coalesce(p->'addons','[]'))),
    array(select jsonb_array_elements_text(coalesce(p->'free_items','[]'))),
    p->>'glitter', p->>'accessories', v_e.xianyu_id, p->>'receiver_name', p->>'contact1', p->>'contact2',
    p->>'shipping', '¥' || v_e.price, v_e.images, v_e.received_at, now());
  update public.entries set status = 'won', win_type = p_type, order_id = v_id where id = v_e.id;
  return v_id;
end $$;
revoke all on function public._win(uuid,text) from public, anon, authenticated;

create or replace function public.admin_pool(p_campaign text, p_pool text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform public._assert_admin();
  return coalesce((select jsonb_agg(jsonb_build_object('entry_id', e.id, 'rank', r, 'xianyu_id', e.xianyu_id,
      'received_at', e.received_at, 'status', e.status, 'win_type', e.win_type, 'order_id', e.order_id,
      'lottery_pos', e.lottery_pos, 'price', e.price) order by r)
    from (select e.*, row_number() over (order by received_at, seq) r from public.entries e
          where e.campaign_id = p_campaign and e.pool = p_pool) e), '[]');
end $$;

create or replace function public.confirm_win(p_campaign text, p_pool text, p_entries uuid[], p_type text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare r jsonb := '[]'; x uuid;
begin
  perform public._assert_admin();
  if p_type not in ('speed','pick') then raise exception 'invalid_payload'; end if;
  if exists (select 1 from public.lottery_pools l where l.campaign_id = p_campaign and l.pool = p_pool) then
    raise exception 'pool_locked';
  end if;
  foreach x in array p_entries loop
    if not exists (select 1 from public.entries e where e.id = x and e.campaign_id = p_campaign and e.pool = p_pool) then
      raise exception 'invalid_payload';
    end if;
    r := r || jsonb_build_object('entry_id', x, 'order_id', public._win(x, p_type));
  end loop;
  return r;
end $$;

create or replace function public.lock_pool(p_campaign text, p_pool text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare m uuid[];
begin
  perform public._assert_admin();
  perform pg_advisory_xact_lock(hashtext('lock_pool|' || p_campaign || '|' || p_pool));
  if exists (select 1 from public.lottery_pools l where l.campaign_id = p_campaign and l.pool = p_pool) then
    raise exception 'pool_locked';
  end if;
  select array_agg(e.id order by e.received_at, e.seq) into m from public.entries e
   where e.campaign_id = p_campaign and e.pool = p_pool and e.status = 'received';
  insert into public.lottery_pools (campaign_id, pool, members) values (p_campaign, p_pool, coalesce(m, '{}'));
  update public.entries e set lottery_pos = s.pos
    from unnest(coalesce(m,'{}')) with ordinality s(id, pos) where e.id = s.id;
  return (select jsonb_build_object('locked_at', l.locked_at, 'm', cardinality(l.members),
            'list', (select jsonb_agg(jsonb_build_object('pos', e.lottery_pos, 'xianyu_id', e.xianyu_id) order by e.lottery_pos)
                     from public.entries e where e.id = any(l.members)))
          from public.lottery_pools l where l.campaign_id = p_campaign and l.pool = p_pool);
end $$;

create or replace function public.draw(p_campaign text, p_pool text, p_number text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare l public.lottery_pools; m int; n int; k int; s int; x bigint; i int; pos int; wins jsonb := '[]';
begin
  perform public._assert_admin();
  select * into l from public.lottery_pools where campaign_id = p_campaign and pool = p_pool for update;
  if not found then raise exception 'pool_not_locked'; end if;
  if l.drawn_at is not null then return l.draw_detail; end if;
  if p_number !~ '^[0-9]{1,12}$' then raise exception 'invalid_payload'; end if;
  m := cardinality(l.members);
  n := least(m, ((select c.quotas from public.campaigns c where c.id = p_campaign)->p_pool->>'lottery')::int);
  if m = 0 or n = 0 then
    update public.lottery_pools set drawn_at = clock_timestamp(), draw_detail = jsonb_build_object('m', m, 'n', 0, 'winners', '[]'::jsonb)
     where campaign_id = p_campaign and pool = p_pool;
    return jsonb_build_object('m', m, 'n', 0, 'winners', '[]'::jsonb);
  end if;
  x := p_number::bigint; k := m / n; s := (x % m) + 1;
  for i in 0 .. n-1 loop
    pos := ((s - 1 + i * k) % m) + 1;
    wins := wins || jsonb_build_object('pos', pos, 'entry_id', l.members[pos],
      'xianyu_id', (select e.xianyu_id from public.entries e where e.id = l.members[pos]),
      'order_id', public._win(l.members[pos], 'lottery'));
  end loop;
  update public.lottery_pools set drawn_at = clock_timestamp(),
    draw_detail = jsonb_build_object('number', p_number, 'm', m, 'n', n, 'k', k, 's', s, 'winners', wins)
   where campaign_id = p_campaign and pool = p_pool;
  update public.campaigns set lottery_number = p_number where id = p_campaign;
  update public.entries e set status = 'not_selected'
   where e.campaign_id = p_campaign and e.pool = p_pool and e.status = 'received';
  return (select draw_detail from public.lottery_pools where campaign_id = p_campaign and pool = p_pool);
end $$;

-- 未中签资料脱敏：只留闲鱼 ID + 手机后四位
create or replace function public.purge_not_selected(p_campaign text)
returns int language plpgsql volatile security definer set search_path = '' as $$
declare n int;
begin
  perform public._assert_admin();
  update public.entries set payload = '{}'::jsonb, purged_at = now()
   where campaign_id = p_campaign and status = 'not_selected' and purged_at is null;
  get diagnostics n = row_count; return n;
end $$;

revoke all on function public._assert_admin(), public.admin_pool(text,text), public.confirm_win(text,text,uuid[],text),
  public.lock_pool(text,text), public.draw(text,text,text), public.purge_not_selected(text) from public, anon;
grant execute on function public.admin_pool(text,text), public.confirm_win(text,text,uuid[],text),
  public.lock_pool(text,text), public.draw(text,text,text), public.purge_not_selected(text) to authenticated;

-- ========== 6. 旧表收紧 ==========
-- 先在测试库确认旧策略名再删；正式库按取证结果改写
drop policy if exists "Allow all access to orders" on public.orders;
drop policy if exists "Allow all access to settings" on public.settings;
create policy orders_admin on public.orders for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy settings_admin on public.settings for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
-- settings 公开字段改由 campaign_status() 提供，匿名不再直读

-- storage：参考图桶私有，匿名只能按凭证前缀新建，不能列、读、改、删
update storage.buckets set public = false where id = 'reference-images';
create policy ref_anon_insert on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'reference-images' and public.can_upload(name));
create policy ref_admin_read on storage.objects for select to authenticated
  using (bucket_id = 'reference-images' and public.is_admin());

commit;
