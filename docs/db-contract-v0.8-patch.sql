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
