-- v1.2-final：按阿序 launch-plan-review v2 收口
-- 1) 维护开关一律停收（去掉 SMOKE 例外），Storage 写入策略也受维护约束
-- 2) DEMO 编号按批次串行；清空演练先封批、要求窗口已结束
-- 3) 建批次与演练标记原子完成；公开状态/回执/查单返回 demo
begin;
create or replace function public._maint_guard(p_campaign text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if coalesce((select s.maintenance from public.settings s where s.id = 1), false) then raise exception 'maintenance'; end if;
end $$;
revoke all on function public._maint_guard(text) from public, anon, authenticated;

create or replace function public.submit_entry(p_request_id uuid, p_token text, p_pool text, p_payload jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  t_recv timestamptz := clock_timestamp();
  v_th bytea; v_ph bytea; v_c public.campaigns; v_e public.entries; v_price int; v_p jsonb;
begin
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{43}$' then raise exception 'invalid_token'; end if;
  if p_pool not in ('普','钞','三倍钞') then raise exception 'invalid_pool'; end if;
  perform public._maint_guard(null);
  v_p := public._clean_payload(p_pool, p_payload);
  if p_pool = '三倍钞' then v_p := v_p - 'campaign_id'; end if;
  v_th := public._hash(p_token);
  v_ph := public._hash(p_pool || '|' || v_p::text);

  select * into v_e from public.entries where request_id = p_request_id;
  if found then
    if v_e.token_hash = v_th and v_e.payload_hash = v_ph then
      return jsonb_build_object('ok', true, 'entry_id', v_e.id, 'status', v_e.status, 'received_at', v_e.received_at, 'price', v_e.price, 'replay', true, 'demo', coalesce((select c.demo from public.campaigns c where c.id = v_e.campaign_id), false));
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
      return jsonb_build_object('ok', true, 'entry_id', v_e.id, 'status', v_e.status, 'received_at', v_e.received_at, 'price', v_e.price, 'replay', true, 'demo', coalesce((select c.demo from public.campaigns c where c.id = v_e.campaign_id), false));
    end if;
    raise exception 'conflict';
  end;
  return jsonb_build_object('ok', true, 'entry_id', v_e.id, 'status', v_e.status, 'received_at', v_e.received_at, 'price', v_e.price, 'replay', false, 'demo', coalesce((select c.demo from public.campaigns c where c.id = v_e.campaign_id), false));
end $$;

create or replace function public.request_upload(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_e public.entries; v_t public.upload_tickets; n int; v_prefix text;
begin
  select * into v_e from public.entries where token_hash = public._hash(p_token) for update;
  if not found then raise exception 'invalid_token'; end if;
  perform public._maint_guard(null);
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

create or replace function public.attach_images(p_token text, p_paths text[])
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_e public.entries; p text; v_paths text[];
begin
  select * into v_e from public.entries where token_hash = public._hash(p_token) for update;
  if not found then raise exception 'invalid_token'; end if;
  perform public._maint_guard(null);
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

create or replace function public.can_upload(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select not coalesce((select s.maintenance from public.settings s where s.id = 1), false)
     and exists (
    select 1 from public.entries e join public.upload_tickets t on t.entry_id = e.id
     where e.upload_secret is not null
       and p_name ~ ('^entries/' || e.id || '/' || e.upload_secret || '/[1-6]$')
       and clock_timestamp() < t.expires_at and clock_timestamp() < e.upload_until
       and e.status in ('received','reviewing','won')
       and e.purged_at is null and cardinality(e.images) = 0);
$$;

create or replace function public._win(p_entry uuid, p_type text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_e public.entries; v_id text; p jsonb;
begin
  select * into v_e from public.entries where id = p_entry for update;
  if v_e.order_id is not null then return v_e.order_id; end if;          -- 重复点击不重复发号
  if v_e.status not in ('received','reviewing') then raise exception 'invalid_state'; end if;
  if coalesce((select c.demo from public.campaigns c where c.id = v_e.campaign_id), false) then
    perform pg_advisory_xact_lock(hashtext('afamakeup_demo_no|' || v_e.campaign_id));   -- 两个池同时发号也串行
    -- 演练批次：不占正式编号、不写正式订单
    v_id := 'DEMO-' || v_e.campaign_id || '-' || lpad(((select count(*) from public.entries x where x.campaign_id = v_e.campaign_id and x.order_id is not null) + 1)::text, 3, '0');
    update public.entries set status = 'won', win_type = p_type, order_id = v_id where id = v_e.id;
    return v_id;
  end if;
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

create or replace function public.lookup_entry(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_e public.entries; o record;
begin
  select * into v_e from public.entries where token_hash = public._hash(p_token);
  if not found then raise exception 'invalid_token'; end if;
  select status, last_update into o from public.orders where order_id = v_e.order_id;
  return jsonb_build_object('entry_id', v_e.id, 'pool', v_e.pool, 'campaign_id', v_e.campaign_id,
    'status', v_e.status, 'win_type', v_e.win_type, 'order_id', v_e.order_id,
    'order_status', o.status, 'demo', coalesce((select c.demo from public.campaigns c where c.id = v_e.campaign_id), false), 'received_at', v_e.received_at, 'price', v_e.price,
    'payload', case when v_e.purged_at is null then v_e.payload - 'contact1' - 'contact2' - 'receiver_name' else null end);
end $$;

create or replace function public.campaign_status()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'server_time', clock_timestamp(),
    'maintenance', coalesce((select s.maintenance from public.settings s where s.id = 1), false),
    'campaign', (select jsonb_build_object('id', c.id, 'open_at', c.open_at,
                   'close_at', c.open_at + make_interval(secs => c.window_seconds), 'quotas', c.quotas, 'demo', c.demo)
                 from public.campaigns c order by c.open_at desc limit 1),
    'triple_open', coalesce((select s.premium_3x_open from public.settings s where s.id = 1), false)
      and not coalesce((select s.maintenance from public.settings s where s.id = 1), false)
  );
$$;

drop function if exists public.set_campaign_demo(text, boolean);
drop function if exists public.upsert_campaign(text, timestamptz, int, jsonb);
create or replace function public.upsert_campaign(p_id text, p_open_at timestamptz, p_window int, p_quotas jsonb, p_demo boolean default false)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_c public.campaigns;
begin
  perform public._assert_admin();
  if p_id !~ '^[A-Za-z0-9_-]{1,20}$' or p_demo is null then raise exception 'invalid_payload'; end if;
  perform pg_advisory_xact_lock(hashtext('afamakeup_submit|' || p_id));
  select * into v_c from public.campaigns where id = p_id;
  if found and (clock_timestamp() >= v_c.open_at or v_c.sealed_at is not null
                or exists (select 1 from public.entries where campaign_id = p_id)) then
    raise exception 'campaign_started';
  end if;
  insert into public.campaigns (id, open_at, window_seconds, quotas, demo) values (p_id, p_open_at, p_window, p_quotas, p_demo)
  on conflict (id) do update set open_at = excluded.open_at, window_seconds = excluded.window_seconds, quotas = excluded.quotas, demo = excluded.demo;
  return (select to_jsonb(c) from public.campaigns c where c.id = p_id);
end $$;
revoke all on function public.upsert_campaign(text,timestamptz,int,jsonb,boolean) from public, anon;
grant execute on function public.upsert_campaign(text,timestamptz,int,jsonb,boolean) to authenticated;

create or replace function public.purge_demo(p_campaign text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare paths text[]; v_c public.campaigns;
begin
  perform public._assert_admin();
  select * into v_c from public.campaigns where id = p_campaign;
  if not found or not v_c.demo then raise exception 'not_demo'; end if;
  if clock_timestamp() < v_c.open_at + make_interval(secs => v_c.window_seconds) then raise exception 'not_closed'; end if;
  perform public._seal(p_campaign);                                  -- 等在途收件落库，之后再来的明确 closed
  select coalesce(array_agg(o.name), '{}') into paths from storage.objects o
    join public.entries e on o.name like 'entries/' || e.id || '/%'
   where o.bucket_id = 'reference-images' and e.campaign_id = p_campaign;
  delete from public.upload_tickets t using public.entries e where t.entry_id = e.id and e.campaign_id = p_campaign;
  update public.entries set payload = '{}'::jsonb, images = '{}', upload_until = now(), purged_at = coalesce(purged_at, now()),
         status = case when status = 'received' then 'not_selected' else status end
   where campaign_id = p_campaign;
  return jsonb_build_object('purged', (select count(*) from public.entries where campaign_id = p_campaign), 'delete_paths', to_jsonb(paths));
end $$;
commit;
