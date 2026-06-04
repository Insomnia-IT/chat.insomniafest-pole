const express = require('express');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;
const CODE_REGEX = /^[0-9a-f]{32}$/i;
const FEED_API_BASE_URL = process.env.FEED_API_BASE_URL;
const FEED_API_AUTH = process.env.FEED_API_AUTH;
const SYNAPSE_URL = process.env.SYNAPSE_URL || 'http://pole-synapse:8008';
const SYNAPSE_SERVER_NAME = process.env.SYNAPSE_SERVER_NAME || 'pole.insomniafest.ru';
const SYNAPSE_SHARED_SECRET = normalizeSecret(process.env.SYNAPSE_REGISTRATION_SHARED_SECRET);
const SYNAPSE_ADMIN_ACCESS_TOKEN = process.env.SYNAPSE_ADMIN_ACCESS_TOKEN;
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
    const engagements = normalizeEngagements(volunteer?.person?.engagements);
    const teams = buildTeamsFromEngagements(engagements);
    const shouldBeServerAdmin = engagements.some((e) => e.roleId === 'ORGANIZER' || e.roleId === 'VICE');
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

      await syncVolunteerMatrixAccess({
        requestId,
        userId,
        teams,
        shouldBeServerAdmin
      });

      return res.status(409).json({
        error: 'Пользователь уже зарегистрирован. Если вы забыли пароль (или если кто-то зарегистрировал вас без вашего ведома), обратитесь в штаб для сброса пароля.',
        firstName,
        lastName,
        telegram: telegram || null,
        username: userId,
        usernameSource: usernameInfo.source
      });
    }

    const tempPassword = generateTempPassword();
    const displayName = buildDisplayName(firstName, lastName);
    await createSynapseUser(localpart, tempPassword, displayName, requestId);

    await syncVolunteerMatrixAccess({
      requestId,
      userId,
      teams,
      shouldBeServerAdmin
    });

    logInfo('api.getUserInfo.created', 'Synapse user created', {
      requestId,
      volunteerId,
      localpart,
      usernameSource: usernameInfo.source,
      displayName,
      teamsCount: teams.length,
      shouldBeServerAdmin
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
        error: 'Пользователь уже зарегистрирован. Если вы забыли пароль (или если кто-то зарегистрировал вас без вашего ведома), обратитесь в штаб для сброса пароля.',
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

async function createSynapseUser(localpart, password, displayName, requestId, options = {}) {
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
  const adminFlag = 'notadmin';
  const mac = buildSynapseRegisterMac({
    secret: SYNAPSE_SHARED_SECRET,
    nonce,
    localpart,
    password,
    isAdmin: false
  });

  const createResponse = await fetch(registerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nonce,
      username: localpart,
      password,
      displayname: displayName || undefined,
      admin: false,
      mac
    })
  });

  const createPayload = await parseJsonSafe(createResponse);
  if (createResponse.ok) {
    return { created: true };
  }

  if (createResponse.status === 400 && createPayload?.errcode === 'M_USER_IN_USE') {
    logWarn('synapse.create.user_exists', 'User already exists during create', {
      requestId,
      localpart
    });
    if (options.allowUserExists) {
      return { created: false };
    }
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

async function syncVolunteerMatrixAccess({ requestId, userId, teams, shouldBeServerAdmin }) {
  const accessToken = await getServiceAccessToken();
  if (!accessToken) {
    logWarn('synapse.admin_token.missing', 'SYNAPSE_ADMIN_ACCESS_TOKEN is not set; skipping room/admin sync', {
      requestId,
      userId,
      teamsCount: teams.length,
      shouldBeServerAdmin
    });
    return;
  }

  if (shouldBeServerAdmin) {
    await ensureServerAdmin(userId, accessToken, requestId);
  }

  for (const team of teams) {
    const roomId = await ensureTeamRoom(team, accessToken, requestId);
    await forceJoinUserToRoom(userId, roomId, accessToken, requestId);
    if (shouldBeServerAdmin) {
      await ensureRoomAdmin(userId, roomId, accessToken, requestId);
      continue;
    }

    if (team.isTeamLead) {
      await ensureRoomModerator(userId, roomId, accessToken, requestId);
    }
  }
}

async function getServiceAccessToken() {
  if (!SYNAPSE_ADMIN_ACCESS_TOKEN) {
    return null;
  }
  return SYNAPSE_ADMIN_ACCESS_TOKEN;
}

async function ensureServerAdmin(userId, accessToken, requestId) {
  const response = await synapseRequest(
    `/_synapse/admin/v2/users/${encodeURIComponent(userId)}`,
    {
      method: 'PUT',
      accessToken,
      body: { admin: true }
    },
    requestId,
    { 400: 'handled' }
  );

  if (response.status === 400) {
    await synapseRequest(
      `/_synapse/admin/v1/users/${encodeURIComponent(userId)}/admin`,
      {
        method: 'PUT',
        accessToken,
        body: { admin: true }
      },
      requestId
    );
  }
}

async function ensureTeamRoom(team, accessToken, requestId) {
  const roomAlias = `#${team.aliasLocalpart}:${SYNAPSE_SERVER_NAME}`;

  const lookup = await synapseRequest(
    `/_matrix/client/v3/directory/room/${encodeURIComponent(roomAlias)}`,
    {
      method: 'GET',
      accessToken
    },
    requestId,
    { 404: 'handled' }
  );

  if (lookup.status === 200 && lookup.payload?.room_id) {
    return lookup.payload.room_id;
  }

  const create = await synapseRequest(
    '/_matrix/client/v3/createRoom',
    {
      method: 'POST',
      accessToken,
      body: {
        name: team.directionName,
        room_alias_name: team.aliasLocalpart,
        preset: 'private_chat',
        visibility: 'private'
      }
    },
    requestId,
    { 400: 'handled' }
  );

  if (create.status === 200 && create.payload?.room_id) {
    return create.payload.room_id;
  }

  const createErr = create.payload?.errcode;
  if (create.status === 400 && createErr === 'M_ROOM_IN_USE') {
    const secondLookup = await synapseRequest(
      `/_matrix/client/v3/directory/room/${encodeURIComponent(roomAlias)}`,
      {
        method: 'GET',
        accessToken
      },
      requestId
    );
    return secondLookup.payload.room_id;
  }

  throw new Error(`Could not ensure team room for ${team.directionName}`);
}

async function forceJoinUserToRoom(userId, roomId, accessToken, requestId) {
  await synapseRequest(
    `/_synapse/admin/v1/join/${encodeURIComponent(roomId)}`,
    {
      method: 'POST',
      accessToken,
      body: { user_id: userId }
    },
    requestId
  );
}

async function ensureRoomModerator(userId, roomId, accessToken, requestId) {
  await ensureRoomPowerAtLeast(userId, roomId, accessToken, requestId, 50);
}

async function ensureRoomAdmin(userId, roomId, accessToken, requestId) {
  await ensureRoomPowerAtLeast(userId, roomId, accessToken, requestId, 100);
}

async function ensureRoomPowerAtLeast(userId, roomId, accessToken, requestId, minPower) {
  const statePath = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.power_levels`;
  const current = await synapseRequest(
    statePath,
    {
      method: 'GET',
      accessToken
    },
    requestId,
    { 404: 'handled' }
  );

  const base = current.status === 200
    ? current.payload
    : {
        users: {},
        users_default: 0,
        events: {},
        events_default: 0,
        state_default: 50,
        ban: 50,
        kick: 50,
        redact: 50,
        invite: 0
      };

  base.users = base.users || {};
  const currentPower = Number(base.users[userId] || 0);
  if (currentPower >= minPower) {
    return;
  }

  base.users[userId] = minPower;
  await synapseRequest(
    statePath,
    {
      method: 'PUT',
      accessToken,
      body: base
    },
    requestId
  );
}

function normalizeEngagements(engagements) {
  if (!Array.isArray(engagements)) {
    return [];
  }

  return engagements
    .map((item) => ({
      roleId: String(item?.role?.id || '').trim(),
      directionId: String(item?.direction?.id || '').trim(),
      directionName: String(item?.direction?.name || '').trim()
    }))
    .filter((item) => item.directionName);
}

function buildTeamsFromEngagements(engagements) {
  const teamsByKey = new Map();

  for (const item of engagements) {
    const key = item.directionId || item.directionName;
    if (!teamsByKey.has(key)) {
      teamsByKey.set(key, {
        directionId: item.directionId || null,
        directionName: item.directionName,
        isTeamLead: false,
        aliasLocalpart: makeTeamAliasLocalpart(item.directionName, item.directionId)
      });
    }
    const team = teamsByKey.get(key);
    if (item.roleId === 'TEAM_LEAD') {
      team.isTeamLead = true;
    }
  }

  return Array.from(teamsByKey.values());
}

function makeTeamAliasLocalpart(directionName, directionId) {
  const slug = String(directionName || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const safeSlug = slug || 'team';
  const suffixSource = String(directionId || directionName || 'team');
  const suffix = crypto.createHash('sha1').update(suffixSource).digest('hex').slice(0, 8);
  return `team-${safeSlug}-${suffix}`.slice(0, 120);
}

async function synapseRequest(path, options, requestId, handledStatuses = {}) {
  const url = new URL(path, SYNAPSE_URL + '/').toString();
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${options.accessToken}`,
      'Content-Type': 'application/json'
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const payload = await parseResponseBody(response);
  if (!response.ok && !handledStatuses[response.status]) {
    const details = payload?.json?.error || payload?.json?.errcode || payload?.textPreview || `HTTP ${response.status}`;
    logError('synapse.request.failed', 'Synapse request failed', {
      requestId,
      path,
      status: response.status,
      details
    });
    throw new Error(`Synapse request failed (${path}): ${details}`);
  }

  return {
    status: response.status,
    payload: payload.json
  };
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

function buildSynapseRegisterMac({ secret, nonce, localpart, password, isAdmin }) {
  const flag = isAdmin ? 'admin' : 'notadmin';
  const msg = [String(nonce), String(localpart), String(password), flag].join('\x00');
  return crypto
    .createHmac('sha1', Buffer.from(String(secret), 'utf8'))
    .update(Buffer.from(msg, 'utf8'))
    .digest('hex');
}

function normalizeSecret(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }

  // Handle accidental quoting in env files: SECRET="..." or SECRET='...'
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }

  return raw;
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

function buildDisplayName(firstName, lastName) {
  return [String(firstName || '').trim(), String(lastName || '').trim()]
    .filter(Boolean)
    .join(' ');
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
