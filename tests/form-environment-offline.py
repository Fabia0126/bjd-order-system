"""Synthetic HTTP/IP and HTTPS controls. All requests intercepted."""
import ast
import asyncio
import json
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright

ROOT=Path(__file__).resolve().parent.parent
syntax=ast.parse((ROOT/'tests/browser-offline.py').read_text())
INIT=next(ast.literal_eval(node.value) for node in syntax.body if isinstance(node,ast.Assign)
          and any(isinstance(t,ast.Name) and t.id=='INIT' for t in node.targets))

async def main():
    result={}
    async with async_playwright() as p:
        browser=await p.chromium.launch(headless=True)
        for scheme in ('http','https'):
            context=await browser.new_context(viewport={'width':390,'height':844},is_mobile=True)
            await context.add_init_script(INIT)
            async def handle(route):
                parsed=urlparse(route.request.url)
                target=(ROOT/parsed.path.lstrip('/')).resolve()
                if parsed.hostname=='192.0.2.10' and target.is_relative_to(ROOT) and target.is_file():
                    if target.name.startswith('supabase-js-'):
                        return await route.fulfill(content_type='application/javascript',body='window.supabase={createClient:()=>window.__fixtureClient};')
                    return await route.fulfill(path=str(target))
                return await route.fulfill(status=404,body='offline')
            await context.route('**/*',handle)
            page=await context.new_page()
            alerts=[]
            async def dialog(d):
                alerts.append(d.message)
                await d.dismiss()
            page.on('dialog',dialog)
            await page.goto(scheme+'://192.0.2.10/form.html')
            await page.wait_for_function('bjdForm.status !== null')
            caps=await page.evaluate('({secure:isSecureContext,sha:!!crypto.subtle})')
            await page.evaluate("""bjdForm.submit({pool:'普',payload:{campaign_id:'fixture',size:'3fen',makeup:'free',
                xianyu_id:'虚构',receiver_name:'虚构',contact1:'fictional'}})""")
            result[scheme]={**caps,'submission_calls':await page.evaluate('window.__calls.filter(x=>x.name==="submit_entry").length'),
                'pending_exists':await page.evaluate('!!bjdSite.rpc.pending()'),'alerts':alerts}
            if scheme=='http':
                assert not caps['secure'] and not caps['sha']
                assert result[scheme]['submission_calls']==0 and not result[scheme]['pending_exists']
                assert len(alerts)==1 and 'HTTPS' in alerts[0] and '尚未发送' in alerts[0]
                assert await page.locator('#submitBtn').is_disabled()
            else:
                assert caps['secure'] and caps['sha'] and result[scheme]['submission_calls']==1 and not alerts
                for phase,begin,end,words in [('before',5000,10000,'距离开放'),('during',-1000,5000,'正在收件'),('after',-10000,-1000,'收件已结束')]:
                    await page.evaluate('''([begin,end])=>{
                      const now=Date.now();bjdForm.serverBase=now;bjdForm.clockBase=performance.now();
                      bjdForm.status.campaign={id:'fixture',open_at:new Date(now+begin).toISOString(),close_at:new Date(now+end).toISOString()};
                      bjdForm.updateAvailability();
                    }''',[begin,end])
                    await page.locator('#submitBtn').scroll_into_view_if_needed()
                    bar=page.locator('#countdownDisplay')
                    assert await bar.is_visible() and words in await bar.inner_text()
                    box=await bar.bounding_box()
                    assert box['y']>=0 and box['y']+box['height']<=844
                result[scheme]['bottom_countdown_before_during_after']=True
                await page.evaluate('bjdForm.status.maintenance=true;document.getElementById("agreeNotice").checked=true;bjdForm.updateAvailability()')
                assert await page.locator('#submitBtn').is_disabled()
                assert '维护' in await page.locator('#normalStatus').inner_text()
                await page.evaluate('bjdForm.status.maintenance=false;bjdForm.updateAvailability()')
                result[scheme]['maintenance_blocks_submission_and_preserves_status']=True
                await page.goto(scheme+'://192.0.2.10/form-3x.html')
                await page.wait_for_function('bjdForm.status !== null')
                assert not await page.locator('#countdownDisplay').is_visible()
                result[scheme]['triple_has_no_lottery_countdown']=True
            await context.close()
        await browser.close()
    print(json.dumps({'synthetic_only':True,'real_network_requests':0,'observations':result},ensure_ascii=False))

asyncio.run(main())
