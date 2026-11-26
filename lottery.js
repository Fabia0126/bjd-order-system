// 开单开奖台：只走管理员 RPC，所有页面文字用 textContent，不拼 HTML
(() => {
  const cfg = window.BJD_ADMIN_CONFIG;
  if (!cfg) { document.addEventListener('DOMContentLoaded', () => {}); document.getElementById('login').hidden = false;
    document.getElementById('loginMsg').textContent = '这个地址没有配置数据库，已停止连接'; document.getElementById('loginForm').querySelector('button').disabled = true; return; }
  const linkType = (new URLSearchParams(location.hash.slice(1))).get('type');   // 邀请/找回密码链接，客户端处理前先记下
  const sb = window.supabase.createClient(cfg.url, cfg.anonKey);
  const $ = (id) => document.getElementById(id);
  const ERR = {
    not_closed: '投递窗口还没结束', quota_exceeded: '超过这一类的名额了', not_top_n: '手速只能确认最前面的几名',
    speed_not_confirmed: '先把手速确认完，才能锁摇号池', pool_locked: '摇号池已经锁定，不能再改',
    pool_not_locked: '先锁定摇号池', invalid_number: '开奖号要正好 5 位数字', already_drawn: '这个池已经开过奖了，号码不一样',
    forbidden: '这个账号不是管理员', campaign_started: '已经有人投递，批次不能再改', invalid_state: '这张单的状态不对',
    invalid_payload: '提交的内容不对', invalid_quota: '名额格式不对', not_demo: '这不是演练批次', maintenance: '维护中，暂停收件',
  };
  const say = (el, text, ok) => { el.textContent = text || ''; el.classList.toggle('ok', !!ok); };
  const errText = (e) => { const m = (e && (e.message || e.error_description)) || String(e); return ERR[m] || m; };
  const fmt = (t) => t ? new Date(t).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + '.' + String(new Date(t).getMilliseconds()).padStart(3, '0') : '';
  const el = (tag, props = {}, ...kids) => { const n = document.createElement(tag); Object.assign(n, props); kids.forEach(k => n.append(k)); return n; };
  async function rpc(name, args) { const { data, error } = await sb.rpc(name, args); if (error) throw error; return data; }

  function ask(text) {
    return new Promise((resolve) => {
      $('confirmText').textContent = text; $('confirmBox').hidden = false;
      const done = (v) => { $('confirmBox').hidden = true; $('confirmOk').onclick = $('confirmNo').onclick = null; resolve(v); };
      $('confirmOk').onclick = () => done(true); $('confirmNo').onclick = () => done(false);
    });
  }

  let campaigns = [], cur = null, gen = 0;

  async function boot() {
    const { data: { session } } = await sb.auth.getSession();
    if (session && (linkType === 'invite' || linkType === 'recovery') && !sessionStorage.getItem('pwset')) {
      $('login').hidden = true; $('main').hidden = true; $('setpw').hidden = false; return;
    }
    if (!session) { $('login').hidden = false; $('main').hidden = true; return; }
    let admin = false; try { admin = await rpc('is_admin'); } catch (e) {}
    if (!admin) { $('login').hidden = false; $('main').hidden = true; say($('loginMsg'), '这个账号不是管理员'); await sb.auth.signOut(); return; }
    $('login').hidden = true; $('main').hidden = false; $('who').textContent = session.user.email;
    await syncClock();
    await loadCampaigns();
  }

  $('loginForm').addEventListener('submit', async (ev) => {
    ev.preventDefault(); say($('loginMsg'), '登录中…');
    const { error } = await sb.auth.signInWithPassword({ email: $('email').value.trim(), password: $('password').value });
    $('password').value = '';
    if (error) return say($('loginMsg'), '邮箱或密码不对');
    say($('loginMsg'), ''); boot();
  });
  $('setpwForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if ($('pw1').value !== $('pw2').value) return say($('setpwMsg'), '两次输入不一样');
    const { error } = await sb.auth.updateUser({ password: $('pw1').value });
    $('pw1').value = $('pw2').value = '';
    if (error) return say($('setpwMsg'), errText(error));
    try { sessionStorage.setItem('pwset', '1'); } catch (e) {}
    history.replaceState(null, '', location.pathname);
    $('setpw').hidden = true; boot();
  });
  $('otpForm').addEventListener('submit', async (ev) => {
    ev.preventDefault(); say($('otpMsg'), '验证中…');
    const email = $('otpEmail').value.trim(), token = $('otpCode').value.trim();
    let r = await sb.auth.verifyOtp({ email, token, type: 'invite' });
    if (r.error) r = await sb.auth.verifyOtp({ email, token, type: 'email' });
    $('otpCode').value = '';
    if (r.error) return say($('otpMsg'), '验证码不对或已过期');
    say($('otpMsg'), '');
    $('login').hidden = true; $('setpw').hidden = false;      // 第一次用验证码进来，先设密码
  });
  $('otpSend').onclick = async () => {
    const email = $('otpEmail').value.trim(); if (!email) return say($('otpMsg'), '先填邮箱');
    const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
    say($('otpMsg'), error ? '发送失败，稍后再试' : '验证码已发到邮箱', !error);
  };
  $('logout').onclick = async () => { $('main').hidden = true; $('pools').replaceChildren(); $('triple').replaceChildren(); try { await sb.auth.signOut(); } finally { location.reload(); } };

  async function loadCampaigns() {
    const { data, error } = await sb.from('campaigns').select('*').order('open_at', { ascending: false });
    if (error) { say($('campaignInfo'), errText(error)); return; }
    campaigns = data || [];
    const sel = $('campaignSel'); const keep = sel.value; sel.replaceChildren();
    campaigns.forEach(c => sel.append(el('option', { value: c.id, textContent: `${c.id} · ${fmt(c.open_at).slice(0, 19)}` })));
    if (keep && campaigns.some(c => c.id === keep)) sel.value = keep;
    await render();
  }
  $('campaignSel').onchange = render;
  $('reload').onclick = loadCampaigns;

  $('campaignForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const q = (s) => { const [speed, pick, lottery] = s.split('/').map(Number); return { speed, pick, lottery }; };
    const local = $('cOpen').value; // 按东八区解释
    const openAt = new Date(local + (local.length === 16 ? ':00' : '') + '+08:00').toISOString();
    try {
      await rpc('upsert_campaign', { p_id: $('cId').value.trim(), p_open_at: openAt, p_window: Number($('cWin').value),
        p_quotas: { '普': q($('qp').value), '钞': q($('qc').value) }, p_demo: $('cDemo').checked });
      $('campaignSel').value = $('cId').value.trim(); await loadCampaigns();
    } catch (e) { alertInline($('campaignInfo'), errText(e)); }
  });
  function alertInline(node, text) { node.textContent = text; }

  // 倒计时：用服务器时间校准，不信本机时钟
  let skew = 0, tick = null;
  async function syncClock() {
    try { const t0 = Date.now(); const d = await rpc('campaign_status'); const t1 = Date.now();
      skew = new Date(d.server_time).getTime() - (t0 + t1) / 2; } catch (e) {}
  }
  function startCountdown(c) {
    if (tick) clearInterval(tick);
    const el = $('countdown'); if (!c) { el.textContent = ''; return; }
    const open = new Date(c.open_at).getTime(), close = open + c.window_seconds * 1000;
    const f = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
      return (h ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(x).padStart(2, '0'); };
    const step = () => {
      const now = Date.now() + skew;
      if (now < open) { el.className = 'countdown'; el.textContent = `距开放还有 ${f(open - now)}`; }
      else if (now < close) { el.className = 'countdown live'; el.textContent = `投递中，还剩 ${f(close - now)}`; }
      else { el.className = 'countdown'; el.textContent = '投递已结束，可以开始确认手速（先点“刷新”）'; clearInterval(tick); tick = null; }
    };
    step(); tick = setInterval(step, 200);
  }

  async function render() {
    const my = ++gen;
    cur = campaigns.find(c => c.id === $('campaignSel').value) || campaigns[0] || null;
    const c = cur;
    $('pools').replaceChildren();
    startCountdown(cur);
    if (!cur) { $('campaignInfo').textContent = '还没有批次，先在下面新建一个'; await renderTriple(); return; }
    const close = new Date(new Date(cur.open_at).getTime() + cur.window_seconds * 1000);
    $('purgeDemo').hidden = !cur.demo;
    $('campaignInfo').textContent = (cur.demo ? '【演练批次，不占正式编号】' : '') + `开放 ${fmt(cur.open_at)} → 关闭 ${fmt(close)}（${cur.window_seconds} 秒）` +
      (cur.lottery_number ? ` · 开奖号 ${cur.lottery_number}` : '');
    const cards = [];
    for (const pool of ['普', '钞']) cards.push(await poolCard(c, pool));
    if (my !== gen) return;                       // 期间切了批次或又刷新过，丢掉这次结果
    $('pools').replaceChildren(...cards);
    await renderTriple();
  }

  async function poolCard(c, pool) {
    const cid = c.id, q = c.quotas[pool];
    const card = el('div', { className: 'card' });
    const msg = el('p', { className: 'msg', role: 'status' });
    let rows = [], lock = null;
    try {
      rows = await rpc('admin_pool', { p_campaign: cid, p_pool: pool });
      const { data } = await sb.from('lottery_pools').select('*').eq('campaign_id', cid).eq('pool', pool).maybeSingle();
      lock = data;
    } catch (e) { say(msg, errText(e)); }
    const speedDone = rows.filter(r => r.win_type === 'speed').length;
    const pickDone = rows.filter(r => r.win_type === 'pick').length;
    card.append(el('div', { className: 'pool-head' },
      el('h2', { textContent: `${pool}单池 · 共 ${rows.length} 人投递` }),
      el('span', { className: 'tag', textContent: `手速 ${speedDone}/${q.speed} · 选抽 ${pickDone}/${q.pick} · 摇号 ${q.lottery}` })));

    let picked = null;
    const steps = el('div', { className: 'steps' });
    const bSpeed = el('button', { type: 'button', textContent: `① 确认手速（前 ${q.speed} 名）` });
    const bPick = el('button', { type: 'button', textContent: '② 确认选抽（先在表里点一个人）', disabled: true });
    const bLock = el('button', { type: 'button', textContent: '③ 锁定摇号池' });
    bSpeed.disabled = !!lock || speedDone >= Math.min(q.speed, rows.length);
    bLock.disabled = !!lock;
    steps.append(bSpeed, bPick, bLock);
    card.append(steps, msg);

    const tbody = el('tbody');
    rows.forEach(r => {
      const tr = el('tr');
      if (r.order_id) tr.className = 'won'; else if (r.status === 'not_selected') tr.className = 'out';
      else if (r.rank <= q.speed) tr.className = 'top';
      const kind = r.win_type ? el('span', { className: 'pill ' + r.win_type, textContent: { speed: '手速', pick: '选抽', lottery: '摇中' }[r.win_type] || r.win_type })
        : r.status === 'not_selected' ? el('span', { className: 'pill out', textContent: '未中签' }) : '';
      const tg = el('button', { type: 'button', className: 'ghost', textContent: '小纸条' });
      tg.style.padding = '2px 8px';
      [r.rank, r.xianyu_id, fmt(r.received_at).slice(11), '¥' + r.price, r.lottery_pos || '', kind, r.order_id || '']
        .forEach(v => tr.append(el('td', {}, v === '' ? '' : (v instanceof Node ? v : String(v)))));
      tr.append(el('td', {}, tg));
      const noteTr = el('tr', { hidden: true }); noteTr.className = 'note-row';
      noteTr.append(el('td', { colSpan: 8 }, noteView(r)));
      tg.onclick = (ev) => { ev.stopPropagation(); noteTr.hidden = !noteTr.hidden; tg.textContent = noteTr.hidden ? '小纸条' : '收起'; };
      if (!lock && !r.win_type && r.status === 'received' && pickDone < q.pick) {
        tr.style.cursor = 'pointer';
        tr.onclick = () => { picked = r; [...tbody.children].forEach(x => x.style.outline = ''); tr.style.outline = '2px solid var(--dai)';
          bPick.disabled = false; bPick.textContent = `② 确认选抽：${r.xianyu_id}`; };
      }
      tbody.append(tr, noteTr);
    });
    const thead = el('thead', {}, el('tr', {}, ...['名次', '闲鱼 ID', '收到时间', '价格', '摇号序号', '结果', '正式编号', ''].map(h => el('th', { textContent: h }))));
    card.append(el('div', { className: 'tablewrap' }, el('table', {}, thead, tbody)));

    bSpeed.onclick = async () => {
      const top = rows.slice(0, q.speed).filter(r => !r.win_type);
      if (!(await ask(`确认 ${pool}单手速：${top.map(r => r.xianyu_id).join('、')}？确认后立刻生成正式编号。`))) return;
      try { await rpc('confirm_win', { p_campaign: cid, p_pool: pool, p_entries: top.map(r => r.entry_id), p_type: 'speed' }); await render(); }
      catch (e) { say(msg, errText(e)); }
    };
    bPick.onclick = async () => {
      if (!picked || !(await ask(`确认 ${pool}单选抽：${picked.xianyu_id}？`))) return;
      try { await rpc('confirm_win', { p_campaign: cid, p_pool: pool, p_entries: [picked.entry_id], p_type: 'pick' }); await render(); }
      catch (e) { say(msg, errText(e)); }
    };
    bLock.onclick = async () => {
      if (!(await ask(`锁定 ${pool}单摇号池？锁定后名单和顺序不能再改，选抽也不能再加。`))) return;
      try { await rpc('lock_pool', { p_campaign: cid, p_pool: pool }); await render(); }
      catch (e) { say(msg, errText(e)); }
    };

    if (lock) card.append(sheet(cid, pool, rows, lock), drawBox(cid, pool, lock));
    return card;
  }

  // 小纸条：全部用 textContent
  function noteView(r) {
    const n = r.note || {}, j = (a) => (Array.isArray(a) && a.length ? a.join('、') : '无');
    const rows = [['尺寸', n.size_label], ['妆面', n.makeup_label], ['娃社+官名+肤色', n.doll_info], ['属性', n.attribute], ['性别', n.gender],
      ['色系', n.color_scheme], ['禁忌', j(n.taboos)], ['要求', j(n.requirements)], ['加购', j(n.addons) + (n.koupei_qty ? `（口配×${n.koupei_qty}）` : '')],
      ['免费项', j(n.free_items)], ['闪粉', n.glitter], ['随箱物品', n.accessories], ['参考图', (r.images || 0) + ' 张']];
    const dl = el('dl', { className: 'note' });
    rows.forEach(([k, v]) => dl.append(el('dt', { textContent: k }), el('dd', { textContent: v == null || v === '' ? '—' : String(v) })));
    return dl;
  }

  // 公布用名单：只有序号和闲鱼 ID
  function sheet(cid, pool, rows, lock) {
    const list = rows.filter(r => r.lottery_pos).sort((a, b) => a.lottery_pos - b.lottery_pos);
    const ol = el('ol');
    list.forEach(r => ol.append(el('li', { textContent: r.xianyu_id })));
    return el('div', { className: 'sheet' },
      el('h3', { textContent: `${cid} · ${pool}单摇号池（共 ${list.length} 人）` }),
      el('div', { className: 'meta', textContent: `锁定时间 ${fmt(lock.locked_at)} · 开奖用当晚排列5 · 步长＝人数÷名额取整，起点＝开奖号÷人数的余数＋1` }),
      ol);
  }

  function drawBox(cid, pool, lock) {
    const box = el('div', { className: 'drawbox' });
    const msg = el('p', { className: 'msg', role: 'status' });
    if (lock.drawn_at) {
      const d = lock.draw_detail;
      box.append(el('p', { textContent: `已开奖：号码 ${d.number}，人数 ${d.m}，名额 ${d.n}` + (d.n ? `，步长 ${d.k}，起点 ${d.s}` : '') }),
        el('p', { textContent: '中签：' + (d.winners.map(w => `${w.pos} 号 ${w.xianyu_id}（${w.order_id}）`).join('、') || '无') }));
      return box;
    }
    const inp = el('input', { inputMode: 'numeric', maxLength: 5, placeholder: '排列5 号码 5 位', id: 'num-' + pool });
    const bPrev = el('button', { type: 'button', className: 'ghost', textContent: '④ 预览结果' });
    const bDraw = el('button', { type: 'button', textContent: '⑤ 确认开奖', disabled: true });
    const out = el('p');
    let previewed = null, seq = 0;
    inp.oninput = () => { seq++; bDraw.disabled = true; previewed = null; out.textContent = ''; };
    bPrev.onclick = async () => {
      const num = inp.value.trim(), mine = ++seq;
      bDraw.disabled = true; previewed = null; out.textContent = '计算中…';
      try {
        const d = await rpc('draw_preview', { p_campaign: cid, p_pool: pool, p_number: num });
        if (mine !== seq || inp.value.trim() !== num) return;   // 期间改过号码，作废
        previewed = num;
        out.textContent = `人数 ${d.m}，名额 ${d.n}` + (d.n ? `，步长 ${d.k}，起点 ${d.s} → 中签：` + d.winners.map(w => `${w.pos} 号 ${w.xianyu_id}`).join('、') : '');
        bDraw.disabled = false; say(msg, '');
      } catch (e) { say(msg, errText(e)); }
    };
    bDraw.onclick = async () => {
      const num = previewed;
      if (!num || inp.value.trim() !== num) return say(msg, '号码和预览的不一样，请重新预览');
      if (!(await ask(`用 ${num} 正式开奖？开了就不能换号码。`))) return;
      if (previewed !== num || inp.value.trim() !== num) return say(msg, '号码和预览的不一样，请重新预览');
      bDraw.disabled = true;
      try { await rpc('draw', { p_campaign: cid, p_pool: pool, p_number: num }); await render(); }
      catch (e) { say(msg, errText(e)); }
    };
    box.append(el('div', { className: 'row' }, el('label', { htmlFor: inp.id, textContent: '开奖号' }), inp, bPrev, bDraw), out, msg);
    return box;
  }

  async function renderTriple() {
    const wrap = $('triple'); wrap.replaceChildren();
    let rows = [];
    try { rows = await rpc('admin_triple'); } catch (e) { wrap.append(el('p', { className: 'msg', textContent: errText(e) })); return; }
    if (!rows.length) { wrap.append(el('p', { className: 'muted', textContent: '暂时没有三倍钞投递' })); return; }
    const tbody = el('tbody');
    rows.forEach(r => {
      const tr = el('tr'); const act = el('td');
      if (r.status === 'reviewing') {
        const ok = el('button', { type: 'button', textContent: '通过' });
        const no = el('button', { type: 'button', className: 'ghost', textContent: '拒绝' });
        ok.onclick = async () => { if (await ask(`通过 ${r.xianyu_id} 的三倍钞？`)) { try { await rpc('approve_triple', { p_entry: r.entry_id }); renderTriple(); } catch (e) { act.textContent = errText(e); } } };
        no.onclick = async () => { if (await ask(`拒绝 ${r.xianyu_id}？`)) { try { await rpc('reject_entry', { p_entry: r.entry_id, p_reason: '' }); renderTriple(); } catch (e) { act.textContent = errText(e); } } };
        act.append(el('div', { className: 'row' }, ok, no));
      } else act.textContent = r.status === 'won' ? r.order_id : '已拒绝';
      [r.xianyu_id, fmt(r.received_at).slice(0, 19), '¥' + r.price].forEach(v => tr.append(el('td', { textContent: String(v) })));
      tr.append(act); tbody.append(tr);
    });
    wrap.append(el('div', { className: 'tablewrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ...['闲鱼 ID', '收到时间', '价格', '操作'].map(h => el('th', { textContent: h })))), tbody)));
  }

  $('purgeDemo').onclick = async () => {
    const cid = cur && cur.id;
    if (!cid || !cur.demo || !(await ask(`清空演练批次 ${cid}：所有投递的资料和图片都删掉？`))) return;
    try {
      const r = await rpc('purge_demo', { p_campaign: cid });
      const paths = r.delete_paths || []; let removed = 0;
      for (let i = 0; i < paths.length; i += 50) {
        const { data, error } = await sb.storage.from('reference-images').remove(paths.slice(i, i + 50));
        if (error) throw error; removed += (data || []).length;
      }
      say($('purgeMsg'), `演练批次已清空：${r.purged} 单，删图 ${removed}/${paths.length} 张`, removed === paths.length);
      render();
    } catch (e) { say($('purgeMsg'), errText(e)); }
  };
  $('purge').onclick = async () => {
    const cid = cur && cur.id;
    if (!cid || !(await ask(`清理批次 ${cid} 所有未中签的资料和图片？不可撤销。`))) return;
    try {
      const r = await rpc('purge_not_selected', { p_campaign: cid });
      const paths = r.delete_paths || [];
      let removed = 0;
      for (let i = 0; i < paths.length; i += 50) {
        const { data, error } = await sb.storage.from('reference-images').remove(paths.slice(i, i + 50));
        if (error) throw error;
        removed += (data || []).length;
      }
      if (removed < paths.length) say($('purgeMsg'), `资料已清理 ${r.purged} 人；图片应删 ${paths.length} 张，实际删掉 ${removed} 张，剩下的再点一次清理`);
      else say($('purgeMsg'), `已清理 ${r.purged} 人，删除图片 ${removed} 张`, true);
      render();
    } catch (e) { say($('purgeMsg'), errText(e)); }
  };

  boot().catch((e) => { $('main').hidden = true; $('login').hidden = false; say($('loginMsg'), '加载失败：' + errText(e) + '，请刷新'); });
})();
