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
