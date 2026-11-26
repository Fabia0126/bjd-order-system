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
