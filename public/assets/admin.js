const state = {
  busy: false,
  mobileDataBusy: false,
  trafficBusy: false,
  currentMobileData: null,
  pushChannels: [],
  selectedPushChannel: -1,
  pushLoaded: false
};

const elements = {
  pushSettingsButton: document.querySelector('#pushSettingsButton'),
  pushModal: document.querySelector('#pushModal'),
  pushModalClose: document.querySelector('#pushModalClose'),
  pushAddTypeSelect: document.querySelector('#pushAddTypeSelect'),
  pushAddButton: document.querySelector('#pushAddButton'),
  pushDeleteButton: document.querySelector('#pushDeleteButton'),
  pushSaveButton: document.querySelector('#pushSaveButton'),
  pushTestButton: document.querySelector('#pushTestButton'),
  pushChannelList: document.querySelector('#pushChannelList'),
  pushChannelForm: document.querySelector('#pushChannelForm'),
  pushFormFields: document.querySelector('#pushFormFields'),
  pushStatus: document.querySelector('#pushStatus'),
  pushUrlLabel: document.querySelector('#pushUrlLabel'),
  pushSecretLabel: document.querySelector('#pushSecretLabel'),
  pushKey1Label: document.querySelector('#pushKey1Label'),
  pushKey2Label: document.querySelector('#pushKey2Label'),
  refreshButton: document.querySelector('#refreshButton'),
  logsButton: document.querySelector('#logsButton'),
  readyBadge: document.querySelector('#readyBadge'),
  panelStatus: document.querySelector('#panelStatus'),
  modelName: document.querySelector('#modelName'),
  operator: document.querySelector('#operator'),
  signalQuality: document.querySelector('#signalQuality'),
  mobileDataSummary: document.querySelector('#mobileDataSummary'),
  uptime: document.querySelector('#uptime'),
  connectionState: document.querySelector('#connectionState'),
  connectionHint: document.querySelector('#connectionHint'),
  signalValue: document.querySelector('#signalValue'),
  signalHint: document.querySelector('#signalHint'),
  mobileDataState: document.querySelector('#mobileDataState'),
  mobileDataHint: document.querySelector('#mobileDataHint'),
  mobileDataToggle: document.querySelector('#mobileDataToggle'),
  mobileDataConsume: document.querySelector('#mobileDataConsume'),
  mobileDataTrafficHint: document.querySelector('#mobileDataTrafficHint'),
  mobileDataStatus: document.querySelector('#mobileDataStatus'),
  moduleModel: document.querySelector('#moduleModel'),
  moduleVersion: document.querySelector('#moduleVersion'),
  iccid: document.querySelector('#iccid'),
  smsForm: document.querySelector('#smsForm'),
  smsStatus: document.querySelector('#smsStatus'),
  messagesButton: document.querySelector('#messagesButton'),
  messageCount: document.querySelector('#messageCount'),
  messageScope: document.querySelector('#messageScope'),
  messageList: document.querySelector('#messageList'),
  atForm: document.querySelector('#atForm'),
  atOutput: document.querySelector('#atOutput'),
  consoleState: document.querySelector('#consoleState'),
  logWindow: document.querySelector('#logWindow')
};

const PUSH_TYPE_OPTIONS = {
  dingtalk: '钉钉机器人',
  feishu: '飞书机器人',
  telegram: 'Telegram Bot',
  pushplus: 'PushPlus',
  serverchan: 'Server酱',
  post_json: 'POST JSON',
  bark: 'Bark',
  get: 'GET',
  custom: '自定义 POST'
};

const PUSH_TYPE_META = {
  dingtalk: {
    urlLabel: '钉钉 Webhook URL',
    secretLabel: '加签密钥',
    show: ['url', 'secret']
  },
  feishu: {
    urlLabel: '飞书 Webhook URL',
    secretLabel: '加签密钥',
    show: ['url', 'secret']
  },
  telegram: {
    urlLabel: 'Bot Token',
    key1Label: 'Chat ID',
    show: ['url', 'key1']
  },
  pushplus: {
    key1Label: 'PushPlus Token',
    show: ['key1']
  },
  serverchan: {
    key1Label: 'Server酱 SendKey',
    show: ['key1']
  },
  post_json: {
    urlLabel: 'POST URL',
    show: ['url']
  },
  bark: {
    urlLabel: 'Bark 推送 URL',
    show: ['url']
  },
  get: {
    urlLabel: 'GET URL',
    show: ['url']
  },
  custom: {
    urlLabel: 'POST URL',
    show: ['url', 'customBody']
  }
};

function setText(node, value) {
  if (!node) return;
  node.textContent = value || '--';
}

function setStatusMessage(node, message, type = '') {
  if (!node) return;
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

function formatMobileDataMode(mode) {
  if (mode === 'mipcall') {
    return 'MIPCALL';
  }
  if (mode === 'cgact') {
    return 'CGACT';
  }
  return 'AT';
}

function formatMobileDataContexts(contexts = []) {
  const active = contexts
    .filter(item => item.active)
    .map(item => `CID ${item.cid}`)
    .join('、');

  return active || '';
}

function renderMobileData(mobileData = {}) {
  state.currentMobileData = mobileData;
  const unknown = mobileData.status === 'unknown';
  const enabled = Boolean(mobileData.enabled || mobileData.anyActive);
  const cid = mobileData.cid || 1;
  const mode = formatMobileDataMode(mobileData.mode);
  const isMipcall = mobileData.mode === 'mipcall';
  const activeContexts = formatMobileDataContexts(mobileData.contexts || []);

  if (unknown) {
    setText(elements.mobileDataSummary, '未知');
    setText(elements.mobileDataState, '状态未知');
    setText(elements.mobileDataHint, mobileData.error || (isMipcall ? '未能确认应用层拨号状态，可先强制断开。' : '未能确认移动数据状态，可先强制关闭。'));
    elements.mobileDataToggle.textContent = isMipcall ? '强制断开拨号' : '强制关闭流量';
    elements.mobileDataToggle.dataset.action = 'disable';
    elements.mobileDataConsume.classList.add('is-hidden');
    elements.mobileDataTrafficHint.classList.remove('is-hidden');
    elements.mobileDataTrafficHint.textContent = '状态确认后，开启流量才会显示消耗流量按钮。';
  } else if (enabled) {
    setText(elements.mobileDataSummary, isMipcall ? '已连接' : '已开启');
    setText(elements.mobileDataState, isMipcall ? '应用拨号已连接' : '流量已开启');
    setText(elements.mobileDataHint, activeContexts ? `${mode} 检测到 ${activeContexts} 处于活动状态。` : `CID ${cid} 处于活动状态。`);
    elements.mobileDataToggle.textContent = isMipcall ? '断开拨号' : '关闭流量';
    elements.mobileDataToggle.dataset.action = 'disable';
    elements.mobileDataConsume.classList.remove('is-hidden');
    elements.mobileDataTrafficHint.classList.add('is-hidden');
  } else {
    setText(elements.mobileDataSummary, isMipcall ? '已断开' : '已关闭');
    setText(elements.mobileDataState, isMipcall ? '应用拨号已断开' : '流量已关闭');
    setText(elements.mobileDataHint, isMipcall ? `${mode} CID ${cid} 未建立应用层拨号连接；已保护性尝试停用PDP。` : `${mode} CID ${cid} 未建立移动数据连接，重启后也会先保持关闭。`);
    elements.mobileDataToggle.textContent = isMipcall ? '开启拨号' : '开启流量';
    elements.mobileDataToggle.dataset.action = 'enable';
    elements.mobileDataConsume.classList.add('is-hidden');
    elements.mobileDataTrafficHint.classList.remove('is-hidden');
    elements.mobileDataTrafficHint.textContent = isMipcall ? '先开启拨号后，才可以执行一次MPING消耗少量流量。' : '先开启流量后，才可以执行一次MPING消耗少量流量。';
  }

  elements.mobileDataToggle.disabled = state.mobileDataBusy;
  elements.mobileDataConsume.disabled = state.mobileDataBusy || state.trafficBusy || !enabled;
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
  renderMobileData(data.mobileData || {});

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

function renderMessages(messages, meta = {}) {
  elements.messageList.replaceChildren();
  const currentSimLabel = meta.currentSim?.simLabel || '当前SIM未知';
  const countLabel = meta.partitionBySim ? `${currentSimLabel} 最近 ${messages.length} 条` : `全部SIM 最近 ${messages.length} 条`;
  const scopeLabel = meta.partitionBySim
    ? (meta.currentSimKnown ? '仅显示当前SIM收到的短信' : '未识别当前SIM，收件箱已隐藏')
    : 'SIM隔离未启用';

  setText(elements.messageCount, countLabel);
  setText(elements.messageScope, scopeLabel);

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

    const metaRow = document.createElement('div');
    metaRow.className = 'message-meta';

    const sim = document.createElement('span');
    sim.className = 'message-sim';
    sim.textContent = message.simLabel || '未知SIM';

    metaRow.append(sim);
    header.append(sender, status, time);
    item.append(header, metaRow, text);
    fragment.append(item);
  });

  elements.messageList.append(fragment);
}

function getPushTypeLabel(type) {
  return PUSH_TYPE_OPTIONS[type] || type || '推送通道';
}

function createDefaultPushChannel(type = 'dingtalk') {
  return {
    enabled: true,
    type,
    name: `${getPushTypeLabel(type)}通知`,
    url: '',
    secret: '',
    key1: '',
    key2: '',
    customBody: type === 'custom' ? '{"from":"{sender}","message":"{message}","timestamp":"{timestamp}"}' : ''
  };
}

function normalizePushChannel(channel = {}) {
  const fallback = createDefaultPushChannel(channel.type || 'dingtalk');
  return {
    ...fallback,
    enabled: Boolean(channel.enabled),
    type: String(channel.type || fallback.type),
    name: String(channel.name || fallback.name),
    url: String(channel.url || ''),
    secret: String(channel.secret || ''),
    key1: String(channel.key1 || ''),
    key2: String(channel.key2 || ''),
    customBody: String(channel.customBody || '')
  };
}

function setPushStatus(message, type = '') {
  setStatusMessage(elements.pushStatus, message, type);
}

function getPushControls() {
  return elements.pushChannelForm.elements;
}

function readPushChannelForm() {
  const controls = getPushControls();
  return {
    enabled: controls.enabled.checked,
    type: String(controls.type.value || 'dingtalk'),
    name: String(controls.name.value || '').trim(),
    url: String(controls.url.value || '').trim(),
    secret: String(controls.secret.value || '').trim(),
    key1: String(controls.key1.value || '').trim(),
    key2: String(controls.key2.value || '').trim(),
    customBody: String(controls.customBody.value || '').trim()
  };
}

function writePushChannelForm(channel) {
  const controls = getPushControls();
  controls.enabled.checked = Boolean(channel.enabled);
  controls.type.value = channel.type;
  controls.name.value = channel.name;
  controls.url.value = channel.url;
  controls.secret.value = channel.secret;
  controls.key1.value = channel.key1;
  controls.key2.value = channel.key2;
  controls.customBody.value = channel.customBody;
  updatePushFieldVisibility(channel.type);
}

function clearPushChannelForm() {
  writePushChannelForm(createDefaultPushChannel());
}

function setPushFieldVisible(name, visible) {
  const row = elements.pushChannelForm.querySelector(`[data-push-field="${name}"]`);
  if (row) {
    row.classList.toggle('is-hidden', !visible);
  }
}

function updatePushFieldVisibility(type) {
  const meta = PUSH_TYPE_META[type] || PUSH_TYPE_META.dingtalk;
  const visibleFields = new Set(meta.show || []);

  elements.pushUrlLabel.textContent = meta.urlLabel || 'Webhook URL';
  elements.pushSecretLabel.textContent = meta.secretLabel || '密钥';
  elements.pushKey1Label.textContent = meta.key1Label || 'Key1';
  elements.pushKey2Label.textContent = meta.key2Label || 'Key2';

  ['url', 'secret', 'key1', 'key2', 'customBody'].forEach((name) => {
    setPushFieldVisible(name, visibleFields.has(name));
  });
}

function syncCurrentPushChannel() {
  const index = state.selectedPushChannel;
  if (index < 0 || !state.pushChannels[index] || elements.pushFormFields.disabled) {
    return;
  }

  state.pushChannels[index] = normalizePushChannel(readPushChannelForm());
}

function renderPushChannelList() {
  elements.pushChannelList.replaceChildren();

  if (!state.pushChannels.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state empty-state--light';
    empty.textContent = '暂无推送通道。';
    elements.pushChannelList.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  state.pushChannels.forEach((channel, index) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `channel-list__item${index === state.selectedPushChannel ? ' is-active' : ''}`;

    const name = document.createElement('span');
    name.className = 'channel-list__name';
    name.textContent = channel.name || getPushTypeLabel(channel.type);

    const meta = document.createElement('span');
    meta.className = 'channel-list__meta';

    const type = document.createElement('span');
    type.textContent = getPushTypeLabel(channel.type);

    const status = document.createElement('span');
    status.textContent = channel.enabled ? '启用' : '停用';

    meta.append(type, status);
    item.append(name, meta);
    item.addEventListener('click', () => {
      selectPushChannel(index);
    });
    fragment.append(item);
  });

  elements.pushChannelList.append(fragment);
}

function renderPushChannelForm() {
  const channel = state.pushChannels[state.selectedPushChannel];
  const hasChannel = Boolean(channel);

  elements.pushFormFields.disabled = !hasChannel;
  elements.pushTestButton.disabled = !hasChannel;
  elements.pushDeleteButton.disabled = !hasChannel;
  elements.pushSaveButton.disabled = !state.pushLoaded;

  if (!hasChannel) {
    clearPushChannelForm();
    return;
  }

  writePushChannelForm(channel);
}

function renderPushSettings() {
  renderPushChannelList();
  renderPushChannelForm();
}

function selectPushChannel(index) {
  syncCurrentPushChannel();
  state.selectedPushChannel = index;
  renderPushSettings();
  setPushStatus('');
}

function addPushChannel() {
  syncCurrentPushChannel();
  const type = elements.pushAddTypeSelect?.value || 'dingtalk';
  state.pushChannels.push(createDefaultPushChannel(type));
  state.selectedPushChannel = state.pushChannels.length - 1;
  renderPushSettings();
  setPushStatus('');
}

function deletePushChannel() {
  if (state.selectedPushChannel < 0) {
    return;
  }

  state.pushChannels.splice(state.selectedPushChannel, 1);
  state.selectedPushChannel = Math.min(state.selectedPushChannel, state.pushChannels.length - 1);
  renderPushSettings();
  setPushStatus('');
}

async function loadPushChannels() {
  elements.pushAddButton.disabled = true;
  elements.pushSaveButton.disabled = true;
  elements.pushTestButton.disabled = true;
  elements.pushDeleteButton.disabled = true;
  setPushStatus('加载中...');

  try {
    const result = await requestJSON('/api/push/channels');
    state.pushChannels = (result.data || []).map(normalizePushChannel);
    state.selectedPushChannel = state.pushChannels.length ? 0 : -1;
    state.pushLoaded = true;
    renderPushSettings();
    setPushStatus('');
  } catch (err) {
    setPushStatus(err.message, 'error');
  } finally {
    elements.pushAddButton.disabled = false;
    elements.pushSaveButton.disabled = !state.pushLoaded;
  }
}

function openPushModal() {
  elements.pushModal.classList.add('is-open');
  elements.pushModal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');

  if (!state.pushLoaded) {
    loadPushChannels();
  } else {
    renderPushSettings();
    setPushStatus('');
  }
}

function closePushModal() {
  syncCurrentPushChannel();
  elements.pushModal.classList.remove('is-open');
  elements.pushModal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
}

async function savePushChannels(event) {
  event.preventDefault();
  syncCurrentPushChannel();

  elements.pushSaveButton.disabled = true;
  setPushStatus('保存中...');

  try {
    const result = await requestJSON('/api/push/channels', {
      method: 'PUT',
      body: JSON.stringify({ channels: state.pushChannels })
    });
    state.pushChannels = (result.data || []).map(normalizePushChannel);
    if (state.selectedPushChannel >= state.pushChannels.length) {
      state.selectedPushChannel = state.pushChannels.length - 1;
    }
    renderPushSettings();
    setPushStatus(result.message || '推送通道配置已保存。', 'success');
    await refreshLogs();
  } catch (err) {
    setPushStatus(err.message, 'error');
  } finally {
    elements.pushSaveButton.disabled = false;
  }
}

async function testPushChannel() {
  syncCurrentPushChannel();

  const channel = state.pushChannels[state.selectedPushChannel];
  if (!channel) {
    setPushStatus('请先新增一个推送通道。', 'error');
    return;
  }

  elements.pushTestButton.disabled = true;
  setPushStatus('测试发送中...');

  try {
    const result = await requestJSON('/api/push/test', {
      method: 'POST',
      body: JSON.stringify({ channel })
    });
    setPushStatus(result.message || '测试推送已发送。', 'success');
    await refreshLogs();
  } catch (err) {
    setPushStatus(err.message, 'error');
  } finally {
    elements.pushTestButton.disabled = false;
  }
}

function handlePushTypeChange() {
  const controls = getPushControls();
  const channel = state.pushChannels[state.selectedPushChannel];
  const previousType = channel?.type || 'dingtalk';
  const previousDefaultName = createDefaultPushChannel(previousType).name;
  const type = controls.type.value;
  const nextDefaultName = createDefaultPushChannel(type).name;
  const currentName = controls.name.value.trim();

  updatePushFieldVisibility(type);
  if (!currentName || currentName === previousDefaultName) {
    controls.name.value = nextDefaultName;
  }
  if (type === 'custom' && !controls.customBody.value.trim()) {
    controls.customBody.value = createDefaultPushChannel('custom').customBody;
  }
  syncCurrentPushChannel();
}

async function refreshLogs() {
  const logs = await requestJSON('/api/logs');
  renderLogs(logs.data || []);
}

async function refreshMessages() {
  const messages = await requestJSON('/api/sms/received?limit=50');
  renderMessages(messages.data || [], messages.meta || {});
}

async function toggleMobileData() {
  if (state.mobileDataBusy) {
    return;
  }

  const action = elements.mobileDataToggle.dataset.action || 'disable';
  const enabled = action === 'enable';

  if (enabled && !window.confirm('开启移动数据可能产生流量费用，确定要开启吗？')) {
    return;
  }

  state.mobileDataBusy = true;
  elements.mobileDataToggle.disabled = true;
  setStatusMessage(elements.mobileDataStatus, enabled ? '正在开启...' : '正在关闭...');

  try {
    const result = await requestJSON('/api/modem/mobile-data', {
      method: 'POST',
      body: JSON.stringify({ enabled })
    });
    renderMobileData(result.data || {});
    setStatusMessage(elements.mobileDataStatus, result.message || (enabled ? '已开启。' : '已关闭。'), 'success');
    await refreshLogs();
  } catch (err) {
    setStatusMessage(elements.mobileDataStatus, err.message, 'error');
  } finally {
    state.mobileDataBusy = false;
    renderMobileData(state.currentMobileData || {});
  }
}

async function consumeMobileDataTraffic() {
  if (state.mobileDataBusy || state.trafficBusy) {
    return;
  }

  state.trafficBusy = true;
  elements.mobileDataToggle.disabled = true;
  elements.mobileDataConsume.disabled = true;
  setStatusMessage(elements.mobileDataStatus, '正在执行MPING，会消耗少量流量...');

  try {
    const result = await requestJSON('/api/modem/mobile-data/consume', {
      method: 'POST',
      body: JSON.stringify({ target: '8.8.8.8' })
    });
    renderMobileData(result.data?.mobileData || state.currentMobileData || {});
    const pingMessage = result.data?.ping?.message || result.message || '已完成流量消耗测试。';
    setStatusMessage(elements.mobileDataStatus, pingMessage, 'success');
    await refreshLogs();
  } catch (err) {
    setStatusMessage(elements.mobileDataStatus, err.message, 'error');
  } finally {
    state.trafficBusy = false;
    renderMobileData(state.currentMobileData || {});
  }
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
    setStatusMessage(elements.mobileDataStatus, '');
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
  elements.atOutput.textContent = `› ${command}\n等待响应...`;

  try {
    const result = await requestJSON('/api/modem/at', {
      method: 'POST',
      body: JSON.stringify({ command })
    });
    elements.atOutput.textContent = `› ${command}\n${result.data.response || ''}`.trim();
    setText(elements.consoleState, 'done');
    await refreshLogs();
  } catch (err) {
    elements.atOutput.textContent = `› ${command}\nERROR: ${err.message}`;
    setText(elements.consoleState, 'error');
  } finally {
    submit.disabled = false;
  }
}

elements.pushSettingsButton.addEventListener('click', openPushModal);
elements.pushModalClose.addEventListener('click', closePushModal);
elements.pushModal.addEventListener('click', (event) => {
  if (event.target.matches('[data-close-push-modal]')) {
    closePushModal();
  }
});
elements.pushAddButton.addEventListener('click', addPushChannel);
elements.pushDeleteButton.addEventListener('click', deletePushChannel);
elements.pushChannelForm.addEventListener('submit', savePushChannels);
elements.pushTestButton.addEventListener('click', testPushChannel);
elements.pushChannelForm.elements.type.addEventListener('change', handlePushTypeChange);
elements.refreshButton.addEventListener('click', refreshAll);
elements.mobileDataToggle.addEventListener('click', toggleMobileData);
elements.mobileDataConsume.addEventListener('click', consumeMobileDataTraffic);
elements.logsButton.addEventListener('click', refreshLogs);
elements.messagesButton.addEventListener('click', refreshMessages);
elements.smsForm.addEventListener('submit', sendSMS);
elements.atForm.addEventListener('submit', runATCommand);

const ctaPushButton = document.querySelector('#ctaPushButton');
const ctaRefreshButton = document.querySelector('#ctaRefreshButton');
const footerPushLink = document.querySelector('#footerPushLink');
const footerYear = document.querySelector('#footerYear');

if (ctaPushButton) ctaPushButton.addEventListener('click', openPushModal);
if (ctaRefreshButton) ctaRefreshButton.addEventListener('click', refreshAll);
if (footerPushLink) footerPushLink.addEventListener('click', (event) => {
  event.preventDefault();
  openPushModal();
});
if (footerYear) footerYear.textContent = String(new Date().getFullYear());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && elements.pushModal.classList.contains('is-open')) {
    closePushModal();
  }
});

refreshAll();
setInterval(() => {
  refreshMessages().catch(() => {});
}, 5000);
