import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { configFromEnv, createApplication } from '../src/server.js';

const config = { adminPassword: 'test-password-only', dataFile: ':memory:' };
async function fixture(t, overrides = {}) {
  const app = createApplication({ ...config, ...overrides });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (path, { body, ...init } = {}) => fetch(base + path, {
    ...init,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { app, base, request };
}

test('无需登录或鉴权头即可登记、并发领取及回报打卡', async (t) => {
  const { request } = await fixture(t);
  assert.equal((await request('/api/state')).status, 200);
  const emptyPoll = await request('/api/device/poll', { method: 'POST' });
  assert.equal(emptyPoll.status, 200);
  assert.deepEqual(await emptyPoll.json(), { shouldRun: false });
  const added = await request('/api/trigger', { method: 'POST' });
  assert.equal(added.status, 202);
  assert.equal((await added.json()).job.delaySeconds, 0);
  const browserPoll = await request('/api/device/poll');
  assert.equal(browserPoll.status, 405);
  assert.equal(browserPoll.headers.get('allow'), 'POST');
  assert.match((await browserPoll.json()).error, /POST/);
  assert.equal((await (await request('/api/state')).json()).jobs[0].status, 'pending');
  assert.equal((await request('/api/device/ack')).status, 405);
  assert.equal((await request('/api/device/missing')).status, 404);
  const poll = () => request('/api/device/poll', { method: 'POST' });
  const responses = await Promise.all([poll(), poll(), poll(), poll()]);
  const claims = await Promise.all(responses.map((response) => response.json()));
  assert.equal(claims.filter((claim) => claim.shouldRun).length, 1);
  const claim = claims.find((item) => item.shouldRun);
  assert.equal(claim.delaySeconds, 0);
  assert.equal((await request('/api/device/ack', { method: 'POST', body: { ...claim, ackToken: 'f'.repeat(64) } })).status, 403);
  assert.equal((await request('/api/device/ack', { method: 'POST', body: claim })).status, 200);
  const stateResponse = await request('/api/state');
  assert.equal(stateResponse.headers.get('cache-control'), 'no-store');
  const state = await stateResponse.json();
  assert.equal(state.jobs[0].status, 'completed');
  assert.ok(state.lastPollAt);
  assert.equal(JSON.stringify(state).includes(claim.ackToken), false);
});

test('再次打卡终止旧回报，并发登记只保留一个新待办且只下发一次', async (t) => {
  const { request } = await fixture(t);
  assert.equal((await request('/api/trigger', { method: 'POST' })).status, 202);
  const oldClaim = await (await request('/api/device/poll', { method: 'POST' })).json();
  assert.equal(oldClaim.shouldRun, true);
  const triggers = await Promise.all(Array.from({ length: 4 }, () => request('/api/trigger', { method: 'POST' })));
  assert.deepEqual(triggers.map((response) => response.status).sort(), [202, 409, 409, 409]);
  const { job } = await triggers.find((response) => response.status === 202).json();
  assert.equal(job.status, 'pending');
  let state = await (await request('/api/state')).json();
  assert.equal(state.jobs.find((item) => item.id === oldClaim.jobId).status, 'failed');
  assert.equal(state.jobs.filter((item) => item.status === 'pending').length, 1);
  assert.equal((await request('/api/device/ack', { method: 'POST', body: oldClaim })).status, 409);
  const polls = await Promise.all(Array.from({ length: 4 }, () => request('/api/device/poll', { method: 'POST' })));
  const claims = await Promise.all(polls.map((response) => response.json()));
  assert.equal(claims.filter((claim) => claim.shouldRun).length, 1);
  const claim = claims.find((item) => item.shouldRun);
  assert.equal(claim.jobId, job.id);
  assert.equal((await request('/api/device/ack', { method: 'POST', body: oldClaim })).status, 409);
  assert.equal((await request('/api/device/ack', { method: 'POST', body: claim })).status, 200);
  state = await (await request('/api/state')).json();
  assert.equal(state.jobs.find((item) => item.id === oldClaim.jobId).status, 'failed');
  assert.equal(state.jobs.find((item) => item.id === job.id).status, 'completed');
});

test('回报最长等待领取后60秒，读取状态或回报时立即判定超时', async (t) => {
  for (const delaySeconds of [0, 3600]) {
    for (const expireThrough of ['state', 'ack']) {
      await t.test(`delaySeconds=${delaySeconds}, ${expireThrough}`, async (t) => {
        const { app, request } = await fixture(t);
        const deliveredAt = Date.parse('2026-10-16T01:00:00Z');
        let now = deliveredAt;
        app.scheduler.clock = () => new Date(now);
        assert.equal((await request('/api/trigger', { method: 'POST', body: { delaySeconds } })).status, 202);
        const claim = await (await request('/api/device/poll', { method: 'POST' })).json();
        assert.equal(claim.shouldRun, true);
        assert.equal(claim.delaySeconds, delaySeconds);
        now = deliveredAt + 59999;
        assert.equal((await (await request('/api/state')).json()).jobs[0].status, 'delivered');
        now = deliveredAt + 60000;
        if (expireThrough === 'state') {
          assert.equal((await (await request('/api/state')).json()).jobs[0].status, 'failed');
        }
        assert.equal((await request('/api/device/ack', { method: 'POST', body: claim })).status, 409);
        const state = await (await request('/api/state')).json();
        assert.equal(state.jobs[0].status, 'failed');
      });
    }
  }
});

test('手动指令接口校验并返回延时，设备领取及状态接口保留同一延时', async (t) => {
  const { request } = await fixture(t);
  for (const delaySeconds of [-1, 3601, 0.5, '30', null, true]) {
    assert.equal((await request('/api/trigger', { method: 'POST', body: { delaySeconds } })).status, 400);
  }
  const response = await request('/api/trigger', { method: 'POST', body: { delaySeconds: 30 } });
  assert.equal(response.status, 202);
  const { job } = await response.json();
  assert.equal(job.delaySeconds, 30);
  const claim = await (await request('/api/device/poll', { method: 'POST' })).json();
  assert.equal(claim.jobId, job.id);
  assert.equal(claim.delaySeconds, 30);
  assert.equal((await (await request('/api/state')).json()).jobs[0].delaySeconds, 30);
  assert.deepEqual(await (await request('/api/device/poll', { method: 'POST' })).json(), { shouldRun: false });
  assert.equal((await request('/api/device/ack', { method: 'POST', body: claim })).status, 200);
});

test('网页登录cookie及同源校验，登出后会话失效', async (t) => {
  const { request, base } = await fixture(t);
  assert.equal((await request('/api/session')).status, 401);
  assert.equal((await request('/api/logout', { method: 'POST', headers: { Origin: base } })).status, 401);
  assert.equal((await request('/api/login', { method: 'POST', body: { password: config.adminPassword }, headers: { Origin: 'https://evil.example' } })).status, 403);
  const login = await request('/api/login', { method: 'POST', body: { password: config.adminPassword }, headers: { Origin: base } });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly; SameSite=Strict/);
  const headers = { Cookie: cookie.split(';')[0] };
  assert.equal((await request('/api/session', { headers })).status, 200);
  assert.equal((await request('/api/logout', { method: 'POST', headers })).status, 403);
  assert.equal((await request('/api/logout', { method: 'POST', headers: { ...headers, Origin: base } })).status, 200);
  assert.equal((await request('/api/session', { headers })).status, 401);
  assert.equal((await request('/api/state', { headers })).status, 200);
});

test('计划CRUD无需鉴权，保留参数校验和静态文件路径限制', async (t) => {
  const { request } = await fixture(t);
  const body = { name: '下班', startTime: '18:00', endTime: '18:10', days: [1, 2, 3, 4, 5], enabled: true };
  const added = await request('/api/schedules', { method: 'POST', body });
  assert.equal(added.status, 201);
  const { schedule } = await added.json();
  assert.equal(schedule.useDelay, true);
  const updated = await request(`/api/schedules/${schedule.id}`, { method: 'PUT', body: { ...body, enabled: false, useDelay: false } });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).schedule.useDelay, false);
  assert.equal((await (await request('/api/state')).json()).schedules[0].useDelay, false);
  assert.equal((await request('/api/schedules', { method: 'POST', body: { ...body, useDelay: 'false' } })).status, 400);
  assert.equal((await request(`/api/schedules/${schedule.id}`, { method: 'PUT', body: { ...body, useDelay: 1 } })).status, 400);
  assert.equal((await request('/api/schedules', { method: 'POST', body: { ...body, endTime: '17:00' } })).status, 400);
  assert.equal((await request(`/api/schedules/${schedule.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await request(`/api/schedules/${schedule.id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await request('/api/schedules', { method: 'POST', body: { ...body, name: 'a'.repeat(17000) } })).status, 413);
  const page = await request('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await page.text(), /id="save-trigger-delay-button"/);
  assert.equal((await request('/.env')).status, 404);
  assert.equal((await request('/src/server.js')).status, 404);
  assert.equal((await request('/healthz')).status, 200);
});

test('保留网页登录密码要求和错误密码限流', async (t) => {
  const { request, base } = await fixture(t);
  for (let i = 0; i < 5; i++) {
    assert.equal((await request('/api/login', { method: 'POST', headers: { Origin: base }, body: { password: 'wrong' } })).status, 401);
  }
  assert.equal((await request('/api/login', { method: 'POST', headers: { Origin: base }, body: { password: 'wrong' } })).status, 429);
  assert.throws(() => createApplication({ ...config, adminPassword: '' }), /ADMIN_PASSWORD/);
  assert.throws(() => createApplication({ ...config, adminPassword: '   ' }), /ADMIN_PASSWORD/);
});

test('下载入口返回已签名快捷指令，HEAD不返回正文且不公开生成脚本', async (t) => {
  const { request } = await fixture(t);
  const source = await readFile(new URL('../shortcuts/wechat-checkin.shortcut', import.meta.url));
  assert.equal(source.subarray(0, 4).toString(), 'AEA1');
  const response = await request('/shortcuts/wechat-checkin.shortcut');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="wechat-checkin.shortcut"');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), source);
  const head = await request('/shortcuts/wechat-checkin.shortcut', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get('content-length')), source.length);
  assert.equal(await head.text(), '');
  assert.equal((await request('/shortcuts/build-wechat.mjs')).status, 404);
});

test('单字符管理密码可以启动并完成网页登录', async (t) => {
  const { request, base } = await fixture(t, { adminPassword: '1' });
  const login = await request('/api/login', { method: 'POST', body: { password: '1' }, headers: { Origin: base } });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/api/session', { headers: { Cookie: cookie } })).status, 200);
});

test('只配置管理密码即可启动，无需设备或API密钥', async (t) => {
  const settings = configFromEnv({ ADMIN_PASSWORD: config.adminPassword });
  assert.equal(settings.port, 2580);
  const app = createApplication({ ...settings, dataFile: ':memory:' });
  t.after(() => app.close());
  assert.equal(app.scheduler.getState().deviceConfigured, true);
});

test('随机等待与0秒指令完整领取回报，callbackJson在记录中返回', async (t) => {
  const { request } = await fixture(t);
  assert.equal((await request('/api/device/ack', { method: 'POST', body: { callbackJson: '未领取' } })).status, 409);
  for (const body of [{ delayMinSeconds: 8, delayMaxSeconds: 3 }, { delayMinSeconds: 3 }]) {
    assert.equal((await request('/api/trigger', { method: 'POST', body })).status, 400);
  }
  for (const body of [{ delayMinSeconds: 5, delayMaxSeconds: 10 }, { delaySeconds: 0 }]) {
    const response = await request('/api/trigger', { method: 'POST', body });
    assert.equal(response.status, 202);
    const { job } = await response.json();
    assert.ok(job.delaySeconds >= (body.delayMinSeconds ?? 0));
    assert.ok(job.delaySeconds <= (body.delayMaxSeconds ?? 0));
    const claim = await (await request('/api/device/poll', { method: 'POST' })).json();
    assert.equal(claim.delaySeconds, job.delaySeconds);
    const callbackJson = `已领取任务\n等待 ${claim.delaySeconds} 秒\n已打开 App`;
    assert.equal((await request('/api/device/ack', { method: 'POST', body: { callbackJson: false } })).status, 400);
    for (let i = 0; i < 2; i++) {
      const ack = await request('/api/device/ack', { method: 'POST', body: { callbackJson } });
      assert.equal(ack.status, 200);
      assert.deepEqual(await ack.json(), { ok: true });
    }
    const state = await (await request('/api/state')).json();
    const saved = state.jobs.find((item) => item.id === job.id);
    assert.equal(saved.callbackJson, callbackJson);
    assert.equal(saved.status, 'completed');
  }
});

test('计划统一使用外部等待设置，修改全局值更新待领取任务且旧计划区间不能覆盖', async (t) => {
  const { app, request } = await fixture(t);
  app.scheduler.clock = () => new Date('2026-10-14T00:59:00Z');
  const saveGlobal = (seconds) => request('/api/settings/trigger-delay', { method: 'PUT', body: { delayMinSeconds: seconds, delayMaxSeconds: seconds } });
  assert.equal((await saveGlobal(12)).status, 200);
  const body = { name: '随机等待', startTime: '09:00', endTime: '09:10', days: [1, 2, 3, 4, 5], enabled: true, delayMinSeconds: 100, delayMaxSeconds: 300 };
  const added = await request('/api/schedules', { method: 'POST', body });
  assert.equal(added.status, 201);
  const { schedule } = await added.json();
  assert.equal('delayMinSeconds' in schedule, false);
  assert.equal('delayMaxSeconds' in schedule, false);
  let state = await (await request('/api/state')).json();
  assert.equal(state.jobs[0].delaySeconds, 12);
  const initialJob = state.jobs[0];
  assert.equal((await saveGlobal(24)).status, 200);
  state = await (await request('/api/state')).json();
  assert.equal(state.jobs[0].delaySeconds, 24);
  assert.equal(state.jobs[0].id, initialJob.id);
  assert.equal(state.jobs[0].plannedTime, initialJob.plannedTime);
  const updated = await request(`/api/schedules/${schedule.id}`, { method: 'PUT', body: { ...body, useDelay: false } });
  assert.equal(updated.status, 200);
  state = await (await request('/api/state')).json();
  assert.equal(state.schedules[0].useDelay, false);
  assert.equal(state.jobs[0].delaySeconds, 0);
  assert.equal((await saveGlobal(36)).status, 200);
  app.scheduler.clock = () => new Date('2026-10-14T01:10:00Z');
  const claim = await (await request('/api/device/poll', { method: 'POST' })).json();
  assert.equal(claim.shouldRun, true);
  assert.equal(claim.delaySeconds, 0);
});

test('首页随机等待配置可保存并从状态接口读取', async (t) => {
  const { request } = await fixture(t);
  const initial = await (await request('/api/state')).json();
  assert.deepEqual(initial.triggerDelay, { delayMinSeconds: 0, delayMaxSeconds: 0 });
  const saved = await request('/api/settings/trigger-delay', { method: 'PUT', body: { delayMinSeconds: 12, delayMaxSeconds: 36 } });
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).triggerDelay, { delayMinSeconds: 12, delayMaxSeconds: 36 });
  const state = await (await request('/api/state')).json();
  assert.deepEqual(state.triggerDelay, { delayMinSeconds: 12, delayMaxSeconds: 36 });
  assert.equal((await request('/api/settings/trigger-delay', { method: 'PUT', body: { delayMinSeconds: 37 } })).status, 400);
});

function holidayResponse(types = {}) {
  const data = [];
  for (let day = new Date('2026-01-01T12:00:00Z'); day.getUTCFullYear() === 2026; day.setUTCDate(day.getUTCDate() + 1)) {
    const date = day.toISOString().slice(0, 10);
    data.push({ date, type: types[date] ?? ([0, 6].includes(day.getUTCDay()) ? 1 : 0) });
  }
  return { code: 0, year: '2026', count: data.length, data };
}

test('节假日HTTP接口同步整年并查询指定月，拒绝非法参数且同步失败保留数据', async (t) => {
  let offline = false;
  let calls = 0;
  const { app, request } = await fixture(t, { holidayFetch: async (url) => {
    calls++;
    assert.equal(url, 'https://holiday.ailcc.com/api/holiday/allyear/2026');
    if (offline) throw new Error('offline');
    return { ok: true, json: async () => holidayResponse({ '2026-10-01': 2, '2026-10-10': 4 }) };
  } });
  app.scheduler.clock = () => new Date('2026-10-15T00:50:00Z');
  assert.equal((await (await request('/api/holidays')).json()).syncedAt, null);
  for (const month of ['', '2026-13', '2026-1', '2026-10-01']) {
    assert.equal((await request(`/api/holidays?month=${month}`)).status, 400);
  }
  for (const year of ['2026', 26, 2026.5, null]) {
    assert.equal((await request('/api/holidays/sync', { method: 'POST', body: { year } })).status, 400);
  }
  assert.equal(calls, 0);
  const synced = await request('/api/holidays/sync', { method: 'POST' });
  assert.equal(synced.status, 200);
  assert.deepEqual(await synced.json(), { year: 2026, count: 365, syncedAt: '2026-10-15T00:50:00.000Z' });
  let calendar = await (await request('/api/holidays?month=2026-10')).json();
  assert.equal(calendar.month, '2026-10');
  assert.equal(calendar.days.length, 31);
  assert.equal(calendar.days[0].type, 2);
  assert.equal(calendar.days[9].type, 4);
  app.scheduler.clock = () => new Date('2026-10-15T00:50:23Z');
  const updated = await request('/api/holidays/sync', { method: 'POST', body: { year: 2026 } });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).syncedAt, '2026-10-15T00:50:23.000Z');
  const refreshed = await (await request('/api/holidays?month=2026-10')).json();
  assert.deepEqual(refreshed.days, calendar.days);
  assert.equal(refreshed.syncedAt, '2026-10-15T00:50:23.000Z');
  calendar = refreshed;
  offline = true;
  assert.equal((await request('/api/holidays/sync', { method: 'POST', body: { year: 2026 } })).status, 502);
  assert.deepEqual(await (await request('/api/holidays?month=2026-10')).json(), calendar);
});

test('HTTP计划开关回填：周末补班可领取、关闭延时下发0，节假日不领取', async (t) => {
  const { app, request } = await fixture(t, { holidayFetch: async () => ({ ok: true, json: async () => holidayResponse({ '2026-10-10': 4, '2026-10-12': 3 }) }) });
  app.scheduler.clock = () => new Date('2026-10-10T00:59:00Z');
  assert.equal((await request('/api/settings/trigger-delay', { method: 'PUT', body: { delayMinSeconds: 20, delayMaxSeconds: 50 } })).status, 200);
  const body = { name: '补班打卡', startTime: '09:00', endTime: '09:00', days: [1, 2, 3, 4, 5], enabled: true, holidayAware: true, useDelay: false };
  const created = await request('/api/schedules', { method: 'POST', body });
  assert.equal(created.status, 201);
  const { schedule } = await created.json();
  assert.equal(schedule.holidayAware, true);
  assert.equal(schedule.useDelay, false);
  assert.equal((await (await request('/api/state')).json()).jobs.length, 0);
  assert.equal((await request('/api/holidays/sync', { method: 'POST', body: { year: 2026 } })).status, 200);
  app.scheduler.clock = () => new Date('2026-10-10T01:00:00Z');
  const claim = await (await request('/api/device/poll', { method: 'POST' })).json();
  assert.equal(claim.shouldRun, true);
  assert.equal(claim.delaySeconds, 0);
  assert.equal((await request('/api/device/ack', { method: 'POST', body: claim })).status, 200);
  app.scheduler.clock = () => new Date('2026-10-12T01:00:00Z');
  assert.deepEqual(await (await request('/api/device/poll', { method: 'POST' })).json(), { shouldRun: false });
  const updated = await request(`/api/schedules/${schedule.id}`, { method: 'PUT', body: { ...body, holidayAware: false, useDelay: true } });
  assert.equal(updated.status, 200);
  const next = await (await request('/api/device/poll', { method: 'POST' })).json();
  assert.equal(next.shouldRun, true);
  assert.ok(next.delaySeconds >= 20 && next.delaySeconds <= 50);
});
