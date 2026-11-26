#!/usr/bin/env python3
"""维护开关 + 零名额冒烟（只连测试库）"""
import json, os, secrets, subprocess, time, urllib.request, uuid
REF="pvtlmabvtvyuyuycwovc"
env=dict(l.strip().split("=",1) for l in open(os.path.expanduser("~/infra/credentials/supabase-test.env")) if "=" in l and not l.startswith("#"))
U,K=env["AFAMAKEUP_TEST_URL"],env["AFAMAKEUP_TEST_ANON_KEY"]; assert REF in U
res=[]; T=int(time.time())
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
def sub(cid,x,tok):
    return http("POST","/rest/v1/rpc/submit_entry",{"p_request_id":str(uuid.uuid4()),"p_token":tok,"p_pool":"普","p_payload":{"campaign_id":cid,"size":"4fen","makeup":"free","xianyu_id":x,"contact1":"13900001111","receiver_name":"x"}})[1]
st,tk=http("POST","/auth/v1/token?grant_type=password",{"email":env["AFAMAKEUP_TEST_ADMIN_EMAIL"],"password":env["AFAMAKEUP_TEST_ADMIN_PASS"]}); A=tk["access_token"]
def arpc(n,a): return http("POST",f"/rest/v1/rpc/{n}",a,bearer=A)[1]
N,S=f"MN{T}",f"SMOKE{T}"
sql(f"insert into public.campaigns (id,open_at,window_seconds,quotas) values ('{N}',clock_timestamp(),300,'{{\"普\":{{\"speed\":1,\"pick\":0,\"lottery\":1}},\"钞\":{{\"speed\":1,\"pick\":0,\"lottery\":1}}}}'),"
    f" ('{S}',clock_timestamp(),15,'{{\"普\":{{\"speed\":0,\"pick\":0,\"lottery\":0}},\"钞\":{{\"speed\":0,\"pick\":0,\"lottery\":0}}}}'); update public.settings set maintenance=true where id=1;")
t0=time.time()
ok("维护中普通投递",sub(N,"M1",secrets.token_urlsafe(32)).get("message"),"maintenance")
ok("维护中三倍钞",http("POST","/rest/v1/rpc/submit_entry",{"p_request_id":str(uuid.uuid4()),"p_token":secrets.token_urlsafe(32),"p_pool":"三倍钞","p_payload":{"size":"4fen","makeup":"free","xianyu_id":"M3","contact1":"1","receiver_name":"x"}})[1].get("message"),"maintenance")
ok("公开状态显示维护",http("POST","/rest/v1/rpc/campaign_status",{})[1].get("maintenance"),True)
ok("公开状态不暴露SMOKE",(http("POST","/rest/v1/rpc/campaign_status",{})[1].get("campaign") or {}).get("id","").startswith("SMOKE"),False)
st_tok=secrets.token_urlsafe(32)
ok("维护中SMOKE投递",sub(S,"SMOKE_TEST",st_tok).get("status"),"received")
slots=http("POST","/rest/v1/rpc/request_upload",{"p_token":st_tok})[1]["slots"]
ok("SMOKE补图",http("POST",f"/storage/v1/object/reference-images/{slots[0]}",b"\xff\xd8\xff\xe0x","image/jpeg")[0],200)
ok("SMOKE绑定",http("POST","/rest/v1/rpc/attach_images",{"p_token":st_tok,"p_paths":[slots[0]]})[1].get("ok"),True)
ok("SMOKE查单",http("POST","/rest/v1/rpc/lookup_entry",{"p_token":st_tok})[1].get("status"),"received")
while time.time()-t0<16: time.sleep(0.5)
ok("零名额锁池",arpc("lock_pool",{"p_campaign":S,"p_pool":"普"}).get("m"),1)
ok("零名额开奖不发号",arpc("draw",{"p_campaign":S,"p_pool":"普","p_number":"12345"}).get("n"),0)
r=arpc("purge_not_selected",{"p_campaign":S}); ok("SMOKE清理",r.get("purged"),1)
st,d=http("DELETE","/storage/v1/object/reference-images",{"prefixes":r["delete_paths"]},bearer=A); ok("SMOKE图删除",len(d) if isinstance(d,list) else d,1)
ok("SMOKE无正式号",sql(f"select count(order_id)::int n from public.entries where campaign_id='{S}'")[0]["n"],0)
sql("update public.settings set maintenance=false where id=1;")
ok("关维护后普通投递",sub(N,"M2",secrets.token_urlsafe(32)).get("status"),"received")
print(f"== 通过 {sum(res)} 项，失败 {len(res)-sum(res)} 项")
