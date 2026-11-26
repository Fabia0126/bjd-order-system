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
