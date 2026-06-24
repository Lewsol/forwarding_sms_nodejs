import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';
import ModemManager from './modem.js';
import ConcatManager from './concat.js';
import PushManager from './push.js';
import SMSProcessor from './sms.js';
import APIServer from './api.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 加载配置
function loadConfig() {
  const configPath = path.join(__dirname, '../config.json');
  if (!fs.existsSync(configPath)) {
    logger.error('配置文件不存在: config.json');
    logger.error('请复制 config.example.json 为 config.json 并修改配置');
    process.exit(1);
  }

  const configContent = fs.readFileSync(configPath, 'utf-8');
  return JSON.parse(configContent);
}

// 创建日志目录
function ensureLogDirectory() {
  const logDir = path.join(__dirname, '../logs');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
}

// 主函数
async function main() {
  // 确保日志目录存在
  ensureLogDirectory();

  logger.info('========================================');
  logger.info('      4G SMS Gateway 启动中...        ');
  logger.info('========================================');

  // 加载配置
  const config = loadConfig();
  logger.info('配置加载完成');

  // 创建模组管理器
  const modem = new ModemManager(config.serial);

  // 创建长短信管理器
  const concatManager = new ConcatManager();

  // 创建推送管理器
  const pushManager = new PushManager(config);

  // 创建短信处理器
  const smsProcessor = new SMSProcessor(config, modem, concatManager, pushManager);

  // 监听长短信合并完成事件
  concatManager.on('complete', async (sms) => {
    logger.info('收到长短信合并完成事件');
    await smsProcessor.processSmsContent(sms.sender, sms.text, sms.timestamp);
  });

  // 监听模组短信事件
  modem.on('sms', async (pduHex) => {
    await smsProcessor.processPDU(pduHex);
  });

  // 监听模组错误事件
  modem.on('error', (err) => {
    logger.error('模组错误:', err);
  });

  // 监听模组关闭事件
  modem.on('close', () => {
    logger.warn('模组连接已关闭');
    process.exit(1); // PM2会自动重启
  });

  // 监听模组就绪事件
  modem.on('ready', async () => {
    logger.info('✓ 模组已就绪');

    // 发送启动通知邮件
    if (config.smtp && config.smtp.server) {
      const subject = '短信网关已启动';
      const body = `4G SMS Gateway 已成功启动\n\n模组信息:\n- 厂商: ${modem.modelInfo.manufacturer}\n- 型号: ${modem.modelInfo.model}\n- 版本: ${modem.modelInfo.version}\n\nAPI地址: http://your-server:${config.api.port}`;
      await pushManager.sendEmail(subject, body);
    }
  });

  try {
    // 打开串口并初始化模组
    await modem.open();

    // 启动长短信超时检查器
    concatManager.startTimeoutChecker();

    // 启动API服务器
    const apiServer = new APIServer(config, modem, smsProcessor, pushManager);
    apiServer.start();

    logger.info('========================================');
    logger.info('      4G SMS Gateway 运行中          ');
    logger.info('========================================');

  } catch (err) {
    logger.error('启动失败:', err);
    process.exit(1);
  }

  // 优雅退出
  process.on('SIGINT', async () => {
    logger.info('\n收到 SIGINT 信号，正在关闭...');
    concatManager.stopTimeoutChecker();
    await modem.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('\n收到 SIGTERM 信号，正在关闭...');
    concatManager.stopTimeoutChecker();
    await modem.close();
    process.exit(0);
  });

  // 捕获未处理的异常
  process.on('uncaughtException', (err) => {
    logger.error('未捕获的异常:', err);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error('未处理的Promise拒绝:', reason);
    process.exit(1);
  });
}

// 启动应用
main().catch(err => {
  logger.error('应用启动失败:', err);
  process.exit(1);
});
