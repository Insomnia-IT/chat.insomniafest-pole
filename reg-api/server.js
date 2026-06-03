const express = require('express');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;
const CODE_REGEX = /^[0-9a-f]{32}$/i;

// Keeps issued credentials stable for a code during service lifetime.
const credentialsByCode = new Map();

app.use(express.json({ limit: '16kb' }));

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/credentials', (req, res) => {
  const code = String(req.body?.code || '').trim().toLowerCase();
  if (!CODE_REGEX.test(code)) {
    return res.status(400).json({
      error: 'Invalid badge code format. Expected 32 hexadecimal characters.'
    });
  }

  const existing = credentialsByCode.get(code);
  if (existing) {
    return res.json(existing);
  }

  const username = `vol-${code.slice(0, 8)}`;
  const tempPassword = generateTempPassword();
  const payload = { username, tempPassword };
  credentialsByCode.set(code, payload);

  return res.json(payload);
});

function generateTempPassword() {
  return crypto.randomBytes(9).toString('base64url');
}

app.listen(port, () => {
  console.log(`reg-api listening on ${port}`);
});
