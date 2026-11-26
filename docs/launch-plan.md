# afamakeup 上线方案（草案 v1，2026-11-26 21:15 CST，待阿序复核、阿发同意）

## 0. 前提（全部满足才上线）
- [ ] 阿序对 migration-v1.2（sha256 41c12537…）、我的 admin/lottery、他的前台做最终复核通过
- [ ] 预览站（Vercel 分支预览，runtime-config 指向测试库）上，阿发亲手走一遍：投递→手速→选抽→锁池→名单截图→预览→开奖→三倍钞通过→旧后台看单/导出
- [ ] regress-v1.py（24 项）+ regress-purge.py（14 项）在测试库最后一次全过
- [ ] 上线时段：11/27 晚，阿发在场；11/28 当天不动任何东西

## 1. 上线前 30 分钟
1. 后台“接单设置”先把普单/钞单/三倍钞都关掉（避免切换间隙有人投递）
2. 线上快照（只读，Management API）：
   - 结构：pg_policies、函数定义、触发器、grants、storage 桶配置 → `~/fafa-work/bjd/backup/2026-11-27/schema.json`
   - 数据：orders、settings 全表 → `orders.json`、`settings.json`（含单主隐私，文件 0600，只在本机，一周后删除）
   - 记录 orders 行数、最大 order_id

## 2. 切换（目标 10 分钟内完成，旧站在这段时间不可投递）
1. 执行 `docs/migration-v1.2.sql`（--write），执行后跑断言：
   - pg_policies 里 orders/settings/storage 没有任何 public/anon 放行策略
   - reference-images 桶 public=false、5MB、jpeg/png/webp
   - 匿名 REST 读 orders → 401；campaign_status → 200
2. Auth 设置（Management API PATCH config/auth）：site_url=https://afamakeup.top；uri_allow_list=https://afamakeup.top/lottery.html,https://afamakeup.top/admin.html；disable_signup=true
3. 合并 `codex/frontend-hardening` + `luxun/db-lottery` → main，推送，Vercel 自动部署正式站；确认正式站 runtime-config.js 为“只有注释”版本（走正式域名默认配置）
4. 邀请阿发邮箱（~/infra/credentials/afamakeup-admin.env）→ 她点邮件设密码 → `insert into public.admins select id from auth.users where email = …`
5. 阿发登录 admin.html、lottery.html，能看到旧订单、能打开带图旧单（签名地址）

## 3. 冒烟（正式库，最少写入）
- 新建批次 `SMOKE1127`（开放 = 现在，窗口 120 秒，名额 普/钞 各 1/0/0）
- 用正式前台投 1 单，闲鱼 ID 写 `SMOKE_TEST_请忽略`，传 1 张图 → 查单页能查到
- 后台：确认手速 → 生成一个正式号（**会占用一个 BJD 编号**，阿发事先同意）→ 旧后台里看到这张单 → 直接“拒绝/删除”掉
- 不想占号的话：只做到“收件 + 查单 + 图片绑定”，不确认手速，之后 purge
- 创建正式批次 `1128`：开放 2026-11-28 21:00:00 东八区，窗口 5 秒，普 3/1/2、钞 3/1/2（开放后无法再改，保存前两人核对）
- 重新打开普单/钞单/三倍钞开关（按阿发要求）

## 4. 回滚（如果第 2 步后出现无法当场修好的问题，且离 11/28 21:00 还早）
- Vercel：把上一个正式部署 Promote 回去（旧前台）
- 数据库：执行 `docs/rollback-to-legacy.sql`（重建旧的 "Allow all access…" 两条策略和旧的 storage 两条策略、桶改回 public；新表和函数保留不删）。**回滚等于恢复旧漏洞**，只作为保开单的应急
- 订单数据不会因迁移丢失（迁移不删 orders 行），快照只作为最后保险

## 5. 11/28 当晚流程（阿发操作，我在旁边盯）
- 20:40 我叫她；20:45 登录开奖台，确认批次 1128 时间、名额
- 21:00:00–21:00:05 投递窗口
- 21:00:10 起：① 确认手速（普、钞各前 3）→ ② 点选抽 → ③ 锁定摇号池 → 截图两张名单公布（**21:25 前**）
- 21:25 排列5 开奖后：填号 → ④ 预览 → 核对 → ⑤ 确认开奖 → 截图公布中签与算式
- 未中签资料：开奖一周后在开奖台点“清理本批未中签资料”

## 6. 上线后
- 阿发撤销本次 7 天的 Supabase 管理 token（Account → Access Tokens），以后需要再按最小权限新建
- 旧后台密码按已公开处理；如别处复用需更换
- status.html 不再支持按手机号查旧单，旧单买家问进度由阿发人工回复
