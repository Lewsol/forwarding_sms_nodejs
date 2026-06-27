import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';
import { Submit } from 'node-pdu';
import EventEmitter from 'events';
import fs from 'fs';
import path from 'path';
import logger from './logger.js';

class ModemManager extends EventEmitter {
  constructor(config, mobileDataConfig = {}, appConfig = {}) {
    super();
    this.config = config;
    this.appConfig = appConfig;
    this.mobileDataConfig = {
      cid: this.normalizeMobileDataCid(mobileDataConfig.cid)
    };
    this.smsSending = false;
    this.port = null;
    this.parser = null;
    this.atCommandQueue = Promise.resolve();
    this.ready = false;
    this.modelInfo = {
      manufacturer: '未知',
      model: '未知',
      version: '未知'
    };
    this.sim = {
      supported: false,
      canSwitch: false,
      mode: null,
      modeLabel: '未知',
      activeSlot: null,
      switchSlot: null,
      bindSlot: null,
      switching: false,
      probing: false,
      slots: this.createSimSlots(),
      lastCheckedAt: null,
      error: '',
      notice: '直出模式下按模组URC接收短信；URC未携带卡槽时显示未知SIM。'
    };
    this.mobileData = {
      cid: this.mobileDataConfig.cid,
      desiredEnabled: false,
      enabled: false,
      targetEnabled: false,
      anyActive: false,
      status: 'disabled',
      mode: 'unknown',
      contexts: [],
      lastCheckedAt: null,
      error: ''
    };
  }

  createSimSlots() {
    return [0, 1].map(slot => this.createSimSlot(slot));
  }

  createSimSlot(slot) {
    const phoneNumber = this.getConfiguredSimPhoneNumber(slot);

    return {
      slot,
      name: `SIM${slot + 1}`,
      active: false,
      present: null,
      phoneNumber,
      phoneLabel: phoneNumber || `SIM${slot + 1}`,
      lastCheckedAt: null
    };
  }

  /**
   * 打开串口并初始化模组
   */
  async open() {
    try {
      const portPath = await this.resolvePortPath();

      logger.info(`准备打开串口: ${portPath} (${this.config.baudRate})`);

      // 打开串口
      this.port = new SerialPort({
        path: portPath,
        baudRate: this.config.baudRate,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        autoOpen: false
      });

      // 设置行解析器
      this.parser = this.port.pipe(new ReadlineParser({ delimiter: '\r\n' }));

      // 监听串口事件
      this.port.on('error', (err) => {
        logger.error('串口错误:', err);
        this.emit('error', err);
      });

      this.port.on('close', () => {
        logger.warn('串口已关闭');
        this.ready = false;
        this.emit('close');
      });

      // 监听URC（主动上报）消息
      this.setupURCListener();

      // 等待串口打开
      await new Promise((resolve, reject) => {
        this.port.open((err) => {
          if (err) {
            reject(err);
            return;
          }

          resolve();
        });
      });
      this.config.path = portPath;
      logger.info(`串口已打开: ${portPath}`);

      // 初始化模组
      await this.init();

    } catch (err) {
      logger.error('打开串口失败:', err);
      throw err;
    }
  }

  /**
   * 自动探测能响应AT命令的串口；可通过 serial.autoDetect=false 关闭。
   */
  async resolvePortPath() {
    const manualPath = this.normalizePortPath(this.config.path);

    if (this.config.autoDetect === false) {
      return manualPath;
    }

    const candidates = await this.getSerialProbeCandidates(manualPath);
    if (candidates.length === 0) {
      throw new Error('未发现可探测的串口设备');
    }

    logger.info(`开始自动探测AT串口: ${this.formatProbeCandidateList(candidates)}`);

    const timeout = this.config.probeTimeout || 1200;
    const failures = [];

    for (const candidate of candidates) {
      const result = await this.probeATPort(candidate.path, timeout);
      if (result.ok) {
        logger.info(`✓ 自动探测到AT串口: ${candidate.path}`);
        return candidate.path;
      }

      failures.push(result);
      logger.debug(`串口探测未通过: ${candidate.path} (${this.formatProbeFailure(result)})`);
    }

    const summary = failures
      .slice(0, 8)
      .map(item => `${item.path}: ${this.formatProbeFailure(item)}`)
      .join('; ');

    throw new Error(`未找到可响应AT的串口，已探测 ${failures.length} 个端口${summary ? ` (${summary})` : ''}`);
  }

  normalizePortPath(portPath) {
    if (!portPath) {
      return null;
    }

    const normalized = String(portPath).trim();
    if (process.platform === 'win32' && /^\d+$/.test(normalized)) {
      return `COM${normalized}`;
    }

    return normalized;
  }

  async getSerialProbeCandidates(manualPath) {
    const candidates = new Map();

    const addCandidate = (path, portInfo = {}, manual = false) => {
      if (!path) {
        return;
      }

      const candidate = candidates.get(path) || {
        path,
        portInfo: {},
        manual: false
      };

      candidate.portInfo = { ...candidate.portInfo, ...portInfo };
      candidate.manual = candidate.manual || manual;
      candidate.metadata = this.getPortMetadata(path, candidate.portInfo);
      candidate.priority = this.getProbeCandidatePriority(path, candidate.portInfo, candidate.manual, candidate.metadata);
      candidates.set(path, candidate);
    };

    let ports = [];
    try {
      ports = await SerialPort.list();
    } catch (err) {
      logger.warn(`读取系统串口列表失败: ${err.message}`);
    }

    for (const portInfo of ports) {
      addCandidate(this.normalizePortPath(portInfo.path), portInfo);
    }

    addCandidate(manualPath, {}, true);

    return Array.from(candidates.values())
      .sort((a, b) => a.priority - b.priority || a.path.localeCompare(b.path));
  }

  getProbeCandidatePriority(portPath, portInfo, manual, metadata) {
    const interfaceName = (metadata.interfaceName || '').toLowerCase();
    const interfaceNumber = metadata.interfaceNumber;

    if (interfaceName.includes('at interface') || /\bat\b/.test(interfaceName)) {
      return interfaceNumber === null ? 0 : interfaceNumber;
    }

    if (portInfo.vendorId === '2ecc' && portInfo.productId === '3012') {
      // ML307A: if02/if03 are AT interfaces; if04 is Diag; if00/if01 are RNDIS.
      if (interfaceNumber === 2 || interfaceNumber === 3) {
        return interfaceNumber;
      }

      return 40 + (interfaceNumber ?? 9);
    }

    if (interfaceName.includes('diag')) {
      return 40;
    }

    if (interfaceName.includes('rndis') || interfaceName.includes('network')) {
      return 50;
    }

    if (portInfo.vendorId || portInfo.productId || /usb|acm/i.test(portPath)) {
      return 20;
    }

    if (/^COM\d+$/i.test(portPath)) {
      return 30;
    }

    if (manual) {
      return 35;
    }

    return 80;
  }

  getPortMetadata(portPath, portInfo) {
    const metadata = {
      interfaceName: '',
      interfaceNumber: this.parseUSBInterfaceNumber(portInfo.pnpId)
    };

    if (process.platform !== 'linux') {
      return metadata;
    }

    const ttyName = this.getTTYName(portPath);
    if (!ttyName) {
      return metadata;
    }

    try {
      const ttyDevicePath = fs.realpathSync(`/sys/class/tty/${ttyName}/device`);
      const usbInterfacePath = path.dirname(ttyDevicePath);
      metadata.interfaceName = this.readFirstLine(path.join(usbInterfacePath, 'interface')) || '';

      const sysfsInterfaceNumber = this.readFirstLine(path.join(usbInterfacePath, 'bInterfaceNumber'));
      if (sysfsInterfaceNumber) {
        metadata.interfaceNumber = Number.parseInt(sysfsInterfaceNumber, 16);
      }
    } catch (err) {
      // Some platforms expose serial ports without Linux USB sysfs metadata.
    }

    return metadata;
  }

  parseUSBInterfaceNumber(pnpId) {
    const match = String(pnpId || '').match(/if(\d+)/i);
    if (!match) {
      return null;
    }

    return Number.parseInt(match[1], 10);
  }

  getTTYName(portPath) {
    try {
      return path.basename(fs.realpathSync(portPath));
    } catch (err) {
      return path.basename(portPath);
    }
  }

  readFirstLine(filePath) {
    try {
      return fs.readFileSync(filePath, 'utf8').split('\n')[0].trim();
    } catch (err) {
      return '';
    }
  }

  formatProbeCandidateList(candidates) {
    const paths = candidates.map(item => item.path);
    if (paths.length <= 12) {
      return paths.join(', ');
    }

    return `${paths.slice(0, 12).join(', ')} ... 共${paths.length}个`;
  }

  async probeATPort(path, timeout = 1200) {
    return new Promise((resolve) => {
      let buffer = '';
      let settled = false;

      const port = new SerialPort({
        path,
        baudRate: this.config.baudRate,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        autoOpen: false
      });

      const done = (result) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        port.removeListener('data', onData);
        port.removeListener('error', onError);

        const finalResult = {
          path,
          ...result,
          response: buffer
        };

        if (port.isOpen) {
          port.close(() => resolve(finalResult));
          return;
        }

        resolve(finalResult);
      };

      const onData = (data) => {
        buffer += data.toString('utf8');
        if (buffer.includes('OK')) {
          done({ ok: true, reason: 'ok' });
        } else if (buffer.includes('ERROR')) {
          done({ ok: false, reason: 'error_response' });
        }
      };

      const onError = (err) => {
        done({ ok: false, reason: 'error', error: err.message });
      };

      const timer = setTimeout(() => {
        done({ ok: false, reason: 'timeout' });
      }, timeout);

      port.on('data', onData);
      port.on('error', onError);

      port.open((err) => {
        if (err) {
          done({ ok: false, reason: 'open_error', error: err.message });
          return;
        }

        port.write('AT\r\n', (writeErr) => {
          if (writeErr) {
            done({ ok: false, reason: 'write_error', error: writeErr.message });
          }
        });
      });
    });
  }

  formatProbeFailure(result) {
    if (result.error) {
      return `${result.reason}: ${result.error}`;
    }

    return result.reason;
  }

  normalizeMobileDataCid(value) {
    const cid = Number.parseInt(value, 10);
    if (Number.isInteger(cid) && cid > 0 && cid <= 15 && cid !== 8) {
      return cid;
    }

    return 1;
  }

  getConfiguredSimPhoneNumber(slotNumber) {
    const slot = this.normalizeSimSlot(slotNumber);
    if (slot === null) {
      return '';
    }

    const sources = [
      this.appConfig?.simCards,
      this.appConfig?.simSlots,
      this.appConfig?.sims,
      this.appConfig?.sim
    ];

    for (const source of sources) {
      const phoneNumber = this.extractConfiguredSimPhoneNumber(source, slot);
      if (phoneNumber) {
        return phoneNumber;
      }
    }

    return '';
  }

  extractConfiguredSimPhoneNumber(source, slot) {
    if (!source) {
      return '';
    }

    let candidate = null;
    if (Array.isArray(source)) {
      candidate = source.find(item => this.normalizeSimSlot(item?.slot ?? item?.simSlot ?? item?.sim) === slot) ||
        source[slot];
    } else if (typeof source === 'object') {
      candidate = source[slot] ?? source[String(slot)] ?? source[`sim${slot + 1}`] ?? source[`SIM${slot + 1}`];
    }

    if (typeof candidate === 'string' || typeof candidate === 'number') {
      return this.normalizePhoneNumber(candidate);
    }

    if (candidate && typeof candidate === 'object') {
      return this.normalizePhoneNumber(candidate.phoneNumber ?? candidate.phone ?? candidate.msisdn ?? candidate.number);
    }

    return '';
  }

  normalizePhoneNumber(value) {
    const text = String(value || '').trim();
    if (!text) {
      return '';
    }

    const normalized = text.replace(/[^\d+]/g, '');
    return normalized.length >= 3 ? normalized : '';
  }

  normalizeSimSlot(value) {
    if (typeof value === 'string') {
      const normalized = value.trim().toUpperCase();
      if (normalized === 'SIM1') {
        return 0;
      }
      if (normalized === 'SIM2') {
        return 1;
      }
    }

    const slot = Number.parseInt(value, 10);
    return slot === 0 || slot === 1 ? slot : null;
  }

  getCachedSimStatus() {
    return {
      ...this.sim,
      slots: this.sim.slots.map(slot => ({ ...slot }))
    };
  }

  isSimSwitching() {
    return Boolean(this.sim.switching);
  }

  formatDualSimMode(mode) {
    if (mode === 0) {
      return '双卡双待';
    }
    if (mode === 1) {
      return '双卡单待';
    }
    if (mode === 3) {
      return '双卡双待(FP)';
    }
    return '未知';
  }

  parseDualSimMode(resp) {
    const match = String(resp || '').match(/\+DUALSIM:\s*(\d+)/);
    if (!match) {
      return null;
    }

    const mode = Number.parseInt(match[1], 10);
    return Number.isInteger(mode) ? mode : null;
  }

  parseSimSlotResponse(resp, prefix) {
    const pattern = new RegExp(`\\+${prefix}:\\s*(\\d+)`, 'i');
    const match = String(resp || '').match(pattern);
    if (!match) {
      return null;
    }

    return this.normalizeSimSlot(match[1]);
  }

  markActiveSimSlot(status, activeSlot) {
    status.activeSlot = activeSlot;
    status.slots = status.slots.map(slot => ({
      ...slot,
      active: slot.slot === activeSlot
    }));
  }

  updateSimSlotPresence(status, slotNumber, present) {
    const slot = this.normalizeSimSlot(slotNumber);
    if (slot === null) {
      return;
    }

    status.slots = status.slots.map(item => {
      if (item.slot !== slot) {
        return item;
      }

      return {
        ...item,
        present: Boolean(present),
        lastCheckedAt: new Date().toISOString()
      };
    });
  }

  getBusinessSimSlot(status = this.sim) {
    return this.normalizeSimSlot(status.bindSlot) ?? this.normalizeSimSlot(status.switchSlot);
  }

  getSimSlotLabel(slotNumber) {
    const slot = this.normalizeSimSlot(slotNumber);
    if (slot === null) {
      return '未知SIM';
    }

    const slotInfo = this.sim.slots.find(item => item.slot === slot);
    return slotInfo?.phoneLabel || slotInfo?.phoneNumber || `SIM${slot + 1}`;
  }

  updateSimSlotPhoneNumber(status, slotNumber, phoneNumber) {
    const slot = this.normalizeSimSlot(slotNumber);
    if (slot === null) {
      return;
    }

    const normalized = this.normalizePhoneNumber(phoneNumber);
    if (!normalized) {
      return;
    }

    status.slots = status.slots.map(item => {
      if (item.slot !== slot) {
        return item;
      }

      return {
        ...item,
        phoneNumber: normalized,
        phoneLabel: normalized,
        lastCheckedAt: new Date().toISOString()
      };
    });
  }

  parseOwnNumberResponse(resp) {
    const lines = String(resp || '')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      if (/^AT/i.test(line) || line === 'OK' || line === 'ERROR') {
        continue;
      }

      const match = line.match(/^\+CNUM:\s*(?:"[^"]*")?\s*,\s*"?([^",\s]*)"?/i);
      if (match) {
        return this.normalizePhoneNumber(match[1]);
      }
    }

    return '';
  }

  async queryOwnPhoneNumber() {
    try {
      const resp = await this.sendATCommand('AT+CNUM', 2000);
      return this.parseOwnNumberResponse(resp);
    } catch (err) {
      logger.debug(`查询当前SIM手机号失败: ${err.message}`);
      return '';
    }
  }

  async readCurrentSimSlotPhoneNumber(slotNumber, context = '当前') {
    const slot = this.normalizeSimSlot(slotNumber);
    if (slot === null) {
      return false;
    }

    const phoneNumber = await this.queryOwnPhoneNumber();
    if (!phoneNumber) {
      logger.debug(`${context}SIM${slot + 1}未读取到手机号`);
      return false;
    }

    this.updateSimSlotPhoneNumber(this.sim, slot, phoneNumber);
    logger.info(`✓ ${context}SIM${slot + 1}手机号: ${phoneNumber}`);
    return true;
  }

  async switchSimForIdentityRead(slotNumber, options = {}) {
    const targetSlot = this.normalizeSimSlot(slotNumber);
    if (targetSlot === null) {
      throw new Error('SIM卡槽参数无效，只支持 SIM1 或 SIM2');
    }

    const {
      context = '启动探测',
      purpose = '',
      retries = 2,
      retryDelay = 2000,
      settleDelay = 3000,
      confirmTimeout = 15000,
      confirmInterval = 1000,
      simReadyAttempts = 10,
      simReadyDelay = 1000
    } = options;

    const currentSlot = await this.querySwitchSimSlot().catch(() => this.sim.switchSlot);
    this.sim.switchSlot = currentSlot;

    if (currentSlot === targetSlot) {
      try {
        await this.waitSIMReady({
          attempts: simReadyAttempts,
          delay: simReadyDelay,
          label: `SIM${targetSlot + 1}`
        });
        this.updateSimSlotPresence(this.sim, targetSlot, true);
      } catch (err) {
        this.updateSimSlotPresence(this.sim, targetSlot, false);
        throw err;
      }

      return targetSlot;
    }

    logger.info(`${context}: 切到SIM${targetSlot + 1}${purpose ? purpose : ''}`);
    let switched = false;

    for (let attempt = 1; attempt <= retries && !switched; attempt++) {
      try {
        const resp = await this.sendATCommand(`AT+SWITCHSIM=${targetSlot}`, 10000);
        if (!resp.includes('OK')) {
          logger.warn(`${context}切到SIM${targetSlot + 1}返回非OK(${attempt}/${retries}): ${this.formatATResponse(resp)}`);
        }
      } catch (err) {
        logger.warn(`${context}切到SIM${targetSlot + 1}命令失败(${attempt}/${retries}): ${err.message}`);
      }

      switched = await this.waitForSwitchSimSlot(targetSlot, confirmTimeout, confirmInterval);
      if (!switched && attempt < retries && retryDelay > 0) {
        await this.sleep(retryDelay);
      }
    }

    if (!switched) {
      throw new Error(`${context}切到SIM${targetSlot + 1}失败`);
    }

    this.sim.switchSlot = targetSlot;
    this.markActiveSimSlot(this.sim, this.getBusinessSimSlot(this.sim) ?? targetSlot);
    await this.sleep(settleDelay);

    try {
      await this.waitSIMReady({
        attempts: simReadyAttempts,
        delay: simReadyDelay,
        label: `SIM${targetSlot + 1}`
      });
      this.updateSimSlotPresence(this.sim, targetSlot, true);
    } catch (err) {
      this.updateSimSlotPresence(this.sim, targetSlot, false);
      await this.restoreSwitchSimSlot(currentSlot, `${context}失败后回退`).catch((restoreErr) => {
        logger.warn(`${context}失败后回退SIM失败: ${restoreErr.message}`);
      });
      throw err;
    }

    return targetSlot;
  }

  async restoreSwitchSimSlot(slotNumber, context = 'SIM回退', timeout = 20000) {
    const slot = this.normalizeSimSlot(slotNumber);
    if (slot === null) {
      return false;
    }

    logger.warn(`${context}: 恢复到SIM${slot + 1}`);
    await this.sendATCommand(`AT+SWITCHSIM=${slot}`, 10000).catch((err) => {
      logger.warn(`${context}命令失败: ${err.message}`);
    });

    const restored = await this.waitForSwitchSimSlot(slot, timeout, 1000);
    if (restored) {
      this.sim.switchSlot = slot;
      this.markActiveSimSlot(this.sim, this.getBusinessSimSlot(this.sim) ?? slot);
      return true;
    }

    logger.warn(`${context}: 未能确认恢复到SIM${slot + 1}`);
    return false;
  }

  async restoreBindSimSlot(slotNumber, context = '业务SIM回退') {
    const slot = this.normalizeSimSlot(slotNumber);
    if (slot === null) {
      return false;
    }

    await this.sendATWithRetry(`AT+BINDSIM=${slot}`, {
      timeout: 5000,
      retries: 1,
      retryDelay: 500,
      label: `${context}到SIM${slot + 1}`
    }).catch((err) => {
      logger.warn(`${context}到SIM${slot + 1}失败: ${err.message}`);
    });

    return true;
  }

  async restoreSimAfterProbe(switchSlot, bindSlot, context = 'SIM探测后恢复') {
    const targetSwitchSlot = this.normalizeSimSlot(switchSlot);
    const targetBindSlot = this.normalizeSimSlot(bindSlot) ?? targetSwitchSlot;

    if (targetSwitchSlot !== null) {
      await this.restoreSwitchSimSlot(targetSwitchSlot, context).catch((err) => {
        logger.warn(`${context}切回SIM${targetSwitchSlot + 1}失败: ${err.message}`);
      });
    }

    if (targetBindSlot !== null) {
      await this.restoreBindSimSlot(targetBindSlot, context);
    }
  }

  async probeInactiveSimSlot(status, slotNumber, originalSlot, originalBindSlot = originalSlot) {
    const targetSlot = this.normalizeSimSlot(slotNumber);
    const restoreSlot = this.normalizeSimSlot(originalSlot);
    const restoreBindSlot = this.normalizeSimSlot(originalBindSlot) ?? restoreSlot;
    if (targetSlot === null || restoreSlot === null || targetSlot === restoreSlot) {
      return false;
    }

    logger.info(`探测SIM${targetSlot + 1}是否可用`);
    let switched = false;

    try {
      const resp = await this.sendATCommand(`AT+SWITCHSIM=${targetSlot}`, 10000);
      if (!resp.includes('OK')) {
        logger.warn(`探测SIM${targetSlot + 1}切换返回非OK: ${this.formatATResponse(resp)}`);
      }

      switched = await this.waitForSwitchSimSlot(targetSlot, 15000, 1000);
      if (!switched) {
        this.updateSimSlotPresence(status, targetSlot, false);
        return false;
      }

      await this.sleep(1000);
      await this.waitSIMReady({
        attempts: 5,
        delay: 1000,
        label: `SIM${targetSlot + 1}`
      });
      this.updateSimSlotPresence(status, targetSlot, true);
      return true;
    } catch (err) {
      logger.warn(`探测SIM${targetSlot + 1}失败: ${err.message}`);
      this.updateSimSlotPresence(status, targetSlot, false);
      return false;
    } finally {
      if (switched) {
        await this.restoreSimAfterProbe(restoreSlot, restoreBindSlot, `探测SIM${targetSlot + 1}后恢复`);
      }
    }
  }

  async probeSimSlotPresence(status, currentSlot) {
    const originalSlot = this.normalizeSimSlot(currentSlot);
    if (!status.supported || !status.canSwitch || originalSlot === null) {
      return status;
    }

    if (this.sim.switching || this.sim.probing) {
      return status;
    }

    const originalBindSlot = this.normalizeSimSlot(status.bindSlot) ?? originalSlot;

    this.sim.probing = true;
    try {
      for (const slot of status.slots) {
        if (slot.slot !== originalSlot) {
          await this.probeInactiveSimSlot(status, slot.slot, originalSlot, originalBindSlot);
        }
      }

      await this.restoreSimAfterProbe(originalSlot, originalBindSlot, 'SIM探测结束恢复');

      const restoredSlot = await this.querySwitchSimSlot().catch(() => originalSlot);
      status.switchSlot = this.normalizeSimSlot(restoredSlot) ?? originalSlot;
      status.bindSlot = await this.queryBindSimSlot();
      this.markActiveSimSlot(status, this.getBusinessSimSlot(status));
      return status;
    } finally {
      this.sim.probing = false;
      status.probing = false;
    }
  }

  async waitForSwitchSimSlot(targetSlot, timeout = 15000, interval = 1000) {
    const startedAt = Date.now();

    while (Date.now() - startedAt <= timeout) {
      try {
        const currentSlot = await this.querySwitchSimSlot();
        this.sim.switchSlot = currentSlot;
        if (currentSlot === targetSlot) {
          return true;
        }
      } catch (err) {
        logger.debug(`等待SWITCHSIM生效失败: ${err.message}`);
      }

      await this.sleep(interval);
    }

    return false;
  }

  async ensureATSimMatchesBinding(context = 'SIM同步') {
    if (!this.sim.supported || !this.sim.canSwitch) {
      return null;
    }

    const bindSlot = this.normalizeSimSlot(this.sim.bindSlot ?? await this.queryBindSimSlot());
    if (bindSlot === null) {
      return null;
    }

    const switchSlot = await this.querySwitchSimSlot();
    this.sim.switchSlot = switchSlot;
    this.markActiveSimSlot(this.sim, bindSlot);

    if (switchSlot === bindSlot) {
      return {
        slot: bindSlot,
        changed: false
      };
    }

    const currentLabel = switchSlot === null ? '未知' : `SIM${switchSlot + 1}`;
    logger.warn(`${context}: 业务绑定为SIM${bindSlot + 1}，但AT当前为${currentLabel}，准备同步AT卡槽`);
    await this.switchSimForIdentityRead(bindSlot, {
      context,
      purpose: '用于短信发送',
      retries: 4,
      retryDelay: 3000,
      settleDelay: 3000
    });

    return {
      slot: bindSlot,
      changed: true
    };
  }

  async discoverSimSlotIdentities() {
    const status = await this.refreshSimStatus({ refreshIdentity: false });
    const currentSlot = this.normalizeSimSlot(status.switchSlot) ??
      this.normalizeSimSlot(status.activeSlot) ??
      0;

    logger.info(`启动仅初始化当前SIM${currentSlot + 1}，不读取SMSC、不遍历其他卡槽`);
    await this.waitSIMReady();
    await this.readCurrentSimSlotPhoneNumber(currentSlot, '启动当前');
    this.sim.lastCheckedAt = new Date().toISOString();

    return this.getCachedSimStatus();
  }

  identifyIncomingSms(metadata = {}) {
    const urcSlot = this.normalizeSimSlot(metadata.simSlot);
    if (urcSlot !== null) {
      return {
        slot: urcSlot,
        source: metadata.simSource || 'urc'
      };
    }

    return null;
  }

  async queryDualSimMode() {
    try {
      const resp = await this.sendATCommand('AT+DUALSIM?', 2000);
      const mode = this.parseDualSimMode(resp);
      if (mode === null) {
        return {
          supported: false,
          mode: null,
          modeLabel: '未检测到双卡能力',
          error: this.formatATResponse(resp)
        };
      }

      return {
        supported: true,
        mode,
        modeLabel: this.formatDualSimMode(mode),
        error: ''
      };
    } catch (err) {
      return {
        supported: false,
        mode: null,
        modeLabel: '未检测到双卡能力',
        error: err.message
      };
    }
  }

  async querySwitchSimSlot() {
    const resp = await this.sendATCommand('AT+SWITCHSIM?', 2000);
    return this.parseSimSlotResponse(resp, 'SWITCHSIM');
  }

  async queryBindSimSlot() {
    try {
      const resp = await this.sendATCommand('AT+BINDSIM?', 2000);
      return this.parseSimSlotResponse(resp, 'BINDSIM');
    } catch (err) {
      logger.debug(`查询BINDSIM失败: ${err.message}`);
      return null;
    }
  }

  isSimReadyResponse(resp) {
    return String(resp || '').includes('+CPIN: READY');
  }

  async isCurrentSimReady(timeout = 2000) {
    try {
      const resp = await this.sendATCommand('AT+CPIN?', timeout);
      return this.isSimReadyResponse(resp);
    } catch (err) {
      logger.debug(`查询当前SIM就绪状态失败: ${err.message}`);
      return false;
    }
  }

  async getSimStatus(options = {}) {
    return await this.refreshSimStatus(options);
  }

  async refreshSimStatus(options = {}) {
    const refreshIdentity = options.refreshIdentity === true;
    const probeSlots = options.probeSlots === true;
    const status = {
      ...this.sim,
      slots: this.sim.slots.map(slot => ({ ...slot })),
      error: ''
    };

    try {
      const dualSim = await this.queryDualSimMode();
      status.supported = dualSim.supported;
      status.canSwitch = false;
      status.mode = dualSim.mode;
      status.modeLabel = dualSim.modeLabel;

      if (!dualSim.supported) {
        status.activeSlot = null;
        status.switchSlot = null;
        status.bindSlot = null;
        status.error = dualSim.error || '';
        status.lastCheckedAt = new Date().toISOString();
        this.sim = status;
        return this.getCachedSimStatus();
      }

      const switchSlot = await this.querySwitchSimSlot();
      if (switchSlot !== null) {
        status.canSwitch = true;
        status.switchSlot = switchSlot;
        const currentSimReady = await this.isCurrentSimReady();
        this.updateSimSlotPresence(status, switchSlot, currentSimReady);
      } else {
        status.switchSlot = null;
        status.error = '未能读取当前AT SIM卡槽';
      }

      status.bindSlot = await this.queryBindSimSlot();
      this.markActiveSimSlot(status, this.getBusinessSimSlot(status));

      if (refreshIdentity && switchSlot !== null) {
        const phoneNumber = await this.queryOwnPhoneNumber();
        this.updateSimSlotPhoneNumber(status, switchSlot, phoneNumber);
      }

      if (probeSlots && status.canSwitch && switchSlot !== null) {
        await this.probeSimSlotPresence(status, switchSlot);
      }

      status.lastCheckedAt = new Date().toISOString();
      this.sim = status;
      return this.getCachedSimStatus();
    } catch (err) {
      logger.warn(`查询SIM状态失败: ${err.message}`);
      status.error = err.message;
      status.lastCheckedAt = new Date().toISOString();
      this.sim = status;
      return this.getCachedSimStatus();
    }
  }

  async switchSim(slotNumber) {
    const targetSlot = this.normalizeSimSlot(slotNumber);
    if (targetSlot === null) {
      throw new Error('SIM卡槽参数无效，只支持 SIM1 或 SIM2');
    }

    if (this.sim.switching) {
      throw new Error('SIM正在切换中，请稍后再试');
    }

    const before = await this.refreshSimStatus({ refreshIdentity: false });
    if (!before.supported || !before.canSwitch) {
      logger.warn(`绑定SIM前状态不可用: supported=${before.supported}, canSwitch=${before.canSwitch}, bindSlot=${before.bindSlot ?? 'unknown'}, switchSlot=${before.switchSlot ?? 'unknown'}, error=${before.error || 'none'}`);
      throw new Error(before.error || '当前模组未检测到双卡绑定能力');
    }

    if (this.normalizeSimSlot(before.bindSlot) === targetSlot && this.normalizeSimSlot(before.switchSlot) === targetSlot) {
      logger.info(`当前已经绑定并切到SIM${targetSlot + 1}`);
      return {
        changed: false,
        status: await this.refreshSimStatus({ refreshIdentity: false })
      };
    }

    logger.info(`准备切到并绑定SIM${targetSlot + 1}`);
    this.sim.switching = true;

    try {
      if (this.normalizeSimSlot(before.switchSlot) !== targetSlot) {
        await this.switchSimForIdentityRead(targetSlot, {
          context: `切换SIM${targetSlot + 1}`,
          purpose: '用于业务绑定',
          retries: 2,
          retryDelay: 1000,
          settleDelay: 1000,
          confirmTimeout: 5000,
          confirmInterval: 1000,
          simReadyAttempts: 3,
          simReadyDelay: 1000
        });
      } else {
        await this.waitSIMReady({
          attempts: 3,
          delay: 1000,
          label: `SIM${targetSlot + 1}`
        });
      }

      if (this.normalizeSimSlot(before.bindSlot) !== targetSlot) {
        await this.sendATWithRetry(`AT+BINDSIM=${targetSlot}`, {
          timeout: 5000,
          retries: 2,
          retryDelay: 1000,
          label: `绑定到SIM${targetSlot + 1}`
        });
      }

      this.sim.bindSlot = targetSlot;
      this.markActiveSimSlot(this.sim, targetSlot);
      await this.readCurrentSimSlotPhoneNumber(targetSlot, '切换后');
      await this.configureSMS();

      this.sim.switching = false;
      const status = await this.refreshSimStatus({ refreshIdentity: false });
      const activeSlot = this.normalizeSimSlot(status.activeSlot);
      const switchSlot = this.normalizeSimSlot(status.switchSlot);
      if (activeSlot !== targetSlot || switchSlot !== targetSlot) {
        throw new Error(`切换SIM后状态不一致: activeSlot=${activeSlot ?? 'unknown'}, switchSlot=${switchSlot ?? 'unknown'}`);
      }

      logger.info(`✓ 已绑定并切到SIM${targetSlot + 1}`);
      return {
        changed: true,
        status
      };
    } finally {
      this.sim.switching = false;
    }
  }

  getMobileDataMode() {
    return this.isML307Family() ? 'mipcall' : 'cgact';
  }

  getMobileDataCommand(mode = this.getMobileDataMode(), enabled = false, cid = this.mobileDataConfig.cid) {
    if (mode === 'mipcall') {
      return `AT+MIPCALL=${enabled ? 1 : 0},${cid}`;
    }

    return `AT+CGACT=${enabled ? 1 : 0},${cid}`;
  }

  getMobileDataStatusCommand(mode = this.getMobileDataMode()) {
    return mode === 'mipcall' ? 'AT+MIPCALL?' : 'AT+CGACT?';
  }

  getCachedMobileDataStatus() {
    return {
      ...this.mobileData,
      contexts: this.mobileData.contexts.map(item => ({ ...item }))
    };
  }

  async getMobileDataStatus() {
    const mode = this.getMobileDataMode();
    const command = this.getMobileDataStatusCommand(mode);

    try {
      const resp = await this.sendATCommand(command, 5000);
      const status = this.parseMobileDataStatusResponse(resp, mode);
      this.updateMobileDataStatus(status);
      return this.getCachedMobileDataStatus();
    } catch (err) {
      logger.warn(`查询移动数据状态失败: ${err.message}`);
      this.updateMobileDataStatus({
        mode,
        cid: this.mobileDataConfig.cid,
        status: 'unknown',
        enabled: false,
        targetEnabled: false,
        anyActive: false,
        contexts: [],
        error: err.message
      });
      return this.getCachedMobileDataStatus();
    }
  }

  parseMobileDataStatusResponse(resp, mode) {
    const contexts = [];
    const lines = resp.split('\n').map(line => line.trim()).filter(Boolean);

    for (const line of lines) {
      const payload = this.extractMobileDataPayload(line, mode);
      if (!payload) {
        continue;
      }

      const match = payload.match(/^(\d+)\s*,\s*(\d+)(.*)$/);
      if (!match) {
        continue;
      }

      const cid = Number.parseInt(match[1], 10);
      const state = Number.parseInt(match[2], 10);
      const addresses = [...match[3].matchAll(/"([^"]+)"/g)].map(item => item[1]).filter(Boolean);

      contexts.push({
        cid,
        active: state === 1,
        state,
        addresses
      });
    }

    const target = contexts.find(item => item.cid === this.mobileDataConfig.cid);
    const anyActive = contexts.some(item => item.active);
    const targetEnabled = target ? target.active : false;

    return {
      mode,
      cid: this.mobileDataConfig.cid,
      enabled: anyActive,
      targetEnabled,
      anyActive,
      status: anyActive ? 'enabled' : 'disabled',
      contexts,
      error: ''
    };
  }

  extractMobileDataPayload(line, mode) {
    if (mode === 'mipcall') {
      if (line.startsWith('+MIPCALL:')) {
        return line.slice('+MIPCALL:'.length).trim();
      }

      if (/^\d+\s*,\s*\d+/.test(line)) {
        return line;
      }
    }

    if (line.startsWith('+CGACT:')) {
      return line.slice('+CGACT:'.length).trim();
    }

    return '';
  }

  updateMobileDataStatus(status) {
    this.mobileData = {
      ...this.mobileData,
      ...status,
      cid: this.mobileDataConfig.cid,
      lastCheckedAt: new Date().toISOString(),
      contexts: Array.isArray(status.contexts) ? status.contexts : []
    };
  }

  getMobileDataTargetCids(status) {
    const cids = new Set([this.mobileDataConfig.cid]);
    for (const context of status.contexts || []) {
      if (context.active && context.cid !== 8) {
        cids.add(context.cid);
      }
    }

    return [...cids].filter(cid => this.normalizeMobileDataCid(cid) === cid);
  }

  async setMobileDataEnabled(enabled, options = {}) {
    this.mobileData.desiredEnabled = Boolean(enabled);
    if (enabled) {
      return await this.enableMobileData(options);
    }

    return await this.disableMobileData(options);
  }

  async enableMobileData(options = {}) {
    const mode = this.getMobileDataMode();
    const cid = this.mobileDataConfig.cid;
    const command = this.getMobileDataCommand(mode, true, cid);
    const label = mode === 'mipcall' ? '开启移动数据拨号' : '激活PDP数据连接';

    logger.warn(`准备开启移动数据(CID ${cid})，可能产生流量费用`);
    const resp = await this.sendATWithRetry(command, {
      timeout: 30000,
      retries: 1,
      label,
      required: false
    });

    const status = await this.waitForMobileDataState(true, options.timeout || 20000);
    if (!resp || !status.anyActive) {
      throw new Error('移动数据开启失败，未检测到已激活的数据连接');
    }

    logger.info(`✓ 已开启移动数据(CID ${cid})`);
    return status;
  }

  async disableMobileData(options = {}) {
    const mode = this.getMobileDataMode();
    if (mode === 'mipcall') {
      return await this.disableMipcallMobileData(options);
    }

    return await this.disableCgactMobileData(options);
  }

  async disableMipcallMobileData(options = {}) {
    const before = await this.getMobileDataStatus();
    const cids = this.getMobileDataTargetCids(before);

    logger.info(`${options.reason || '手动操作'}: 断开ML307应用层拨号连接，避免流量消耗`);

    for (const cid of cids) {
      try {
        await this.sendATWithRetry(this.getMobileDataCommand('mipcall', false, cid), {
          timeout: 8000,
          retries: 1,
          label: `断开应用层拨号(CID ${cid})`,
          required: true
        });
      } catch (err) {
        err.mobileDataCritical = true;
        throw err;
      }
    }

    const status = await this.waitForMobileDataState(false, options.timeout || 8000);
    if (status.anyActive) {
      const err = new Error(`MIPCALL断开后仍检测到活动连接: ${this.formatMobileDataContexts(status.contexts)}`);
      err.mobileDataCritical = true;
      throw err;
    }

    if (status.status === 'unknown') {
      logger.warn('MIPCALL断开命令已成功发送，但状态未确认');
    }

    await this.tryDeactivatePdpContexts(cids);

    logger.info('✓ 应用层拨号连接已断开');
    return status;
  }

  async disableCgactMobileData(options = {}) {
    const before = await this.getMobileDataStatus();
    const cids = this.getMobileDataTargetCids(before);
    let commandSucceeded = false;

    logger.info(`${options.reason || '手动操作'}: 停用PDP数据连接，避免流量消耗`);

    for (const cid of cids) {
      const resp = await this.sendATWithRetry(this.getMobileDataCommand('cgact', false, cid), {
        timeout: 8000,
        retries: 1,
        label: `停用PDP数据连接(CID ${cid})`,
        required: false
      });

      commandSucceeded = commandSucceeded || Boolean(resp);
    }

    const status = await this.waitForMobileDataState(false, options.timeout || 8000);
    if (status.anyActive) {
      const message = `移动数据关闭后仍检测到活动连接: ${this.formatMobileDataContexts(status.contexts)}`;
      if (options.required === false) {
        logger.warn(message);
        return status;
      }

      throw new Error(message);
    }

    if (status.status === 'unknown') {
      const message = commandSucceeded ? '移动数据关闭命令已发送，但状态未确认' : '移动数据关闭命令未确认成功';
      if (options.required === false) {
        logger.warn(message);
        return status;
      }

      throw new Error(message);
    }

    if (!commandSucceeded && before.status === 'unknown' && options.required !== false) {
      throw new Error('移动数据关闭命令未确认成功');
    }

    logger.info('✓ 移动数据已关闭');
    return status;
  }

  async tryDeactivatePdpContexts(cids) {
    for (const cid of cids) {
      const resp = await this.sendATWithRetry(this.getMobileDataCommand('cgact', false, cid), {
        timeout: 8000,
        retries: 1,
        label: `保护性停用PDP(CID ${cid})`,
        required: false
      });

      if (!resp) {
        logger.warn(`保护性停用PDP(CID ${cid})未成功，已按MIPCALL断开结果继续`);
      }
    }
  }

  async forceMobileDataOff(stage) {
    this.mobileData.desiredEnabled = false;
    try {
      return await this.disableMobileData({
        reason: stage,
        required: false,
        timeout: 5000
      });
    } catch (err) {
      if (err.mobileDataCritical) {
        throw err;
      }

      logger.warn(`${stage}: 移动数据关闭未确认: ${err.message}`);
      return this.getCachedMobileDataStatus();
    }
  }

  async consumeMobileDataTraffic(options = {}) {
    const target = this.normalizePingTarget(options.target || '8.8.8.8');
    const status = await this.getMobileDataStatus();

    if (status.status === 'unknown') {
      const err = new Error(status.error || '未能确认移动数据状态，无法执行流量消耗测试');
      err.statusCode = 503;
      throw err;
    }

    if (!status.anyActive) {
      const err = new Error('当前未开启流量，请先开启后再执行流量消耗测试');
      err.statusCode = 409;
      throw err;
    }

    return await this.runMPing(target, {
      timeout: options.timeout || 35000,
      pingTimeoutSeconds: options.pingTimeoutSeconds || 30,
      count: options.count || 1
    });
  }

  normalizePingTarget(value) {
    const target = String(value || '').trim();
    if (!target || !/^[A-Za-z0-9.:-]{1,253}$/.test(target)) {
      throw new Error('Ping目标地址无效');
    }

    return target;
  }

  runMPing(target, options = {}) {
    if (!this.port || !this.port.isOpen) {
      throw new Error('串口未打开');
    }

    const timeout = options.timeout || 35000;
    const pingTimeoutSeconds = Math.min(Math.max(Number(options.pingTimeoutSeconds) || 30, 1), 255);
    const count = Math.min(Math.max(Number(options.count) || 1, 1), 10);
    const command = `AT+MPING="${target}",${pingTimeoutSeconds},${count}`;

    logger.info(`准备通过模组执行MPING，目标: ${target}`);

    return new Promise((resolve, reject) => {
      const lines = [];
      let settled = false;
      let commandAccepted = false;

      const finish = (err, result = null) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        this.parser.removeListener('data', handler);

        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      };

      const timer = setTimeout(() => {
        finish(new Error(`MPING超时，未收到结果: ${target}`));
      }, timeout);

      const handler = (line) => {
        const trimmed = String(line).trim();
        if (!trimmed) {
          return;
        }

        lines.push(trimmed);

        if (trimmed === 'OK') {
          commandAccepted = true;
          return;
        }

        if (trimmed.includes('ERROR')) {
          finish(new Error(`MPING命令失败: ${this.formatATResponse(lines.join('\n'))}`));
          return;
        }

        if (trimmed.startsWith('+MPING:')) {
          const result = this.parseMPingResult(trimmed, target);
          result.commandAccepted = commandAccepted;
          result.rawResponse = lines.join('\n');

          if (result.success) {
            logger.info(`✓ ${result.message}`);
            finish(null, result);
          } else {
            const err = new Error(result.message);
            err.statusCode = 502;
            err.data = result;
            finish(err);
          }
        }
      };

      this.parser.on('data', handler);

      logger.debug(`>> ${command}`);
      this.port.write(`${command}\r\n`, (err) => {
        if (err) {
          finish(err);
        }
      });
    });
  }

  parseMPingResult(line, target) {
    const payload = line.slice('+MPING:'.length).trim();
    const params = payload.match(/"[^"]*"|[^,]+/g)?.map(item => {
      const value = item.trim();
      return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
    }) || [];
    const resultCode = Number.parseInt(params[0], 10);
    const responseTarget = params[1] || target;
    const packetLength = Number.parseInt(params[2], 10);
    const latencyMs = Number.parseInt(params[3], 10);
    const ttl = Number.parseInt(params[4], 10);
    const hasReplyFields = params.length >= 4;
    const success = (resultCode === 0 || resultCode === 1) && hasReplyFields;
    const message = success
      ? `MPING成功: ${responseTarget}, 延迟 ${Number.isFinite(latencyMs) ? `${latencyMs}ms` : '未知'}, TTL ${Number.isFinite(ttl) ? ttl : '未知'}`
      : `MPING失败或目标不可达，错误码: ${Number.isFinite(resultCode) ? resultCode : payload}`;

    return {
      success,
      target: responseTarget,
      resultCode: Number.isFinite(resultCode) ? resultCode : null,
      packetLength: Number.isFinite(packetLength) ? packetLength : null,
      latencyMs: Number.isFinite(latencyMs) ? latencyMs : null,
      ttl: Number.isFinite(ttl) ? ttl : null,
      message,
      rawLine: line
    };
  }

  async waitForMobileDataState(enabled, timeout = 10000) {
    const startedAt = Date.now();
    let status = await this.getMobileDataStatus();

    while (status.status !== 'unknown' && status.anyActive !== enabled && Date.now() - startedAt < timeout) {
      await this.sleep(1000);
      status = await this.getMobileDataStatus();
    }

    return status;
  }

  formatMobileDataContexts(contexts = []) {
    const active = contexts
      .filter(item => item.active)
      .map(item => `CID ${item.cid}`)
      .join(', ');

    return active || '无';
  }

  splitATFields(value) {
    const fields = [];
    let current = '';
    let quoted = false;

    for (const char of String(value || '')) {
      if (char === '"') {
        quoted = !quoted;
        continue;
      }

      if (char === ',' && !quoted) {
        fields.push(current.trim());
        current = '';
        continue;
      }

      current += char;
    }

    fields.push(current.trim());
    return fields;
  }

  parseSimSlotHint(value) {
    const text = String(value || '').trim();
    if (!text) {
      return null;
    }

    const explicit = text.match(/\bSIM\s*[:=]?\s*([12])\b/i) || text.match(/\bSLOT\s*[:=]?\s*([12])\b/i);
    if (explicit) {
      return Number.parseInt(explicit[1], 10) - 1;
    }

    const zeroBased = text.match(/\b(?:SIM|SLOT)\s*[:=]\s*([01])\b/i);
    if (zeroBased) {
      return Number.parseInt(zeroBased[1], 10);
    }

    return null;
  }

  parseIncomingSmsURC(line) {
    const raw = String(line || '').trim();
    const payload = raw.replace(/^\+CMT:\s*/i, '');
    const fields = this.splitATFields(payload);
    const length = Number.parseInt(fields[fields.length - 1], 10);
    const simSlot = fields
      .map(field => this.parseSimSlotHint(field))
      .find(slot => slot === 0 || slot === 1);

    return {
      type: 'CMT',
      raw,
      fields,
      length: Number.isFinite(length) ? length : null,
      simSlot: simSlot ?? null,
      receivedAt: new Date().toISOString()
    };
  }

  parseIncomingSmsIndexURC(line) {
    const raw = String(line || '').trim();
    const payload = raw.replace(/^\+CMTI:\s*/i, '');
    const fields = this.splitATFields(payload);
    const mem = fields[0] || '';
    const index = Number.parseInt(fields[1], 10);
    const simSlot = fields
      .map(field => this.parseSimSlotHint(field))
      .find(slot => slot === 0 || slot === 1);

    return {
      type: 'CMTI',
      raw,
      mem,
      index: Number.isFinite(index) ? index : null,
      simSlot: simSlot ?? null,
      receivedAt: new Date().toISOString()
    };
  }

  /**
   * 设置URC监听器
   */
  setupURCListener() {
    let waitingPDU = false;
    let pendingSms = null;

    this.parser.on('data', (line) => {
      line = line.trim();

      // 调试输出
      if (line.length > 0 && !line.startsWith('AT')) {
        logger.debug(`<< ${line}`);
      }

      // 检测短信URC
      if (line.startsWith('+CMT:')) {
        pendingSms = this.parseIncomingSmsURC(line);
        const slotLabel = pendingSms.simSlot === null ? '未携带卡槽' : `SIM${pendingSms.simSlot + 1}`;
        logger.info(`检测到短信URC(${slotLabel})，等待PDU数据...`);
        waitingPDU = true;
      } else if (line.startsWith('+CMTI:')) {
        const notification = this.parseIncomingSmsIndexURC(line);
        const slotLabel = notification.simSlot === null ? '未携带卡槽' : `SIM${notification.simSlot + 1}`;
        logger.info(`检测到短信存储通知(${slotLabel}): ${notification.mem || '未知存储'} ${notification.index ?? '未知编号'}`);
        this.emit('sms-notification', notification);
        this.readSmsFromNotification(notification).catch((err) => {
          logger.warn(`读取短信存储通知失败: ${err.message}`);
        });
      } else if (waitingPDU && this.isHexString(line)) {
        logger.info('收到PDU数据');
        waitingPDU = false;
        this.emit('sms', {
          pdu: line,
          metadata: pendingSms || {
            type: 'CMT',
            raw: '',
            simSlot: null,
            receivedAt: new Date().toISOString()
          }
        });
        pendingSms = null;
      } else if (waitingPDU && line.length === 0) {
        // 跳过空行
      } else if (waitingPDU) {
        // 收到非PDU数据，返回等待状态
        waitingPDU = false;
        pendingSms = null;
      }

      // 检测网络注册状态变化
      if (line.startsWith('+CEREG:')) {
        this.emit('cereg', line);
      }
    });
  }

  parseStoredSmsResponse(resp, notification = {}) {
    const lines = String(resp || '')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
    let header = '';
    let pdu = '';

    for (const line of lines) {
      if (line.startsWith('+CMGR:')) {
        header = line;
        continue;
      }

      if (!pdu && this.isHexString(line) && line.length > 8) {
        pdu = line;
      }
    }

    if (!pdu) {
      return null;
    }

    const headerFields = header ? this.splitATFields(header.replace(/^\+CMGR:\s*/i, '')) : [];
    const length = Number.parseInt(headerFields[headerFields.length - 1], 10);

    return {
      pdu,
      metadata: {
        ...notification,
        type: 'CMTI',
        raw: notification.raw || '',
        cmgrRaw: header,
        length: Number.isFinite(length) ? length : null,
        receivedAt: notification.receivedAt || new Date().toISOString()
      }
    };
  }

  async readSmsFromNotification(notification = {}) {
    if (!Number.isInteger(notification.index)) {
      logger.warn('短信存储通知缺少有效编号，跳过读取');
      return false;
    }

    const memLabel = notification.mem ? `${notification.mem},` : '';
    logger.info(`读取存储短信: ${memLabel}${notification.index}`);
    const resp = await this.sendATCommand(`AT+CMGR=${notification.index}`, 5000);
    const sms = this.parseStoredSmsResponse(resp, notification);

    if (!sms) {
      logger.warn(`未能从存储短信读取到PDU: ${this.formatATResponse(resp)}`);
      return false;
    }

    logger.info('收到存储短信PDU数据');
    this.emit('sms', sms);
    await this.deleteSmsAtIndex(notification.index, notification.simSlot);
    return true;
  }

  /**
   * 检查是否为十六进制字符串
   */
  isHexString(str) {
    return /^[0-9A-Fa-f]+$/.test(str);
  }

  /**
   * 发送AT命令并等待响应
   */
  async sendATCommand(cmd, timeout = 2000) {
    return this.enqueueATCommand(() => this.sendATCommandUnlocked(cmd, timeout));
  }

  enqueueATCommand(task) {
    const run = this.atCommandQueue.then(task, task);
    this.atCommandQueue = run.catch(() => {});
    return run;
  }

  sendATCommandUnlocked(cmd, timeout = 2000) {
    return new Promise((resolve, reject) => {
      if (!this.port || !this.port.isOpen || !this.parser) {
        reject(new Error('串口未打开'));
        return;
      }

      let buffer = '';
      const timer = setTimeout(() => {
        this.parser.removeListener('data', handler);
        reject(new Error(`AT命令超时: ${cmd}`));
      }, timeout);

      const handler = (line) => {
        buffer += line + '\n';
        if (line.includes('OK') || line.includes('ERROR')) {
          clearTimeout(timer);
          this.parser.removeListener('data', handler);
          resolve(buffer);
        }
      };

      this.parser.on('data', handler);

      logger.debug(`>> ${cmd}`);
      this.port.write(cmd + '\r\n');
    });
  }

  /**
   * 发送AT命令并等待OK
   */
  async sendATandWaitOK(cmd, timeout = 2000) {
    try {
      const resp = await this.sendATCommand(cmd, timeout);
      return resp.includes('OK');
    } catch (err) {
      return false;
    }
  }

  /**
   * 发送AT命令，失败时打印模组原始响应，便于排查型号差异
   */
  async sendATWithRetry(cmd, options = {}) {
    const {
      timeout = 2000,
      retries = 3,
      retryDelay = 1000,
      label = cmd,
      required = true
    } = options;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const resp = await this.sendATCommand(cmd, timeout);
        if (resp.includes('OK')) {
          return resp;
        }

        logger.warn(`${label}失败(${attempt}/${retries}): ${this.formatATResponse(resp)}`);
      } catch (err) {
        logger.warn(`${label}失败(${attempt}/${retries}): ${err.message}`);
      }

      if (attempt < retries && retryDelay > 0) {
        await this.sleep(retryDelay);
      }
    }

    if (required) {
      throw new Error(`${label}失败`);
    }

    return null;
  }

  /**
   * 压缩AT响应，避免日志跨太多行
   */
  formatATResponse(resp) {
    return resp
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .join(' | ');
  }

  /**
   * 初始化模组
   */
  async init() {
    logger.info('开始初始化4G模组...');

    // 1. AT握手
    let retries = 0;
    while (!(await this.sendATandWaitOK('AT', 1000)) && retries < 10) {
      logger.warn('AT未响应，重试...');
      retries++;
      await this.sleep(1000);
    }
    if (retries >= 10) {
      throw new Error('模组AT握手失败');
    }
    logger.info('✓ 模组AT响应正常');

    // 2. 查询模组信息
    try {
      const resp = await this.sendATCommand('ATI', 2000);
      const lines = resp.split('\n').map(l => l.trim()).filter(l => l && l !== 'ATI' && l !== 'OK');
      if (lines.length >= 3) {
        this.modelInfo.manufacturer = lines[0];
        this.modelInfo.model = lines[1];
        this.modelInfo.version = lines[2];
        logger.info(`模组信息: ${this.modelInfo.manufacturer} ${this.modelInfo.model} ${this.modelInfo.version}`);
      }
    } catch (err) {
      logger.warn('查询模组信息失败');
    }

    // 3. 启动时先重置协议栈，避免上一次双卡切换/短信上报状态残留。
    await this.resetProtocolStackForStartup();

    // 3.1. 查询双卡能力和当前卡槽；不支持时保持单卡运行。
    await this.refreshSimStatus({ refreshIdentity: false });

    // 3. 按ML307A文档先确认SIM卡和协议栈状态
    await this.waitSIMReady();

    // 启动时只初始化当前卡，不遍历其他卡槽。
    await this.discoverSimSlotIdentities();
    await this.ensureFullFunctionality();

    // 4. 启动保护：先断开应用层拨号，再等待短信所需的网络注册。
    await this.forceMobileDataOff('启动保护(CFUN=1后)');

    // 5. 等待网络注册
    this.ready = await this.waitForNetworkRegistration('启动', 30, 2000);

    // 6. 驻网后再断开一次，防止模组自动拨号在驻网完成后重新拉起。
    await this.forceMobileDataOff('启动保护(驻网后)');

    // 7. 按文档配置短信功能，并启用本项目需要的PDU模式
    await this.configureSMS();
    await this.refreshSimStatus({ refreshIdentity: true, probeSlots: true });

    logger.info('模组初始化完成');
    this.emit('ready');
  }

  /**
   * 等待SIM卡完成初始化
   */
  async waitSIMReady(options = {}) {
    const attempts = options.attempts ?? 10;
    const delay = options.delay ?? 1000;
    const timeout = options.timeout ?? 2000;
    const label = options.label || 'SIM卡';

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const resp = await this.sendATCommand('AT+CPIN?', timeout);
        if (this.isSimReadyResponse(resp)) {
          logger.info(`✓ ${label}已就绪`);
          return;
        }

        logger.warn(`${label}未就绪(${attempt}/${attempts}): ${this.formatATResponse(resp)}`);
      } catch (err) {
        logger.warn(`查询${label}状态失败(${attempt}/${attempts}): ${err.message}`);
      }

      await this.sleep(delay);
    }

    throw new Error(`${label}未就绪，可能未插卡或SIM初始化失败`);
  }

  /**
   * 确保驻网前协议栈功能模式为CFUN=1
   */
  async ensureFullFunctionality() {
    const resp = await this.sendATCommand('AT+CFUN?', 2000);
    const match = resp.match(/\+CFUN:\s*(\d+)/);

    if (match && match[1] === '1') {
      logger.info('✓ 协议栈功能模式正常(CFUN=1)');
      return;
    }

    logger.warn(`当前CFUN状态不是1: ${this.formatATResponse(resp)}`);
    await this.sendATWithRetry('AT+CFUN=1', {
      timeout: 5000,
      retries: 3,
      label: '设置CFUN=1'
    });

    // 文档要求CFUN切换后等待模组完成协议栈恢复。
    await this.sleep(2000);
    logger.info('✓ 已设置协议栈功能模式(CFUN=1)');
  }

  /**
   * 启动时重置协议栈。避免使用 AT+CFUN=1,1 整机重启导致USB串口断开后反复重启容器。
   */
  async resetProtocolStackForStartup() {
    logger.info('启动初始化: 重置协议栈(CFUN=0 -> CFUN=1)');

    try {
      await this.sendATWithRetry('AT+CFUN=0', {
        timeout: 8000,
        retries: 2,
        retryDelay: 1000,
        label: '启动重置协议栈(CFUN=0)',
        required: false
      });

      await this.sleep(3000);

      await this.sendATWithRetry('AT+CFUN=1', {
        timeout: 10000,
        retries: 3,
        retryDelay: 2000,
        label: '启动恢复协议栈(CFUN=1)'
      });

      await this.sleep(5000);
      logger.info('✓ 启动协议栈重置完成');
    } catch (err) {
      logger.warn(`启动协议栈重置失败，继续初始化: ${err.message}`);
    }
  }

  /**
   * 按ML307A文档配置短信功能；项目接收逻辑依赖PDU模式下的+CMT上报。
   */
  async configureSMS() {
    if (this.modelInfo.version.includes('ML307A-DL')) {
      throw new Error('当前ML307A-DL型号不支持短信功能');
    }

    await this.sendATWithRetry('AT+CMGF=0', {
      timeout: 2000,
      retries: 3,
      label: '设置PDU模式'
    });
    logger.info('✓ PDU模式设置完成');

    await this.sendATWithRetry('AT+CNMI=2,2,0,2,0', {
      timeout: 2000,
      retries: 3,
      label: '设置CNMI短信上报'
    });
    logger.info('✓ CNMI参数设置完成');

    await this.sendATWithRetry('AT+CSCS="IRA"', {
      timeout: 2000,
      retries: 3,
      label: '设置短信字符集'
    });
    logger.info('✓ 短信字符集设置完成');

    await this.sendATWithRetry('AT+CSMP=33,167,0,0', {
      timeout: 2000,
      retries: 3,
      label: '设置短信发送参数'
    });
    logger.info('✓ 短信发送参数设置完成');

    return null;
  }

  async deleteSmsAtIndex(index, slot = null) {
    try {
      await this.sendATWithRetry(`AT+CMGD=${index}`, {
        timeout: 5000,
        retries: 1,
        label: `删除已读取短信${slot === null ? '' : `(SIM${slot + 1})`}`,
        required: false
      });
    } catch (err) {
      logger.warn(`删除已读取短信失败: ${err.message}`);
    }
  }

  /**
   * 判断是否为ML307系列模组
   */
  isML307Family() {
    return this.modelInfo.model.startsWith('ML307') || this.modelInfo.version.startsWith('ML307');
  }

  /**
   * 检测网络注册状态
   */
  async waitCEREG() {
    try {
      const resp = await this.sendATCommand('AT+CEREG?', 2000);
      // +CEREG: 0,1 或 +CEREG: 0,5 表示已注册
      if (resp.includes('+CEREG:')) {
        if (resp.includes(',1') || resp.includes(',5')) {
          return true;
        }
      }
      return false;
    } catch (err) {
      return false;
    }
  }

  async waitForNetworkRegistration(label = '网络注册', maxRetries = 30, retryDelay = 2000) {
    let retries = 0;
    while (!(await this.waitCEREG()) && retries < maxRetries) {
      logger.info(`${label}: 等待网络注册...`);
      retries++;
      await this.sleep(retryDelay);
    }

    if (retries < maxRetries) {
      logger.info('✓ 网络已注册');
      return true;
    }

    logger.error(`${label}: 网络注册超时（无SIM卡或信号差）`);
    return false;
  }

  /**
   * 发送短信（PDU模式）
   */
  async sendSMS(phoneNumber, message) {
    const sendResult = {
      success: false,
      simSlot: null,
      simLabel: '未知SIM',
      parts: 0
    };

    if (this.isSimSwitching()) {
      logger.warn('SIM切换中，暂不发送短信');
      return sendResult;
    }

    logger.info(`准备发送短信到: ${phoneNumber}`);
    logger.info(`短信内容: ${message}`);
    this.smsSending = true;

    try {
      const simSync = await this.ensureATSimMatchesBinding('发送短信前SIM同步');
      if (simSync?.changed) {
        await this.configureSMS();
      }

      const sendSlot = this.normalizeSimSlot(simSync?.slot ?? this.sim.bindSlot ?? await this.queryBindSimSlot().catch(() => null));
      sendResult.simSlot = sendSlot;
      sendResult.simLabel = this.getSimSlotLabel(sendSlot);
      logger.info(`发送使用SIM: ${sendResult.simLabel}${sendSlot === null ? '' : ` (SIM${sendSlot + 1})`}`);

      // 编码PDU
      const submit = new Submit(phoneNumber, message);
      const parts = submit.getPartStrings();
      sendResult.parts = parts.length;

      if (parts.length === 0) {
        throw new Error('PDU编码失败');
      }

      for (let i = 0; i < parts.length; i++) {
        const pduData = parts[i];
        const pduLength = this.getSubmitPduLength(pduData);

        logger.debug(`PDU分段: ${i + 1}/${parts.length}`);
        logger.debug(`PDU数据: ${pduData}`);
        logger.debug(`PDU长度: ${pduLength}`);

        const success = await this.sendPduPart(pduData, pduLength);
        if (!success) {
          logger.error(`✗ 短信分段发送失败: ${i + 1}/${parts.length}`);
          return sendResult;
        }
      }

      logger.info('✓ 短信发送成功');
      sendResult.success = true;
      return sendResult;
    } catch (err) {
      logger.error('发送短信异常:', err);
      return sendResult;
    } finally {
      this.smsSending = false;
    }
  }

  /**
   * 计算AT+CMGS需要的TPDU长度，不包含SMSC长度字段和SMSC内容。
   */
  getSubmitPduLength(pduData) {
    const smscLength = parseInt(pduData.slice(0, 2), 16);
    const totalLength = pduData.length / 2;
    const submitLength = totalLength - smscLength - 1;

    if (!Number.isFinite(submitLength) || submitLength <= 0) {
      throw new Error(`PDU长度无效: ${pduData}`);
    }

    return submitLength;
  }

  /**
   * 发送单个PDU分段。
   */
  async sendPduPart(pduData, pduLength) {
    const cmgsCmd = `AT+CMGS=${pduLength}`;
    this.port.write(cmgsCmd + '\r\n');

    const gotPrompt = await this.waitForPrompt();
    if (!gotPrompt) {
      throw new Error('未收到>提示符');
    }

    logger.debug('收到>提示符，发送PDU数据...');
    this.port.write(pduData + String.fromCharCode(0x1A));

    return await this.waitForCMGSResult();
  }

  /**
   * 等待CMGS输入提示符。提示符通常没有行结束符，所以直接监听原始串口数据。
   */
  waitForPrompt(timeout = 5000) {
    return new Promise((resolve) => {
      let buffer = '';
      const timer = setTimeout(() => {
        this.port.removeListener('data', handler);
        resolve(false);
      }, timeout);

      const handler = (chunk) => {
        buffer += chunk.toString('utf8');
        if (buffer.includes('>')) {
          clearTimeout(timer);
          this.port.removeListener('data', handler);
          resolve(true);
        }
      };

      this.port.on('data', handler);
    });
  }

  /**
   * 等待短信发送结果。
   */
  waitForCMGSResult(timeout = 30000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.parser.removeListener('data', handler);
        logger.warn('等待CMGS发送结果超时');
        resolve(false);
      }, timeout);

      const handler = (line) => {
        if (line.includes('OK')) {
          clearTimeout(timer);
          this.parser.removeListener('data', handler);
          resolve(true);
        } else if (line.includes('ERROR')) {
          clearTimeout(timer);
          this.parser.removeListener('data', handler);
          logger.warn(`CMGS发送返回错误: ${String(line).trim()}`);
          resolve(false);
        }
      };

      this.parser.on('data', handler);
    });
  }

  /**
   * 查询信号强度
   */
  async getSignalQuality() {
    try {
      const resp = await this.sendATCommand('AT+CSQ', 2000);
      const match = resp.match(/\+CSQ:\s*(\d+),(\d+)/);
      if (match) {
        const rssi = parseInt(match[1]);
        const ber = parseInt(match[2]);
        let quality = '未知';
        if (rssi === 99) {
          quality = '未知或不可检测';
        } else if (rssi >= 20) {
          quality = '很好';
        } else if (rssi >= 15) {
          quality = '好';
        } else if (rssi >= 10) {
          quality = '一般';
        } else {
          quality = '弱';
        }
        return { rssi, ber, quality };
      }
      return null;
    } catch (err) {
      logger.error('查询信号强度失败:', err);
      return null;
    }
  }

  /**
   * 查询运营商
   */
  async getOperator() {
    try {
      const resp = await this.sendATCommand('AT+COPS?', 2000);
      const match = resp.match(/\+COPS:\s*\d+,\d+,"([^"]+)"/);
      if (match) {
        return match[1];
      }
      return '未知';
    } catch (err) {
      logger.error('查询运营商失败:', err);
      return '未知';
    }
  }

  /**
   * 关闭串口
   */
  async close() {
    if (this.port && this.port.isOpen) {
      await new Promise((resolve) => {
        this.port.close(resolve);
      });
      logger.info('串口已关闭');
    }
  }

  /**
   * 辅助函数：延时
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default ModemManager;
