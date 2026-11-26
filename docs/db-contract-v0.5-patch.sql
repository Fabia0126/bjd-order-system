-- v0.5：上传改成每单固定 6 个对象名（槽位），同名重复会被 Storage 拒绝，所以总数天然 ≤6，不靠计数（计数有并发竞态，实测 10 并发进了 7 张）
begin;
alter table public.entries add column if not exists upload_secret uuid;

create or replace function public.request_upload(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_e public.entries; v_t public.upload_tickets; n int; v_prefix text;
begin
  select * into v_e from public.entries where token_hash = public._hash(p_token) for update;
  if not found then raise exception 'invalid_token'; end if;
  if v_e.purged_at is not null or v_e.status not in ('received','reviewing') or clock_timestamp() > v_e.upload_until then
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
  values (v_e.id, v_prefix || gen_random_uuid(), least(v_e.upload_until, clock_timestamp() + interval '10 minutes'))  -- prefix 列唯一，存一个票号
  returning * into v_t;
  return jsonb_build_object('bucket','reference-images','expires_at',v_t.expires_at,'max_bytes',5242880,
    'mime',jsonb_build_array('image/jpeg','image/png','image/webp'),
    'slots',(select jsonb_agg(v_prefix || i order by i) from generate_series(1,6) i));
end $$;

create or replace function public.can_upload(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.entries e join public.upload_tickets t on t.entry_id = e.id
     where e.upload_secret is not null
       and p_name ~ ('^entries/' || e.id || '/' || e.upload_secret || '/[1-6]$')
       and clock_timestamp() < t.expires_at
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
  if v_e.purged_at is not null or clock_timestamp() > v_e.upload_until or v_e.upload_secret is null then raise exception 'closed'; end if;
  if cardinality(v_paths) > 6 then raise exception 'invalid_payload'; end if;
  foreach p in array v_paths loop
    if p !~ ('^entries/' || v_e.id || '/' || v_e.upload_secret || '/[1-6]$')
       or not exists (select 1 from storage.objects o where o.bucket_id = 'reference-images' and o.name = p) then
      raise exception 'invalid_payload';
    end if;
  end loop;
  update public.entries set images = v_paths where id = v_e.id;
  delete from public.upload_tickets where entry_id = v_e.id;
  return jsonb_build_object('ok', true, 'images', cardinality(v_paths), 'replay', false);
end $$;
commit;
