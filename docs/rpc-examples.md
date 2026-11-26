# RPC 样例（测试库 pvtlmabvtvyuyuycwovc 实跑，2026-11-26 18:40 CST）

## payload 字段（submit_entry 的 p_payload）
必填：campaign_id（普/钞）、size ('3fen'|'4fen')、makeup ('free'|'specified'|'cos')、xianyu_id
可选：addons(数组：卸妆/睫毛/Pan粉去黄/面罩/疤痕/口配/重肌理/面纹/加急)、koupei_qty(1-10)、size_label、makeup_label、doll_info、attribute、gender、color_scheme、taboos[]、requirements[]、free_items[]、glitter、accessories、receiver_name、contact1、contact2、shipping
价格服务端算：base(4分 free160/specified180/cos200；3分 190/210/230) × 普1/钞2/三倍钞3 + 加购；前端价格只作展示

## campaign_status()
{"server_time":"…","campaign":{"id":"T1","open_at":"…","close_at":"2026-11-26T10:40:26Z","quotas":{"普":{"speed":3,"pick":1,"lottery":2},"钞":{…}}},"triple_open":true}

## submit_entry(p_request_id uuid, p_token text(≥40字符), p_pool '普'|'钞'|'三倍钞', p_payload)
成功：{"ok":true,"entry_id":"…","status":"received","received_at":"…","price":185,"replay":false}
同请求同凭据同内容重试（关窗后也行）：同上，"replay":true
错误（Postgres 异常 message）：not_open / closed / invalid_pool / invalid_payload / conflict / invalid_token

## request_upload(p_token) → {"bucket":"reference-images","prefix":"entries/{entry_id}/{ticket}/","expires_at":"…","max_files":6,"max_bytes":5242880,"mime":["image/jpeg","image/png","image/webp"]}
前端用 supabase.storage.from(bucket).upload(prefix + 文件名, file, {upsert:false})；文件名不能含 /
## attach_images(p_token, p_paths text[]) → {"ok":true,"images":2}

## lookup_entry(p_token)
{"entry_id":"…","pool":"普","campaign_id":"T1","status":"received|reviewing|won|not_selected|rejected","win_type":null|"speed"|"pick"|"lottery","order_id":null|"BJD202611-016","order_status":null|"approved"…,"received_at":"…","price":185,"payload":{…去掉 contact1/contact2/receiver_name；未中签脱敏后为 null}}

## 已验证（测试库）
- anon：orders/entries/settings 读 0 行；update orders 0 行
- 16 人投递 → 全部 received；重放 replay=true；同 request_id 换凭据 → conflict；关窗后新投递 → closed
- 管理员：手速前3 → BJD202611-012~014（接线上最大 011 往后排）；重复确认不重复发号；选抽 → 015；lock_pool M=6 名单只出闲鱼ID；draw(38627) k=3 s=6 → 6号、3号中签 016/017；再次 draw 返回第一次结果；其余 4 人 not_selected
- 未测：storage 上传策略、purge、三倍钞、Auth 登录（需建真实账号）

## v0.2 变更（对应 db-review-codex-v0.1）
- token 必须是 32 字节 base64url（43 字符，`^[A-Za-z0-9_-]{43}$`），token_hash 唯一
- payload 白名单：未知字段丢弃；字符串 120/500 截断；taboos/requirements ≤3；addons 去重；必填 xianyu_id、contact1、receiver_name；size_label/makeup_label 服务端生成
- 新错误码：invalid_quota / not_closed / quota_exceeded / not_top_n / speed_not_confirmed / pool_locked / pool_not_locked / invalid_number(必须5位) / already_drawn / too_many / invalid_state / forbidden
- 新管理 RPC：draw_preview(campaign,pool,'38627') 不写库；draw 同号重复调用返回原结果，换号 already_drawn；approve_triple(entry)；reject_entry(entry,reason)；purge_not_selected 返回 {purged, delete_paths[]}，后台拿 delete_paths 调 storage remove
- entries 管理员只读；所有写走 RPC
- 图片：attach 后不再发票、不能再传；request_upload 每单最多 3 张票

## v0.2 测试库实测（2026-11-26 18:55 CST）
- 19 人投递（含三倍钞、重复加购、恶意字段 evil、伪造 size_label）：价格 335/795 正确，加购去重，evil 丢弃，标签服务端生成
- 关窗前 confirm_win → not_closed；手速选第 5 名 → not_top_n；未确认手速就锁池 → speed_not_confirmed；第 4 个手速/2 个选抽 → quota_exceeded；锁后选抽 → pool_locked
- 4 位号 → invalid_number；preview 与 draw 结果一致（M=8,k=4,s=4 → 4、8 号）；换号重开 → already_drawn
- 钞池 lottery=0：锁池 M=3，draw n=0，3 人 not_selected（零名额收尾 OK）
- 三倍钞 approve_triple → BJD202611-027
- Storage（真实 anon key 走 REST）：凭证路径上传 200；同名覆盖 409；text/html 400；越界目录/子目录 400；匿名 list 空；public/authenticated 读 400；绑定别人路径 invalid_payload；绑定后再传 400、再要票 conflict
- 匿名 REST 读 orders：permission denied
- 未测：并发多连接（同时确认/锁池/迟提交）、真实 Auth 登录后台、purge 后 storage 删除、文件内容魔数校验（目前只靠桶的 MIME 限制，信 Content-Type）
