const crypto = require('crypto');
const pino = require('pino');
const pinoHttp = require('pino-http');

const logger = pino({
  // Jest would otherwise interleave request logs through the test output.
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  formatters: { level: (label) => ({ level: label }) },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Credentials must never reach the log sink. Error objects thrown by the
  // OpenAI/Astra SDKs carry request config, so redact by wildcard path too.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-api-key"]',
      '*.apiKey',
      '*.token',
      '*.headers.authorization',
    ],
    censor: '[redacted]',
  },
});

const httpLogger = pinoHttp({
  logger,
  genReqId: (req, res) => {
    const existing = req.headers['x-request-id'];
    const id = existing || crypto.randomUUID();
    res.setHeader('x-request-id', id); // echo it so clients can correlate
    return id;
  },
  customLogLevel: (req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  serializers: {
    req: (req) => ({ id: req.id, method: req.method, url: req.url, ip: req.remoteAddress }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
});

module.exports = { logger, httpLogger };
