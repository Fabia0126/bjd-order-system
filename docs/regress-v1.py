#!/usr/bin/env python3
"""migration-v1 回归（只连测试库 pvtlmabvtvyuyuycwovc）。用法：python3 regress-v1.py"""
import json, os, secrets, subprocess, time, urllib.request, uuid

REF = "pvtlmabvtvyuyuycwovc"
env = dict(l.strip().split("=", 1) for l in open(os.path.expanduser("~/infra/credentials/supabase-test.env")) if "=" in l and not l.startswith("#"))
U, K = env["AFAMAKEUP_TEST_URL"], env["AFAMAKEUP_TEST_ANON_KEY"]
assert REF in U, "只允许测试库"
TAG = "RG%d" % time.time()
res = []

def sql(q, write=True):
    out = subprocess.run([os.path.expanduser("~/infra/scripts/sbq"), REF, "-"] + (["--write"] if write else []),
                         input=q, capture_output=True, text=True).stdout
    d = json.loads(out)
    if isinstance(d, dict):
        msg = d.get("message", "")
        return {"error": msg.split("ERROR:", 1)[-1].split("\n")[0].strip().split(": ", 1)[-1]}
    return d

ADM = ("begin; select set_config('request.jwt.claims', '{\"sub\":\"00000000-0000-0000-0000-0000000000a1\",\"role\":\"authenticated\"}', true);"
       " set local role authenticated;")
def adm(expr):
    d = sql(f"{ADM} select ({expr})::text as v; commit;")
    return d["error"] if "error" in d else d[0]["v"]

def http(method, path, body=None, ctype="application/json"):
    data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
    req = urllib.request.Request(U + path, data=data, method=method,
                                 headers={"apikey": K, "Authorization": "Bearer " + K, "Content-Type": ctype})
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        b = e.read()
        try: return e.code, json.loads(b)
        except Exception: return e.code, b.decode(errors="ignore")

def rpc(name, args):
    st, d = http("POST", f"/rest/v1/rpc/{name}", args)
    return d.get("message") if st >= 400 and isinstance(d, dict) else d

def upload(path):
    return http("POST", f"/storage/v1/object/reference-images/{path}", b"\xff\xd8\xff\xe0test", "image/jpeg")[0]

def ok(name, got, want):
    res.append(got == want); print(("✓ " if got == want else "✗ ") + name + ("" if got == want else f"  期望[{want}] 实得[{got}]"))

def pay(x, campaign=True):
    p = {"size": "4fen", "makeup": "free", "xianyu_id": x, "contact1": "13900000000", "receiver_name": "x"}
    if campaign: p["campaign_id"] = TAG
    return p

def tok(): return secrets.token_urlsafe(32)

sql("insert into auth.users (id, email, aud, role) values ('00000000-0000-0000-0000-0000000000a1','admin-test@example.com','authenticated','authenticated') on conflict do nothing;"
    " insert into public.admins values ('00000000-0000-0000-0000-0000000000a1') on conflict do nothing;"
    " insert into public.admins select id from auth.users where email='luxun-admin-test@example.com' on conflict do nothing;"
    " update public.settings set premium_3x_open = true where id = 1;")
sql(f"insert into public.campaigns (id, open_at, window_seconds, quotas) values ('{TAG}', clock_timestamp(), 20,"
    " '{\"普\":{\"speed\":2,\"pick\":1,\"lottery\":1},\"钞\":{\"speed\":1,\"pick\":0,\"lottery\":1}}');")
t0 = time.time()
T = {i: tok() for i in range(1, 7)}; RQ = {i: str(uuid.uuid4()) for i in range(1, 7)}
for i in range(1, 7):
    ok(f"投递{i}", rpc("submit_entry", {"p_request_id": RQ[i], "p_token": T[i], "p_pool": "普", "p_payload": pay(f"{TAG}_{i}")}).get("status"), "received")
ok("重放", rpc("submit_entry", {"p_request_id": RQ[1], "p_token": T[1], "p_pool": "普", "p_payload": pay(f"{TAG}_1")}).get("replay"), True)
ok("同请求换内容", rpc("submit_entry", {"p_request_id": RQ[1], "p_token": T[1], "p_pool": "普", "p_payload": pay(f"{TAG}_X")}), "conflict")
ok("凭据格式不对", rpc("submit_entry", {"p_request_id": str(uuid.uuid4()), "p_token": "short", "p_pool": "普", "p_payload": pay("a")}), "invalid_token")
ok("窗口内确认", adm(f"public.confirm_win('{TAG}','普',array[(select id from public.entries where xianyu_id='{TAG}_1')],'speed')"), "not_closed")
ok("开放后改批次", adm(f"public.upsert_campaign('{TAG}', now(), 5, '{{\"普\":{{\"speed\":1,\"pick\":0,\"lottery\":1}},\"钞\":{{\"speed\":1,\"pick\":0,\"lottery\":1}}}}')"), "campaign_started")
slot6 = rpc("request_upload", {"p_token": T[6]})["slots"][0]     # 中签前领票
while time.time() - t0 < 22: time.sleep(0.5)
ok("关窗后投递", rpc("submit_entry", {"p_request_id": str(uuid.uuid4()), "p_token": tok(), "p_pool": "普", "p_payload": pay(f"{TAG}_late")}), "closed")
TOP = f"(select array_agg(id order by received_at, seq) from (select id, received_at, seq from public.entries where campaign_id='{TAG}' order by received_at, seq limit 2) z)"
ok("手速前2", adm(f"jsonb_array_length(public.confirm_win('{TAG}','普',{TOP},'speed'))"), "2")
ok("确认后已封批", adm(f"(select sealed_at is not null from public.campaigns where id='{TAG}')"), "true")
ok("手速第3人", adm(f"public.confirm_win('{TAG}','普',array[(select id from public.entries where xianyu_id='{TAG}_3')],'speed')"), "quota_exceeded")
ok("选抽5号", adm(f"jsonb_array_length(public.confirm_win('{TAG}','普',array[(select id from public.entries where xianyu_id='{TAG}_5')],'pick'))"), "1")
ok("锁池人数", adm(f"public.lock_pool('{TAG}','普')->>'m'"), "3")
ok("开奖名额", adm(f"public.draw('{TAG}','普','00001')->>'n'"), "1")
st6 = sql(f"select status from public.entries where xianyu_id='{TAG}_6'", write=False)[0]["status"]
if st6 == "not_selected": ok("落选后旧票上传", upload(slot6), 400)
else: ok("中签后用旧票补图", upload(slot6), 200)
# 三倍钞：先通过后补图，正式订单要同步到图
ta = tok(); rpc("submit_entry", {"p_request_id": str(uuid.uuid4()), "p_token": ta, "p_pool": "三倍钞", "p_payload": pay(f"{TAG}_tA", False)})
oa = adm(f"public.approve_triple((select id from public.entries where xianyu_id='{TAG}_tA'))->>'order_id'")
sa = rpc("request_upload", {"p_token": ta})["slots"][0]
ok("通过后补图上传", upload(sa), 200)
ok("通过后绑定", rpc("attach_images", {"p_token": ta, "p_paths": [sa]}).get("ok"), True)
ok("正式订单同步到图", sql(f"select coalesce(array_length(reference_images,1),0)::text n from public.orders where order_id='{oa}'", write=False)[0]["n"], "1")
# 三倍钞：领票后被拒，旧票失效
tb = tok(); rpc("submit_entry", {"p_request_id": str(uuid.uuid4()), "p_token": tb, "p_pool": "三倍钞", "p_payload": pay(f"{TAG}_tB", False)})
sb = rpc("request_upload", {"p_token": tb})["slots"][0]
adm(f"public.reject_entry((select id from public.entries where xianyu_id='{TAG}_tB'),'')")
ok("拒绝后旧票上传", upload(sb), 400)
ok("匿名读 orders", http("GET", "/rest/v1/orders?select=order_id&limit=1")[0], 401)
print(f"== {TAG} 通过 {sum(res)} 项，失败 {len(res) - sum(res)} 项")
