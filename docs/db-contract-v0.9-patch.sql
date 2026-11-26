-- v0.9：开奖台列表带上小纸条内容（不含收件人/电话），选抽时能看
begin;
create or replace function public.admin_pool(p_campaign text, p_pool text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform public._assert_admin();
  return coalesce((select jsonb_agg(jsonb_build_object('entry_id', e.id, 'rank', r, 'xianyu_id', e.xianyu_id,
      'received_at', e.received_at, 'status', e.status, 'win_type', e.win_type, 'order_id', e.order_id,
      'lottery_pos', e.lottery_pos, 'price', e.price, 'images', cardinality(e.images),
      'note', e.payload - 'contact1' - 'contact2' - 'receiver_name' - 'shipping' - 'campaign_id') order by r)
    from (select e.*, row_number() over (order by received_at, seq) r from public.entries e
          where e.campaign_id = p_campaign and e.pool = p_pool) e), '[]');
end $$;
commit;
