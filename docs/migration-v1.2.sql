-- afamakeup 迁移 v1（冻结）：由 v0.1→v0.6b 依次拼接，测试库从零重建后按此执行

-- ===== db-contract.sql =====
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

-- ===== db-contract-v0.2-patch.sql =====
-- v0.2 补丁：针对阿序 db-review-codex-v0.1 的 R01–R06，在 v0.1 之上执行（测试库已有 v0.1）
-- 正式迁移时会把 v0.1+v0.2 合成一份，并按线上快照写旧策略清理与断言
begin;

-- ---------- R06 凭据唯一 ----------
alter table public.entries add constraint entries_token_hash_key unique (token_hash);

-- ---------- R02 配额结构严格校验 ----------
create or replace function public._quota(q jsonb, p_pool text, p_type text)
returns int language plpgsql immutable set search_path = '' as $$
declare v jsonb := q->p_pool->p_type;
begin
  if v is null or jsonb_typeof(v) <> 'number' or (v::text)::numeric <> floor((v::text)::numeric) or (v::text)::int < 0 or (v::text)::int > 100 then
    raise exception 'invalid_quota';
  end if;
  return (v::text)::int;
end $$;
revoke all on function public._quota(jsonb,text,text) from public, anon, authenticated;

create or replace function public._check_campaign() returns trigger language plpgsql set search_path = '' as $$
declare p text; t text;
begin
  foreach p in array array['普','钞'] loop
    foreach t in array array['speed','pick','lottery'] loop perform public._quota(new.quotas, p, t); end loop;
  end loop;
  return new;
end $$;
drop trigger if exists campaigns_check on public.campaigns;
create trigger campaigns_check before insert or update of quotas on public.campaigns
  for each row execute function public._check_campaign();

-- ---------- R01 后台只能读 entries，写只走 RPC ----------
drop policy if exists entries_admin on public.entries;
create policy entries_admin_read on public.entries for select to authenticated using (public.is_admin());
revoke all on public.entries, public.lottery_pools, public.upload_tickets, public.campaigns, public.admins from anon;
revoke insert, update, delete on public.entries, public.lottery_pools, public.upload_tickets, public.admins from authenticated;

create or replace function public._pool_lock(p_campaign text, p_pool text) returns void
language sql volatile set search_path = '' as $$
  select pg_advisory_xact_lock(hashtext('afamakeup_pool|' || p_campaign || '|' || p_pool));
$$;
revoke all on function public._pool_lock(text,text) from public, anon, authenticated;

-- ---------- R06 payload 白名单、长度、可信标签 ----------
create or replace function public._clean_payload(p_pool text, p jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare r jsonb := '{}'; k text; s text;
  str_keys text[] := array['campaign_id','size','makeup','xianyu_id','doll_info','attribute','gender','color_scheme',
                           'glitter','accessories','receiver_name','contact1','contact2','shipping'];
  arr_keys text[] := array['taboos','requirements','addons','free_items'];
begin
  if jsonb_typeof(p) <> 'object' or length(p::text) > 8000 then raise exception 'invalid_payload'; end if;
  foreach k in array str_keys loop
    if p ? k then
      if jsonb_typeof(p->k) not in ('string','null') then raise exception 'invalid_payload'; end if;
      s := left(trim(coalesce(p->>k,'')), case when k in ('doll_info','accessories','shipping') then 500 else 120 end);
      r := r || jsonb_build_object(k, s);
    end if;
  end loop;
  foreach k in array arr_keys loop
    if p ? k then
      if jsonb_typeof(p->k) <> 'array' or jsonb_array_length(p->k) > (case when k in ('taboos','requirements') then 3 else 12 end) then
        raise exception 'invalid_payload';
      end if;
      r := r || jsonb_build_object(k, (select coalesce(jsonb_agg(distinct left(trim(x),120)), '[]') from jsonb_array_elements_text(p->k) x where trim(x) <> ''));
    end if;
  end loop;
  if p ? 'koupei_qty' then r := r || jsonb_build_object('koupei_qty', greatest(1, least(coalesce((p->>'koupei_qty')::int,1),10))); end if;
  if coalesce(r->>'xianyu_id','') = '' or coalesce(r->>'contact1','') = '' or coalesce(r->>'receiver_name','') = '' then
    raise exception 'invalid_payload';
  end if;
  -- 标签由服务端生成，不认客户端
  r := r || jsonb_build_object(
    'size_label', case r->>'size' when '3fen' then '三分' when '4fen' then '四分' end,
    'makeup_label', case r->>'makeup' when 'free' then '全自由妆' when 'specified' then '指定妆' when 'cos' then 'COS妆' end);
  if r->>'size_label' is null or r->>'makeup_label' is null then raise exception 'invalid_payload'; end if;
  return r;
exception when invalid_text_representation then raise exception 'invalid_payload';
end $$;
revoke all on function public._clean_payload(text,jsonb) from public, anon, authenticated;

create or replace function public.submit_entry(p_request_id uuid, p_token text, p_pool text, p_payload jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  t_recv timestamptz := clock_timestamp();
  v_th bytea; v_ph bytea; v_c public.campaigns; v_e public.entries; v_price int; v_p jsonb;
begin
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{43}$' then raise exception 'invalid_token'; end if;
  if p_pool not in ('普','钞','三倍钞') then raise exception 'invalid_pool'; end if;
  v_p := public._clean_payload(p_pool, p_payload);
  if p_pool = '三倍钞' then v_p := v_p - 'campaign_id'; end if;
  v_th := public._hash(p_token);
  v_ph := public._hash(p_pool || '|' || v_p::text);

  select * into v_e from public.entries where request_id = p_request_id;
  if found then
    if v_e.token_hash = v_th and v_e.payload_hash = v_ph then
      return jsonb_build_object('ok', true, 'entry_id', v_e.id, 'status', v_e.status, 'received_at', v_e.received_at, 'price', v_e.price, 'replay', true);
    end if;
    raise exception 'conflict';
  end if;

  v_price := public.compute_price(p_pool, v_p);
  if p_pool = '三倍钞' then
    if not coalesce((select s.premium_3x_open from public.settings s where s.id = 1), false) then raise exception 'closed'; end if;
  else
    select * into v_c from public.campaigns where id = v_p->>'campaign_id';
    if not found then raise exception 'invalid_payload'; end if;
    if t_recv < v_c.open_at then raise exception 'not_open'; end if;
    if t_recv >= v_c.open_at + make_interval(secs => v_c.window_seconds) then raise exception 'closed'; end if;
    -- 共享锁：锁池要等所有在途收件提交完
    perform pg_advisory_xact_lock_shared(hashtext('afamakeup_submit|' || v_c.id));
  end if;

  begin
    insert into public.entries (campaign_id, pool, request_id, token_hash, payload_hash, payload, price,
      xianyu_id, contact_last4, received_at, status, upload_until)
    values (v_c.id, p_pool, p_request_id, v_th, v_ph, v_p, v_price, v_p->>'xianyu_id',
      right(regexp_replace(v_p->>'contact1', '\D', '', 'g'), 4), t_recv,
      case when p_pool = '三倍钞' then 'reviewing' else 'received' end, t_recv + interval '30 minutes')
    returning * into v_e;
  exception when unique_violation then
    -- 同一请求并发重试：再查一次，内容一致就当重放
    select * into v_e from public.entries where request_id = p_request_id;
    if found and v_e.token_hash = v_th and v_e.payload_hash = v_ph then
      return jsonb_build_object('ok', true, 'entry_id', v_e.id, 'status', v_e.status, 'received_at', v_e.received_at, 'price', v_e.price, 'replay', true);
    end if;
    raise exception 'conflict';
  end;
  return jsonb_build_object('ok', true, 'entry_id', v_e.id, 'status', v_e.status, 'received_at', v_e.received_at, 'price', v_e.price, 'replay', false);
end $$;

-- ---------- R03 上传：桶强制限制，服务端核数量，清理后禁止 ----------
update storage.buckets set public = false, file_size_limit = 5242880,
  allowed_mime_types = array['image/jpeg','image/png','image/webp'] where id = 'reference-images';

create or replace function public.request_upload(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_e public.entries; v_t public.upload_tickets; n int;
begin
  select * into v_e from public.entries where token_hash = public._hash(p_token) for update;
  if not found then raise exception 'invalid_token'; end if;
  if v_e.purged_at is not null or v_e.status not in ('received','reviewing') or clock_timestamp() > v_e.upload_until then
    raise exception 'closed';
  end if;
  if cardinality(v_e.images) > 0 then raise exception 'conflict'; end if;        -- 已绑定就不再发票
  select count(*) into n from public.upload_tickets where entry_id = v_e.id;
  if n >= 3 then raise exception 'too_many'; end if;
  insert into public.upload_tickets (entry_id, prefix, expires_at)
  values (v_e.id, 'entries/' || v_e.id || '/' || gen_random_uuid() || '/', least(v_e.upload_until, clock_timestamp() + interval '10 minutes'))
  returning * into v_t;
  return jsonb_build_object('bucket','reference-images','prefix',v_t.prefix,'expires_at',v_t.expires_at,
    'max_files',6,'max_bytes',5242880,'mime',jsonb_build_array('image/jpeg','image/png','image/webp'));
end $$;

create or replace function public.can_upload(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.upload_tickets t join public.entries e on e.id = t.entry_id
     where p_name like t.prefix || '%'
       and position('/' in substring(p_name from length(t.prefix)+1)) = 0
       and length(p_name) <= 200
       and clock_timestamp() < t.expires_at
       and e.purged_at is null and cardinality(e.images) = 0
       and (select count(*) from storage.objects o
             where o.bucket_id = 'reference-images' and o.name like 'entries/' || e.id || '/%') < 6);
$$;

create or replace function public.attach_images(p_token text, p_paths text[])
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_e public.entries; p text; v_paths text[];
begin
  select * into v_e from public.entries where token_hash = public._hash(p_token) for update;
  if not found then raise exception 'invalid_token'; end if;
  select coalesce(array_agg(distinct x order by x), '{}') into v_paths from unnest(coalesce(p_paths,'{}')) x;
  if cardinality(v_e.images) > 0 then
    if v_e.images = v_paths then return jsonb_build_object('ok', true, 'images', cardinality(v_paths), 'replay', true); end if;
    raise exception 'conflict';
  end if;
  if v_e.purged_at is not null or clock_timestamp() > v_e.upload_until then raise exception 'closed'; end if;
  if cardinality(v_paths) > 6 then raise exception 'invalid_payload'; end if;
  foreach p in array v_paths loop
    if not exists (select 1 from public.upload_tickets t where t.entry_id = v_e.id and p like t.prefix || '%')
       or not exists (select 1 from storage.objects o where o.bucket_id = 'reference-images' and o.name = p) then
      raise exception 'invalid_payload';
    end if;
  end loop;
  update public.entries set images = v_paths where id = v_e.id;
  delete from public.upload_tickets where entry_id = v_e.id;
  return jsonb_build_object('ok', true, 'images', cardinality(v_paths), 'replay', false);
end $$;

-- ---------- R01 中签：配额、前 N、互斥 ----------
create or replace function public.confirm_win(p_campaign text, p_pool text, p_entries uuid[], p_type text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare r jsonb := '[]'; x uuid; q int; used int; v_c public.campaigns;
begin
  perform public._assert_admin();
  if p_type not in ('speed','pick') or p_pool not in ('普','钞') then raise exception 'invalid_payload'; end if;
  perform public._pool_lock(p_campaign, p_pool);
  select * into v_c from public.campaigns where id = p_campaign;
  if not found then raise exception 'invalid_payload'; end if;
  if clock_timestamp() < v_c.open_at + make_interval(secs => v_c.window_seconds) then raise exception 'not_closed'; end if;
  if exists (select 1 from public.lottery_pools l where l.campaign_id = p_campaign and l.pool = p_pool) then raise exception 'pool_locked'; end if;
  if cardinality(p_entries) <> (select count(distinct u) from unnest(p_entries) u) then raise exception 'invalid_payload'; end if;
  q := public._quota(v_c.quotas, p_pool, p_type);
  select count(*) into used from public.entries where campaign_id = p_campaign and pool = p_pool and win_type = p_type;
  foreach x in array p_entries loop
    if exists (select 1 from public.entries where id = x and win_type = p_type) then
      r := r || jsonb_build_object('entry_id', x, 'order_id', (select order_id from public.entries where id = x));  -- 重复点击
      continue;
    end if;
    if used >= q then raise exception 'quota_exceeded'; end if;
    if not exists (select 1 from public.entries e where e.id = x and e.campaign_id = p_campaign and e.pool = p_pool and e.status = 'received') then
      raise exception 'invalid_payload';
    end if;
    if p_type = 'speed' and x not in (
         select e.id from public.entries e where e.campaign_id = p_campaign and e.pool = p_pool
          order by e.received_at, e.seq limit public._quota(v_c.quotas, p_pool, 'speed')) then
      raise exception 'not_top_n';
    end if;
    r := r || jsonb_build_object('entry_id', x, 'order_id', public._win(x, p_type));
    used := used + 1;
  end loop;
  return r;
end $$;

create or replace function public.lock_pool(p_campaign text, p_pool text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare m uuid[]; v_c public.campaigns; nspeed int; total int;
begin
  perform public._assert_admin();
  perform public._pool_lock(p_campaign, p_pool);
  select * into v_c from public.campaigns where id = p_campaign;
  if not found then raise exception 'invalid_payload'; end if;
  if clock_timestamp() < v_c.open_at + make_interval(secs => v_c.window_seconds) then raise exception 'not_closed'; end if;
  perform pg_advisory_xact_lock(hashtext('afamakeup_submit|' || p_campaign));   -- 等在途收件提交
  if exists (select 1 from public.lottery_pools l where l.campaign_id = p_campaign and l.pool = p_pool) then raise exception 'pool_locked'; end if;
  select count(*) filter (where win_type = 'speed'), count(*) into nspeed, total
    from public.entries where campaign_id = p_campaign and pool = p_pool;
  if nspeed < least(total, public._quota(v_c.quotas, p_pool, 'speed')) then raise exception 'speed_not_confirmed'; end if;
  select array_agg(e.id order by e.received_at, e.seq) into m from public.entries e
   where e.campaign_id = p_campaign and e.pool = p_pool and e.status = 'received';
  insert into public.lottery_pools (campaign_id, pool, members) values (p_campaign, p_pool, coalesce(m, '{}'));
  update public.entries e set lottery_pos = s.pos from unnest(coalesce(m,'{}')) with ordinality s(id, pos) where e.id = s.id;
  return (select jsonb_build_object('locked_at', l.locked_at, 'm', cardinality(l.members),
            'list', coalesce((select jsonb_agg(jsonb_build_object('pos', e.lottery_pos, 'xianyu_id', e.xianyu_id) order by e.lottery_pos)
                     from public.entries e where e.id = any(l.members)), '[]'))
          from public.lottery_pools l where l.campaign_id = p_campaign and l.pool = p_pool);
end $$;

-- 摇号：先预览（不写库），确认用同一号码
create or replace function public._draw_calc(p_members uuid[], p_n int, p_number text)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare m int := cardinality(p_members); n int; k int; s int; i int; pos int; w jsonb := '[]';
begin
  if p_number !~ '^[0-9]{5}$' then raise exception 'invalid_number'; end if;
  n := least(m, p_n);
  if m = 0 or n = 0 then return jsonb_build_object('number', p_number, 'm', m, 'n', 0, 'winners', '[]'::jsonb); end if;
  k := m / n; s := (p_number::bigint % m) + 1;
  for i in 0 .. n-1 loop
    pos := ((s - 1 + i * k) % m) + 1;
    w := w || jsonb_build_object('pos', pos, 'entry_id', p_members[pos]);
  end loop;
  return jsonb_build_object('number', p_number, 'm', m, 'n', n, 'k', k, 's', s, 'winners', w);
end $$;
revoke all on function public._draw_calc(uuid[],int,text) from public, anon, authenticated;

create or replace function public.draw_preview(p_campaign text, p_pool text, p_number text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare l public.lottery_pools; d jsonb;
begin
  perform public._assert_admin();
  select * into l from public.lottery_pools where campaign_id = p_campaign and pool = p_pool;
  if not found then raise exception 'pool_not_locked'; end if;
  d := public._draw_calc(l.members, public._quota((select quotas from public.campaigns where id = p_campaign), p_pool, 'lottery'), p_number);
  return d || jsonb_build_object('winners', (select coalesce(jsonb_agg(w || jsonb_build_object('xianyu_id', e.xianyu_id)), '[]')
           from jsonb_array_elements(d->'winners') w join public.entries e on e.id = (w->>'entry_id')::uuid));
end $$;

create or replace function public.draw(p_campaign text, p_pool text, p_number text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare l public.lottery_pools; d jsonb; w jsonb; out jsonb := '[]';
begin
  perform public._assert_admin();
  perform public._pool_lock(p_campaign, p_pool);
  select * into l from public.lottery_pools where campaign_id = p_campaign and pool = p_pool for update;
  if not found then raise exception 'pool_not_locked'; end if;
  if l.drawn_at is not null then
    if l.draw_detail->>'number' = p_number then return l.draw_detail; end if;
    raise exception 'already_drawn';
  end if;
  d := public._draw_calc(l.members, public._quota((select quotas from public.campaigns where id = p_campaign), p_pool, 'lottery'), p_number);
  for w in select * from jsonb_array_elements(d->'winners') loop
    out := out || (w || jsonb_build_object(
      'xianyu_id', (select e.xianyu_id from public.entries e where e.id = (w->>'entry_id')::uuid),
      'order_id', public._win((w->>'entry_id')::uuid, 'lottery')));
  end loop;
  d := d || jsonb_build_object('winners', out);
  update public.lottery_pools set drawn_at = clock_timestamp(), draw_detail = d where campaign_id = p_campaign and pool = p_pool;
  update public.entries e set status = 'not_selected'                    -- 零名额也收尾
   where e.campaign_id = p_campaign and e.pool = p_pool and e.status = 'received';
  return d;
end $$;

-- ---------- R05 三倍钞审核 / 拒绝 ----------
create or replace function public.approve_triple(p_entry uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  perform public._assert_admin();
  if not exists (select 1 from public.entries where id = p_entry and pool = '三倍钞') then raise exception 'invalid_payload'; end if;
  return jsonb_build_object('entry_id', p_entry, 'order_id', public._win(p_entry, 'direct'));
end $$;

create or replace function public.reject_entry(p_entry uuid, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  perform public._assert_admin();
  update public.entries set status = 'rejected', upload_until = now()
   where id = p_entry and pool = '三倍钞' and status = 'reviewing';
  if not found then raise exception 'invalid_state'; end if;
  return jsonb_build_object('ok', true);
end $$;

-- ---------- R03 清理：撤销上传、清图片清单，返回待删对象由后台走 Storage API 删 ----------
drop function if exists public.purge_not_selected(text);
create or replace function public.purge_not_selected(p_campaign text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare paths text[];
begin
  perform public._assert_admin();
  select coalesce(array_agg(o.name), '{}') into paths from storage.objects o
    join public.entries e on o.name like 'entries/' || e.id || '/%'
   where o.bucket_id = 'reference-images' and e.campaign_id = p_campaign and e.status = 'not_selected';
  delete from public.upload_tickets t using public.entries e
   where t.entry_id = e.id and e.campaign_id = p_campaign and e.status = 'not_selected';
  update public.entries set payload = '{}'::jsonb, images = '{}', upload_until = now(), purged_at = coalesce(purged_at, now())
   where campaign_id = p_campaign and status = 'not_selected';
  return jsonb_build_object('purged', (select count(*) from public.entries where campaign_id = p_campaign and status = 'not_selected'),
                            'delete_paths', to_jsonb(paths));
end $$;

drop policy if exists ref_admin_delete on storage.objects;
create policy ref_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'reference-images' and public.is_admin());

-- ---------- R04 旧放行策略：按线上取证的确切名字删 ----------
drop policy if exists "Allow public read reference-images" on storage.objects;
drop policy if exists "Allow public upload to reference-images" on storage.objects;
revoke all on public.orders, public.settings from anon;

revoke all on function public.approve_triple(uuid), public.reject_entry(uuid,text), public.draw_preview(text,text,text),
  public.purge_not_selected(text) from public, anon;
grant execute on function public.approve_triple(uuid), public.reject_entry(uuid,text), public.draw_preview(text,text,text),
  public.purge_not_selected(text) to authenticated;

commit;

-- 断言（只读）：不应有任何给 anon/public 的放行策略留在这几张表上
-- select schemaname, tablename, policyname, roles, cmd from pg_policies
--  where (schemaname='public' and tablename in ('orders','settings','entries','campaigns','lottery_pools','upload_tickets','admins'))
--     or (schemaname='storage' and tablename='objects');

-- ===== db-contract-v0.3-patch.sql =====
-- v0.3：后台需要的批次读写
begin;
drop policy if exists campaigns_admin_read on public.campaigns;
create policy campaigns_admin_read on public.campaigns for select to authenticated using (public.is_admin());
revoke insert, update, delete on public.campaigns from authenticated;

create or replace function public.upsert_campaign(p_id text, p_open_at timestamptz, p_window int, p_quotas jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  perform public._assert_admin();
  if p_id !~ '^[A-Za-z0-9_-]{1,20}$' then raise exception 'invalid_payload'; end if;
  if exists (select 1 from public.entries where campaign_id = p_id) then raise exception 'campaign_started'; end if;
  insert into public.campaigns (id, open_at, window_seconds, quotas) values (p_id, p_open_at, p_window, p_quotas)
  on conflict (id) do update set open_at = excluded.open_at, window_seconds = excluded.window_seconds, quotas = excluded.quotas;
  return (select to_jsonb(c) from public.campaigns c where c.id = p_id);
end $$;
revoke all on function public.upsert_campaign(text,timestamptz,int,jsonb) from public, anon;
grant execute on function public.upsert_campaign(text,timestamptz,int,jsonb) to authenticated;

create or replace function public.admin_triple()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform public._assert_admin();
  return coalesce((select jsonb_agg(jsonb_build_object('entry_id', e.id, 'xianyu_id', e.xianyu_id, 'received_at', e.received_at,
    'status', e.status, 'order_id', e.order_id, 'price', e.price, 'payload', e.payload) order by e.received_at)
    from public.entries e where e.pool = '三倍钞' and e.status in ('reviewing','won','rejected')), '[]');
end $$;
revoke all on function public.admin_triple() from public, anon;
grant execute on function public.admin_triple() to authenticated;
commit;

-- ===== db-contract-v0.4-patch.sql =====
-- v0.4：确认中签也要等在途收件提交完，否则手速前 N 名可能漏算一笔还没落库、但收到时间更早的投递
begin;
create or replace function public._wait_submits(p_campaign text) returns void
language sql volatile set search_path = '' as $$
  select pg_advisory_xact_lock(hashtext('afamakeup_submit|' || p_campaign));
$$;
revoke all on function public._wait_submits(text) from public, anon, authenticated;
create or replace function public.confirm_win(p_campaign text, p_pool text, p_entries uuid[], p_type text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare r jsonb := '[]'; x uuid; q int; used int; v_c public.campaigns;
begin
  perform public._assert_admin();
  if p_type not in ('speed','pick') or p_pool not in ('普','钞') then raise exception 'invalid_payload'; end if;
  perform public._pool_lock(p_campaign, p_pool);
  perform public._wait_submits(p_campaign);
  select * into v_c from public.campaigns where id = p_campaign;
  if not found then raise exception 'invalid_payload'; end if;
  if clock_timestamp() < v_c.open_at + make_interval(secs => v_c.window_seconds) then raise exception 'not_closed'; end if;
  if exists (select 1 from public.lottery_pools l where l.campaign_id = p_campaign and l.pool = p_pool) then raise exception 'pool_locked'; end if;
  if cardinality(p_entries) <> (select count(distinct u) from unnest(p_entries) u) then raise exception 'invalid_payload'; end if;
  q := public._quota(v_c.quotas, p_pool, p_type);
  select count(*) into used from public.entries where campaign_id = p_campaign and pool = p_pool and win_type = p_type;
  foreach x in array p_entries loop
    if exists (select 1 from public.entries where id = x and win_type = p_type) then
      r := r || jsonb_build_object('entry_id', x, 'order_id', (select order_id from public.entries where id = x));  -- 重复点击
      continue;
    end if;
    if used >= q then raise exception 'quota_exceeded'; end if;
    if not exists (select 1 from public.entries e where e.id = x and e.campaign_id = p_campaign and e.pool = p_pool and e.status = 'received') then
      raise exception 'invalid_payload';
    end if;
    if p_type = 'speed' and x not in (
         select e.id from public.entries e where e.campaign_id = p_campaign and e.pool = p_pool
          order by e.received_at, e.seq limit public._quota(v_c.quotas, p_pool, 'speed')) then
      raise exception 'not_top_n';
    end if;
    r := r || jsonb_build_object('entry_id', x, 'order_id', public._win(x, p_type));
    used := used + 1;
  end loop;
  return r;
end $$;
commit;

-- ===== db-contract-v0.5-patch.sql =====
-- v0.5：上传改成每单固定 6 个对象名（槽位），同名重复会被 Storage 拒绝，所以总数天然 ≤6，不靠计数（计数有并发竞态，实测 10 并发进了 7 张）
begin;
alter table public.entries add column if not exists upload_secret uuid;

create or replace function public.request_upload(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_e public.entries; v_t public.upload_tickets; n int; v_prefix text;
begin
  select * into v_e from public.entries where token_hash = public._hash(p_token) for update;
  if not found then raise exception 'invalid_token'; end if;
  if v_e.purged_at is not null or v_e.status not in ('received','reviewing') or clock_timestamp() > v_e.upload_until then
    raise exception 'closed';
  end if;
  if cardinality(v_e.images) > 0 then raise exception 'conflict'; end if;
  select count(*) into n from public.upload_tickets where entry_id = v_e.id;
  if n >= 3 then raise exception 'too_many'; end if;
  if v_e.upload_secret is null then
    update public.entries set upload_secret = gen_random_uuid() where id = v_e.id returning * into v_e;
  end if;
  v_prefix := 'entries/' || v_e.id || '/' || v_e.upload_secret || '/';
  insert into public.upload_tickets (entry_id, prefix, expires_at)
  values (v_e.id, v_prefix || gen_random_uuid(), least(v_e.upload_until, clock_timestamp() + interval '10 minutes'))  -- prefix 列唯一，存一个票号
  returning * into v_t;
  return jsonb_build_object('bucket','reference-images','expires_at',v_t.expires_at,'max_bytes',5242880,
    'mime',jsonb_build_array('image/jpeg','image/png','image/webp'),
    'slots',(select jsonb_agg(v_prefix || i order by i) from generate_series(1,6) i));
end $$;

create or replace function public.can_upload(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.entries e join public.upload_tickets t on t.entry_id = e.id
     where e.upload_secret is not null
       and p_name ~ ('^entries/' || e.id || '/' || e.upload_secret || '/[1-6]$')
       and clock_timestamp() < t.expires_at
       and e.purged_at is null and cardinality(e.images) = 0);
$$;

create or replace function public.attach_images(p_token text, p_paths text[])
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_e public.entries; p text; v_paths text[];
begin
  select * into v_e from public.entries where token_hash = public._hash(p_token) for update;
  if not found then raise exception 'invalid_token'; end if;
  select coalesce(array_agg(distinct x order by x), '{}') into v_paths from unnest(coalesce(p_paths,'{}')) x;
  if cardinality(v_e.images) > 0 then
    if v_e.images = v_paths then return jsonb_build_object('ok', true, 'images', cardinality(v_paths), 'replay', true); end if;
    raise exception 'conflict';
  end if;
  if v_e.purged_at is not null or clock_timestamp() > v_e.upload_until or v_e.upload_secret is null then raise exception 'closed'; end if;
  if cardinality(v_paths) > 6 then raise exception 'invalid_payload'; end if;
  foreach p in array v_paths loop
    if p !~ ('^entries/' || v_e.id || '/' || v_e.upload_secret || '/[1-6]$')
       or not exists (select 1 from storage.objects o where o.bucket_id = 'reference-images' and o.name = p) then
      raise exception 'invalid_payload';
    end if;
  end loop;
  update public.entries set images = v_paths where id = v_e.id;
  delete from public.upload_tickets where entry_id = v_e.id;
  return jsonb_build_object('ok', true, 'images', cardinality(v_paths), 'replay', false);
end $$;
commit;

-- ===== db-contract-v0.6-patch.sql =====
-- v0.6：收件屏障收口、批次修改串行、图片生命周期（阿序 db-review v0.2 追加项）
begin;
alter table public.campaigns add column if not exists sealed_at timestamptz;

-- 第一次确认中签/锁池时“封批”：拿独占收件锁，等在途收件全部落库，然后写 sealed_at。
-- 之后才拿到共享锁的收件，会看到 sealed_at 而明确返回 closed，不会悄悄漏掉。
create or replace function public._seal(p_campaign text) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtext('afamakeup_submit|' || p_campaign));
  update public.campaigns set sealed_at = coalesce(sealed_at, clock_timestamp()) where id = p_campaign;
end $$;
revoke all on function public._seal(text) from public, anon, authenticated;
create or replace function public._wait_submits(p_campaign text) returns void
language sql volatile set search_path = '' as $$ select public._seal(p_campaign); $$;

create or replace function public.submit_entry(p_request_id uuid, p_token text, p_pool text, p_payload jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  t_recv timestamptz := clock_timestamp();
  v_th bytea; v_ph bytea; v_c public.campaigns; v_e public.entries; v_price int; v_p jsonb;
begin
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{43}$' then raise exception 'invalid_token'; end if;
  if p_pool not in ('普','钞','三倍钞') then raise exception 'invalid_pool'; end if;
  v_p := public._clean_payload(p_pool, p_payload);
  if p_pool = '三倍钞' then v_p := v_p - 'campaign_id'; end if;
  v_th := public._hash(p_token);
  v_ph := public._hash(p_pool || '|' || v_p::text);

  select * into v_e from public.entries where request_id = p_request_id;
  if found then
    if v_e.token_hash = v_th and v_e.payload_hash = v_ph then
      return jsonb_build_object('ok', true, 'entry_id', v_e.id, 'status', v_e.status, 'received_at', v_e.received_at, 'price', v_e.price, 'replay', true);
    end if;
    raise exception 'conflict';
  end if;

  v_price := public.compute_price(p_pool, v_p);
  if p_pool = '三倍钞' then
    if not coalesce((select s.premium_3x_open from public.settings s where s.id = 1), false) then raise exception 'closed'; end if;
  else
    perform 1 from public.campaigns where id = v_p->>'campaign_id';
    if not found then raise exception 'invalid_payload'; end if;
    perform pg_advisory_xact_lock_shared(hashtext('afamakeup_submit|' || (v_p->>'campaign_id')));
    select * into v_c from public.campaigns where id = v_p->>'campaign_id';     -- 拿锁后再读，看得到最新的 sealed_at
    if t_recv < v_c.open_at then raise exception 'not_open'; end if;
    if t_recv >= v_c.open_at + make_interval(secs => v_c.window_seconds) then raise exception 'closed'; end if;
    if v_c.sealed_at is not null then raise exception 'closed'; end if;
  end if;

  begin
    insert into public.entries (campaign_id, pool, request_id, token_hash, payload_hash, payload, price,
      xianyu_id, contact_last4, received_at, status, upload_until)
    values (v_c.id, p_pool, p_request_id, v_th, v_ph, v_p, v_price, v_p->>'xianyu_id',
      right(regexp_replace(v_p->>'contact1', '\D', '', 'g'), 4), t_recv,
      case when p_pool = '三倍钞' then 'reviewing' else 'received' end, t_recv + interval '30 minutes')
    returning * into v_e;
  exception when unique_violation then
    select * into v_e from public.entries where request_id = p_request_id;
    if found and v_e.token_hash = v_th and v_e.payload_hash = v_ph then
      return jsonb_build_object('ok', true, 'entry_id', v_e.id, 'status', v_e.status, 'received_at', v_e.received_at, 'price', v_e.price, 'replay', true);
    end if;
    raise exception 'conflict';
  end;
  return jsonb_build_object('ok', true, 'entry_id', v_e.id, 'status', v_e.status, 'received_at', v_e.received_at, 'price', v_e.price, 'replay', false);
end $$;

-- 批次修改：与收件同一把独占锁；开放时间一到、或已封批、或已有投递，就不能改
create or replace function public.upsert_campaign(p_id text, p_open_at timestamptz, p_window int, p_quotas jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_c public.campaigns;
begin
  perform public._assert_admin();
  if p_id !~ '^[A-Za-z0-9_-]{1,20}$' then raise exception 'invalid_payload'; end if;
  perform pg_advisory_xact_lock(hashtext('afamakeup_submit|' || p_id));
  select * into v_c from public.campaigns where id = p_id;
  if found and (clock_timestamp() >= v_c.open_at or v_c.sealed_at is not null
                or exists (select 1 from public.entries where campaign_id = p_id)) then
    raise exception 'campaign_started';
  end if;
  insert into public.campaigns (id, open_at, window_seconds, quotas) values (p_id, p_open_at, p_window, p_quotas)
  on conflict (id) do update set open_at = excluded.open_at, window_seconds = excluded.window_seconds, quotas = excluded.quotas;
  return (select to_jsonb(c) from public.campaigns c where c.id = p_id);
end $$;

-- 图片：中签/通过后，在原 30 分钟内仍可补图；绑定时同步正式订单
create or replace function public.request_upload(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_e public.entries; v_t public.upload_tickets; n int; v_prefix text;
begin
  select * into v_e from public.entries where token_hash = public._hash(p_token) for update;
  if not found then raise exception 'invalid_token'; end if;
  if v_e.purged_at is not null or v_e.status not in ('received','reviewing','won') or clock_timestamp() > v_e.upload_until then
    raise exception 'closed';
  end if;
  if cardinality(v_e.images) > 0 then raise exception 'conflict'; end if;
  select count(*) into n from public.upload_tickets where entry_id = v_e.id;
  if n >= 3 then raise exception 'too_many'; end if;
  if v_e.upload_secret is null then
    update public.entries set upload_secret = gen_random_uuid() where id = v_e.id returning * into v_e;
  end if;
  v_prefix := 'entries/' || v_e.id || '/' || v_e.upload_secret || '/';
  insert into public.upload_tickets (entry_id, prefix, expires_at)
  values (v_e.id, v_prefix || gen_random_uuid(), least(v_e.upload_until, clock_timestamp() + interval '10 minutes'))
  returning * into v_t;
  return jsonb_build_object('bucket','reference-images','expires_at',v_t.expires_at,'max_bytes',5242880,
    'mime',jsonb_build_array('image/jpeg','image/png','image/webp'),
    'slots',(select jsonb_agg(v_prefix || i order by i) from generate_series(1,6) i),
    'occupied',(select coalesce(jsonb_agg(jsonb_build_object('path', o.name, 'size', o.metadata->>'size', 'etag', o.metadata->>'eTag') order by o.name), '[]')
                from storage.objects o where o.bucket_id = 'reference-images' and o.name like v_prefix || '%'));
end $$;

-- 写入策略同时核对当前状态和截止时间：拒绝、落选、清理、过期后旧票立刻失效
create or replace function public.can_upload(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.entries e join public.upload_tickets t on t.entry_id = e.id
     where e.upload_secret is not null
       and p_name ~ ('^entries/' || e.id || '/' || e.upload_secret || '/[1-6]$')
       and clock_timestamp() < t.expires_at and clock_timestamp() < e.upload_until
       and e.status in ('received','reviewing','won')
       and e.purged_at is null and cardinality(e.images) = 0);
$$;

create or replace function public.attach_images(p_token text, p_paths text[])
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_e public.entries; p text; v_paths text[];
begin
  select * into v_e from public.entries where token_hash = public._hash(p_token) for update;
  if not found then raise exception 'invalid_token'; end if;
  select coalesce(array_agg(distinct x order by x), '{}') into v_paths from unnest(coalesce(p_paths,'{}')) x;
  if cardinality(v_e.images) > 0 then
    if v_e.images = v_paths then return jsonb_build_object('ok', true, 'images', cardinality(v_paths), 'replay', true); end if;
    raise exception 'conflict';
  end if;
  if v_e.purged_at is not null or v_e.status not in ('received','reviewing','won')
     or clock_timestamp() > v_e.upload_until or v_e.upload_secret is null then raise exception 'closed'; end if;
  if cardinality(v_paths) > 6 then raise exception 'invalid_payload'; end if;
  foreach p in array v_paths loop
    if p !~ ('^entries/' || v_e.id || '/' || v_e.upload_secret || '/[1-6]$')
       or not exists (select 1 from storage.objects o where o.bucket_id = 'reference-images' and o.name = p) then
      raise exception 'invalid_payload';
    end if;
  end loop;
  update public.entries set images = v_paths where id = v_e.id;
  if v_e.order_id is not null then                                  -- 已中签/已通过：同步正式订单
    update public.orders set reference_images = v_paths, last_update = now() where order_id = v_e.order_id;
  end if;
  delete from public.upload_tickets where entry_id = v_e.id;
  return jsonb_build_object('ok', true, 'images', cardinality(v_paths), 'replay', false);
end $$;

create or replace function public.reject_entry(p_entry uuid, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  perform public._assert_admin();
  update public.entries set status = 'rejected', upload_until = now()
   where id = p_entry and pool = '三倍钞' and status = 'reviewing';
  if not found then raise exception 'invalid_state'; end if;
  delete from public.upload_tickets where entry_id = p_entry;
  return jsonb_build_object('ok', true);
end $$;

-- 开奖收尾时落选者立刻撤票
create or replace function public._close_losers() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'not_selected' and old.status is distinct from 'not_selected' then
    new.upload_until := least(new.upload_until, now());
    delete from public.upload_tickets where entry_id = new.id;
  end if;
  return new;
end $$;
drop trigger if exists entries_close_losers on public.entries;
create trigger entries_close_losers before update of status on public.entries for each row execute function public._close_losers();
commit;

-- ===== db-contract-v0.6b-patch.sql =====
-- v0.6b：锁池也走封批协议
begin;
create or replace function public.lock_pool(p_campaign text, p_pool text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare m uuid[]; v_c public.campaigns; nspeed int; total int;
begin
  perform public._assert_admin();
  perform public._pool_lock(p_campaign, p_pool);
  select * into v_c from public.campaigns where id = p_campaign;
  if not found then raise exception 'invalid_payload'; end if;
  if clock_timestamp() < v_c.open_at + make_interval(secs => v_c.window_seconds) then raise exception 'not_closed'; end if;
  perform public._seal(p_campaign);   -- 封批：等在途收件提交，之后的收件明确拒绝
  if exists (select 1 from public.lottery_pools l where l.campaign_id = p_campaign and l.pool = p_pool) then raise exception 'pool_locked'; end if;
  select count(*) filter (where win_type = 'speed'), count(*) into nspeed, total
    from public.entries where campaign_id = p_campaign and pool = p_pool;
  if nspeed < least(total, public._quota(v_c.quotas, p_pool, 'speed')) then raise exception 'speed_not_confirmed'; end if;
  select array_agg(e.id order by e.received_at, e.seq) into m from public.entries e
   where e.campaign_id = p_campaign and e.pool = p_pool and e.status = 'received';
  insert into public.lottery_pools (campaign_id, pool, members) values (p_campaign, p_pool, coalesce(m, '{}'));
  update public.entries e set lottery_pos = s.pos from unnest(coalesce(m,'{}')) with ordinality s(id, pos) where e.id = s.id;
  return (select jsonb_build_object('locked_at', l.locked_at, 'm', cardinality(l.members),
            'list', coalesce((select jsonb_agg(jsonb_build_object('pos', e.lottery_pos, 'xianyu_id', e.xianyu_id) order by e.lottery_pos)
                     from public.entries e where e.id = any(l.members)), '[]'))
          from public.lottery_pools l where l.campaign_id = p_campaign and l.pool = p_pool);
end $$;
commit;

-- ===== db-contract-v0.7-patch.sql =====
-- v0.7：旧后台“通过”改走服务端发号（与开奖同一条编号线，原子）
begin;
create or replace function public.admin_approve_order(p_id uuid)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare v_id text;
begin
  perform public._assert_admin();
  select order_id into v_id from public.orders where id = p_id and status = 'approved' and order_id is not null;
  if found then return v_id; end if;                                  -- 重复点击
  if not exists (select 1 from public.orders where id = p_id and status = 'pending') then raise exception 'invalid_state'; end if;
  v_id := public._next_order_id();
  update public.orders set status = 'approved', order_id = v_id, last_update = now() where id = p_id;
  return v_id;
end $$;
revoke all on function public.admin_approve_order(uuid) from public, anon;
grant execute on function public.admin_approve_order(uuid) to authenticated;
commit;

-- ===== db-contract-v0.8-patch.sql =====
-- v0.8：旧单审核先锁行再判状态再发号，并发点两次只发一个号
begin;
create or replace function public.admin_approve_order(p_id uuid)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare v_o public.orders; v_id text;
begin
  perform public._assert_admin();
  select * into v_o from public.orders where id = p_id for update;   -- 并发的第二个请求在这里等第一个提交
  if not found then raise exception 'invalid_state'; end if;
  if v_o.status = 'approved' and v_o.order_id is not null then return v_o.order_id; end if;
  if v_o.status <> 'pending' or v_o.order_id is not null then raise exception 'invalid_state'; end if;
  v_id := public._next_order_id();
  update public.orders set status = 'approved', order_id = v_id, last_update = now() where id = p_id;
  return v_id;
end $$;
commit;
