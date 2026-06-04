const express = require('express');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;
const CODE_REGEX = /^[0-9a-f]{32}$/i;
const FEED_API_BASE_URL = process.env.FEED_API_BASE_URL || 'https://feedapp-dev.insomniafest.ru/feedapi/v1';
const FEED_API_AUTH = process.env.FEED_API_AUTH;
const SYNAPSE_URL = process.env.SYNAPSE_URL || 'http://pole-synapse:8008';
const SYNAPSE_SERVER_NAME = process.env.SYNAPSE_SERVER_NAME || 'pole.insomniafest.ru';
const SYNAPSE_SHARED_SECRET = process.env.SYNAPSE_REGISTRATION_SHARED_SECRET;
const APP_ENV = String(process.env.env || process.env.ENV || 'prod').trim().toLowerCase();

app.use(express.json({ limit: '16kb' }));
app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  next();
});

if (!FEED_API_AUTH) {
  logWarn('startup.config', 'FEED_API_AUTH не задан');
}
if (!SYNAPSE_SHARED_SECRET) {
  logWarn('startup.config', 'SYNAPSE_REGISTRATION_SHARED_SECRET не задан');
}

app.post('/getUserInfo', async (req, res) => {
  const requestId = req.requestId;
  const code = String(req.body?.code || '').trim().toLowerCase();
  if (!CODE_REGEX.test(code)) {
    logWarn('api.getUserInfo.invalid_qr', 'Отклонен запрос с неверным форматом QR', { requestId, codeLength: code.length });
    return res.status(400).json({
      error: 'Неверный формат QR-кода. Ожидается 32 шестнадцатеричных символа.'
    });
  }

  if (!FEED_API_AUTH) {
    logError('api.getUserInfo.config', 'Не задан FEED_API_AUTH', { requestId });
    return res.status(500).json({
      error: 'Не задана конфигурация FEED_API_AUTH на сервере.'
    });
  }

  if (!SYNAPSE_SHARED_SECRET) {
    logError('api.getUserInfo.config', 'Не задан SYNAPSE_REGISTRATION_SHARED_SECRET', { requestId });
    return res.status(500).json({
      error: 'Не задана конфигурация SYNAPSE_REGISTRATION_SHARED_SECRET на сервере.'
    });
  }

  try {
    const volunteerId = await fetchVolunteerIdByQr(code, requestId);
    if (!volunteerId) {
      logWarn('api.getUserInfo.not_found', 'Волонтер не найден по QR', { requestId, code });
      return res.status(404).json({ error: 'Волонтер с таким QR-кодом не найден.' });
    }

    const volunteer = await fetchVolunteerById(volunteerId, requestId);
    const firstName = String(volunteer?.first_name || '').trim();
    const lastName = String(volunteer?.last_name || '').trim();
    const telegram = String(volunteer?.person?.telegram || '').trim();
    const usernameInfo = buildLocalpart(telegram, volunteerId);
    const localpart = usernameInfo.localpart;
    const userId = `@${localpart}:${SYNAPSE_SERVER_NAME}`;

    const available = await isUsernameAvailable(localpart, requestId);
    if (!available) {
      logWarn('api.getUserInfo.user_exists', 'Пользователь уже существует в Synapse', {
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

    logInfo('api.getUserInfo.created', 'Создан пользователь Synapse', {
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
    logError('api.getUserInfo.failed', error.message, { requestId, stack: error.stack });
    return res.status(502).json({ error: error.message || 'Непредвиденная ошибка сервера.' });
  }
});

async function fetchVolunteerIdByQr(code, requestId) {
  const url = new URL('/volunteers/', FEED_API_BASE_URL + '/');
  url.searchParams.set('qr', code);

  const data = await feedRequest(url.toString(), requestId);
  const results = Array.isArray(data?.results) ? data.results : [];
  return results[0]?.id || null;
}

async function fetchVolunteerById(volunteerId, requestId) {
  const url = new URL(`/volunteers/${volunteerId}`, FEED_API_BASE_URL + '/');
  return feedRequest(url.toString(), requestId);
}

async function feedRequest(url, requestId) {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: FEED_API_AUTH
    }
  });

  const payload = await parseJsonSafe(response);
  if (!response.ok) {
    const details = payload?.detail || payload?.error || `HTTP ${response.status}`;
    logError('feed.request.failed', 'Ошибка запроса к Feed API', {
      requestId,
      url,
      status: response.status,
      details
    });
    throw new Error(`Ошибка запроса к Feed API: ${details}`);
  }

  return payload;
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
    logError('synapse.available.failed', 'Ошибка проверки доступности пользователя', {
      requestId,
      localpart,
      status: response.status,
      details: payload?.error || null
    });
    throw new Error(`Ошибка проверки доступности пользователя в Synapse: ${payload?.error || `HTTP ${response.status}`}`);
  }

  return true;
}

async function createSynapseUser(localpart, password, requestId) {
  const registerUrl = new URL('/_synapse/admin/v1/register', SYNAPSE_URL + '/').toString();

  const nonceResponse = await fetch(registerUrl, { method: 'GET' });
  const noncePayload = await parseJsonSafe(nonceResponse);
  if (!nonceResponse.ok || !noncePayload?.nonce) {
    logError('synapse.nonce.failed', 'Не удалось получить nonce от Synapse', {
      requestId,
      status: nonceResponse.status,
      details: noncePayload?.error || null
    });
    throw new Error(`Не удалось получить nonce от Synapse: ${noncePayload?.error || `HTTP ${nonceResponse.status}`}`);
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
    logWarn('synapse.create.user_exists', 'Пользователь уже существует при создании', {
      requestId,
      localpart
    });
    throw new Error('Пользователь уже существует в Synapse.');
  }

  logError('synapse.create.failed', 'Не удалось создать пользователя в Synapse', {
    requestId,
    localpart,
    status: createResponse.status,
    details: createPayload?.error || null
  });

  throw new Error(`Не удалось создать пользователя в Synapse: ${createPayload?.error || `HTTP ${createResponse.status}`}`);
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

function generateTempPassword() {
  return crypto.randomBytes(12).toString('base64url');
}

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
