import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Scheduler, ServiceError } from './scheduler.js';

const SESSION_COOKIE = 'iphonefast_session';
const SESSION_TTL = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW = 10 * 60 * 1000;
const BODY_LIMIT = 16 * 1024;
const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/shortcuts/wechat-checkin.shortcut', ['../shortcuts/wechat-checkin.shortcut', 'application/octet-stream']],
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function equalSecret(actual, expected) {
  const digest = (value) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(actual), digest(expected));
}

function json(response, status, data) {
  const body = JSON.stringify(data);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

function readJson(request, optional = false) {
  const length = request.headers['content-length'];
  if (optional && !request.headers['transfer-encoding'] && (!length || length === '0')) {
    return Promise.resolve({});
  }
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] || '')) {
    request.resume();
    throw new HttpError(415, '请求正文必须使用 application/json。');
  }
  if (length && Number(length) > BODY_LIMIT) {
    request.resume();
    throw new HttpError(413, '请求正文过大。');
  }
  return new Promise((resolveBody, reject) => {
    let size = 0;
    let chunks = [];
    let settled = false;
    request.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > BODY_LIMIT) {
        settled = true;
        chunks = [];
        reject(new HttpError(413, '请求正文过大。'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const source = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        const body = JSON.parse(source);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          throw new Error('Invalid body');
        }
        resolveBody(body);
      } catch {
        reject(new HttpError(400, '请求正文必须是有效的 JSON 对象。'));
      }
    });
    request.on('error', () => {
      if (!settled) reject(new HttpError(400, '读取请求失败。'));
      settled = true;
    });
    request.on('aborted', () => {
      if (!settled) reject(new HttpError(400, '请求已中断。'));
      settled = true;
    });
  });
}

function verifyOrigin(request) {
  try {
    const origin = new URL(request.headers.origin);
    if (!['http:', 'https:'].includes(origin.protocol)
      || origin.origin !== request.headers.origin
      || origin.host.toLowerCase() !== (request.headers.host || '').toLowerCase()) {
      throw new Error('Invalid origin');
    }
  } catch {
    throw new HttpError(403, '请通过本站页面登录或退出。');
  }
}

function normalizedConfig(config) {
  const result = {
    adminPassword: config.adminPassword,
    cookieSecure: config.cookieSecure === true,
    timezone: config.timezone || 'Asia/Shanghai',
    dataFile: config.dataFile || resolve(config.dataDir || './data', 'state.sqlite'),
  };
  if (typeof result.adminPassword !== 'string' || !result.adminPassword.trim()) {
    throw new Error('ADMIN_PASSWORD 必须设置为非空的网页登录密码。');
  }
  try {
    new Intl.DateTimeFormat('zh-CN', { timeZone: result.timezone }).format();
  } catch {
    throw new Error('TIMEZONE 必须是有效的 IANA 时区。');
  }
  return result;
}

export function configFromEnv(env = process.env) {
  const port = Number(env.PORT || 2580);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须在 1 至 65535 之间。');
  if (env.COOKIE_SECURE && !['true', 'false'].includes(env.COOKIE_SECURE)) {
    throw new Error('COOKIE_SECURE 只能设置为 true 或 false。');
  }
  return {
    adminPassword: env.ADMIN_PASSWORD,
    cookieSecure: env.COOKIE_SECURE === 'true',
    timezone: env.TIMEZONE || 'Asia/Shanghai',
    dataDir: env.DATA_DIR || './data',
    port,
    host: env.HOST || '0.0.0.0',
  };
}

export function createApplication(config) {
  const settings = normalizedConfig(config);
  const scheduler = new Scheduler({
    dataFile: settings.dataFile,
    timezone: settings.timezone,
    holidayFetch: config.holidayFetch,
  });
  const sessions = new Map();
  const failures = new Map();

  function cleanup() {
    const now = Date.now();
    for (const [token, expires] of sessions) if (expires <= now) sessions.delete(token);
    for (const [address, failure] of failures) if (failure.resetAt <= now) failures.delete(address);
  }

  function sessionToken(request) {
    for (const part of (request.headers.cookie || '').split(';')) {
      const [name, value] = part.trim().split('=');
      if (name === SESSION_COOKIE && /^[a-f0-9]{64}$/.test(value || '')) return value;
    }
    return '';
  }

  function requireSession(request) {
    if (sessions.has(sessionToken(request))) return;
    throw new HttpError(401, '请先登录。');
  }

  function setCookie(response, value, maxAge) {
    response.setHeader('Set-Cookie', `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${settings.cookieSecure ? '; Secure' : ''}`);
  }

  async function handle(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'");
    cleanup();
    let url;
    try {
      url = new URL(request.url, 'http://localhost');
    } catch {
      throw new HttpError(400, '请求地址无效。');
    }
    const { pathname } = url;

    if (pathname === '/healthz' && ['GET', 'HEAD'].includes(request.method)) {
      json(response, 200, { ok: true });
      return;
    }
    if (pathname === '/api/login' && request.method === 'POST') {
      verifyOrigin(request);
      const address = request.socket.remoteAddress || 'unknown';
      const body = await readJson(request);
      const failure = failures.get(address);
      if (failure && failure.count >= 5) {
        response.setHeader('Retry-After', Math.ceil((failure.resetAt - Date.now()) / 1000));
        throw new HttpError(429, '登录失败次数过多，请 10 分钟后重试。');
      }
      if (typeof body.password !== 'string' || !equalSecret(body.password, settings.adminPassword)) {
        if (failures.size >= 1000 && !failures.has(address)) failures.delete(failures.keys().next().value);
        failures.set(address, {
          count: (failure?.count || 0) + 1,
          resetAt: failure?.resetAt || Date.now() + LOGIN_WINDOW,
        });
        throw new HttpError(401, '密码不正确。');
      }
      failures.delete(address);
      if (sessions.size >= 256) sessions.delete(sessions.keys().next().value);
      const token = randomBytes(32).toString('hex');
      sessions.set(token, Date.now() + SESSION_TTL);
      setCookie(response, token, SESSION_TTL / 1000);
      json(response, 200, { ok: true });
      return;
    }

    if (pathname.startsWith('/api/')) {
      if (pathname.startsWith('/api/device/')) {
        if (['/api/device/poll', '/api/device/ack'].includes(pathname) && request.method !== 'POST') {
          response.setHeader('Allow', 'POST');
          throw new HttpError(405, '此接口需要 POST 请求。请在快捷指令的“获取 URL 内容”中将方法设为 POST；浏览器连通测试请访问 /healthz。');
        }
        if (pathname === '/api/device/poll' && request.method === 'POST') {
          await readJson(request, true);
          json(response, 200, scheduler.poll());
          return;
        }
        if (pathname === '/api/device/ack' && request.method === 'POST') {
          scheduler.ack(await readJson(request));
          json(response, 200, { ok: true });
          return;
        }
        throw new HttpError(404, '设备接口不存在。');
      }
      if (pathname === '/api/session' && request.method === 'GET') {
        requireSession(request);
        json(response, 200, { ok: true });
        return;
      }
      if (pathname === '/api/settings/trigger-delay' && request.method === 'PUT') {
        json(response, 200, { triggerDelay: scheduler.saveTriggerDelay(await readJson(request)) });
        return;
      }
      if (pathname === '/api/logout' && request.method === 'POST') {
        requireSession(request);
        verifyOrigin(request);
        await readJson(request, true);
        sessions.delete(sessionToken(request));
        setCookie(response, '', 0);
        json(response, 200, { ok: true });
        return;
      }
      if (pathname === '/api/state' && request.method === 'GET') {
        json(response, 200, scheduler.getState());
        return;
      }
      if (pathname === '/api/holidays' && request.method === 'GET') {
        json(response, 200, scheduler.getHolidayCalendar(url.searchParams.get('month') ?? undefined));
        return;
      }
      if (pathname === '/api/holidays/sync' && request.method === 'POST') {
        const { year } = await readJson(request, true);
        json(response, 200, await scheduler.syncHolidays(year));
        return;
      }
      if (pathname === '/api/trigger' && request.method === 'POST') {
        json(response, 202, { job: scheduler.trigger(await readJson(request, true)) });
        return;
      }
      if (pathname === '/api/schedules' && request.method === 'POST') {
        json(response, 201, { schedule: scheduler.createSchedule(await readJson(request)) });
        return;
      }
      const schedulePath = /^\/api\/schedules\/([a-zA-Z0-9_-]+)$/.exec(pathname);
      if (schedulePath && request.method === 'PUT') {
        json(response, 200, { schedule: scheduler.updateSchedule(schedulePath[1], await readJson(request)) });
        return;
      }
      if (schedulePath && request.method === 'DELETE') {
        await readJson(request, true);
        scheduler.deleteSchedule(schedulePath[1]);
        json(response, 200, { ok: true });
        return;
      }
      const jobCancelPath = /^\/api\/jobs\/([a-zA-Z0-9_-]+)\/cancel$/.exec(pathname);
      if (jobCancelPath && request.method === 'POST') {
        await readJson(request, true);
        json(response, 200, { job: scheduler.cancelJob(jobCancelPath[1]) });
        return;
      }
      throw new HttpError(404, '接口不存在。');
    }

    const file = STATIC_FILES.get(pathname);
    if (file && ['GET', 'HEAD'].includes(request.method)) {
      let body;
      try {
        body = await readFile(resolve(PUBLIC_DIR, file[0]));
      } catch (error) {
        if (error.code === 'ENOENT') throw new HttpError(404, '页面不存在。');
        throw error;
      }
      if (pathname === '/shortcuts/wechat-checkin.shortcut') {
        response.setHeader('Content-Disposition', 'attachment; filename="wechat-checkin.shortcut"');
      }
      response.writeHead(200, { 'Content-Type': file[1], 'Content-Length': body.length });
      response.end(request.method === 'HEAD' ? undefined : body);
      return;
    }
    throw new HttpError(404, '页面不存在。');
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error) => {
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof HttpError || error instanceof ServiceError) {
        json(response, error.status, { error: error.message });
      } else {
        console.error('请求处理失败。');
        json(response, 500, { error: '服务暂时无法完成操作，请稍后重试。' });
      }
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;

  return {
    server,
    scheduler,
    async close() {
      if (server.listening) {
        await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
      }
      await scheduler.close();
      sessions.clear();
      failures.clear();
    },
  };
}

async function main() {
  let config;
  let app;
  try {
    config = configFromEnv();
    // Validate separately so startup configuration errors can be reported safely.
    normalizedConfig(config);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  try {
    app = createApplication(config);
    await new Promise((resolveListen, reject) => {
      app.server.once('error', reject);
      app.server.listen(config.port, config.host, resolveListen);
    });
  } catch {
    console.error('服务启动失败，请检查数据目录权限及监听端口。');
    await app?.close();
    process.exitCode = 1;
    return;
  }
  const runTick = () => Promise.resolve(app.scheduler.tick()).catch(() => console.error('调度执行失败。'));
  const timer = setInterval(runTick, 1000);
  timer.unref();
  runTick();
  console.log(`服务已启动，监听端口 ${config.port}。`);

  let closing = false;
  async function shutdown() {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    try {
      await app.close();
    } catch {
      console.error('服务关闭失败。');
      process.exitCode = 1;
    }
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
