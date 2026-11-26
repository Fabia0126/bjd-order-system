#!/usr/bin/env python3
"""带图清理回归（只连测试库）：落选者上传图片 → 开奖 → 管理员 purge → Storage 真删 → 核对"""
import json, os, secrets, subprocess, time, urllib.request, uuid

REF = "pvtlmabvtvyuyuycwovc"
env = dict(l.strip().split("=", 1) for l in open(os.path.expanduser("~/infra/credentials/supabase-test.env")) if "=" in l and not l.startswith("#"))
U, K = env["AFAMAKEUP_TEST_URL"], env["AFAMAKEUP_TEST_ANON_KEY"]
assert REF in U
TAG = "PG%d" % time.time(); res = []

def sql(q):
    return json.loads(subprocess.run([os.path.expanduser("~/infra/scripts/sbq"), REF, "-", "--write"], input=q, capture_output=True, text=True).stdout)

def http(method, path, body=None, ctype="application/json", bearer=None):
    data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
    req = urllib.request.Request(U + path, data=data, method=method,
        headers={"apikey": K, "Authorization": "Bearer " + (bearer or K), "Content-Type": ctype})
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        b = e.read()
        try: return e.code, json.loads(b)
        except Exception: return e.code, b.decode(errors="ignore")

def ok(name, got, want):
    res.append(got == want); print(("✓ " if got == want else "✗ ") + name + ("" if got == want else f"  期望[{want}] 实得[{got}]"))

# 管理员真实登录
st, tok_resp = http("POST", "/auth/v1/token?grant_type=password", {"email": env["AFAMAKEUP_TEST_ADMIN_EMAIL"], "password": env["AFAMAKEUP_TEST_ADMIN_PASS"]})
ADM = tok_resp["access_token"]
def arpc(name, args): return http("POST", f"/rest/v1/rpc/{name}", args, bearer=ADM)[1]

sql(f"insert into public.campaigns (id, open_at, window_seconds, quotas) values ('{TAG}', clock_timestamp(), 12,"
    " '{\"普\":{\"speed\":1,\"pick\":0,\"lottery\":0},\"钞\":{\"speed\":1,\"pick\":0,\"lottery\":0}}');")
t0 = time.time(); T = {}
for i in (1, 2, 3):
    T[i] = secrets.token_urlsafe(32)
    st, d = http("POST", "/rest/v1/rpc/submit_entry", {"p_request_id": str(uuid.uuid4()), "p_token": T[i], "p_pool": "普",
        "p_payload": {"campaign_id": TAG, "size": "4fen", "makeup": "free", "xianyu_id": f"{TAG}_{i}", "contact1": "13900001234", "receiver_name": "x", "doll_info": "secret"}})
# 2、3 号各传 2 张图并绑定
paths = {}
for i in (2, 3):
    slots = http("POST", "/rest/v1/rpc/request_upload", {"p_token": T[i]})[1]["slots"]
    for s in slots[:2]:
        http("POST", f"/storage/v1/object/reference-images/{s}", b"\xff\xd8\xff\xe0img", "image/jpeg")
    http("POST", "/rest/v1/rpc/attach_images", {"p_token": T[i], "p_paths": slots[:2]}); paths[i] = slots[:2]
while time.time() - t0 < 13: time.sleep(0.5)
first = arpc("admin_pool", {"p_campaign": TAG, "p_pool": "普"})[0]["entry_id"]
arpc("confirm_win", {"p_campaign": TAG, "p_pool": "普", "p_entries": [first], "p_type": "speed"})
ok("锁池2人", arpc("lock_pool", {"p_campaign": TAG, "p_pool": "普"})["m"], 2)
ok("零名额开奖", arpc("draw", {"p_campaign": TAG, "p_pool": "普", "p_number": "12345"})["n"], 0)
r = arpc("purge_not_selected", {"p_campaign": TAG})
ok("清理人数", r["purged"], 2)
ok("待删图片数", len(r["delete_paths"]), 4)
st, d = http("DELETE", "/storage/v1/object/reference-images", {"prefixes": r["delete_paths"]}, bearer=ADM)
ok("Storage 实际删除数", len(d) if isinstance(d, list) else d, 4)
left = sql(f"select count(*)::int n from storage.objects where bucket_id='reference-images' and name like 'entries/%' and name in ({','.join(repr(p) for p in r['delete_paths'])})")[0]["n"]
ok("对象已不存在", left, 0)
row = sql(f"select payload::text p, cardinality(images) im, contact_last4 l4, xianyu_id x from public.entries where xianyu_id='{TAG}_2'")[0]
ok("资料清空", row["p"], "{}"); ok("图片清单清空", row["im"], 0); ok("只留后四位", row["l4"], "1234"); ok("只留闲鱼ID", row["x"], f"{TAG}_2")
ok("清理后再领票", http("POST", "/rest/v1/rpc/request_upload", {"p_token": T[2]})[1].get("message"), "closed")
ok("清理后查单不给资料", http("POST", "/rest/v1/rpc/lookup_entry", {"p_token": T[2]})[1].get("payload"), None)
ok("中签者资料还在", sql(f"select (payload <> '{{}}'::jsonb) v from public.entries where id='{first}'")[0]["v"], True)
ok("非管理员调 purge", http("POST", "/rest/v1/rpc/purge_not_selected", {"p_campaign": TAG})[1].get("message"), "permission denied for function purge_not_selected")
print(f"== {TAG} 通过 {sum(res)} 项，失败 {len(res) - sum(res)} 项")
