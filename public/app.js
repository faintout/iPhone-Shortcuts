'use strict';

const $ = (id) => document.getElementById(id);
const statusLabels = {
  pending: ['待手机领取', 'pending'],
  delivered: ['已下发，等待回报', 'delivered'],
  completed: ['打卡完成', 'completed'],
  failed: ['打卡失败', 'failed'],
  unknown: ['未收到手机回报', 'unknown'],
  skipped: ['已过期未执行', 'skipped'],
};
const dayNames = ['一', '二', '三', '四', '五', '六', '日'];
let currentState = null;
let authenticated = false;
let stateRequest = null;
let editingId = null;
let scheduleOpener = null;
let scheduleScrollY = 0;
let triggering = false;
let saving = false;
let triggerDelayLoaded = false;
let savingTriggerDelay = false;
let holidayRequestId = 0;
let syncingHolidays = false;
let toastTimer;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showError(id, message) {
  $(id).textContent = message || '';
  $(id).hidden = !message;
}

function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}

function showLogin() {
  authenticated = false;
  currentState = null;
  triggerDelayLoaded = false;
  holidayRequestId++;
  $('holiday-month').value = '';
  $('loading-screen').hidden = true;
  $('app-screen').hidden = true;
  $('login-screen').hidden = false;
  hideSchedule();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    credentials: 'same-origin',
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    showLogin();
    throw new Error(data.error || '登录已失效，请重新登录。');
  }
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}），请稍后重试。`);
  return data;
}

function dateKey(value) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: currentState.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(value));
  const part = (type) => parts.find((item) => item.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function localTime(value, includeDate = false) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: currentState.timezone,
    ...(includeDate ? { month: '2-digit', day: '2-digit' } : {}),
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(date);
}

function statusBadge(status) {
  const [label, className] = statusLabels[status] || ['结果未知', 'unknown'];
  return element('span', `status-badge ${className}`, label);
}

function emptyState(title, description) {
  const node = element('div', 'empty-state');
  node.append(element('span', 'empty-symbol', '· · ·'), element('strong', '', title), element('p', '', description));
  return node;
}

function describeDays(days) {
  const sorted = [...days].sort((a, b) => a - b);
  if (sorted.join(',') === '1,2,3,4,5,6,7') return '每天';
  if (sorted.join(',') === '1,2,3,4,5') return '周一至周五';
  return sorted.map((day) => `周${dayNames[day - 1]}`).join('、');
}

function describeDelay(seconds = 0) {
  return seconds > 0 ? `领取后延时 ${seconds} 秒` : '领取后立即执行';
}

function describeDelayRange(schedule) {
  if (schedule.useDelay === false) return '不使用延迟 · 领取后立即执行';
  const { delayMinSeconds: min, delayMaxSeconds: max } = currentState.triggerDelay;
  return min === max ? `全局等待 ${min} 秒` : `全局随机等待 ${min}–${max} 秒`;
}

function readDelayRange() {
  const min = $('trigger-delay-min');
  const max = $('trigger-delay-max');
  max.setCustomValidity('');
  if (!min.reportValidity() || !max.reportValidity()) return null;
  if (Number(min.value) > Number(max.value)) {
    max.setCustomValidity('最大秒数不能小于最小秒数。');
    max.reportValidity();
    return null;
  }
  return { delayMinSeconds: Number(min.value), delayMaxSeconds: Number(max.value) };
}

function renderToday(jobs) {
  const list = $('today-list');
  list.textContent = '';
  $('today-count').textContent = jobs.length;
  if (!jobs.length) {
    list.append(emptyState('今天还没有定时任务', '新建并启用计划后，今日安排会显示在这里。'));
    return;
  }
  jobs.sort((a, b) => a.plannedTime.localeCompare(b.plannedTime)).forEach((job) => {
    const row = element('div', 'today-row');
    const info = element('div', 'today-info');
    info.append(element('strong', '', job.scheduleName || '定时任务'), element('span', 'small-text muted', describeDelay(job.delaySeconds)), statusBadge(job.status));
    row.append(element('time', 'planned-time', job.plannedTime), info);
    list.append(row);
  });
}

function actionButton(label, className, handler) {
  const button = element('button', `button text-button compact ${className}`, label);
  button.type = 'button';
  button.addEventListener('click', handler);
  return button;
}

function renderSchedules(schedules) {
  const list = $('schedules-list');
  list.textContent = '';
  if (!schedules.length) {
    list.append(emptyState('从一个计划开始', '设置日期和时间窗口，手机在窗口内主动查询领取待办。'));
    return;
  }
  schedules.forEach((schedule) => {
    const card = element('article', `schedule-card${schedule.enabled ? '' : ' paused'}`);
    const heading = element('div', 'schedule-card-heading');
    heading.append(element('h3', '', schedule.name), element('span', `status-badge ${schedule.enabled ? 'enabled' : 'skipped'}`, schedule.enabled ? '已启用' : '已暂停'));
    const timing = element('div', 'schedule-timing');
    const fixed = schedule.startTime === schedule.endTime;
    timing.append(element('strong', '', fixed ? schedule.startTime : `${schedule.startTime} — ${schedule.endTime}`), element('span', '', fixed ? '固定时间' : '随机窗口'), element('span', '', describeDelayRange(schedule)));
    const footer = element('div', 'schedule-card-footer');
    const actions = element('div', 'schedule-actions');
    actions.append(
      actionButton('编辑', '', () => openSchedule(schedule)),
      actionButton(schedule.enabled ? '暂停' : '启用', '', (event) => toggleSchedule(schedule, event.currentTarget)),
      actionButton('删除', 'danger-text', (event) => deleteSchedule(schedule, event.currentTarget)),
    );
    footer.append(element('span', 'repeat-days', `${describeDays(schedule.days)}${schedule.holidayAware ? ' · 启用调休补班' : ''}`), actions);
    card.append(heading, timing, footer);
    list.append(card);
  });
}

function renderHistory(jobs) {
  const list = $('history-list');
  list.textContent = '';
  if (!jobs.length) {
    list.append(emptyState('暂无打卡记录', '点击立即打卡或由手机领取定时待办后，可在这里查看状态。'));
    return;
  }
  const heading = element('div', 'history-row history-heading');
  ['任务 / 来源', '时间', '执行状态', '运行日志'].forEach((label) => heading.append(element('span', '', label)));
  list.append(heading);
  jobs.sort((a, b) => new Date(b.finishedAt || b.deliveredAt || b.createdAt) - new Date(a.finishedAt || a.deliveredAt || a.createdAt)).forEach((job) => {
    const row = element('div', 'history-row');
    const info = element('div', 'history-info');
    info.append(element('strong', '', job.source === 'manual' ? '立即打卡' : (job.scheduleName || '定时任务')), element('span', 'small-text muted', `${job.source === 'manual' ? '手动登记' : '定时计划'} · ${describeDelay(job.delaySeconds)}`));
    const status = element('div', 'history-status');
    status.append(statusBadge(job.status));
    if (job.error) status.append(element('p', 'job-error', job.error));
    const log = element('div', 'history-log');
    log.append(element('span', 'history-log-label small-text muted', '运行日志'), element('pre', 'job-log', job.callbackJson || '暂无运行日志'));
    row.append(info, element('time', 'history-time', localTime(job.finishedAt || job.deliveredAt || job.createdAt, true)), status, log);
    list.append(row);
  });
}

function renderState() {
  const state = currentState;
  const today = dateKey(state.serverTime);
  const todayJobs = state.jobs.filter((job) => job.date === today);
  if (!triggerDelayLoaded) {
    const triggerDelay = state.triggerDelay || { delayMinSeconds: 0, delayMaxSeconds: 0 };
    $('trigger-delay-min').value = triggerDelay.delayMinSeconds;
    $('trigger-delay-max').value = triggerDelay.delayMaxSeconds;
    $('trigger-delay-max').setCustomValidity('');
    triggerDelayLoaded = true;
  }
  $('timezone-label').textContent = state.timezone;
  $('today-date').textContent = `${today} · 最早可领取分钟`;
  $('pending-count').textContent = todayJobs.filter((job) => job.status === 'pending').length;
  $('completed-count').textContent = todayJobs.filter((job) => job.status === 'completed').length;
  $('enabled-count').textContent = state.schedules.filter((schedule) => schedule.enabled).length;
  $('server-time').textContent = `服务器时间 ${localTime(state.serverTime)}`;
  $('trigger-button').disabled = !state.deviceConfigured || triggering;
  $('trigger-now-button').disabled = !state.deviceConfigured || triggering;
  $('save-trigger-delay-button').disabled = !state.deviceConfigured || savingTriggerDelay;
  renderToday(todayJobs.filter((job) => job.source === 'schedule'));
  renderSchedules(state.schedules);
  renderHistory(state.jobs.filter((job) => job.status !== 'pending' || job.source === 'manual'));
  $('refresh-status').textContent = `${localTime(state.serverTime)} 已更新 · 点击刷新获取最新状态`;
  if (!$('holiday-month').value) $('holiday-month').value = today.slice(0, 7);
}

const holidayLabels = ['上班', '周末', '节日', '调休', '补班'];

function renderHolidaySyncStatus(syncedAt) {
  $('holiday-sync-status').textContent = syncedAt
    ? `最近同步：${new Intl.DateTimeFormat('zh-CN', { timeZone: currentState.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(syncedAt))} · 每月 1 日 00:00 自动更新`
    : '该年份尚未同步，当前仅按星期预览。请更新节假日信息；启用调休补班的计划在同步成功后执行。';
}

async function loadHolidayCalendar() {
  const month = $('holiday-month').value;
  if (!currentState || !$('holiday-month').checkValidity()) return;
  const requestId = ++holidayRequestId;
  try {
    const calendar = await api(`/api/holidays?month=${encodeURIComponent(month)}`);
    if (requestId !== holidayRequestId || !authenticated) return;
    const body = $('holiday-days');
    body.textContent = '';
    const offset = (new Date(`${month}-01T12:00:00Z`).getUTCDay() + 6) % 7;
    const today = dateKey(currentState.serverTime);
    let row;
    const cells = Math.ceil((offset + calendar.days.length) / 7) * 7;
    for (let index = 0; index < cells; index++) {
      if (index % 7 === 0) {
        row = element('tr');
        body.append(row);
      }
      const day = calendar.days[index - offset];
      const cell = element('td');
      if (day) {
        cell.className = `holiday-type-${day.type}${day.date === today ? ' calendar-today' : ''}`;
        cell.title = `${day.date} ${day.type === 3 ? '调休放假' : holidayLabels[day.type]}`;
        const date = element('time', '', Number(day.date.slice(-2)));
        date.dateTime = day.date;
        if (day.date === today) date.setAttribute('aria-current', 'date');
        cell.append(date, element('span', '', holidayLabels[day.type]));
      } else {
        cell.className = 'calendar-empty';
      }
      row.append(cell);
    }
    const workdays = calendar.days.filter((day) => day.type === 0 || day.type === 4).length;
    const makeup = calendar.days.filter((day) => day.type === 4).length;
    $('holiday-summary').textContent = `本月上班 ${workdays} 天 · 其中补班 ${makeup} 天`;
    renderHolidaySyncStatus(calendar.syncedAt);
    showError('holiday-error', '');
  } catch (error) {
    if (requestId === holidayRequestId && authenticated) showError('holiday-error', error.message);
  }
}

$('holiday-month').addEventListener('change', () => {
  $('holiday-days').textContent = '';
  $('holiday-summary').textContent = '';
  $('holiday-sync-status').textContent = '正在读取节假日信息…';
  loadHolidayCalendar();
});

$('sync-holidays-button').addEventListener('click', async () => {
  if (syncingHolidays || !currentState || !$('holiday-month').reportValidity()) return;
  syncingHolidays = true;
  const button = $('sync-holidays-button');
  button.disabled = true;
  button.textContent = '正在更新…';
  showError('holiday-error', '');
  try {
    const year = Number($('holiday-month').value.slice(0, 4));
    const result = await api('/api/holidays/sync', { method: 'POST', body: JSON.stringify({ year }) });
    if (authenticated && Number($('holiday-month').value.slice(0, 4)) === result.year) {
      holidayRequestId++;
      renderHolidaySyncStatus(result.syncedAt);
    }
    toast(`${result.year} 年节假日信息已更新，共 ${result.count} 天`);
    await refreshAfterWrite();
  } catch (error) {
    showError('holiday-error', error.message);
  } finally {
    syncingHolidays = false;
    button.disabled = false;
    button.textContent = '更新节假日信息';
  }
});

function refreshState() {
  if (stateRequest) return stateRequest;
  stateRequest = (async () => {
    try {
      await api('/api/session');
      currentState = await api('/api/state');
      authenticated = true;
      renderState();
      $('loading-screen').hidden = true;
      $('login-screen').hidden = true;
      $('app-screen').hidden = false;
      await loadHolidayCalendar();
      showError('page-error', '');
      return true;
    } catch (error) {
      if (authenticated) {
        showError('page-error', `刷新失败：${error.message}`);
        $('refresh-status').textContent = '连接异常，请点击刷新重试';
      } else {
        showLogin();
        if (!error.message.includes('登录')) showError('login-error', `无法连接服务器：${error.message}`);
      }
      return false;
    } finally {
      stateRequest = null;
    }
  })();
  return stateRequest;
}

async function refreshAfterWrite() {
  if (stateRequest) await stateRequest;
  await refreshState();
}

function openSchedule(schedule) {
  editingId = schedule ? schedule.id : null;
  $('schedule-form').reset();
  $('dialog-title').textContent = schedule ? '编辑计划' : '新建计划';
  $('schedule-name').value = schedule ? schedule.name : '';
  $('start-time').value = schedule ? schedule.startTime : '09:00';
  $('end-time').value = schedule ? schedule.endTime : '09:10';
  $('schedule-enabled').checked = schedule ? schedule.enabled : true;
  $('schedule-holiday-aware').checked = schedule?.holidayAware ?? false;
  $('schedule-use-delay').checked = schedule?.useDelay ?? true;
  const days = schedule ? schedule.days : [1, 2, 3, 4, 5];
  document.querySelectorAll('input[name="days"]').forEach((input) => { input.checked = days.includes(Number(input.value)); });
  showError('schedule-error', '');
  scheduleOpener = document.activeElement;
  scheduleScrollY = window.scrollY;
  document.body.style.top = `-${scheduleScrollY}px`;
  document.body.classList.add('modal-open');
  $('schedule-modal').hidden = false;
  $('schedule-modal').scrollTop = 0;
  $('schedule-name').focus();
  $('app-screen').setAttribute('aria-hidden', 'true');
}

async function toggleSchedule(schedule, button) {
  button.disabled = true;
  try {
    await api(`/api/schedules/${encodeURIComponent(schedule.id)}`, {
      method: 'PUT',
      body: JSON.stringify({ name: schedule.name, startTime: schedule.startTime, endTime: schedule.endTime, days: schedule.days, enabled: !schedule.enabled, holidayAware: schedule.holidayAware ?? false, useDelay: schedule.useDelay ?? true }),
    });
    toast(schedule.enabled ? '计划已暂停' : '计划已启用');
    await refreshAfterWrite();
  } catch (error) {
    showError('page-error', error.message);
  } finally {
    button.disabled = false;
  }
}

async function deleteSchedule(schedule, button) {
  if (!window.confirm(`删除计划“${schedule.name}”？之后将不再生成此计划的待办。`)) return;
  button.disabled = true;
  try {
    await api(`/api/schedules/${encodeURIComponent(schedule.id)}`, { method: 'DELETE' });
    toast('计划已删除');
    await refreshAfterWrite();
  } catch (error) {
    showError('page-error', error.message);
  } finally {
    button.disabled = false;
  }
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('login-button');
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = '正在登录…';
  showError('login-error', '');
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('password').value }) });
    $('password').value = '';
    await refreshState();
  } catch (error) {
    showError('login-error', error.message);
  } finally {
    button.disabled = false;
    button.textContent = '登录控制台';
  }
});

$('logout-button').addEventListener('click', async () => {
  const button = $('logout-button');
  button.disabled = true;
  try {
    if (stateRequest) await stateRequest;
    await api('/api/logout', { method: 'POST' });
    showLogin();
    showError('login-error', '');
  } catch (error) {
    showError('page-error', error.message);
  } finally {
    button.disabled = false;
  }
});

async function triggerCheckin(withDelay) {
  if (triggering || !currentState || !currentState.deviceConfigured) return;
  const payload = withDelay ? readDelayRange() : { delaySeconds: 0 };
  if (!payload) return;
  triggering = true;
  const button = $(withDelay ? 'trigger-button' : 'trigger-now-button');
  const label = button.textContent;
  $('trigger-button').disabled = true;
  $('trigger-now-button').disabled = true;
  button.textContent = '正在提交…';
  showError('page-error', '');
  try {
    const { job } = await api('/api/trigger', { method: 'POST', body: JSON.stringify(payload) });
    toast(`已登记，${describeDelay(job.delaySeconds)}。请在 5 分钟内由手机查询领取。`);
    await refreshAfterWrite();
  } catch (error) {
    showError('page-error', error.message);
  } finally {
    triggering = false;
    button.textContent = label;
    $('trigger-button').disabled = !currentState || !currentState.deviceConfigured;
    $('trigger-now-button').disabled = !currentState || !currentState.deviceConfigured;
  }
}

async function saveTriggerDelay() {
  if (savingTriggerDelay || !currentState || !currentState.deviceConfigured) return;
  const range = readDelayRange();
  if (!range) return;
  savingTriggerDelay = true;
  const button = $('save-trigger-delay-button');
  button.disabled = true;
  button.textContent = '正在保存…';
  showError('page-error', '');
  try {
    const { triggerDelay } = await api('/api/settings/trigger-delay', {
      method: 'PUT', body: JSON.stringify(range),
    });
    currentState.triggerDelay = triggerDelay;
    triggerDelayLoaded = true;
    toast('随机等待时长已保存');
    await refreshAfterWrite();
  } catch (error) {
    showError('page-error', error.message);
  } finally {
    savingTriggerDelay = false;
    button.disabled = !currentState || !currentState.deviceConfigured;
    button.textContent = '保存等待时长';
  }
}

$('trigger-button').addEventListener('click', () => triggerCheckin(true));
$('trigger-now-button').addEventListener('click', () => triggerCheckin(false));
$('save-trigger-delay-button').addEventListener('click', saveTriggerDelay);
for (const suffix of ['min', 'max']) {
  $(`trigger-delay-${suffix}`).addEventListener('input', () => $('trigger-delay-max').setCustomValidity(''));
}

$('add-schedule-button').addEventListener('click', () => openSchedule());
function hideSchedule() {
  if ($('schedule-modal').hidden) return;
  $('schedule-modal').hidden = true;
  $('app-screen').removeAttribute('aria-hidden');
  document.body.classList.remove('modal-open');
  document.body.style.top = '';
  if (authenticated) {
    const opener = scheduleOpener?.isConnected ? scheduleOpener : $('add-schedule-button');
    opener.focus({ preventScroll: true });
  }
  window.scrollTo(0, scheduleScrollY);
  scheduleOpener = null;
}

function closeSchedule() {
  if (!saving) hideSchedule();
}
$('close-dialog-button').addEventListener('click', closeSchedule);
$('cancel-schedule-button').addEventListener('click', closeSchedule);
document.addEventListener('keydown', (event) => {
  if ($('schedule-modal').hidden) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeSchedule();
  }
  if (event.key !== 'Tab') return;
  const controls = $('schedule-dialog').querySelectorAll('button:not(:disabled), input:not(:disabled)');
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (!$('schedule-dialog').contains(document.activeElement) ||
      (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
});

$('schedule-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (saving) return;
  const useDelay = $('schedule-use-delay').checked;
  const payload = {
    name: $('schedule-name').value.trim(),
    startTime: $('start-time').value,
    endTime: $('end-time').value,
    days: [...document.querySelectorAll('input[name="days"]:checked')].map((input) => Number(input.value)),
    enabled: $('schedule-enabled').checked,
    holidayAware: $('schedule-holiday-aware').checked,
    useDelay,
  };
  if (!payload.name) return showError('schedule-error', '请输入计划名称。');
  if (!payload.days.length) return showError('schedule-error', '请至少选择一个重复日期。');
  if (payload.startTime > payload.endTime) return showError('schedule-error', '结束时间不能早于开始时间，不支持跨天窗口。');
  saving = true;
  const button = $('save-schedule-button');
  button.disabled = true;
  button.textContent = '正在保存…';
  showError('schedule-error', '');
  try {
    await api(editingId ? `/api/schedules/${encodeURIComponent(editingId)}` : '/api/schedules', {
      method: editingId ? 'PUT' : 'POST', body: JSON.stringify(payload),
    });
    hideSchedule();
    toast('计划已保存');
    await refreshAfterWrite();
  } catch (error) {
    showError('schedule-error', error.message);
  } finally {
    saving = false;
    button.disabled = false;
    button.textContent = '保存计划';
  }
});

$('refresh-button').addEventListener('click', async () => {
  $('refresh-button').disabled = true;
  await refreshState();
  $('refresh-button').disabled = false;
});

refreshState();
