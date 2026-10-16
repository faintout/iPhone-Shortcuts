import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class ServiceError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const minuteOf = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const timeOf = (minute) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
const visibleJobColumns = 'id, scheduleId, scheduleName, date, plannedTime, windowEnd, delaySeconds, status, source, createdAt, deliveredAt, finishedAt, expiresAt, error, callbackJson';
const triggerDelayMetadataKey = 'triggerDelayRange';
const scheduleDelayMigrationKey = 'scheduleDelayUsesGlobal';
const holidaySyncMonthKey = 'holidaySyncAttemptMonth';

function validateYear(year) {
  if (!Number.isInteger(year) || year < 1000 || year > 9999) throw new ServiceError(400, '年份必须是四位整数');
  return year;
}

function calendarDays(month) {
  if (typeof month !== 'string' || !/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new ServiceError(400, '月份必须使用 YYYY-MM 格式');
  }
  const [year, number] = month.split('-').map(Number);
  const count = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return Array.from({ length: count }, (_, index) => `${month}-${String(index + 1).padStart(2, '0')}`);
}

const ordinaryDayType = (date) => [0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay()) ? 1 : 0;

function validateDelay(delaySeconds = 0) {
  if (!Number.isInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > 3600) {
    throw new ServiceError(400, '延时执行时间必须是 0–3600 秒之间的整数');
  }
  return delaySeconds;
}

function validateDelayRange(value) {
  if (value.delayMinSeconds === undefined && value.delayMaxSeconds === undefined) {
    const delaySeconds = validateDelay(value.delaySeconds);
    return { delayMinSeconds: delaySeconds, delayMaxSeconds: delaySeconds };
  }
  if (value.delayMinSeconds === undefined || value.delayMaxSeconds === undefined) {
    throw new ServiceError(400, '请填写随机等待秒数的最小值和最大值');
  }
  const delayMinSeconds = validateDelay(value.delayMinSeconds);
  const delayMaxSeconds = validateDelay(value.delayMaxSeconds);
  if (delayMinSeconds > delayMaxSeconds) throw new ServiceError(400, '随机等待的最大秒数不能小于最小秒数');
  return { delayMinSeconds, delayMaxSeconds };
}

function validateSchedule(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ServiceError(400, '请填写计划内容');
  }
  const { name, startTime, endTime, days, enabled, holidayAware = false, useDelay = true } = value;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 60) {
    throw new ServiceError(400, '计划名称需要 1–60 个字符');
  }
  const validTime = (time) => typeof time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
  if (!validTime(startTime) || !validTime(endTime) || startTime > endTime) {
    throw new ServiceError(400, '请使用同一天内的时间窗口，结束时间不能早于开始时间');
  }
  if (!Array.isArray(days) || !days.length || days.length > 7 || days.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
    throw new ServiceError(400, '请选择星期一到星期日中的至少一天');
  }
  if (typeof enabled !== 'boolean') throw new ServiceError(400, '启用状态必须为布尔值');
  if (typeof holidayAware !== 'boolean' || typeof useDelay !== 'boolean') throw new ServiceError(400, '节假日和延时开关必须为布尔值');
  return { name: name.trim(), startTime, endTime, days: [...new Set(days)].sort(), enabled, holidayAware, useDelay };
}

export class Scheduler {
  constructor({ dataFile, timezone = 'Asia/Shanghai', now = () => new Date(), random = randomInt, holidayFetch = globalThis.fetch }) {
    this.timezone = timezone;
    this.clock = now;
    this.random = random;
    this.holidayFetch = holidayFetch;
    this.formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    if (dataFile !== ':memory:') mkdirSync(dirname(dataFile), { recursive: true });
    this.db = new DatabaseSync(dataFile);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, startTime TEXT NOT NULL,
        endTime TEXT NOT NULL, days TEXT NOT NULL, enabled INTEGER NOT NULL,
        createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, scheduleId TEXT, scheduleName TEXT NOT NULL,
        date TEXT NOT NULL, plannedTime TEXT NOT NULL, windowEnd TEXT NOT NULL,
        status TEXT NOT NULL, source TEXT NOT NULL, createdAt TEXT NOT NULL,
        deliveredAt TEXT, finishedAt TEXT, expiresAt TEXT, error TEXT, ackHash TEXT,
        delaySeconds INTEGER NOT NULL DEFAULT 0,
        UNIQUE(scheduleId, date)
      );
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS holidays (
        date TEXT PRIMARY KEY, type INTEGER NOT NULL CHECK(type BETWEEN 0 AND 4), syncedAt TEXT NOT NULL
      );
    `);
    if (!this.db.prepare('PRAGMA table_info(jobs)').all().some((column) => column.name === 'delaySeconds')) {
      this.db.exec('ALTER TABLE jobs ADD COLUMN delaySeconds INTEGER NOT NULL DEFAULT 0');
    }
    const scheduleColumns = this.db.prepare('PRAGMA table_info(schedules)').all();
    for (const [column, defaultValue] of [['holidayAware', 0], ['useDelay', 1]]) {
      if (!scheduleColumns.some((item) => item.name === column)) {
        this.db.exec(`ALTER TABLE schedules ADD COLUMN ${column} INTEGER NOT NULL DEFAULT ${defaultValue}`);
      }
    }
    if (!this.db.prepare('PRAGMA table_info(jobs)').all().some((column) => column.name === 'callbackJson')) {
      this.db.exec('ALTER TABLE jobs ADD COLUMN callbackJson TEXT');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.db.prepare('SELECT value FROM metadata WHERE key = ?').get(scheduleDelayMigrationKey)) {
        this.updatePendingScheduleDelays(this.getTriggerDelay());
        this.db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)').run(scheduleDelayMigrationKey, '1');
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    // Claimed jobs remain claimed across restarts; a lost response must not run twice.
    this.planToday();
  }

  localTime(date = this.clock()) {
    const parts = Object.fromEntries(this.formatter.formatToParts(date).map(({ type, value }) => [type, value]));
    const day = `${parts.year}-${parts.month}-${parts.day}`;
    return { date: day, time: `${parts.hour}:${parts.minute}`, weekday: new Date(`${day}T12:00:00Z`).getUTCDay() || 7 };
  }

  schedules() {
    return this.db.prepare('SELECT id, name, startTime, endTime, days, enabled, createdAt, holidayAware, useDelay FROM schedules ORDER BY startTime, createdAt').all()
      .map((row) => ({ ...row, enabled: Boolean(row.enabled), holidayAware: Boolean(row.holidayAware), useDelay: Boolean(row.useDelay), days: JSON.parse(row.days) }));
  }

  getHolidayCalendar(month = this.localTime().date.slice(0, 7)) {
    const dates = calendarDays(month);
    const rows = this.db.prepare('SELECT date, type FROM holidays WHERE date >= ? AND date <= ? ORDER BY date').all(dates[0], dates.at(-1));
    const saved = new Map(rows.map((row) => [row.date, row.type]));
    const syncedAt = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get(`holidaySyncedAt:${month.slice(0, 4)}`)?.value ?? null;
    return { month, days: dates.map((date) => ({ date, type: saved.get(date) ?? ordinaryDayType(date) })), syncedAt };
  }

  async syncHolidays(year = Number(this.localTime().date.slice(0, 4))) {
    validateYear(year);
    if (this.closed) throw new ServiceError(503, '服务正在关闭');
    if (this.holidaySync) {
      if (this.holidaySyncYear !== year) throw new ServiceError(409, '正在同步其他年份的节假日，请稍后重试');
      return this.holidaySync;
    }
    const month = this.localTime().date.slice(0, 7);
    if (Number(month.slice(0, 4)) === year) {
      this.db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(holidaySyncMonthKey, month);
    }
    this.holidaySyncYear = year;
    this.holidayAbort = new AbortController();
    this.holidaySync = this.fetchHolidays(year, AbortSignal.any([this.holidayAbort.signal, AbortSignal.timeout(10_000)]));
    try {
      return await this.holidaySync;
    } finally {
      this.holidaySync = null;
      this.holidayAbort = null;
    }
  }

  async fetchHolidays(year, signal) {
    let data;
    try {
      const response = await this.holidayFetch(`https://holiday.ailcc.com/api/holiday/allyear/${year}`, { signal });
      if (!response.ok) throw new Error('HTTP failure');
      data = await response.json();
    } catch {
      throw new ServiceError(this.closed ? 503 : 502, this.closed ? '服务正在关闭' : '节假日同步失败，请稍后重试');
    }
    if (this.closed) throw new ServiceError(503, '服务正在关闭');
    if (!data || data.code !== 0 || String(data.year) !== String(year) || !Array.isArray(data.data)) {
      throw new ServiceError(502, '节假日接口返回的数据无效，已保留原数据');
    }
    const expectedDates = new Set(Array.from({ length: 12 }, (_, index) => calendarDays(`${year}-${String(index + 1).padStart(2, '0')}`)).flat());
    const days = data.data;
    if (days.length !== expectedDates.size || days.some((value) => !value || !expectedDates.delete(value.date)
      || !Number.isInteger(value.type) || value.type < 0 || value.type > 4)) {
      throw new ServiceError(502, '节假日接口未返回该年份完整有效的日期类型，已保留原数据');
    }
    const syncedAt = this.clock().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM holidays WHERE date >= ? AND date <= ?').run(`${year}-01-01`, `${year}-12-31`);
      const insert = this.db.prepare('INSERT INTO holidays (date, type, syncedAt) VALUES (?, ?, ?)');
      for (const { date, type } of days) insert.run(date, type, syncedAt);
      this.db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`holidaySyncedAt:${year}`, syncedAt);
      this.planToday();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { year, syncedAt, count: days.length };
  }

  getState() {
    this.expireDeliveredJobs();
    return {
      timezone: this.timezone,
      deviceConfigured: true,
      triggerDelay: this.getTriggerDelay(),
      lastPollAt: this.db.prepare("SELECT value FROM metadata WHERE key = 'lastPollAt'").get()?.value ?? null,
      schedules: this.schedules(),
      jobs: this.db.prepare(`SELECT ${visibleJobColumns} FROM jobs ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, createdAt DESC, rowid DESC LIMIT 200`).all(),
      serverTime: this.clock().toISOString(),
    };
  }

  getTriggerDelay() {
    const saved = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get(triggerDelayMetadataKey)?.value;
    if (!saved) return { delayMinSeconds: 0, delayMaxSeconds: 0 };
    try {
      return validateDelayRange(JSON.parse(saved));
    } catch {
      return { delayMinSeconds: 0, delayMaxSeconds: 0 };
    }
  }

  saveTriggerDelay(body) {
    const value = validateDelayRange(body);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.getTriggerDelay();
      this.db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(triggerDelayMetadataKey, JSON.stringify(value));
      if (previous.delayMinSeconds !== value.delayMinSeconds || previous.delayMaxSeconds !== value.delayMaxSeconds) {
        this.updatePendingScheduleDelays(value);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return value;
  }

  updatePendingScheduleDelays(range) {
    const jobs = this.db.prepare("SELECT jobs.id, schedules.useDelay FROM jobs JOIN schedules ON schedules.id = jobs.scheduleId WHERE jobs.source = 'schedule' AND jobs.status = 'pending'").all();
    const update = this.db.prepare('UPDATE jobs SET delaySeconds = ? WHERE id = ?');
    for (const job of jobs) update.run(job.useDelay ? this.drawDelay(range) : 0, job.id);
  }

  createSchedule(body) {
    const value = validateSchedule(body);
    if (this.schedules().length >= 30) throw new ServiceError(400, '最多可创建 30 个计划');
    const id = randomUUID();
    this.db.prepare('INSERT INTO schedules (id, name, startTime, endTime, days, enabled, createdAt, holidayAware, useDelay) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, value.name, value.startTime, value.endTime, JSON.stringify(value.days), Number(value.enabled), this.clock().toISOString(), Number(value.holidayAware), Number(value.useDelay));
    this.planToday();
    return this.schedules().find((schedule) => schedule.id === id);
  }

  updateSchedule(id, body) {
    const value = validateSchedule(body);
    if (!this.db.prepare('SELECT id FROM schedules WHERE id = ?').get(id)) throw new ServiceError(404, '计划不存在');
    this.db.prepare('UPDATE schedules SET name = ?, startTime = ?, endTime = ?, days = ?, enabled = ?, holidayAware = ?, useDelay = ? WHERE id = ?')
      .run(value.name, value.startTime, value.endTime, JSON.stringify(value.days), Number(value.enabled), Number(value.holidayAware), Number(value.useDelay), id);
    this.db.prepare("DELETE FROM jobs WHERE scheduleId = ? AND status = 'pending'").run(id);
    this.planToday();
    return this.schedules().find((schedule) => schedule.id === id);
  }

  deleteSchedule(id) {
    const result = this.db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
    if (!result.changes) throw new ServiceError(404, '计划不存在');
    this.db.prepare("DELETE FROM jobs WHERE scheduleId = ? AND status = 'pending'").run(id);
    return { ok: true };
  }

  addJob({ scheduleId = null, scheduleName, date, plannedTime, windowEnd = plannedTime, delaySeconds = 0, expiresAt = null, source }) {
    const job = {
      id: randomUUID(), scheduleId, scheduleName, date, plannedTime, windowEnd, delaySeconds,
      status: 'pending', source, createdAt: this.clock().toISOString(), expiresAt,
    };
    this.db.prepare('INSERT INTO jobs (id, scheduleId, scheduleName, date, plannedTime, windowEnd, delaySeconds, status, source, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(job.id, scheduleId, scheduleName, date, plannedTime, windowEnd, delaySeconds, job.status, source, job.createdAt, expiresAt);
    return job;
  }

  hasCompletedToday(date) {
    return this.db.prepare("SELECT date, finishedAt FROM jobs WHERE status = 'completed' ORDER BY finishedAt DESC LIMIT 200").all().some((job) => {
      if (!job.finishedAt) return job.date === date;
      const finishedAt = new Date(job.finishedAt);
      return !Number.isNaN(finishedAt.getTime()) && this.localTime(finishedAt).date === date;
    });
  }

  skipPendingSchedules(date) {
    this.db.prepare("UPDATE jobs SET status = 'skipped', finishedAt = ?, error = ? WHERE source = 'schedule' AND date = ? AND status = 'pending'")
      .run(this.clock().toISOString(), '今天已完成打卡，定时计划不再触发', date);
  }

  planToday() {
    const today = this.localTime();
    const dayType = this.db.prepare('SELECT type FROM holidays WHERE date = ?').get(today.date)?.type;
    const completedToday = this.hasCompletedToday(today.date);
    if (completedToday) this.skipPendingSchedules(today.date);
    for (const schedule of this.schedules()) {
      const runsToday = schedule.enabled && (schedule.holidayAware
        ? dayType === 4 || (dayType === 0 && schedule.days.includes(today.weekday))
        : schedule.days.includes(today.weekday));
      if (!runsToday) {
        this.db.prepare("DELETE FROM jobs WHERE scheduleId = ? AND date = ? AND source = 'schedule' AND status = 'pending'").run(schedule.id, today.date);
      }
      if (completedToday || !runsToday) continue;
      if (this.db.prepare('SELECT id FROM jobs WHERE scheduleId = ? AND date = ?').get(schedule.id, today.date)) continue;
      const plannedTime = timeOf(this.random(minuteOf(schedule.startTime), minuteOf(schedule.endTime) + 1));
      this.addJob({ scheduleId: schedule.id, scheduleName: schedule.name, date: today.date, plannedTime, windowEnd: schedule.endTime, delaySeconds: schedule.useDelay ? this.drawDelay(this.getTriggerDelay()) : 0, source: 'schedule' });
    }
    // A late restart should not silently turn a missed morning check-in into an afternoon one.
    this.db.prepare("UPDATE jobs SET status = 'skipped', finishedAt = ?, error = ? WHERE status = 'pending' AND source = 'schedule' AND (date < ? OR (date = ? AND windowEnd < ?))")
      .run(this.clock().toISOString(), '时间窗口内手机未领取，已过期', today.date, today.date, today.time);
    this.db.prepare("UPDATE jobs SET status = 'skipped', finishedAt = ?, error = ? WHERE status = 'pending' AND source = 'manual' AND expiresAt <= ?")
      .run(this.clock().toISOString(), '立即指令超过 5 分钟未领取，已过期', this.clock().toISOString());
    this.expireDeliveredJobs();
    this.db.prepare("DELETE FROM jobs WHERE status != 'pending' AND status != 'delivered' AND date < ?")
      .run(this.localTime(new Date(this.clock().getTime() - 90 * 86400000)).date);
  }

  expireDeliveredJobs() {
    const now = this.clock().toISOString();
    this.db.prepare("UPDATE jobs SET status = 'failed', finishedAt = ?, error = ? WHERE status = 'delivered' AND unixepoch(deliveredAt, 'subsec') + 60 <= unixepoch(?, 'subsec')")
      .run(now, '手机领取任务后 1 分钟未收到回报，已失败，不会自动重发', now);
  }

  drawDelay({ delayMinSeconds, delayMaxSeconds }) {
    return delayMinSeconds === delayMaxSeconds ? delayMinSeconds : this.random(delayMinSeconds, delayMaxSeconds + 1);
  }

  trigger(body = {}) {
    const range = validateDelayRange(body);
    this.planToday();
    if (this.db.prepare("SELECT id FROM jobs WHERE source = 'manual' AND status = 'pending'").get()) {
      throw new ServiceError(409, '已有立即打卡指令等待手机处理，请查看记录');
    }
    const { date, time } = this.localTime();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("UPDATE jobs SET status = 'failed', finishedAt = ?, error = ? WHERE status = 'delivered'")
        .run(this.clock().toISOString(), '已重新发起打卡，终止等待旧任务回报');
      const job = this.addJob({ scheduleName: '立即打卡', date, plannedTime: time, delaySeconds: this.drawDelay(range), source: 'manual', expiresAt: new Date(this.clock().getTime() + 300000).toISOString() });
      this.db.exec('COMMIT');
      return job;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  poll() {
    this.planToday();
    const now = this.clock().toISOString();
    const { date, time } = this.localTime();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("INSERT INTO metadata (key, value) VALUES ('lastPollAt', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(now);
      const active = this.db.prepare("SELECT id FROM jobs WHERE status = 'delivered' LIMIT 1").get();
      const job = active ? null : this.db.prepare("SELECT * FROM jobs WHERE status = 'pending' AND (source = 'manual' OR (date = ? AND plannedTime <= ? AND windowEnd >= ?)) ORDER BY CASE WHEN source = 'manual' THEN 0 ELSE 1 END, plannedTime, createdAt, rowid LIMIT 1").get(date, time, time);
      if (!job) {
        this.db.exec('COMMIT');
        return { shouldRun: false };
      }
      const ackToken = randomBytes(32).toString('hex');
      this.db.prepare("UPDATE jobs SET status = 'delivered', deliveredAt = ?, ackHash = ? WHERE id = ?").run(now, tokenHash(ackToken), job.id);
      this.db.prepare("INSERT INTO metadata (key, value) VALUES ('lastDeliveredJobId', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(job.id);
      this.db.exec('COMMIT');
      return { shouldRun: true, jobId: job.id, ackToken, source: job.source, scheduleName: job.scheduleName, delaySeconds: job.delaySeconds };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  ack(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ServiceError(400, '回报需要 callbackJson 运行日志');
    }
    const { callbackJson } = body;
    if (callbackJson != null && typeof callbackJson !== 'string' && typeof callbackJson !== 'object') {
      throw new ServiceError(400, 'callbackJson 必须是运行日志文本、JSON 对象或数组');
    }
    this.expireDeliveredJobs();
    let job;
    if (body.jobId === undefined && body.ackToken === undefined) {
      if (callbackJson == null) throw new ServiceError(400, '回报需要 callbackJson 运行日志');
      job = this.db.prepare("SELECT id, status, date FROM jobs WHERE deliveredAt IS NOT NULL ORDER BY (id = (SELECT value FROM metadata WHERE key = 'lastDeliveredJobId')) DESC, deliveredAt DESC, rowid DESC LIMIT 1").get();
      if (!job) throw new ServiceError(409, '没有已下发的任务可关联回报');
    } else {
      // Keep previously imported shortcuts working with their original receipt fields.
      if (typeof body.jobId !== 'string' || typeof body.ackToken !== 'string' || !/^[a-f0-9]{64}$/.test(body.ackToken)) {
        throw new ServiceError(400, '旧格式回报需要有效的 jobId 和 ackToken');
      }
      job = this.db.prepare('SELECT id, status, ackHash, date FROM jobs WHERE id = ?').get(body.jobId);
      if (!job || job.ackHash !== tokenHash(body.ackToken)) throw new ServiceError(403, '任务回报凭据无效');
    }
    if (job.status === 'cancelled') throw new ServiceError(409, '任务已撤销，不再接受回报');
    if (job.status === 'failed') throw new ServiceError(409, '任务已失败，不再接受回报');
    if (!['delivered', 'unknown', 'completed'].includes(job.status)) throw new ServiceError(409, '任务尚未下发');
    const log = callbackJson == null ? null : typeof callbackJson === 'string' ? callbackJson : JSON.stringify(callbackJson, null, 2);
    this.db.prepare("UPDATE jobs SET status = 'completed', finishedAt = CASE WHEN status = 'completed' THEN finishedAt ELSE ? END, error = NULL, callbackJson = COALESCE(?, callbackJson) WHERE id = ?")
      .run(this.clock().toISOString(), log, job.id);
    this.skipPendingSchedules(this.localTime().date);
    return { ok: true };
  }

  cancelJob(id) {
    if (typeof id !== 'string' || !id) throw new ServiceError(400, '任务 ID 无效');
    this.expireDeliveredJobs();
    const job = this.db.prepare('SELECT id, status FROM jobs WHERE id = ?').get(id);
    if (!job) throw new ServiceError(404, '任务不存在');
    if (job.status === 'completed') throw new ServiceError(409, '打卡已完成，无法撤销');
    if (job.status === 'failed') throw new ServiceError(409, '任务已失败，无法撤销');
    if (job.status === 'skipped') throw new ServiceError(409, '任务已过期，无法撤销');
    if (job.status === 'cancelled') return this.db.prepare(`SELECT ${visibleJobColumns} FROM jobs WHERE id = ?`).get(id);
    const now = this.clock().toISOString();
    this.db.prepare("UPDATE jobs SET status = 'cancelled', finishedAt = ?, error = ? WHERE id = ?")
      .run(now, '打卡任务已手动撤销', id);
    return this.db.prepare(`SELECT ${visibleJobColumns} FROM jobs WHERE id = ?`).get(id);
  }

  async tick() {
    if (this.closed) return;
    this.planToday();
    if (this.holidaySync) return;
    const month = this.localTime().date.slice(0, 7);
    if (this.db.prepare('SELECT value FROM metadata WHERE key = ?').get(holidaySyncMonthKey)?.value !== month) {
      await this.syncHolidays(Number(month.slice(0, 4)));
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.holidayAbort?.abort();
    this.db.close();
  }
}
