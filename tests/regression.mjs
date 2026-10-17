import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const source = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
function setup(storageValues = {}) {
  const values = new Map(Object.entries(storageValues));
  const node = () => ({ style: {}, classList: { toggle() {}, add() {}, remove() {} }, addEventListener() {} });
  const context = vm.createContext({
    console, URL, Date, setInterval: () => 1, clearInterval() {}, setTimeout() {},
    requestAnimationFrame: fn => fn(), navigator: {},
    window: { addEventListener() {} },
    document: { getElementById: node, querySelector: node, querySelectorAll: () => [],
      documentElement: {}, title: '' },
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
  });
  vm.runInContext(source + '\nthis.App = ZenithApp; this.storage = storage;', context);
  const app = Object.create(context.App.prototype);
  return { app, context, values };
}

test('timer follows elapsed time after delayed callbacks and finishes once', () => {
  const { app } = setup();
  Object.assign(app, {
    deadline: Date.now() - 1500, timeLeft: 60, updateDisplay() {}, updateTitle() {}, updateProgress() {},
    finish() { this.deadline = null; this.finished = (this.finished || 0) + 1; }
  });
  app.tick(); app.tick();
  assert.equal(app.timeLeft, 0);
  assert.equal(app.finished, 1);
  app.deadline = Date.now() + 35000;
  app.tick();
  assert.ok(app.timeLeft >= 34 && app.timeLeft <= 35);
});

test('new settings survive legacy migration', () => {
  const { app, values } = setup({ zenith_settings_v1: '{"dailyGoal":8}', zenith_theme: 'dark' });
  app.settingsKey = 'zenith_settings_v1';
  app.migrateSettings();
  assert.equal(values.get(app.settingsKey), '{"dailyGoal":8}');
});

test('loading settings never writes a partial snapshot', () => {
  const { app, values } = setup();
  app.loadingSettings = true;
  app.saveSettings();
  assert.equal(values.size, 0);
});

test('invalid storage JSON and malformed collections do not break startup', () => {
  for (const value of ['{broken', 'null', '{}', '"text"', '[null,{},7]']) {
    const { app } = setup({ zenith_tasks: value, zenith_session_history: value });
    app.renderTasks = () => {};
    app.loadTasks(); app.loadSessionHistory();
    assert.equal(app.tasks.length, 0);
    assert.equal(app.sessionHistory.length, 0);
  }
});

test('storage denial degrades to in-memory operation', () => {
  const { context } = setup();
  context.localStorage.getItem = () => { throw Error('denied'); };
  context.localStorage.setItem = () => { throw Error('quota'); };
  assert.equal(context.storage.read('test', 4), 4);
  assert.doesNotThrow(() => context.storage.setItem('test', 'value'));
});

test('task content is escaped and keyboard checkbox state is exposed', () => {
  const { app } = setup();
  app.tasks = [{ id: 1, text: '<img src=x onerror="alert(1)">', done: false }];
  app.dom = { taskList: {}, taskCount: {} };
  app.renderTasks();
  assert.ok(!app.dom.taskList.innerHTML.includes('<img'));
  assert.ok(app.dom.taskList.innerHTML.includes('&lt;img'));
  assert.ok(app.dom.taskList.innerHTML.includes('role="checkbox" aria-checked="false"'));
});

test('Apple Music links require the exact HTTPS host', () => {
  const { app } = setup();
  assert.equal(app.isAppleMusicUrl('https://music.apple.com/tr/playlist/test'), true);
  for (const url of ['https://music.apple.com.evil.test/', 'https://music.apple.com@evil.test/', 'javascript:alert(1)', 'http://music.apple.com', null]) {
    assert.equal(app.isAppleMusicUrl(url), false);
  }
});

test('weekly total matches the seven chart days', () => {
  const { app } = setup();
  app.lang = 'en';
  app.sessionHistory = [0, 6, 7].map(days => {
    const date = new Date(); date.setDate(date.getDate() - days); date.setHours(12, 0, 0, 0);
    return { timestamp: date.getTime(), mode: 'focus', duration: 1500 };
  });
  assert.equal(app.getWeekMinutes(), 50);
  assert.equal(app.getLast7Days().reduce((sum, day) => sum + day.minutes, 0), 50);
});

test('focus streak remains until the end of today', () => {
  const { app } = setup();
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  app.sessionHistory = [{ timestamp: yesterday.getTime(), mode: 'focus', duration: 1500 }];
  assert.equal(app.getStreakDays(), 1);
});

const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
function worker() {
  const handlers = {};
  const context = vm.createContext({
    URL, Request, Response, console,
    self: { registration: { scope: 'https://example.test/ZenithFocus/' },
      addEventListener: (name, handler) => { handlers[name] = handler; },
      skipWaiting() {}, clients: { claim() {} } }
  });
  vm.runInContext(sw + '\nthis.assets = ASSETS_TO_CACHE; this.range = audioRange;', context);
  return { context, handlers };
}

test('offline assets resolve under the deployment subdirectory', () => {
  const { context } = worker();
  assert.ok(context.assets.every(url => url.startsWith('https://example.test/ZenithFocus/')));
  assert.ok(context.assets.includes('https://example.test/ZenithFocus/assets/rain.wav'));
});

test('offline audio supports normal, suffix and invalid byte ranges', async () => {
  const { context } = worker();
  for (const [range, status, expected] of [['bytes=2-5', 206, '2345'], ['bytes=-3', 206, '789'], ['bytes=20-', 416, '']]) {
    const response = await context.range(new Request('https://example.test/audio', { headers: { Range: range } }), new Response('0123456789'));
    assert.equal(response.status, status);
    assert.equal(await response.text(), expected);
  }
});

test('worker activation preserves unrelated application caches', async () => {
  const { context, handlers } = worker();
  const deleted = [];
  context.caches = { keys: async () => ['other-app-v1', 'zenith-focus-v2', 'zenith-focus-v4'], delete: async name => deleted.push(name) };
  let pending;
  handlers.activate({ waitUntil: promise => { pending = promise; } });
  await pending;
  assert.deepEqual(deleted, ['zenith-focus-v2']);
});

test('manifest and bundled media are valid local resources', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url)));
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  for (const name of ['rain', 'forest']) {
    const data = readFileSync(new URL(`../assets/${name}.wav`, import.meta.url));
    assert.equal(data.subarray(0, 4).toString(), 'RIFF');
    assert.ok(data.length > 100000);
  }
});

function timerApp(saved) {
  const result = setup(saved ? { zenith_timer_v1: JSON.stringify(saved) } : {});
  Object.assign(result.app, {
    modes: { focus: {}, custom: {}, short: {}, long: {} }, lang: 'en', isRunning: false,
    dom: { startBtn: {}, timer: { classList: { add() {} } } },
    setMode(mode) { this.currentMode = mode; }, updateDisplay() {}, updateProgress() {}, updateTitle() {},
    finish() { this.finished = (this.finished || 0) + 1; this.isRunning = false; this.deadline = null; this.saveTimer(); }
  });
  return result;
}

test('running timer restores the deadline without restarting the full session', () => {
  const { app } = timerApp({ mode: 'focus', totalTime: 1500, timeLeft: 1200, deadline: Date.now() + 65000 });
  app.restoreTimer();
  assert.equal(app.isRunning, true);
  assert.equal(app.totalTime, 1500);
  assert.ok(app.timeLeft >= 64 && app.timeLeft <= 65);
});

test('paused custom timer restores the remaining time', () => {
  const { app } = timerApp({ mode: 'custom', totalTime: 2400, timeLeft: 1100, deadline: null });
  app.restoreTimer();
  assert.equal(app.currentMode, 'custom');
  assert.equal(app.timeLeft, 1100);
  assert.equal(app.isRunning, false);
});

test('expired restored timer completes once and cannot repeat on reload', () => {
  const { app, values } = timerApp({ mode: 'focus', totalTime: 1500, timeLeft: 100, deadline: Date.now() - 1000 });
  app.restoreTimer(); app.tick();
  assert.equal(app.finished, 1);
  const second = timerApp(JSON.parse(values.get('zenith_timer_v1'))).app;
  second.restoreTimer();
  assert.equal(second.finished, undefined);
});

test('corrupt timer snapshots are ignored', () => {
  for (const saved of [null, {}, { mode: '__proto__' },
    { mode: 'focus', totalTime: 1500, timeLeft: 2000, deadline: null },
    { mode: 'focus', totalTime: 1500, timeLeft: 1000, deadline: 'invalid' }]) {
    const { app } = timerApp(saved);
    assert.doesNotThrow(() => app.restoreTimer());
    assert.equal(app.currentMode, undefined);
  }
});

test('CSV export preserves exact duration and ISO timestamps', () => {
  const { app } = setup();
  app.sessionHistory = [{ timestamp: Date.UTC(2026, 9, 17, 12), mode: 'custom', duration: 91 }];
  assert.equal(app.sessionsCSV(), 'timestamp,mode,duration_seconds,duration_minutes\r\n2026-10-17T12:00:00.000Z,custom,91,1.52');
  app.sessionHistory = [];
  assert.equal(app.sessionsCSV().split('\r\n').length, 1);
});
