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
