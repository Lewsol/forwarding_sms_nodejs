import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';
import { Submit } from 'node-pdu';
import EventEmitter from 'events';
import logger from './logger.js';

class ModemManager extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.port = null;
    this.parser = null;
    this.ready = false;
    this.modelInfo = {
      manufacturer: '未知',
      model: '未知',
      version: '未知'
    };
  }

  /**
   * 打开串口并初始化模组
   */
  async open() {
    try {
      // 处理串口路径：Windows支持COMx格式
      let portPath = this.config.path;

      // 如果是Windows且指定了COM端口号（数字），自动添加COM前缀
      if (process.platform === 'win32' && /^\d+$/.test(portPath)) {
        portPath = `COM${portPath}`;
      }

      logger.info(`准备打开串口: ${portPath} (${this.config.baudRate})`);

      // 打开串口
      this.port = new SerialPort({
        path: portPath,
        baudRate: this.config.baudRate,
        dataBits: 8,
        stopBits: 1,
        parity: 'none'
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
      await new Promise((resolve) => this.port.once('open', resolve));
      logger.info(`串口已打开: ${this.config.path}`);

      // 初始化模组
      await this.init();

    } catch (err) {
      logger.error('打开串口失败:', err);
      throw err;
    }
  }

  /**
   * 设置URC监听器
   */
  setupURCListener() {
    let waitingPDU = false;

    this.parser.on('data', (line) => {
      line = line.trim();

      // 调试输出
      if (line.length > 0 && !line.startsWith('AT')) {
        logger.debug(`<< ${line}`);
      }

      // 检测短信URC
      if (line.startsWith('+CMT:')) {
        logger.info('检测到短信URC，等待PDU数据...');
        waitingPDU = true;
      } else if (waitingPDU && this.isHexString(line)) {
        logger.info('收到PDU数据');
        waitingPDU = false;
        this.emit('sms', line); // 发射短信事件
      } else if (waitingPDU && line.length === 0) {
        // 跳过空行
      } else if (waitingPDU) {
        // 收到非PDU数据，返回等待状态
        waitingPDU = false;
      }

      // 检测网络注册状态变化
      if (line.startsWith('+CEREG:')) {
        this.emit('cereg', line);
      }
    });
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
    return new Promise((resolve, reject) => {
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

    // 3. 按ML307A文档先确认SIM卡和协议栈状态
    await this.waitSIMReady();
    await this.ensureFullFunctionality();

    // 4. 等待网络注册
    retries = 0;
    while (!(await this.waitCEREG()) && retries < 30) {
      logger.info('等待网络注册...');
      retries++;
      await this.sleep(2000);
    }
    if (retries < 30) {
      logger.info('✓ 网络已注册');
      this.ready = true;
    } else {
      logger.error('网络注册超时（无SIM卡或信号差）');
      this.ready = false;
    }

    // 5. 数据连接处理。ML307文档不建议用CGACT做PDP激活/去激活。
    await this.disableDataConnection();

    // 6. 按文档配置短信功能，并启用本项目需要的PDU模式
    await this.configureSMS();

    logger.info('模组初始化完成');
    this.emit('ready');
  }

  /**
   * 等待SIM卡完成初始化
   */
  async waitSIMReady() {
    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        const resp = await this.sendATCommand('AT+CPIN?', 2000);
        if (resp.includes('+CPIN: READY')) {
          logger.info('✓ SIM卡已就绪');
          return;
        }

        logger.warn(`SIM卡未就绪(${attempt}/10): ${this.formatATResponse(resp)}`);
      } catch (err) {
        logger.warn(`查询SIM卡状态失败(${attempt}/10): ${err.message}`);
      }

      await this.sleep(1000);
    }

    throw new Error('SIM卡未就绪');
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
   * 按模组型号处理数据连接，避免ML307系列使用文档不推荐的CGACT。
   */
  async disableDataConnection() {
    if (this.isML307Family()) {
      logger.info('ML307系列跳过AT+CGACT，按文档尝试断开应用层拨号(AT+MIPCALL=0,1)');
      const resp = await this.sendATWithRetry('AT+MIPCALL=0,1', {
        timeout: 5000,
        retries: 1,
        label: '断开应用层拨号',
        required: false
      });

      if (resp) {
        logger.info('✓ 已断开应用层拨号连接');
      } else {
        logger.warn('应用层拨号未断开或当前未激活，继续启动');
      }
      return;
    }

    const resp = await this.sendATWithRetry('AT+CGACT=0,1', {
      timeout: 5000,
      retries: 3,
      label: '禁用数据连接',
      required: false
    });

    if (resp) {
      logger.info('✓ 已禁用数据连接(AT+CGACT=0,1)，防止流量消耗');
    } else {
      logger.warn('设置CGACT失败，可能会消耗流量');
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

  /**
   * 发送短信（PDU模式）
   */
  async sendSMS(phoneNumber, message) {
    logger.info(`准备发送短信到: ${phoneNumber}`);
    logger.info(`短信内容: ${message}`);

    try {
      // 编码PDU
      const submit = new Submit(phoneNumber, message);
      const parts = submit.getPartStrings();

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
          return false;
        }
      }

      logger.info('✓ 短信发送成功');
      return true;
    } catch (err) {
      logger.error('发送短信异常:', err);
      return false;
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
   * 查询ICCID
   */
  async getICCID() {
    try {
      const resp = await this.sendATCommand('AT+CCID', 2000);
      const match = resp.match(/\+CCID:\s*(\d+)/);
      if (match) {
        return match[1];
      }
      return null;
    } catch (err) {
      logger.error('查询ICCID失败:', err);
      return null;
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
