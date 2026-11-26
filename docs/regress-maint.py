#!/usr/bin/env python3
"""维护开关（只连测试库）：维护中投递/领票/绑定/存量票直传全部拒绝；关维护恢复"""
import json, os, secrets, subprocess, time, urllib.request, uuid
REF="pvtlmabvtvyuyuycwovc"
env=dict(l.strip().split("=",1) for l in open(os.path.expanduser("~/infra/credentials/supabase-test.env")) if "=" in l and not l.startswith("#"))
U,K=env["AFAMAKEUP_TEST_URL"],env["AFAMAKEUP_TEST_ANON_KEY"]; assert REF in U
res=[]; C=f"MT{int(time.time())}"
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
def sub(x,tok,bearer=None): return http("POST","/rest/v1/rpc/submit_entry",{"p_request_id":str(uuid.uuid4()),"p_token":tok,"p_pool":"普","p_payload":{"campaign_id":C,"size":"4fen","makeup":"free","xianyu_id":x,"contact1":"13900001111","receiver_name":"x"}},bearer=bearer)[1]
st,tk=http("POST","/auth/v1/token?grant_type=password",{"email":env["AFAMAKEUP_TEST_ADMIN_EMAIL"],"password":env["AFAMAKEUP_TEST_ADMIN_PASS"]}); A=tk["access_token"]
sql(f"update public.settings set maintenance=false, premium_3x_open=true where id=1; insert into public.campaigns (id,open_at,window_seconds,quotas) values ('{C}',clock_timestamp(),300,'{{\"普\":{{\"speed\":1,\"pick\":0,\"lottery\":1}},\"钞\":{{\"speed\":1,\"pick\":0,\"lottery\":1}}}}');")
t1=secrets.token_urlsafe(32); ok("维护前投递",sub("M1",t1).get("status"),"received")
slots=http("POST","/rest/v1/rpc/request_upload",{"p_token":t1})[1]["slots"]          # 维护前先领票
sql("update public.settings set maintenance=true where id=1;")
ok("维护中匿名投递",sub("M2",secrets.token_urlsafe(32)).get("message"),"maintenance")
ok("维护中管理员身份投递",sub("M3",secrets.token_urlsafe(32),bearer=A).get("message"),"maintenance")
ok("维护中三倍钞",http("POST","/rest/v1/rpc/submit_entry",{"p_request_id":str(uuid.uuid4()),"p_token":secrets.token_urlsafe(32),"p_pool":"三倍钞","p_payload":{"size":"4fen","makeup":"free","xianyu_id":"M4","contact1":"1","receiver_name":"x"}})[1].get("message"),"maintenance")
ok("维护中领票",http("POST","/rest/v1/rpc/request_upload",{"p_token":t1})[1].get("message"),"maintenance")
ok("维护中用存量票直传 Storage(匿名)",http("POST",f"/storage/v1/object/reference-images/{slots[0]}",b"\xff\xd8\xff\xe0x","image/jpeg")[0],400)
ok("维护中用存量票直传 Storage(管理员)",http("POST",f"/storage/v1/object/reference-images/{slots[1]}",b"\xff\xd8\xff\xe0x","image/jpeg",bearer=A)[0],400)
ok("维护中绑定",http("POST","/rest/v1/rpc/attach_images",{"p_token":t1,"p_paths":[]})[1].get("message"),"maintenance")
s=http("POST","/rest/v1/rpc/campaign_status",{})[1]; ok("状态显示维护",s.get("maintenance"),True); ok("维护时三倍钞关闭",s.get("triple_open"),False)
sql("update public.settings set maintenance=false where id=1;")
ok("关维护后存量票可传",http("POST",f"/storage/v1/object/reference-images/{slots[0]}",b"\xff\xd8\xff\xe0x","image/jpeg")[0],200)
ok("关维护后投递",sub("M5",secrets.token_urlsafe(32)).get("status"),"received")
print(f"== 通过 {sum(res)} 项，失败 {len(res)-sum(res)} 项")
