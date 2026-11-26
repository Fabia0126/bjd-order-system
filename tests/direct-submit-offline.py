"""Single click, optional preview, opening edge, draft and polling. No network."""
import ast
import asyncio
import json
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright

ROOT=Path(__file__).resolve().parent.parent
tree=ast.parse((ROOT/'tests/browser-offline.py').read_text())
INIT=next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign)
          and any(isinstance(t,ast.Name) and t.id=='INIT' for t in n.targets))

async def fill(page):
    for name,value in {'dollInfo':'虚构草稿','xianyuId':'虚构单主','receiverName':'虚构姓名',
                       'contact1':'fictional-one','contact2':'fictional-two'}.items():
        await page.locator('[name="'+name+'"]').fill(value)
    await page.locator('#agreeNotice').check()

async def main():
    checks=[]
    async with async_playwright() as p:
        browser=await p.chromium.launch(headless=True)
        context=await browser.new_context(viewport={'width':390,'height':844},is_mobile=True)
        await context.add_init_script(INIT)
        async def route(route):
            u=urlparse(route.request.url);file=(ROOT/u.path.lstrip('/')).resolve()
            if u.hostname=='fixture.invalid' and file.is_relative_to(ROOT) and file.is_file():
                if file.name.startswith('supabase-js-'):
                    return await route.fulfill(content_type='application/javascript',body='window.supabase={createClient:()=>window.__fixtureClient};')
                return await route.fulfill(path=str(file))
            return await route.fulfill(status=404,body='offline')
        await context.route('**/*',route)
        page=await context.new_page()
        alerts=[]
        async def dialog(d):
            alerts.append(d.message);await d.dismiss()
        page.on('dialog',dialog)
        for form in ('form.html','form-3x.html'):
            await page.goto('https://fixture.invalid/'+form)
            await page.wait_for_function('bjdForm.status !== null')
            await fill(page)
            await page.reload()
            await page.wait_for_function('bjdForm.status !== null')
            assert await page.locator('#agreeNotice').is_checked()
            assert await page.locator('[name="dollInfo"]').input_value()=='虚构草稿'
            await page.locator('#agreeNotice').uncheck()
            await page.reload();await page.wait_for_function('bjdForm.status !== null')
            assert not await page.locator('#agreeNotice').is_checked()
            await page.locator('#agreeNotice').check()
            checks.append(form+': draft and explicit checked/unchecked consent restored')
            position=await page.evaluate("document.getElementById('agreeNotice').closest('label').nextElementSibling.id")
            assert position=='previewBtn'
            await page.locator('#previewBtn').click()
            assert await page.locator('.preview-modal .btn-confirm').count()==0
            assert await page.evaluate('window.__calls.filter(x=>x.name==="submit_entry").length')==0
            await page.locator('.btn-copy').click()
            assert not alerts
            await page.evaluate('closePreview()')
            # Keep one fake upload in flight long enough to try a second submit.
            await page.evaluate('''() => {
              const rpc=__fixtureClient.rpc;
              __fixtureClient.rpc=async(name,args)=>{
                if(name==='submit_entry')await new Promise(r=>setTimeout(r,300));
                return rpc(name,args);
              };
            }''')
            assert await page.locator('#submitBtn').is_enabled()
            await page.locator('#submitBtn').click()
            assert '正在提交' in await page.locator('#submitBtn').inner_text()
            await page.evaluate('handleSubmit({preventDefault(){}})')
            await page.wait_for_function('window.__calls.filter(x=>x.name==="submit_entry").length===1 && !bjdForm.busy')
            await page.wait_for_selector('#submissionReceipt textarea[readonly]')
            assert await page.locator('.preview-modal').count()==0
            assert await page.evaluate('window.__calls.filter(x=>x.name==="submit_entry").length')==1
            checks.append(form+': preview never submits; one main click sends once without confirmation')

        await page.goto('https://fixture.invalid/form.html')
        await page.wait_for_function('bjdForm.status !== null');await fill(page)
        await page.evaluate('''() => {
          clearTimeout(bjdForm.poll);bjdForm.poll=null;bjdForm.schedulePoll=()=>{};
          const now=Date.now();bjdForm.serverBase=now;bjdForm.clockBase=performance.now();
          bjdForm.status.campaign={id:'future',open_at:new Date(now+1200).toISOString(),close_at:new Date(now+6000).toISOString()};
          bjdForm.updateAvailability();
        }''')
        await page.locator('#previewBtn').click()
        assert await page.locator('.preview-modal').is_visible()
        assert '距离开放' in await page.locator('.preview-live-status').inner_text()
        assert await page.locator('#submitBtn').is_disabled()
        await page.evaluate('handleSubmit({preventDefault(){}})')
        assert await page.evaluate('window.__calls.filter(x=>x.name==="submit_entry").length')==0
        await page.wait_for_function('!document.getElementById("submitBtn").disabled',timeout=2500)
        assert await page.locator('.preview-modal').count()==0
        assert await page.evaluate('window.__calls.filter(x=>x.name==="submit_entry").length')==0
        await page.locator('#submitBtn').click()
        await page.wait_for_function('window.__calls.filter(x=>x.name==="submit_entry").length===1 && !bjdForm.busy')
        await page.wait_for_selector('#submissionReceipt textarea[readonly]')
        checks.append('opening edge closes preview and enables direct submit locally without refreshing')

        cadence=await page.evaluate('''() => {
          const now=Date.now();bjdForm.serverBase=now;bjdForm.clockBase=performance.now();
          return [180000,60000,9000,-1000].map(delta=>{
            bjdForm.status.campaign={id:'cadence',open_at:new Date(now+delta).toISOString(),close_at:new Date(now+delta+5000).toISOString()};
            return bjdForm.pollInterval();
          });
        }''')
        assert cadence==[5000,3000,1000,1000]
        checks.append('status polling cadence: 5s / 3s / 1s / 1s')
        shared=await page.evaluate('''async() => {
          const base=__fixtureClient.rpc;let count=0,finish;
          __fixtureClient.rpc=(name,args)=>{
            if(name==='campaign_status'){count++;return new Promise(r=>finish=()=>r({data:{server_time:new Date().toISOString(),triple_open:true,campaign:null}}));}
            return base(name,args);
          };
          const a=bjdForm.refresh(),b=bjdForm.refresh(),same=a===b;finish();await a;
          __fixtureClient.rpc=base;return {same,count};
        }''')
        assert shared=={'same':True,'count':1}
        checks.append('overlapping refresh calls share one status request')
        # A changed server schedule replaces both local button state and timing.
        await page.evaluate('''async() => {
          const base=__fixtureClient.rpc;
          __fixtureClient.rpc=async(name,args)=>name==='campaign_status'?{data:{
            server_time:new Date().toISOString(),triple_open:true,maintenance:false,
            campaign:{id:'changed',open_at:new Date(Date.now()+60000).toISOString(),close_at:new Date(Date.now()+65000).toISOString()}
          }}:base(name,args);
          await bjdForm.refresh();
        }''')
        assert await page.locator('#submitBtn').is_disabled()
        assert '距离开放' in await page.locator('#countdownText').inner_text()
        checks.append('changed backend opening time updates without page reload')
        assert not alerts
        await browser.close()
    print(json.dumps({'synthetic_only':True,'real_network_requests':0,'checks':checks},ensure_ascii=False))

asyncio.run(main())
