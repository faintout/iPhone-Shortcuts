import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Scheduler } from '../src/scheduler.js';

const schedule = { name: '上班', startTime: '09:00', endTime: '09:00', days: [1, 2, 3, 4, 5], enabled: true };
function holidayYear(year = 2026, types = {}) {
  const data = [];
  for (let day = new Date(`${year}-01-01T12:00:00Z`); day.getUTCFullYear() === year; day.setUTCDate(day.getUTCDate() + 1)) {
    const date = day.toISOString().slice(0, 10);
    data.push({ date, type: [0, 6].includes(day.getUTCDay()) ? 1 : 0, ...types[date] });
  }
  return { code: 0, year: String(year), count: data.length, data };
}

function fixture(t, extra = {}) {
  let clock = new Date('2026-10-14T00:59:00Z');
  const scheduler = new Scheduler({ dataFile: ':memory:', now: () => clock, random: (min) => min, holidayFetch: async (url) => ({ ok: true, json: async () => holidayYear(Number(url.split('/').at(-1))) }), ...extra });
  t.after(() => scheduler.close());
  return { scheduler, at: (time) => { clock = new Date(time); } };
}

test('固定时间：提前不下发，当分钟只领取一次，正确回报才完成', (t) => {
  const { scheduler: s, at } = fixture(t);
  s.createSchedule(schedule);
  assert.deepEqual(s.poll(), { shouldRun: false });
  at('2026-10-14T01:00:00Z');
  const claim = s.poll();
  assert.equal(claim.shouldRun, true);
  assert.equal(claim.delaySeconds, 0);
  assert.equal(s.getState().jobs[0].status, 'delivered');
  assert.deepEqual(s.poll(), { shouldRun: false });
  assert.throws(() => s.ack({ ...claim, ackToken: 'f'.repeat(64) }), { status: 403 });
  s.ack(claim);
  assert.equal(s.getState().jobs[0].status, 'completed');
  const finishedAt = s.getState().jobs[0].finishedAt;
  at('2026-10-14T01:00:30Z');
  s.ack(claim);
  assert.equal(s.getState().jobs[0].finishedAt, finishedAt);
  assert.deepEqual(s.poll(), { shouldRun: false });
  assert.equal(JSON.stringify(s.getState()).includes(claim.ackToken), false);
  assert.equal('ackHash' in s.getState().jobs[0], false);
});

test('随机窗口包含结束分钟，只抽取一次，实际领取必须在窗口内', (t) => {
  let draws = 0;
  const { scheduler: s, at } = fixture(t, { random: (min, max) => { draws++; assert.equal(min, 540); assert.equal(max, 543); return max - 1; } });
  s.createSchedule({ ...schedule, endTime: '09:02' });
  s.planToday();
  s.getState();
  assert.equal(draws, 1);
  assert.equal(s.getState().jobs[0].plannedTime, '09:02');
  at('2026-10-14T01:01:00Z');
  assert.equal(s.poll().shouldRun, false);
  at('2026-10-14T01:02:59Z');
  assert.equal(s.poll().shouldRun, true);
});

test('查询晚于抽中时间但仍在窗口内可以领取；窗口结束后过期', (t) => {
  const { scheduler: s, at } = fixture(t);
  s.createSchedule({ ...schedule, endTime: '09:10' });
  at('2026-10-14T01:05:00Z');
  assert.equal(s.poll().shouldRun, true);
  const second = s.createSchedule({ ...schedule, name: '已错过' });
  assert.equal(s.getState().jobs.find((j) => j.scheduleId === second.id).status, 'skipped');
});

test('星期及上海跨日按服务配置时区判断', (t) => {
  const { scheduler: s, at } = fixture(t);
  s.createSchedule({ ...schedule, days: [4], startTime: '00:00', endTime: '00:00' });
  assert.equal(s.getState().jobs.length, 0);
  at('2026-10-14T16:00:00Z');
  const claim = s.poll();
  assert.equal(claim.shouldRun, true);
  assert.equal(s.getState().jobs[0].date, '2026-10-15');
});

test('立即指令防重复排队，5分钟未领取过期', (t) => {
  const { scheduler: s, at } = fixture(t);
  const job = s.trigger();
  assert.equal(job.expiresAt, '2026-10-14T01:04:00.000Z');
  assert.throws(() => s.trigger(), { status: 409 });
  at('2026-10-14T01:04:00Z');
  assert.equal(s.poll().shouldRun, false);
  assert.equal(s.getState().jobs[0].status, 'skipped');
  assert.doesNotThrow(() => s.trigger());
});

test('领取满1分钟未回报即失败，不重发也不接受迟到回报', async (t) => {
  const { scheduler: s, at } = fixture(t);
  s.trigger();
  const claim = s.poll();
  at('2026-10-14T00:59:59.999Z');
  await s.tick();
  assert.equal(s.getState().jobs[0].status, 'delivered');
  at('2026-10-14T01:00:00Z');
  await s.tick();
  const failed = s.getState().jobs[0];
  assert.equal(failed.status, 'failed');
  assert.equal(failed.finishedAt, '2026-10-14T01:00:00.000Z');
  assert.match(failed.error, /1 分钟/);
  assert.equal(s.poll().shouldRun, false);
  assert.throws(() => s.ack(claim), { status: 409 });
  assert.throws(() => s.ack({ callbackJson: '迟到回报' }), { status: 409 });
  assert.deepEqual(s.getState().jobs[0], failed);
});

test('延时保留领取时的快照，但不会延长1分钟回报期限或阻塞超时后的领取', (t) => {
  const { scheduler: s, at } = fixture(t);
  s.saveTriggerDelay({ delaySeconds: 3600 });
  const created = s.createSchedule(schedule);
  const next = s.createSchedule({ ...schedule, name: '下一次打卡', endTime: '09:10' });
  at('2026-10-14T01:00:00Z');
  const claim = s.poll();
  assert.equal(claim.delaySeconds, 3600);
  s.saveTriggerDelay({ delaySeconds: 10 });
  s.updateSchedule(created.id, { ...schedule, useDelay: false });
  assert.equal(s.getState().schedules[0].useDelay, false);
  assert.equal(s.getState().jobs.find((job) => job.id === claim.jobId).delaySeconds, 3600);
  at('2026-10-14T01:00:59.999Z');
  assert.deepEqual(s.poll(), { shouldRun: false });
  assert.equal(s.getState().jobs.find((job) => job.id === claim.jobId).status, 'delivered');
  at('2026-10-14T01:01:00Z');
  // The deadline also applies when no timer has run before the callback.
  assert.throws(() => s.ack(claim), { status: 409 });
  assert.equal(s.getState().jobs.find((job) => job.id === claim.jobId).status, 'failed');
  const nextClaim = s.poll();
  assert.equal(s.getState().jobs.find((job) => job.id === nextClaim.jobId).scheduleId, next.id);
  assert.equal(nextClaim.delaySeconds, 10);
  s.ack(nextClaim);
  assert.equal(s.getState().jobs.find((job) => job.id === nextClaim.jobId).status, 'completed');
});

test('全局等待更新未领取任务延时，重复打卡立即结束旧等待并使用新参数', (t) => {
  const { scheduler: s, at } = fixture(t);
  s.saveTriggerDelay({ delaySeconds: 60 });
  s.createSchedule(schedule);
  const original = s.getState().jobs[0];
  s.saveTriggerDelay({ delaySeconds: 90 });
  assert.equal(s.getState().jobs[0].delaySeconds, 90);
  assert.equal(s.getState().jobs[0].id, original.id);
  assert.equal(s.getState().jobs[0].plannedTime, original.plannedTime);
  const manual = s.trigger({ delaySeconds: 3600 });
  const claim = s.poll();
  assert.equal(claim.delaySeconds, 3600);
  at('2026-10-14T00:59:30Z');
  assert.throws(() => s.trigger({ delaySeconds: -1 }), { status: 400 });
  assert.equal(s.getState().jobs.find((job) => job.id === manual.id).status, 'delivered');
  const replacement = s.trigger({ delaySeconds: 0 });
  const failed = s.getState().jobs.find((job) => job.id === manual.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.finishedAt, '2026-10-14T00:59:30.000Z');
  assert.match(failed.error, /重新发起/);
  assert.throws(() => s.trigger(), { status: 409 });
  assert.throws(() => s.ack(claim), { status: 409 });
  const nextClaim = s.poll();
  assert.equal(nextClaim.jobId, replacement.id);
  assert.equal(nextClaim.delaySeconds, 0);
  assert.throws(() => s.ack(claim), { status: 409 });
  s.ack({ callbackJson: '新任务完成' });
  assert.equal(s.getState().jobs.find((job) => job.id === replacement.id).status, 'completed');
  assert.deepEqual(s.getState().jobs.find((job) => job.id === manual.id), failed);
});

test('立即打卡也会结束定时任务的回报等待，保留其他待领取计划', (t) => {
  const { scheduler: s, at } = fixture(t);
  s.createSchedule(schedule);
  const later = s.createSchedule({ ...schedule, name: '稍后', startTime: '09:05', endTime: '09:10' });
  at('2026-10-14T01:00:00Z');
  const claim = s.poll();
  at('2026-10-14T01:00:10Z');
  const replacement = s.trigger({ delaySeconds: 5 });
  const jobs = s.getState().jobs;
  assert.equal(jobs.find((job) => job.id === claim.jobId).status, 'failed');
  assert.equal(jobs.find((job) => job.scheduleId === later.id).status, 'pending');
  assert.equal(jobs.find((job) => job.id === replacement.id).status, 'pending');
  assert.equal(s.poll().jobId, replacement.id);
});

test('新打卡登记失败时回滚，旧任务仍能正常回报', (t) => {
  const { scheduler: s } = fixture(t);
  s.trigger();
  const claim = s.poll();
  s.db.exec("CREATE TEMP TRIGGER reject_job BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT, 'forced failure'); END");
  assert.throws(() => s.trigger(), /forced failure/);
  assert.equal(s.getState().jobs.length, 1);
  assert.equal(s.getState().jobs[0].status, 'delivered');
  s.ack(claim);
  assert.equal(s.getState().jobs[0].status, 'completed');
});

test('暂停和删除取消待领取计划；编辑已执行计划不会在同一天重发', (t) => {
  const { scheduler: s, at } = fixture(t);
  const created = s.createSchedule(schedule);
  s.updateSchedule(created.id, { ...schedule, enabled: false });
  assert.equal(s.getState().jobs.length, 0);
  s.updateSchedule(created.id, schedule);
  at('2026-10-14T01:00:00Z');
  const claim = s.poll();
  s.ack(claim);
  s.updateSchedule(created.id, { ...schedule, startTime: '09:10', endTime: '09:10' });
  at('2026-10-14T01:10:00Z');
  assert.equal(s.poll().shouldRun, false);
  s.deleteSchedule(created.id);
  assert.equal(s.getState().schedules.length, 0);
  assert.equal(s.getState().jobs[0].status, 'completed');
});

test('持久化：重启不重抽随机时间，已下发任务不重发，回报凭据仍有效', () => {
  const dir = mkdtempSync(join(tmpdir(), 'iphonefast-test-'));
  const dataFile = join(dir, 'state.sqlite');
  let s;
  try {
    const clock = () => new Date('2026-10-14T01:00:00Z');
    s = new Scheduler({ dataFile, now: clock, random: (min) => min });
    s.saveTriggerDelay({ delayMinSeconds: 45, delayMaxSeconds: 60 });
    s.createSchedule({ ...schedule, endTime: '09:05' });
    const planned = s.getState().jobs[0];
    s.close();
    s = new Scheduler({ dataFile, now: clock, random: () => { throw new Error('不应重抽'); } });
    assert.equal(s.getState().jobs[0].id, planned.id);
    assert.deepEqual(s.getTriggerDelay(), { delayMinSeconds: 45, delayMaxSeconds: 60 });
    assert.equal(s.getState().jobs[0].delaySeconds, 45);
    const claim = s.poll();
    assert.equal(claim.delaySeconds, 45);
    s.close();
    s = new Scheduler({ dataFile, now: clock, random: () => { throw new Error('不应重抽'); } });
    assert.equal(s.poll().shouldRun, false);
    assert.ok(s.getState().lastPollAt);
    s.ack(claim);
    assert.equal(s.getState().jobs[0].status, 'completed');
  } finally {
    s?.close();
    for (const name of readdirSync(dir)) unlinkSync(join(dir, name));
    rmdirSync(dir);
  }
});

test('首页随机等待区间保存到数据库并跨重启保留', () => {
  const dir = mkdtempSync(join(tmpdir(), 'iphonefast-trigger-delay-'));
  const dataFile = join(dir, 'state.sqlite');
  let s;
  try {
    const clock = () => new Date('2026-10-14T01:00:00Z');
    s = new Scheduler({ dataFile, now: clock });
    assert.deepEqual(s.getState().triggerDelay, { delayMinSeconds: 0, delayMaxSeconds: 0 });
    assert.deepEqual(s.saveTriggerDelay({ delayMinSeconds: 15, delayMaxSeconds: 45 }), { delayMinSeconds: 15, delayMaxSeconds: 45 });
    s.close();
    s = new Scheduler({ dataFile, now: clock });
    assert.deepEqual(s.getState().triggerDelay, { delayMinSeconds: 15, delayMaxSeconds: 45 });
    for (const body of [{ delayMinSeconds: 46, delayMaxSeconds: 15 }, { delayMinSeconds: 15 }, { delaySeconds: 3601 }]) {
      assert.throws(() => s.saveTriggerDelay(body), { status: 400 });
    }
  } finally {
    s?.close();
    for (const name of readdirSync(dir)) unlinkSync(join(dir, name));
    rmdirSync(dir);
  }
});

test('全局区间变化刷新全部未领取定时任务，重复保存不重抽，历史及手动任务保留快照', (t) => {
  const draws = [];
  const { scheduler: s, at } = fixture(t, { random: (min, max) => { draws.push([min, max]); return min; } });
  at('2026-10-13T01:00:00Z');
  s.saveTriggerDelay({ delayMinSeconds: 10, delayMaxSeconds: 20 });
  s.createSchedule({ ...schedule, endTime: '09:10' });
  const completed = s.poll();
  s.ack(completed);
  at('2026-10-14T01:00:00Z');
  const claimed = s.poll();
  const first = s.createSchedule({ ...schedule, name: '待领取一', endTime: '09:10' });
  const second = s.createSchedule({ ...schedule, name: '待领取二', endTime: '09:10' });
  const disabled = s.createSchedule({ ...schedule, name: '不等待', useDelay: false });
  const manual = s.trigger({ delaySeconds: 77 });
  const original = s.getState().jobs;
  const drawCount = draws.length;
  s.saveTriggerDelay({ delayMinSeconds: 30, delayMaxSeconds: 40 });
  const updated = s.getState().jobs;
  for (const job of original) {
    const actual = updated.find((item) => item.id === job.id);
    const refresh = [first.id, second.id].includes(job.scheduleId);
    assert.deepEqual({ ...actual }, { ...job, delaySeconds: refresh ? 30 : job.delaySeconds });
  }
  assert.equal(updated.find((job) => job.scheduleId === disabled.id).delaySeconds, 0);
  assert.equal(updated.find((job) => job.id === completed.jobId).status, 'completed');
  assert.equal(updated.find((job) => job.id === claimed.jobId).status, 'failed');
  assert.equal(updated.find((job) => job.id === manual.id).status, 'pending');
  assert.deepEqual(draws.slice(drawCount), [[30, 41], [30, 41]]);
  s.saveTriggerDelay({ delayMinSeconds: 30, delayMaxSeconds: 40 });
  s.planToday();
  assert.deepEqual(s.getState().jobs, updated);
  assert.equal(draws.length, drawCount + 2);
});

test('全局等待更新失败时保留原区间和所有任务快照', (t) => {
  const { scheduler: s } = fixture(t);
  s.saveTriggerDelay({ delaySeconds: 10 });
  s.createSchedule(schedule);
  s.createSchedule({ ...schedule, name: '阻止更新' });
  const original = s.getState().jobs;
  s.db.exec("CREATE TEMP TRIGGER reject_delay BEFORE UPDATE OF delaySeconds ON jobs WHEN NEW.scheduleName = '阻止更新' BEGIN SELECT RAISE(ABORT, 'forced failure'); END");
  assert.throws(() => s.saveTriggerDelay({ delaySeconds: 20 }), /forced failure/);
  assert.deepEqual(s.getTriggerDelay(), { delayMinSeconds: 10, delayMaxSeconds: 10 });
  assert.deepEqual(s.getState().jobs, original);
});

test('旧客户端计划等待字段被忽略，计划只使用全局区间且不再返回旧字段', (t) => {
  const { scheduler: s } = fixture(t);
  s.saveTriggerDelay({ delayMinSeconds: 15, delayMaxSeconds: 25 });
  const created = s.createSchedule({ ...schedule, delaySeconds: 90, delayMinSeconds: 100, delayMaxSeconds: 200 });
  assert.equal(s.getState().jobs[0].delaySeconds, 15);
  const updated = s.updateSchedule(created.id, { ...schedule, delaySeconds: -1, delayMinSeconds: 'invalid', delayMaxSeconds: null });
  for (const value of [created, updated, s.getState().schedules[0]]) {
    for (const field of ['delaySeconds', 'delayMinSeconds', 'delayMaxSeconds']) assert.equal(field in value, false);
  }
  assert.deepEqual(s.getTriggerDelay(), { delayMinSeconds: 15, delayMaxSeconds: 25 });
  assert.equal(s.getState().jobs[0].delaySeconds, 15);
});

test('旧数据库自动迁移延时为0，原任务可领取且再次启动不会重复迁移', () => {
  const dir = mkdtempSync(join(tmpdir(), 'iphonefast-migration-'));
  const dataFile = join(dir, 'state.sqlite');
  let s;
  const legacy = new DatabaseSync(dataFile);
  try {
    legacy.exec(`
      CREATE TABLE schedules (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, startTime TEXT NOT NULL,
        endTime TEXT NOT NULL, days TEXT NOT NULL, enabled INTEGER NOT NULL,
        createdAt TEXT NOT NULL
      );
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY, scheduleId TEXT, scheduleName TEXT NOT NULL,
        date TEXT NOT NULL, plannedTime TEXT NOT NULL, windowEnd TEXT NOT NULL,
        status TEXT NOT NULL, source TEXT NOT NULL, createdAt TEXT NOT NULL,
        deliveredAt TEXT, finishedAt TEXT, expiresAt TEXT, error TEXT, ackHash TEXT,
        UNIQUE(scheduleId, date)
      );
      INSERT INTO schedules VALUES ('legacy-schedule', '原计划', '09:00', '09:00', '[3]', 1, '2026-10-14T00:59:00.000Z');
      INSERT INTO jobs (id, scheduleId, scheduleName, date, plannedTime, windowEnd, status, source, createdAt)
        VALUES ('legacy-job', 'legacy-schedule', '原计划', '2026-10-14', '09:00', '09:00', 'pending', 'schedule', '2026-10-14T00:59:00.000Z');
    `);
  } finally {
    legacy.close();
  }
  try {
    const now = () => new Date('2026-10-14T01:00:00Z');
    s = new Scheduler({ dataFile, now });
    for (const field of ['delaySeconds', 'delayMinSeconds', 'delayMaxSeconds']) {
      assert.equal(field in s.schedules()[0], false);
      assert.equal(s.db.prepare('PRAGMA table_info(schedules)').all().some((column) => column.name === field), false);
    }
    assert.equal(s.getState().schedules[0].holidayAware, false);
    assert.equal(s.getState().schedules[0].useDelay, true);
    assert.equal(s.getState().jobs[0].delaySeconds, 0);
    assert.equal(s.getState().jobs[0].callbackJson, null);
    const claim = s.poll();
    assert.equal(claim.jobId, 'legacy-job');
    assert.equal(claim.delaySeconds, 0);
    s.ack(claim);
    const created = s.createSchedule({ ...schedule, enabled: false, delaySeconds: 25 });
    s.close();
    s = new Scheduler({ dataFile, now });
    assert.equal(s.getState().schedules.find((item) => item.id === created.id).useDelay, true);
    assert.deepEqual(s.getTriggerDelay(), { delayMinSeconds: 0, delayMaxSeconds: 0 });
    assert.equal(s.getState().jobs[0].status, 'completed');
    assert.deepEqual(s.poll(), { shouldRun: false });
  } finally {
    s?.close();
    for (const name of readdirSync(dir)) unlinkSync(join(dir, name));
    rmdirSync(dir);
  }
});

test('全局等待和手动指令仅接受0到3600的整数延时，省略延时默认0', (t) => {
  const { scheduler: s } = fixture(t);
  s.createSchedule(schedule);
  assert.equal(s.getState().jobs[0].delaySeconds, 0);
  for (const delaySeconds of [-1, 3601, 0.5, '30', null, true]) {
    assert.throws(() => s.saveTriggerDelay({ delaySeconds }), { status: 400 });
    assert.throws(() => s.trigger({ delaySeconds }), { status: 400 });
  }
  assert.equal(s.getState().schedules.length, 1);
  assert.equal(s.getState().jobs.length, 1);
  assert.equal(s.trigger().delaySeconds, 0);
});

test('无效时间、跨日窗口、星期和开关被拒绝', (t) => {
  const { scheduler: s } = fixture(t);
  for (const bad of [{ startTime: '25:00' }, { endTime: '08:59' }, { days: [] }, { days: [0] }, { enabled: 'true' }, { name: ' ' }]) {
    assert.throws(() => s.createSchedule({ ...schedule, ...bad }), { status: 400 });
  }
  assert.equal(s.getState().schedules.length, 0);
});

test('随机等待包含两端，定时与手动任务只抽一次，不含定时使用0秒', (t) => {
  const draws = [];
  const { scheduler: s, at } = fixture(t, { random: (min, max) => { draws.push([min, max]); return max - 1; } });
  s.saveTriggerDelay({ delayMinSeconds: 5, delayMaxSeconds: 10 });
  s.createSchedule(schedule);
  assert.equal(s.getState().jobs[0].delaySeconds, 10);
  s.planToday();
  assert.deepEqual(draws, [[540, 541], [5, 11]]);
  at('2026-10-14T01:00:00Z');
  const claim = s.poll();
  assert.equal(claim.delaySeconds, 10);
  s.saveTriggerDelay({ delayMinSeconds: 20, delayMaxSeconds: 30 });
  assert.equal(s.getState().jobs[0].delaySeconds, 10);
  s.ack(claim);
  const manual = s.trigger({ delayMinSeconds: 60, delayMaxSeconds: 90 });
  assert.equal(manual.delaySeconds, 90);
  const manualClaim = s.poll();
  assert.equal(manualClaim.delaySeconds, 90);
  s.ack(manualClaim);
  assert.equal(s.trigger({ delaySeconds: 0 }).delaySeconds, 0);
  assert.equal(s.poll().delaySeconds, 0);
  assert.deepEqual(draws, [[540, 541], [5, 11], [60, 91]]);
});

test('随机等待校验上下限，等值区间固定等待，拒绝不完整区间', (t) => {
  const { scheduler: s } = fixture(t);
  s.createSchedule(schedule);
  for (const range of [
    { delayMinSeconds: 10, delayMaxSeconds: 5 },
    { delayMinSeconds: 5 }, { delayMaxSeconds: 10 },
    ...[-1, 3601, 0.5, '5', null, true].flatMap((value) => [
      { delayMinSeconds: value, delayMaxSeconds: 30 },
      { delayMinSeconds: 0, delayMaxSeconds: value },
    ]),
  ]) {
    assert.throws(() => s.saveTriggerDelay(range), { status: 400 });
    assert.throws(() => s.trigger(range), { status: 400 });
  }
  assert.equal(s.trigger({ delayMinSeconds: 3600, delayMaxSeconds: 3600 }).delaySeconds, 3600);
  const { scheduler: lower } = fixture(t);
  assert.equal(lower.trigger({ delayMinSeconds: 5, delayMaxSeconds: 10 }).delaySeconds, 5);
});

test('兼容旧回报时校验凭据，累计运行日志不重复追加', (t) => {
  const { scheduler: s, at } = fixture(t);
  s.trigger();
  const claim = s.poll();
  const callbackJson = '已领取任务\n等待 5 秒\n已打开 App\n<script>alert(1)</script>';
  assert.throws(() => s.ack({ ...claim, ackToken: 'f'.repeat(64), callbackJson }), { status: 403 });
  assert.equal(s.getState().jobs[0].callbackJson, null);
  assert.throws(() => s.ack({ ...claim, callbackJson: true }), { status: 400 });
  assert.equal(s.getState().jobs[0].status, 'delivered');
  s.ack({ ...claim, callbackJson });
  assert.equal(s.getState().jobs[0].callbackJson, callbackJson);
  const finishedAt = s.getState().jobs[0].finishedAt;
  at('2026-10-14T01:00:00Z');
  s.ack({ ...claim, callbackJson });
  s.ack(claim);
  assert.equal(s.getState().jobs[0].callbackJson, callbackJson);
  assert.equal(s.getState().jobs[0].finishedAt, finishedAt);
  const structured = { logs: ['已领取任务', '已完成'], duration: 5 };
  s.ack({ ...claim, callbackJson: structured });
  assert.deepEqual(JSON.parse(s.getState().jobs[0].callbackJson), structured);
});

test('只有callbackJson的回报关联已下发任务，重复回报保留完成时间', (t) => {
  const { scheduler: s, at } = fixture(t);
  const job = s.trigger();
  s.poll();
  const callbackJson = '已领取任务\n等待结束\n已打开 App';
  assert.deepEqual(s.ack({ callbackJson }), { ok: true });
  const completed = s.getState().jobs.find((item) => item.id === job.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.callbackJson, callbackJson);
  at('2026-10-14T01:00:00Z');
  s.ack({ callbackJson });
  assert.equal(s.getState().jobs[0].finishedAt, completed.finishedAt);
  s.ack({ callbackJson: { logs: ['已领取任务', '已打开 App'] } });
  assert.deepEqual(JSON.parse(s.getState().jobs[0].callbackJson), { logs: ['已领取任务', '已打开 App'] });
});

test('仅日志回报不能完成尚未下发的任务，也不接受缺失或无效日志', (t) => {
  const { scheduler: s } = fixture(t);
  assert.throws(() => s.ack({ callbackJson: '完成' }), { status: 409 });
  s.trigger();
  assert.throws(() => s.ack({ callbackJson: '完成' }), { status: 409 });
  assert.equal(s.getState().jobs[0].status, 'pending');
  s.poll();
  for (const body of [null, {}, { callbackJson: null }, { callbackJson: true }, { callbackJson: 5 }]) {
    assert.throws(() => s.ack(body), { status: 400 });
  }
  assert.equal(s.getState().jobs[0].status, 'delivered');
  assert.equal(s.getState().jobs[0].callbackJson, null);
});

test('最近下发任务失败后，仅日志回报不会误关联更早完成或尚未领取的任务', (t) => {
  const { scheduler: s } = fixture(t);
  const first = s.trigger();
  s.poll();
  s.ack({ callbackJson: '第一次完成' });
  const completed = s.getState().jobs[0];
  const second = s.trigger();
  s.ack({ callbackJson: '第一次完成' });
  assert.equal(s.getState().jobs.find((job) => job.id === second.id).status, 'pending');
  s.poll();
  const third = s.trigger();
  assert.throws(() => s.ack({ callbackJson: '第二次迟到回报' }), { status: 409 });
  assert.deepEqual(s.getState().jobs.find((job) => job.id === first.id), completed);
  assert.equal(s.getState().jobs.find((job) => job.id === third.id).status, 'pending');
  s.poll();
  s.ack({ callbackJson: ['第三次完成'] });
  const jobs = s.getState().jobs;
  assert.equal(jobs.find((job) => job.id === first.id).callbackJson, '第一次完成');
  assert.equal(jobs.find((job) => job.id === second.id).status, 'failed');
  assert.equal(jobs.find((job) => job.id === second.id).callbackJson, null);
  assert.deepEqual(JSON.parse(jobs.find((job) => job.id === third.id).callbackJson), ['第三次完成']);
});

test('今日打卡成功后跳过定时任务，但仍可立即打卡', (t) => {
  const { scheduler: s, at } = fixture(t);
  s.createSchedule(schedule);
  s.createSchedule({ ...schedule, name: '第二个定时计划' });
  s.trigger();
  at('2026-10-14T01:00:00Z');
  const manual = s.poll();
  assert.equal(manual.source, 'manual');
  s.ack({ callbackJson: '手动任务完成' });
  const jobs = s.getState().jobs;
  assert.equal(jobs.filter((job) => job.source === 'schedule').length, 2);
  assert.ok(jobs.filter((job) => job.source === 'schedule').every((job) => job.status === 'skipped'));
  assert.deepEqual(s.poll(), { shouldRun: false });
  const immediate = s.trigger();
  const immediateClaim = s.poll();
  assert.equal(immediateClaim.source, 'manual');
  s.ack({ callbackJson: '再次立即打卡完成' });
  assert.equal(jobs.find((job) => job.id === manual.jobId).callbackJson, '手动任务完成');
  assert.equal(s.getState().jobs.find((job) => job.id === immediate.id).status, 'completed');
  assert.equal(immediateClaim.jobId, immediate.id);
});

test('定时任务成功回报后同日其他定时任务也不会领取', (t) => {
  const { scheduler: s, at } = fixture(t);
  s.createSchedule(schedule);
  s.createSchedule({ ...schedule, name: '第二个定时计划' });
  at('2026-10-14T01:00:00Z');
  const first = s.poll();
  assert.equal(first.source, 'schedule');
  s.ack(first);
  const scheduledJobs = s.getState().jobs.filter((job) => job.source === 'schedule');
  assert.equal(scheduledJobs.find((job) => job.id === first.jobId).status, 'completed');
  assert.equal(scheduledJobs.find((job) => job.id !== first.jobId).status, 'skipped');
  assert.deepEqual(s.poll(), { shouldRun: false });
});

test('旧计划待领取任务一次迁移到全局等待，任务时间及历史保留，重启不重抽', () => {
  const dir = mkdtempSync(join(tmpdir(), 'iphonefast-range-migration-'));
  const dataFile = join(dir, 'state.sqlite');
  const legacy = new DatabaseSync(dataFile);
  legacy.exec(`
    CREATE TABLE schedules (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, startTime TEXT NOT NULL,
      endTime TEXT NOT NULL, days TEXT NOT NULL, enabled INTEGER NOT NULL,
      createdAt TEXT NOT NULL, delaySeconds INTEGER NOT NULL DEFAULT 0,
      delayMinSeconds INTEGER NOT NULL DEFAULT 0, delayMaxSeconds INTEGER NOT NULL DEFAULT 0,
      holidayAware INTEGER NOT NULL DEFAULT 0, useDelay INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY, scheduleId TEXT, scheduleName TEXT NOT NULL,
      date TEXT NOT NULL, plannedTime TEXT NOT NULL, windowEnd TEXT NOT NULL,
      status TEXT NOT NULL, source TEXT NOT NULL, createdAt TEXT NOT NULL,
      deliveredAt TEXT, finishedAt TEXT, expiresAt TEXT, error TEXT, ackHash TEXT,
      delaySeconds INTEGER NOT NULL DEFAULT 0,
      UNIQUE(scheduleId, date)
    );
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO metadata VALUES ('triggerDelayRange', '{"delayMinSeconds":5,"delayMaxSeconds":10}');
    INSERT INTO schedules VALUES
      ('pending', '原计划', '09:00', '09:10', '[3]', 1, '2026-10-14T00:59:00.000Z', 100, 100, 200, 0, 1),
      ('off', '不等待', '09:00', '09:10', '[3]', 1, '2026-10-14T00:59:00.000Z', 100, 100, 200, 0, 0),
      ('claimed', '已领取', '09:00', '09:10', '[3]', 1, '2026-10-14T00:59:00.000Z', 100, 100, 200, 0, 1),
      ('completed', '历史计划', '09:00', '09:10', '[3]', 0, '2026-10-13T00:59:00.000Z', 100, 100, 200, 0, 1);
    INSERT INTO jobs (id, scheduleId, scheduleName, date, plannedTime, windowEnd, status, source, createdAt, deliveredAt, finishedAt, expiresAt, delaySeconds) VALUES
      ('pending-job', 'pending', '原计划', '2026-10-14', '09:03', '09:10', 'pending', 'schedule', '2026-10-14T00:59:00.000Z', NULL, NULL, NULL, 175),
      ('off-job', 'off', '不等待', '2026-10-14', '09:04', '09:10', 'pending', 'schedule', '2026-10-14T00:59:00.000Z', NULL, NULL, NULL, 180),
      ('claimed-job', 'claimed', '已领取', '2026-10-14', '09:00', '09:10', 'delivered', 'schedule', '2026-10-14T00:59:00.000Z', '2026-10-14T01:00:00.000Z', NULL, NULL, 181),
      ('completed-job', 'completed', '历史计划', '2026-10-13', '09:01', '09:10', 'completed', 'schedule', '2026-10-13T00:59:00.000Z', '2026-10-13T01:01:00.000Z', '2026-10-13T01:03:00.000Z', NULL, 182),
      ('manual-job', NULL, '立即打卡', '2026-10-14', '08:59', '08:59', 'pending', 'manual', '2026-10-14T00:59:00.000Z', NULL, NULL, '2026-10-14T01:04:00.000Z', 77);
  `);
  const original = legacy.prepare('SELECT id, plannedTime, delaySeconds, status FROM jobs ORDER BY id').all();
  legacy.close();
  let s;
  try {
    const now = () => new Date('2026-10-14T01:00:00Z');
    const draws = [];
    s = new Scheduler({ dataFile, now, random: (min, max) => { draws.push([min, max]); return max - 1; } });
    const migrated = s.db.prepare('SELECT id, plannedTime, delaySeconds, status FROM jobs ORDER BY id').all();
    assert.deepEqual(migrated.map((job) => ({ ...job })), original.map((job) => ({ ...job, delaySeconds: job.id === 'pending-job' ? 10 : job.id === 'off-job' ? 0 : job.delaySeconds })));
    assert.deepEqual(draws, [[5, 11]]);
    const saved = s.db.prepare("SELECT delaySeconds, delayMinSeconds, delayMaxSeconds FROM schedules WHERE id = 'pending'").get();
    assert.deepEqual({ ...saved }, { delaySeconds: 100, delayMinSeconds: 100, delayMaxSeconds: 200 });
    for (const field of ['delaySeconds', 'delayMinSeconds', 'delayMaxSeconds']) assert.equal(field in s.schedules()[0], false);
    s.close();
    s = new Scheduler({ dataFile, now, random: () => { throw new Error('不应重抽'); } });
    assert.deepEqual(s.db.prepare('SELECT id, plannedTime, delaySeconds, status FROM jobs ORDER BY id').all(), migrated);
    s.saveTriggerDelay({ delayMinSeconds: 5, delayMaxSeconds: 10 });
    assert.deepEqual(s.poll(), { shouldRun: false });
    s.ack({ callbackJson: ['已领取', '等待完成', '已打开 App'] });
    s.close();
    s = new Scheduler({ dataFile, now, random: () => { throw new Error('不应重抽'); } });
    const completed = s.getState().jobs.find((job) => job.id === 'claimed-job');
    assert.equal(completed.status, 'completed');
    assert.deepEqual(JSON.parse(completed.callbackJson), ['已领取', '等待完成', '已打开 App']);
    assert.equal(s.getState().jobs.find((job) => job.id === 'manual-job').delaySeconds, 77);
    assert.equal(s.getState().jobs.length, 5);
  } finally {
    s?.close();
    for (const name of readdirSync(dir)) unlinkSync(join(dir, name));
    rmdirSync(dir);
  }
});

test('节假日日历仅保存日期和 type 枚举，校验全年完整数据和年月', async (t) => {
  const requests = [];
  const types = Object.fromEntries([0, 1, 2, 3, 4].map((type) => [`2026-10-0${type + 1}`, { type, name: '忽略名称', wage: 3 }]));
  const { scheduler: s } = fixture(t, { holidayFetch: async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => holidayYear(2026, types) };
  } });
  assert.equal(s.getHolidayCalendar('2026-10').syncedAt, null);
  const result = await s.syncHolidays();
  assert.deepEqual(result, { year: 2026, syncedAt: '2026-10-14T00:59:00.000Z', count: 365 });
  assert.equal(requests[0].url, 'https://holiday.ailcc.com/api/holiday/allyear/2026');
  assert.ok(requests[0].options.signal instanceof AbortSignal);
  const calendar = s.getHolidayCalendar();
  assert.equal(calendar.days.length, 31);
  assert.deepEqual(calendar.days.slice(0, 5), [0, 1, 2, 3, 4].map((type) => ({ date: `2026-10-0${type + 1}`, type })));
  assert.deepEqual(calendar.days.find((day) => day.date === '2026-10-10'), { date: '2026-10-10', type: 1 });
  assert.deepEqual(calendar.days.find((day) => day.date === '2026-10-14'), { date: '2026-10-14', type: 0 });
  assert.deepEqual(s.db.prepare('SELECT * FROM holidays WHERE date = ?').get('2026-10-03'), Object.assign(Object.create(null), { date: '2026-10-03', type: 2, syncedAt: result.syncedAt }));
  assert.equal(s.db.prepare('SELECT count(*) AS count FROM holidays').get().count, 365);
  assert.equal(s.getHolidayCalendar('2028-02').days.length, 29);
  for (const month of ['', '2026-1', '2026-00', '2026-13', '2026-02-01', null, 202610]) {
    assert.throws(() => s.getHolidayCalendar(month), { status: 400 });
  }
  for (const year of ['2026', null, 999, 10000, 2026.5, true]) await assert.rejects(s.syncHolidays(year), { status: 400 });
  assert.equal(requests.length, 1);
});

test('节假日开关：工作日按星期，周末节日调休跳过，补班覆盖星期选择', async (t) => {
  for (const [type, days, holidayAware, expected] of [
    [0, [3], true, 1], [0, [1], true, 0],
    [1, [3], true, 0], [2, [3], true, 0], [3, [3], true, 0],
    [4, [1], true, 1], [4, [3], true, 1],
    [2, [3], false, 1], [4, [1], false, 0],
  ]) {
    const { scheduler: s } = fixture(t, { holidayFetch: async () => ({ ok: true, json: async () => holidayYear(2026, { '2026-10-14': { type } }) }) });
    await s.syncHolidays();
    s.createSchedule({ ...schedule, days, holidayAware });
    assert.equal(s.getState().jobs.length, expected, JSON.stringify({ type, days, holidayAware }));
  }
  const { scheduler: weekend, at } = fixture(t);
  await weekend.syncHolidays();
  at('2026-10-17T00:59:00Z');
  weekend.createSchedule({ ...schedule, days: [6], holidayAware: true });
  assert.equal(weekend.getState().jobs.length, 0);
  weekend.createSchedule({ ...schedule, days: [6] });
  assert.equal(weekend.getState().jobs.length, 1);
});

test('计划延时开关使用全局区间，关闭不抽等待秒数，开关必须是布尔值', async (t) => {
  const draws = [];
  const { scheduler: s } = fixture(t, { random: (min, max) => { draws.push([min, max]); return max - 1; } });
  await s.syncHolidays();
  s.saveTriggerDelay({ delayMinSeconds: 5, delayMaxSeconds: 10 });
  const body = { ...schedule, holidayAware: true, useDelay: false };
  const created = s.createSchedule(body);
  assert.equal(created.useDelay, false);
  assert.equal(created.holidayAware, true);
  assert.equal(s.getState().jobs[0].delaySeconds, 0);
  assert.deepEqual(draws, [[540, 541]]);
  s.updateSchedule(created.id, { ...body, useDelay: true });
  assert.equal(s.getState().jobs[0].delaySeconds, 10);
  assert.deepEqual(draws, [[540, 541], [540, 541], [5, 11]]);
  s.updateSchedule(created.id, body);
  assert.equal(s.getState().jobs[0].delaySeconds, 0);
  assert.deepEqual(draws, [[540, 541], [540, 541], [5, 11], [540, 541]]);
  for (const key of ['holidayAware', 'useDelay']) {
    for (const value of [null, 0, 1, 'true', 'false']) {
      assert.throws(() => s.createSchedule({ ...body, [key]: value }), { status: 400 });
      assert.throws(() => s.updateSchedule(created.id, { ...body, [key]: value }), { status: 400 });
    }
  }
});

test('节假日同步失败及写入中断保留旧年度数据和成功时间', async (t) => {
  let reply = holidayYear(2026, { '2026-10-14': { type: 2 } });
  let ok = true;
  let offline = false;
  const { scheduler: s, at } = fixture(t, { holidayFetch: async () => {
    if (offline) throw new Error('offline');
    return { ok, json: async () => reply };
  } });
  await s.syncHolidays();
  const original = s.getHolidayCalendar();
  at('2026-10-14T01:00:00Z');
  for (const invalid of [
    { code: -1, data: [] }, { code: 0 }, { code: 0, year: '2026', data: [] },
    holidayYear(2027),
    { ...holidayYear(), data: holidayYear().data.slice(1) },
    { ...holidayYear(), data: holidayYear().data.map((item, index) => index === 0 ? { ...item, date: '2026-02-30' } : item) },
    { ...holidayYear(), data: holidayYear().data.map((item, index) => index === 0 ? { ...item, date: '2026-01-02' } : item) },
    ...[-1, 5, '2', null, 1.5].map((type) => holidayYear(2026, { '2026-10-14': { type } })),
  ]) {
    reply = invalid;
    await assert.rejects(s.syncHolidays(), { status: 502 });
    assert.deepEqual(s.getHolidayCalendar(), original);
  }
  reply = holidayYear();
  ok = false;
  await assert.rejects(s.syncHolidays(), { status: 502 });
  ok = true;
  offline = true;
  await assert.rejects(s.syncHolidays(), { status: 502 });
  offline = false;
  reply = holidayYear(2026, { '2026-01-01': { type: 2 }, '2026-01-10': { type: 4 } });
  s.db.exec("CREATE TEMP TRIGGER reject_holiday BEFORE INSERT ON holidays WHEN NEW.date = '2026-01-10' BEGIN SELECT RAISE(ABORT, 'forced failure'); END");
  await assert.rejects(s.syncHolidays(), /forced failure/);
  assert.deepEqual(s.getHolidayCalendar(), original);
  assert.equal(s.db.prepare('SELECT count(*) AS count FROM holidays').get().count, 365);
  s.db.exec('DROP TRIGGER reject_holiday');
  await s.syncHolidays();
  assert.equal(s.getHolidayCalendar().days.find((day) => day.date === '2026-10-14').type, 0);
  assert.equal(s.getHolidayCalendar().syncedAt, '2026-10-14T01:00:00.000Z');
});

test('同日节假日更新取消不符任务，补班生成任务且保留其他随机结果及已领取任务', async (t) => {
  let type = 0;
  let draws = 0;
  const { scheduler: s, at } = fixture(t, {
    random: (min) => { draws++; return min; },
    holidayFetch: async () => ({ ok: true, json: async () => holidayYear(2026, { '2026-10-14': { type } }) }),
  });
  await s.syncHolidays();
  const aware = s.createSchedule({ ...schedule, holidayAware: true });
  const ordinary = s.createSchedule(schedule);
  const extraWorkday = s.createSchedule({ ...schedule, days: [1], holidayAware: true });
  const unaffectedJob = s.getState().jobs.find((job) => job.scheduleId === ordinary.id);
  assert.equal(draws, 2);
  type = 2;
  await s.syncHolidays();
  assert.equal(s.getState().jobs.some((job) => job.scheduleId === aware.id), false);
  assert.equal(s.getState().jobs.find((job) => job.scheduleId === ordinary.id).id, unaffectedJob.id);
  assert.equal(draws, 2);
  type = 4;
  await s.syncHolidays();
  assert.equal(s.getState().jobs.length, 3);
  assert.ok(s.getState().jobs.some((job) => job.scheduleId === extraWorkday.id));
  assert.equal(draws, 4);
  await s.syncHolidays();
  assert.equal(draws, 4);
  s.deleteSchedule(ordinary.id);
  at('2026-10-14T01:00:00Z');
  const claim = s.poll();
  type = 2;
  await s.syncHolidays();
  assert.equal(s.getState().jobs.length, 1);
  assert.equal(s.getState().jobs[0].id, claim.jobId);
  assert.equal(s.getState().jobs[0].status, 'delivered');
  type = 4;
  await s.syncHolidays();
  assert.equal(s.getState().jobs.filter((job) => job.id === claim.jobId).length, 1);
  assert.deepEqual(s.poll(), { shouldRun: false });
  s.ack(claim);
  await s.syncHolidays();
  assert.equal(s.getState().jobs.filter((job) => job.status === 'completed').length, 1);
  assert.equal(s.getState().jobs.filter((job) => job.status === 'pending').length, 0);
  assert.deepEqual(s.poll(), { shouldRun: false });
});

test('节假日数据和开关跨重启保留，月份同步支持跨年、错过月初和失败后手动重试', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iphonefast-holidays-'));
  const dataFile = join(dir, 'state.sqlite');
  let clock = new Date('2026-12-31T15:59:00Z');
  let offline = false;
  const requests = [];
  const config = { dataFile, now: () => clock, random: (min) => min, holidayFetch: async (url) => {
    requests.push(url);
    if (offline) throw new Error('offline');
    return { ok: true, json: async () => holidayYear(Number(url.split('/').at(-1))) };
  } };
  let s;
  try {
    s = new Scheduler(config);
    s.saveTriggerDelay({ delayMinSeconds: 5, delayMaxSeconds: 10 });
    s.createSchedule({ ...schedule, holidayAware: true, useDelay: false });
    await s.tick();
    const original = s.getHolidayCalendar('2026-12');
    await s.tick();
    assert.equal(requests.length, 1);
    s.close();
    s = new Scheduler(config);
    await s.tick();
    assert.equal(requests.length, 1);
    assert.deepEqual(s.getHolidayCalendar('2026-12'), original);
    assert.equal(s.schedules()[0].holidayAware, true);
    assert.equal(s.schedules()[0].useDelay, false);
    assert.deepEqual(s.getTriggerDelay(), { delayMinSeconds: 5, delayMaxSeconds: 10 });
    clock = new Date('2026-12-31T16:00:00Z');
    await s.tick();
    assert.equal(requests.length, 2);
    assert.equal(requests[1], 'https://holiday.ailcc.com/api/holiday/allyear/2027');
    assert.deepEqual(s.getHolidayCalendar('2026-12'), original);
    s.close();
    clock = new Date('2027-02-03T02:00:00Z');
    offline = true;
    s = new Scheduler(config);
    await assert.rejects(s.tick(), { status: 502 });
    await s.tick();
    assert.equal(requests.length, 3);
    s.close();
    s = new Scheduler(config);
    await s.tick();
    assert.equal(requests.length, 3);
    offline = false;
    await s.syncHolidays();
    assert.equal(requests.length, 4);
    assert.equal(s.getHolidayCalendar().syncedAt, clock.toISOString());
  } finally {
    s?.close();
    for (const name of readdirSync(dir)) unlinkSync(join(dir, name));
    rmdirSync(dir);
  }
});

test('同步合并并发请求，关闭时中止请求且不会异步写入已关闭数据库', async (t) => {
  let resolveFetch;
  let signal;
  let calls = 0;
  const { scheduler: s } = fixture(t, { holidayFetch: (url, options) => {
    calls++;
    signal = options.signal;
    return new Promise((resolveFetchResponse) => { resolveFetch = resolveFetchResponse; });
  } });
  const first = s.syncHolidays();
  const second = s.syncHolidays();
  await assert.rejects(s.syncHolidays(2027), { status: 409 });
  await s.tick();
  assert.equal(calls, 1);
  s.close();
  assert.equal(signal.aborted, true);
  resolveFetch({ ok: true, json: async () => ({ code: 0, type: {} }) });
  await assert.rejects(first, { status: 503 });
  await assert.rejects(second, { status: 503 });
  await assert.rejects(s.syncHolidays(), { status: 503 });
  await s.tick();
});

test('未同步年份不会误发调休计划，完整闰年数据同步后可按星期执行', async (t) => {
  const { scheduler: s, at } = fixture(t);
  at('2028-02-29T01:00:00Z');
  s.createSchedule({ ...schedule, holidayAware: true });
  assert.deepEqual(s.poll(), { shouldRun: false });
  const result = await s.syncHolidays(2028);
  assert.equal(result.count, 366);
  assert.equal(s.getHolidayCalendar('2028-02').days.length, 29);
  assert.equal(s.poll().shouldRun, true);
});
