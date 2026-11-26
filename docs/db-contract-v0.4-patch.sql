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
