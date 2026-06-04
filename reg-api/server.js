const express = require('express');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;
const CODE_REGEX = /^[0-9a-f]{32}$/i;
const FEED_API_BASE_URL = process.env.FEED_API_BASE_URL;
const FEED_API_AUTH = process.env.FEED_API_AUTH;
const SYNAPSE_URL = process.env.SYNAPSE_URL || 'http://pole-synapse:8008';
const SYNAPSE_SERVER_NAME = process.env.SYNAPSE_SERVER_NAME || 'pole.insomniafest.ru';
const SYNAPSE_SHARED_SECRET = process.env.SYNAPSE_REGISTRATION_SHARED_SECRET;
const APP_ENV = String(process.env.env || process.env.ENV || 'prod').trim().toLowerCase();

app.use(express.json({ limit: '16kb' }));
app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  const startedAt = Date.now();
  logInfo('http.request', 'Входящий HTTP запрос', {
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl
  });
  res.on('finish', () => {
    logInfo('http.response', 'Исходящий HTTP ответ', {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - startedAt
    });
  });
  next();
});

if (!FEED_API_AUTH) {
  logWarn('startup.config', 'FEED_API_AUTH is not configured');
}
if (!SYNAPSE_SHARED_SECRET) {
  logWarn('startup.config', 'SYNAPSE_REGISTRATION_SHARED_SECRET is not configured');
}

app.post('/getUserInfo', async (req, res) => {
  const requestId = req.requestId;
  const code = String(req.body?.code || '').trim().toLowerCase();
  let firstName = '';
  let lastName = '';
  let telegram = '';
  let userId = null;
  let usernameInfo = null;
  let localpart = null;
  if (!CODE_REGEX.test(code)) {
    logWarn('api.getUserInfo.invalid_qr', 'Request rejected: invalid QR format', { requestId, codeLength: code.length });
    return res.status(400).json({
      error: 'Неверный формат QR-кода. Ожидается 32 шестнадцатеричных символа.'
    });
  }

  if (!FEED_API_AUTH) {
    logError('api.getUserInfo.config', 'FEED_API_AUTH is missing', { requestId });
    return res.status(500).json({
      error: 'Не задана конфигурация FEED_API_AUTH на сервере.'
    });
  }

  if (!SYNAPSE_SHARED_SECRET) {
    logError('api.getUserInfo.config', 'SYNAPSE_REGISTRATION_SHARED_SECRET is missing', { requestId });
    return res.status(500).json({
      error: 'Не задана конфигурация SYNAPSE_REGISTRATION_SHARED_SECRET на сервере.'
    });
  }

  try {
    const volunteerId = await fetchVolunteerIdByQr(code, requestId);
    if (!volunteerId) {
      logWarn('api.getUserInfo.not_found', 'Volunteer not found by QR', { requestId, code });
      return res.status(404).json({ error: 'Волонтер с таким QR-кодом не найден.' });
    }

    const volunteer = await fetchVolunteerById(volunteerId, requestId);
    firstName = String(volunteer?.first_name || '').trim();
    lastName = String(volunteer?.last_name || '').trim();
    telegram = String(volunteer?.person?.telegram || '').trim();
    usernameInfo = buildLocalpart(telegram, volunteerId);
    localpart = usernameInfo.localpart;
    userId = `@${localpart}:${SYNAPSE_SERVER_NAME}`;

    const available = await isUsernameAvailable(localpart, requestId);
    if (!available) {
      logWarn('api.getUserInfo.user_exists', 'User already exists in Synapse', {
        requestId,
        volunteerId,
        localpart,
        usernameSource: usernameInfo.source
      });
      return res.status(409).json({
        error: 'Пользователь уже существует в Synapse.',
        firstName,
        lastName,
        telegram: telegram || null,
        username: userId,
        usernameSource: usernameInfo.source
      });
    }

    const tempPassword = generateTempPassword();
    await createSynapseUser(localpart, tempPassword, requestId);

    logInfo('api.getUserInfo.created', 'Synapse user created', {
      requestId,
      volunteerId,
      localpart,
      usernameSource: usernameInfo.source
    });

    return res.json({
      firstName,
      lastName,
      telegram: telegram || null,
      username: userId,
      usernameSource: usernameInfo.source,
      tempPassword
    });
  } catch (error) {
    if (error?.code === 'USER_EXISTS') {
      logWarn('api.getUserInfo.user_exists_race', 'User already exists during create flow', {
        requestId,
        localpart,
        usernameSource: usernameInfo.source
      });
      return res.status(409).json({
        error: 'Пользователь уже существует в Synapse.',
        firstName,
        lastName,
        telegram: telegram || null,
        username: userId,
        usernameSource: usernameInfo.source
      });
    }

    logError('api.getUserInfo.failed', error.message, { requestId, stack: error.stack });
    return res.status(502).json({ error: 'Ошибка при обработке запроса. Попробуйте еще раз.' });
  }
});

async function fetchVolunteerIdByQr(code, requestId) {
  const url = new URL('volunteers/', FEED_API_BASE_URL + '/');
  url.searchParams.set('qr', code);

  const data = await feedRequest(url.toString(), requestId);
  const results = Array.isArray(data?.results) ? data.results : [];
  const volunteerId = results[0]?.id || null;

  logInfo('feed.lookup.qr_result', 'Volunteer lookup by QR result', {
    requestId,
    url: url.toString(),
    count: typeof data?.count === 'number' ? data.count : null,
    resultsLength: results.length,
    firstResultId: volunteerId
  });

  return volunteerId;
}

async function fetchVolunteerById(volunteerId, requestId) {
  const url = new URL(`volunteers/${volunteerId}`, FEED_API_BASE_URL + '/');
  return feedRequest(url.toString(), requestId);
}

async function feedRequest(url, requestId) {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: FEED_API_AUTH
    }
  });

  const payload = await parseResponseBody(response);
  if (!response.ok) {
    const details = payload?.json?.detail || payload?.json?.error || payload?.textPreview || `HTTP ${response.status}`;
    logError('feed.request.failed', 'Feed API request failed', {
      requestId,
      url,
      status: response.status,
      contentType: payload?.contentType || null,
      details,
      bodyPreview: payload?.textPreview || null,
      authHeaderPresent: Boolean(FEED_API_AUTH),
      authScheme: extractAuthScheme(FEED_API_AUTH)
    });
    throw new Error(`Feed API request failed: ${details}`);
  }

  return payload.json;
}

async function isUsernameAvailable(localpart, requestId) {
  const url = new URL('/_matrix/client/v3/register/available', SYNAPSE_URL + '/');
  url.searchParams.set('username', localpart);

  const response = await fetch(url.toString(), { method: 'GET' });
  const payload = await parseJsonSafe(response);

  if (response.ok && payload?.available === true) {
    return true;
  }

  if (response.status === 400 && payload?.errcode === 'M_USER_IN_USE') {
    return false;
  }

  // If the endpoint is unavailable or registration checks are blocked,
  // continue with registration attempt and let Synapse decide.
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    return true;
  }

  if (!response.ok) {
    logError('synapse.available.failed', 'Synapse user availability check failed', {
      requestId,
      localpart,
      status: response.status,
      details: payload?.error || null
    });
    throw new Error(`Synapse user availability check failed: ${payload?.error || `HTTP ${response.status}`}`);
  }

  return true;
}

async function createSynapseUser(localpart, password, requestId) {
  const registerUrl = new URL('/_synapse/admin/v1/register', SYNAPSE_URL + '/').toString();

  const nonceResponse = await fetch(registerUrl, { method: 'GET' });
  const noncePayload = await parseJsonSafe(nonceResponse);
  if (!nonceResponse.ok || !noncePayload?.nonce) {
    logError('synapse.nonce.failed', 'Could not fetch Synapse nonce', {
      requestId,
      status: nonceResponse.status,
      details: noncePayload?.error || null
    });
    throw new Error(`Could not fetch Synapse nonce: ${noncePayload?.error || `HTTP ${nonceResponse.status}`}`);
  }

  const nonce = noncePayload.nonce;
  const mac = hmacSha1(
    SYNAPSE_SHARED_SECRET,
    `${nonce}\x00${localpart}\x00${password}\x00notadmin`
  );

  const createResponse = await fetch(registerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nonce,
      username: localpart,
      password,
      admin: false,
      mac
    })
  });

  const createPayload = await parseJsonSafe(createResponse);
  if (createResponse.ok) {
    return;
  }

  if (createResponse.status === 400 && createPayload?.errcode === 'M_USER_IN_USE') {
    logWarn('synapse.create.user_exists', 'User already exists during create', {
      requestId,
      localpart
    });
    const err = new Error('User already exists in Synapse.');
    err.code = 'USER_EXISTS';
    throw err;
  }

  logError('synapse.create.failed', 'Could not create Synapse user', {
    requestId,
    localpart,
    status: createResponse.status,
    details: createPayload?.error || null
  });

  throw new Error(`Could not create Synapse user: ${createPayload?.error || `HTTP ${createResponse.status}`}`);
}

function buildLocalpart(telegram, volunteerId) {
  const raw = String(telegram || '').replace(/^@/, '').trim().toLowerCase();
  const clean = raw.replace(/[^a-z0-9._=\/-]/g, '_').replace(/^_+|_+$/g, '');

  if (APP_ENV === 'test') {
    if (clean.length >= 3) {
      return { localpart: `test-${clean}`, source: 'test' };
    }
    return { localpart: `test-user${volunteerId}`, source: 'test' };
  }

  if (clean.length >= 3) {
    return { localpart: clean, source: 'telegram' };
  }
  return { localpart: `user${volunteerId}`, source: 'fallback' };
}

function hmacSha1(secret, text) {
  return crypto.createHmac('sha1', secret).update(text).digest('hex');
}

async function parseJsonSafe(response) {
  try {
    return await response.json();
  } catch (_) {
    return {};
  }
}

async function parseResponseBody(response) {
  const contentType = response.headers.get('content-type') || '';
  const text = await response.text();
  let json = {};

  if (text) {
    try {
      json = JSON.parse(text);
    } catch (_) {
      json = {};
    }
  }

  return {
    contentType,
    json,
    textPreview: text ? text.slice(0, 300) : ''
  };
}

function extractAuthScheme(value) {
  if (!value) {
    return null;
  }
  const firstToken = String(value).trim().split(/\s+/, 1)[0];
  return firstToken || null;
}

function generateTempPassword() {
  return crypto.randomBytes(12).toString('base64url');
}

app.use((req, res) => {
  logWarn('http.not_found', 'Route not found', {
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl
  });
  res.status(404).json({ error: 'Маршрут не найден' });
});

function logInfo(event, message, meta = {}) {
  log('INFO', event, message, meta);
}

function logWarn(event, message, meta = {}) {
  log('WARN', event, message, meta);
}

function logError(event, message, meta = {}) {
  log('ERROR', event, message, meta);
}

function log(level, event, message, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    message,
    ...meta
  };
  const line = JSON.stringify(entry);
  if (level === 'ERROR') {
    console.error(line);
    return;
  }
  console.log(line);
}

app.listen(port, () => {
  logInfo('startup.listen', `reg-api listening on ${port}`, {
    port,
    env: APP_ENV,
    feedApiBaseUrl: FEED_API_BASE_URL,
    synapseUrl: SYNAPSE_URL,
    synapseServerName: SYNAPSE_SERVER_NAME
  });
});
