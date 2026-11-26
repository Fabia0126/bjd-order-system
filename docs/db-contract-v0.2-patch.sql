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
