-- v1.1-demo：演练批次（正式库可演练全流程，不占 BJD 号、不进 orders，演练后一键清空）
begin;
alter table public.campaigns add column if not exists demo boolean not null default false;
create or replace function public._win(p_entry uuid, p_type text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_e public.entries; v_id text; p jsonb;
begin
  select * into v_e from public.entries where id = p_entry for update;
  if v_e.order_id is not null then return v_e.order_id; end if;          -- 重复点击不重复发号
  if v_e.status not in ('received','reviewing') then raise exception 'invalid_state'; end if;
  if coalesce((select c.demo from public.campaigns c where c.id = v_e.campaign_id), false) then
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

create or replace function public.set_campaign_demo(p_id text, p_demo boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  perform public._assert_admin();
  perform pg_advisory_xact_lock(hashtext('afamakeup_submit|' || p_id));
  if exists (select 1 from public.entries where campaign_id = p_id) then raise exception 'campaign_started'; end if;
  update public.campaigns set demo = p_demo where id = p_id;
  if not found then raise exception 'invalid_payload'; end if;
  return jsonb_build_object('id', p_id, 'demo', p_demo);
end $$;
revoke all on function public.set_campaign_demo(text,boolean) from public, anon;
grant execute on function public.set_campaign_demo(text,boolean) to authenticated;

-- 演练批次一键清空：所有投递（含演练中签）资料、图片、上传票全部清掉
create or replace function public.purge_demo(p_campaign text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare paths text[];
begin
  perform public._assert_admin();
  if not coalesce((select demo from public.campaigns where id = p_campaign), false) then raise exception 'not_demo'; end if;
  select coalesce(array_agg(o.name), '{}') into paths from storage.objects o
    join public.entries e on o.name like 'entries/' || e.id || '/%'
   where o.bucket_id = 'reference-images' and e.campaign_id = p_campaign;
  delete from public.upload_tickets t using public.entries e where t.entry_id = e.id and e.campaign_id = p_campaign;
  update public.entries set payload = '{}'::jsonb, images = '{}', upload_until = now(), purged_at = coalesce(purged_at, now()),
         status = case when status = 'received' then 'not_selected' else status end
   where campaign_id = p_campaign;
  return jsonb_build_object('purged', (select count(*) from public.entries where campaign_id = p_campaign), 'delete_paths', to_jsonb(paths));
end $$;
revoke all on function public.purge_demo(text) from public, anon;
grant execute on function public.purge_demo(text) to authenticated;
commit;
