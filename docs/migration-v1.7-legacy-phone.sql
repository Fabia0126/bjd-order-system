-- v1.7 旧订单手机号查询（2026-11-28）
-- 11/28 之前的旧订单没有查询凭据。买家输入当时留的完整 11 位手机号，查本人旧订单的进度。
-- 只读；只返回编号、进度、开工时间、最后更新时间，不返回姓名、地址、闲鱼 ID、联系方式。
-- 限速：同一来源 10 分钟最多 10 次；全站 10 分钟最多 600 次（防止拿号段乱试）。
-- 新系统的投递仍然只能用查询凭据，这条路不碰 entries 表。

begin;

create table if not exists public.legacy_lookup_hits (
  bucket text not null,
  at     timestamptz not null default clock_timestamp()
);
create index if not exists legacy_lookup_hits_bucket_at on public.legacy_lookup_hits (bucket, at);
create index if not exists legacy_lookup_hits_at on public.legacy_lookup_hits (at);
alter table public.legacy_lookup_hits enable row level security;
revoke all on public.legacy_lookup_hits from public, anon, authenticated;

create or replace function public.lookup_legacy_order(p_phone text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_phone  text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  v_hdr    json;
  v_src    text;
  v_bucket text;
  v_rows   jsonb;
begin
  if v_phone !~ '^1[0-9]{10}$' then
    raise exception 'invalid_phone';
  end if;

  begin
    v_hdr := nullif(current_setting('request.headers', true), '')::json;
  exception when others then
    v_hdr := null;
  end;
  v_src := nullif(trim(coalesce(v_hdr ->> 'cf-connecting-ip',
                                split_part(v_hdr ->> 'x-forwarded-for', ',', 1),
                                v_hdr ->> 'x-real-ip', '')), '');
  -- 拿不到来源时按手机号限速，不让所有人挤进同一个桶
  v_bucket := coalesce('ip:' || v_src, 'phone:' || md5(v_phone));

  delete from public.legacy_lookup_hits where at < clock_timestamp() - interval '1 hour';

  if (select count(*) from public.legacy_lookup_hits
       where at > clock_timestamp() - interval '10 minutes') >= 600 then
    raise exception 'rate_limited';
  end if;
  if (select count(*) from public.legacy_lookup_hits
       where bucket = v_bucket and at > clock_timestamp() - interval '10 minutes') >= 10 then
    raise exception 'rate_limited';
  end if;
  insert into public.legacy_lookup_hits (bucket) values (v_bucket);

  select coalesce(jsonb_agg(jsonb_build_object(
           'order_id',        o.order_id,
           'status',          o.status,
           'work_start_time', o.work_start_time,
           'last_update',     o.last_update
         ) order by o.order_id), '[]'::jsonb)
    into v_rows
    from public.orders o
   where o.order_id is not null
     and o.submit_time < timestamptz '2026-11-28 00:00:00+08'
     and o.status in ('approved', 'working', 'packing', 'completed')
     and (regexp_replace(coalesce(o.contact1, ''), '[^0-9]', '', 'g') = v_phone
       or regexp_replace(coalesce(o.contact2, ''), '[^0-9]', '', 'g') = v_phone);

  return jsonb_build_object('orders', v_rows);
end
$$;

revoke all on function public.lookup_legacy_order(text) from public;
grant execute on function public.lookup_legacy_order(text) to anon, authenticated;

commit;
