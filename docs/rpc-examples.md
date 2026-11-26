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
