# afamakeup 上线方案 v2（2026-11-26 21:40 CST，阿发要求今晚上线）

依据：阿序 launch-plan-review-codex-v1 + 两条补充。回退不再恢复匿名权限（rollback-to-legacy.sql 仅留档，禁止使用）。

## 已完成的前置
- 测试库 regress-v1（24）、regress-purge（14）、regress-maint（14：维护开关 + 零名额 SMOKE 冒烟）全过
- 阿发预览站演练整轮通过；HTTPS 预览上 iPhone 投递成功（之前失败=HTTP 下 crypto.subtle 不可用，已由阿序前台明确提示）

## 切换步骤（我执行，阿序复核，阿发在场）
0. 阿序把 codex/frontend-hardening 提交；我把 luxun/db-lottery 合并成 release/2611 分支（runtime-config.js 只含注释）
1. 只读快照（schema+orders+settings，本机 0600）→ 记录 orders 行数 / max(order_id)
2. 执行 migration-v1.4-prod.sql（第 0 段先关开关、拆旧策略、revoke anon → v1.3 → 维护开关补丁 → maintenance=true）。
   每段后断言：无 public/anon 放行策略；桶 private + 限额；anon 读 orders 401；campaign_status 200 且 maintenance=true；orders 行数不变
3. Auth：site_url=https://afamakeup.top/lottery.html，allow list 含 lottery/admin，disable_signup=true
4. release/2611 推 main → Vercel 部署 → 正式站打开 form/status/admin/lottery 无报错、无连测试库
5. 邀请阿发邮箱（正式 https 跳转；若 Cloudflare 仍拦，用 generate_link + POST verify 本机交接）→ 设密码 → 写 admins
6. 冒烟（维护开关仍开，只放行 SMOKE 前缀）：SMOKE 批次名额全 0 → 投 1 单 + 补 1 图 + 查单 → 锁池 → 零名额开奖 → purge + 删图。不生成 BJD 号；写入范围：entries 1 行（清理后只剩闲鱼 ID/后四位）、campaigns 1 行、lottery_pools 1 行
7. 阿发在开奖台建 1128（2026-11-28 21:00:00 东八区，5 秒，普 3/1/2、钞 3/1/2），两人核对
8. 关维护开关；按阿发要求开三倍钞开关；她公布链接

## 出问题怎么办
- 第 2 步任何断言失败：停在维护状态（旧页面已无法写，新页面未上），修 SQL 后重跑该段；不恢复旧策略
- 第 4 步前端问题：维护开关保持开，修前端再部署
- 快照只作最后保险（恢复演练：测试库从快照 JSON 重建 orders 一次，待做）
