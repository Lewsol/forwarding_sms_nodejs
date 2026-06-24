const state = {
  busy: false
};

const elements = {
  refreshButton: document.querySelector('#refreshButton'),
  logsButton: document.querySelector('#logsButton'),
  readyBadge: document.querySelector('#readyBadge'),
  panelStatus: document.querySelector('#panelStatus'),
  modelName: document.querySelector('#modelName'),
  operator: document.querySelector('#operator'),
  signalQuality: document.querySelector('#signalQuality'),
  uptime: document.querySelector('#uptime'),
  connectionState: document.querySelector('#connectionState'),
  connectionHint: document.querySelector('#connectionHint'),
  signalValue: document.querySelector('#signalValue'),
  signalHint: document.querySelector('#signalHint'),
  moduleModel: document.querySelector('#moduleModel'),
  moduleVersion: document.querySelector('#moduleVersion'),
  iccid: document.querySelector('#iccid'),
  smsForm: document.querySelector('#smsForm'),
  smsStatus: document.querySelector('#smsStatus'),
  messagesButton: document.querySelector('#messagesButton'),
  messageCount: document.querySelector('#messageCount'),
  messageList: document.querySelector('#messageList'),
  atForm: document.querySelector('#atForm'),
  atOutput: document.querySelector('#atOutput'),
  consoleState: document.querySelector('#consoleState'),
  logWindow: document.querySelector('#logWindow')
};

function setText(node, value) {
  node.textContent = value || '--';
}

function setStatusMessage(node, message, type = '') {
  node.textContent = message;
  node.classList.toggle('is-success', type === 'success');
  node.classList.toggle('is-error', type === 'error');
}

async function requestJSON(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    ...options
  });

  const data = await response.json();
  if (!response.ok || data.success === false) {
    throw new Error(data.error || data.message || `HTTP ${response.status}`);
  }

  return data;
}

function formatUptime(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (days > 0) {
    return `${days}天 ${hours}小时 ${minutes}分`;
  }
  if (hours > 0) {
    return `${hours}小时 ${minutes}分`;
  }
  if (minutes > 0) {
    return `${minutes}分 ${secs}秒`;
  }
  return `${secs}秒`;
}

function formatModel(model = {}) {
  return [model.manufacturer, model.model].filter(Boolean).join(' ') || '--';
}

function renderStatus(status, info) {
  const data = status.data || {};
  const infoData = info.data || {};
  const model = data.model || infoData.model || {};
  const signal = data.signal || {};
  const ready = Boolean(data.ready);

  setText(elements.readyBadge, ready ? '模组已就绪' : '模组未就绪');
  setText(elements.panelStatus, ready ? 'ready' : 'not ready');
  setText(elements.modelName, formatModel(model));
  setText(elements.operator, data.operator || '未知');
  setText(elements.signalQuality, signal.quality || '未知');
  setText(elements.uptime, formatUptime(data.uptime));

  setText(elements.connectionState, ready ? '运行中' : '未就绪');
  setText(elements.connectionHint, ready ? '串口、SIM、驻网和短信配置均已通过启动检查。' : '请检查启动日志和模组初始化状态。');
  setText(elements.signalValue, signal.rssi === undefined ? '--' : `RSSI ${signal.rssi}`);
  setText(elements.signalHint, signal.ber === undefined ? 'RSSI 与误码率将在刷新后显示。' : `误码率 ${signal.ber}，质量 ${signal.quality || '未知'}。`);
  setText(elements.moduleModel, model.model || '--');
  setText(elements.moduleVersion, model.version || '--');
  setText(elements.iccid, infoData.iccid || '--');
}

function parseLogLine(line) {
  const levelMatch = line.match(/\[(INFO|WARN|ERROR)\]/);
  const timeMatch = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
  return {
    time: timeMatch ? timeMatch[1].slice(11) : '',
    level: levelMatch ? levelMatch[1] : '',
    message: line.replace(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s*/, '')
  };
}

function renderLogs(logs) {
  elements.logWindow.replaceChildren();

  if (!logs.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = '暂无日志。';
    elements.logWindow.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  logs.forEach((line) => {
    const item = parseLogLine(line);
    const row = document.createElement('div');
    row.className = `log-line is-${item.level.toLowerCase()}`;

    const level = document.createElement('span');
    level.className = 'log-level';
    level.textContent = item.level ? `${item.time} ${item.level}` : item.time;

    const message = document.createElement('span');
    message.className = 'log-message';
    message.textContent = item.message;

    row.append(level, message);
    fragment.append(row);
  });

  elements.logWindow.append(fragment);
  elements.logWindow.scrollTop = elements.logWindow.scrollHeight;
}

function formatDateTime(value) {
  if (!value) {
    return '--';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString('zh-CN', {
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function renderMessages(messages) {
  elements.messageList.replaceChildren();
  setText(elements.messageCount, `最近 ${messages.length} 条`);

  if (!messages.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state empty-state--light';
    empty.textContent = '暂无收到的短信。';
    elements.messageList.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  messages.forEach((message) => {
    const item = document.createElement('article');
    item.className = `message-item is-${message.status || 'received'}`;

    const header = document.createElement('div');
    header.className = 'message-item__header';

    const sender = document.createElement('strong');
    sender.textContent = message.sender || '未知号码';

    const status = document.createElement('span');
    status.className = 'message-status';
    status.textContent = message.statusText || '已接收';

    const time = document.createElement('time');
    time.textContent = formatDateTime(message.timestamp || message.receivedAt);

    const text = document.createElement('p');
    text.className = 'message-text';
    text.textContent = message.text || '';

    header.append(sender, status, time);
    item.append(header, text);
    fragment.append(item);
  });

  elements.messageList.append(fragment);
}

async function refreshLogs() {
  const logs = await requestJSON('/api/logs');
  renderLogs(logs.data || []);
}

async function refreshMessages() {
  const messages = await requestJSON('/api/sms/received?limit=50');
  renderMessages(messages.data || []);
}

async function refreshAll() {
  if (state.busy) {
    return;
  }

  state.busy = true;
  elements.refreshButton.disabled = true;
  elements.refreshButton.textContent = '刷新中';

  try {
    const status = await requestJSON('/api/status');
    const info = await requestJSON('/api/modem/info');
    renderStatus(status, info);
    await refreshMessages();
    await refreshLogs();
  } catch (err) {
    setText(elements.readyBadge, '刷新失败');
    setText(elements.panelStatus, 'error');
    setText(elements.connectionState, '查询失败');
    setText(elements.connectionHint, err.message);
  } finally {
    elements.refreshButton.disabled = false;
    elements.refreshButton.textContent = '刷新状态';
    state.busy = false;
  }
}

async function sendSMS(event) {
  event.preventDefault();

  const submit = elements.smsForm.querySelector('button[type="submit"]');
  const formData = new FormData(elements.smsForm);
  const phone = String(formData.get('phone') || '').trim();
  const message = String(formData.get('message') || '').trim();

  if (!phone || !message) {
    setStatusMessage(elements.smsStatus, '号码和内容都不能为空。', 'error');
    return;
  }

  submit.disabled = true;
  setStatusMessage(elements.smsStatus, '发送中...');

  try {
    const result = await requestJSON('/api/sms/send', {
      method: 'POST',
      body: JSON.stringify({ phone, message })
    });
    setStatusMessage(elements.smsStatus, result.message || '短信发送成功。', result.success ? 'success' : 'error');
    await refreshLogs();
  } catch (err) {
    setStatusMessage(elements.smsStatus, err.message, 'error');
  } finally {
    submit.disabled = false;
  }
}

async function runATCommand(event) {
  event.preventDefault();

  const submit = elements.atForm.querySelector('button[type="submit"]');
  const command = String(new FormData(elements.atForm).get('command') || '').trim();

  if (!command) {
    return;
  }

  submit.disabled = true;
  setText(elements.consoleState, 'running');
  elements.atOutput.textContent = `> ${command}\n等待响应...`;

  try {
    const result = await requestJSON('/api/modem/at', {
      method: 'POST',
      body: JSON.stringify({ command })
    });
    elements.atOutput.textContent = `> ${command}\n${result.data.response || ''}`.trim();
    setText(elements.consoleState, 'done');
    await refreshLogs();
  } catch (err) {
    elements.atOutput.textContent = `> ${command}\nERROR: ${err.message}`;
    setText(elements.consoleState, 'error');
  } finally {
    submit.disabled = false;
  }
}

elements.refreshButton.addEventListener('click', refreshAll);
elements.logsButton.addEventListener('click', refreshLogs);
elements.messagesButton.addEventListener('click', refreshMessages);
elements.smsForm.addEventListener('submit', sendSMS);
elements.atForm.addEventListener('submit', runATCommand);

refreshAll();
setInterval(() => {
  refreshMessages().catch(() => {});
}, 5000);
