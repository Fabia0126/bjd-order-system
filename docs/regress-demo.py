#!/usr/bin/env python3
"""演练批次（只连测试库）：中签发 DEMO 号不进 orders、编号线不动、一键清空"""
import json, os, secrets, subprocess, time, urllib.request, uuid
REF="pvtlmabvtvyuyuycwovc"
env=dict(l.strip().split("=",1) for l in open(os.path.expanduser("~/infra/credentials/supabase-test.env")) if "=" in l and not l.startswith("#"))
U,K=env["AFAMAKEUP_TEST_URL"],env["AFAMAKEUP_TEST_ANON_KEY"]; assert REF in U
res=[]; C=f"DEMO{int(time.time())}"
def sql(q): return json.loads(subprocess.run([os.path.expanduser("~/infra/scripts/sbq"),REF,"-","--write"],input=q,capture_output=True,text=True).stdout)
def http(m,p,b=None,ct="application/json",bearer=None):
    d=b if isinstance(b,(bytes,type(None))) else json.dumps(b).encode()
    r=urllib.request.Request(U+p,data=d,method=m,headers={"apikey":K,"Authorization":"Bearer "+(bearer or K),"Content-Type":ct})
    try:
        with urllib.request.urlopen(r) as x: return x.status,json.loads(x.read() or b"null")
    except urllib.error.HTTPError as e:
        b=e.read()
        try: return e.code,json.loads(b)
        except Exception: return e.code,b.decode(errors="ignore")
def ok(n,g,w): res.append(g==w); print(("✓ " if g==w else "✗ ")+n+("" if g==w else f" 期望[{w}] 实得[{g}]"))
st,tk=http("POST","/auth/v1/token?grant_type=password",{"email":env["AFAMAKEUP_TEST_ADMIN_EMAIL"],"password":env["AFAMAKEUP_TEST_ADMIN_PASS"]}); A=tk["access_token"]
def arpc(n,a): return http("POST",f"/rest/v1/rpc/{n}",a,bearer=A)[1]
sql("update public.settings set maintenance=false where id=1;")
maxid0=sql("select max(order_id) m from public.orders")[0]["m"]; n0=sql("select count(*)::int n from public.orders")[0]["n"]
from datetime import datetime, timezone, timedelta
arpc("upsert_campaign",{"p_id":C,"p_open_at":(datetime.now(timezone.utc)+timedelta(seconds=3)).isoformat(),"p_window":12,"p_quotas":{"普":{"speed":1,"pick":1,"lottery":1},"钞":{"speed":1,"pick":0,"lottery":1}}})
ok("标记演练",arpc("set_campaign_demo",{"p_id":C,"p_demo":True}).get("demo"),True)
time.sleep(4); toks=[]
for i in range(4):
    t=secrets.token_urlsafe(32); toks.append(t)
    http("POST","/rest/v1/rpc/submit_entry",{"p_request_id":str(uuid.uuid4()),"p_token":t,"p_pool":"普","p_payload":{"campaign_id":C,"size":"4fen","makeup":"free","xianyu_id":f"{C}_{i}","contact1":"13900002222","receiver_name":"x"}})
sl=http("POST","/rest/v1/rpc/request_upload",{"p_token":toks[0]})[1]["slots"]; http("POST",f"/storage/v1/object/reference-images/{sl[0]}",b"\xff\xd8\xff\xe0x","image/jpeg")
http("POST","/rest/v1/rpc/attach_images",{"p_token":toks[0],"p_paths":[sl[0]]})
ok("演练开始后不能改标记",arpc("set_campaign_demo",{"p_id":C,"p_demo":False}).get("message"),"campaign_started")
time.sleep(13)
pool=arpc("admin_pool",{"p_campaign":C,"p_pool":"普"})
w=arpc("confirm_win",{"p_campaign":C,"p_pool":"普","p_entries":[pool[0]["entry_id"]],"p_type":"speed"})
ok("演练手速发 DEMO 号",w[0]["order_id"].startswith("DEMO-"),True)
arpc("confirm_win",{"p_campaign":C,"p_pool":"普","p_entries":[pool[2]["entry_id"]],"p_type":"pick"})
arpc("lock_pool",{"p_campaign":C,"p_pool":"普"}); d=arpc("draw",{"p_campaign":C,"p_pool":"普","p_number":"38627"})
ok("演练开奖 DEMO 号",d["winners"][0]["order_id"].startswith("DEMO-"),True)
ok("正式订单数没变",sql("select count(*)::int n from public.orders")[0]["n"],n0)
ok("正式最大编号没变",sql("select max(order_id) m from public.orders")[0]["m"],maxid0)
ok("查单看到 DEMO 号",http("POST","/rest/v1/rpc/lookup_entry",{"p_token":toks[0]})[1].get("order_id","").startswith("DEMO-"),True)
r=arpc("purge_demo",{"p_campaign":C}); ok("清空人数",r["purged"],4); ok("待删图",len(r["delete_paths"]),1)
st,dd=http("DELETE","/storage/v1/object/reference-images",{"prefixes":r["delete_paths"]},bearer=A); ok("图删除",len(dd) if isinstance(dd,list) else dd,1)
ok("资料全清",sql(f"select count(*)::int n from public.entries where campaign_id='{C}' and payload <> '{{}}'::jsonb")[0]["n"],0)
ok("非演练批次不能 purge_demo",arpc("purge_demo",{"p_campaign":"1126c"}).get("message"),"not_demo")
print(f"== 通过 {sum(res)} 项，失败 {len(res)-sum(res)} 项")
