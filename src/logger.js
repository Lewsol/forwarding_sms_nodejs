import winston from 'winston';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ level, message, timestamp, stack }) => {
      if (stack) {
        return `${timestamp} [${level.toUpperCase()}] ${message}\n${stack}`;
      }
      return `${timestamp} [${level.toUpperCase()}] ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ level, message, timestamp }) => {
          return `${timestamp} ${level}: ${message}`;
        })
      )
    }),
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5
    }),
    new winston.transports.File({
      filename: 'logs/combined.log',
      maxsize: 5242880, // 5MB
      maxFiles: 5
    })
  ]
});

// 创建循环日志缓冲区（用于API查询）
class LogBuffer {
  constructor(maxLines = 120) {
    this.buffer = [];
    this.maxLines = maxLines;
    this.index = 0;
  }

  add(line) {
    if (this.buffer.length < this.maxLines) {
      this.buffer.push(line);
    } else {
      this.buffer[this.index] = line;
      this.index = (this.index + 1) % this.maxLines;
    }
  }

  getAll() {
    if (this.buffer.length < this.maxLines) {
      return this.buffer.slice();
    }
    // 从index位置开始重新排序，保持时间顺序
    return [
      ...this.buffer.slice(this.index),
      ...this.buffer.slice(0, this.index)
    ];
  }

  clear() {
    this.buffer = [];
    this.index = 0;
  }
}

// 创建全局日志缓冲区
const logBuffer = new LogBuffer(120);

function formatLogPart(part) {
  if (part instanceof Error) {
    return part.stack || part.message;
  }
  if (typeof part === 'object' && part !== null) {
    try {
      return JSON.stringify(part);
    } catch (err) {
      return String(part);
    }
  }
  return String(part);
}

function formatLocalTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('-') + ' ' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join(':');
}

function addToBuffer(level, message, args = []) {
  const timestamp = formatLocalTimestamp();
  const details = [message, ...args].map(formatLogPart).join(' ');
  logBuffer.add(`${timestamp} [${level.toUpperCase()}] ${details}`);
}

// 拦截日志输出，同时写入缓冲区。winston的info/warn/error便捷方法不会走自定义log方法。
const originalLog = logger.log.bind(logger);
logger.log = function(level, message, ...args) {
  addToBuffer(level, message, args);
  return originalLog(level, message, ...args);
};

['error', 'warn', 'info', 'debug'].forEach((level) => {
  const original = logger[level].bind(logger);
  logger[level] = function(message, ...args) {
    addToBuffer(level, message, args);
    return original(message, ...args);
  };
});

// 导出日志缓冲区
logger.getBuffer = () => logBuffer;

export default logger;
