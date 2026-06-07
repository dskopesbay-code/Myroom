const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname;
const DATA_DIR = path.join(__dirname, 'data');
const BOOKINGS_FILE = path.join(DATA_DIR, 'bookings.jsonl');
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'myroom2026';
const SESSION_TTL_MS = 1000 * 60 * 60 * 8;
const sessions = new Map();

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon'
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(payload));
}

function sendRedirect(response, location) {
  response.writeHead(302, { Location: location });
  response.end();
}

function serveFile(filePath, response) {
  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Страница не найдена');
      return;
    }

    const extension = path.extname(filePath);
    response.writeHead(200, {
      'Content-Type': contentTypes[extension] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=300'
    });
    response.end(content);
  });
}

function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const requestedPath = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requestedPath));

  if (!filePath.startsWith(PUBLIC_DIR) || filePath.includes(`${path.sep}data${path.sep}`)) {
    response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Доступ запрещен');
    return;
  }

  serveFile(filePath, response);
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';

    request.on('data', (chunk) => {
      body += chunk;

      if (body.length > 1_000_000) {
        reject(new Error('Слишком большой размер заявки'));
        request.destroy();
      }
    });

    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function parseCookies(request) {
  const header = request.headers.cookie || '';
  return Object.fromEntries(
    header
      .split(';')
      .map((cookie) => cookie.trim())
      .filter(Boolean)
      .map((cookie) => {
        const separatorIndex = cookie.indexOf('=');
        return [
          decodeURIComponent(cookie.slice(0, separatorIndex)),
          decodeURIComponent(cookie.slice(separatorIndex + 1))
        ];
      })
  );
}

function getSession(request) {
  const cookies = parseCookies(request);
  const token = cookies.admin_session;

  if (!token) {
    return null;
  }

  const session = sessions.get(token);

  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }

  return { token, session };
}

function requireAdmin(request, response) {
  const activeSession = getSession(request);

  if (!activeSession) {
    sendJson(response, 401, { message: 'Нужен вход администратора' });
    return null;
  }

  return activeSession;
}

function createSession(response) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, {
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS
  });

  response.setHeader(
    'Set-Cookie',
    `admin_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`
  );
}

function clearSession(request, response) {
  const activeSession = getSession(request);

  if (activeSession) {
    sessions.delete(activeSession.token);
  }

  response.setHeader('Set-Cookie', 'admin_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}

function validateBooking(data) {
  const requiredFields = ['name', 'phone', 'branch', 'eventType', 'date', 'time', 'guests', 'duration'];
  const missingField = requiredFields.find((field) => !String(data[field] || '').trim());

  if (missingField) {
    return 'Заполните все обязательные поля';
  }

  const guestCount = Number(data.guests);

  if (!Number.isInteger(guestCount) || guestCount < 1 || guestCount > 80) {
    return 'Укажите корректное количество гостей от 1 до 80';
  }

  return null;
}

async function readBookings() {
  try {
    const content = await fs.promises.readFile(BOOKINGS_FILE, 'utf8');
    return content
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

async function handleBooking(request, response) {
  try {
    const body = await readRequestBody(request);
    const data = JSON.parse(body || '{}');
    const validationError = validateBooking(data);

    if (validationError) {
      sendJson(response, 400, { message: validationError });
      return;
    }

    const booking = {
      id: crypto.randomUUID().slice(0, 8).toUpperCase(),
      createdAt: new Date().toISOString(),
      name: String(data.name).trim(),
      phone: String(data.phone).trim(),
      branch: String(data.branch).trim(),
      eventType: String(data.eventType).trim(),
      date: String(data.date).trim(),
      time: String(data.time).trim(),
      guests: Number(data.guests),
      duration: String(data.duration).trim(),
      comment: String(data.comment || '').trim()
    };

    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    await fs.promises.appendFile(BOOKINGS_FILE, `${JSON.stringify(booking)}\n`, 'utf8');

    sendJson(response, 201, {
      message: 'Заявка принята',
      booking
    });
  } catch (error) {
    const isJsonError = error instanceof SyntaxError;
    sendJson(response, isJsonError ? 400 : 500, {
      message: isJsonError ? 'Некорректный JSON в запросе' : 'Не удалось сохранить заявку'
    });
  }
}

async function handleAdminLogin(request, response) {
  try {
    const body = await readRequestBody(request);
    const data = JSON.parse(body || '{}');
    const username = String(data.username || '').trim();
    const password = String(data.password || '');

    if (username !== ADMIN_USER || password !== ADMIN_PASSWORD) {
      sendJson(response, 401, { message: 'Неверный логин или пароль' });
      return;
    }

    createSession(response);
    sendJson(response, 200, { message: 'Вход выполнен' });
  } catch (error) {
    sendJson(response, 400, { message: 'Некорректный запрос' });
  }
}

async function handleAdminBookings(request, response) {
  if (!requireAdmin(request, response)) {
    return;
  }

  try {
    const bookings = await readBookings();
    sendJson(response, 200, { bookings });
  } catch (error) {
    sendJson(response, 500, { message: 'Не удалось загрузить список брони' });
  }
}

function handleAdminLogout(request, response) {
  clearSession(request, response);
  sendJson(response, 200, { message: 'Вы вышли из админки' });
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === 'GET' && url.pathname === '/admin') {
    serveFile(path.join(PUBLIC_DIR, 'admin.html'), response);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/admin/') {
    sendRedirect(response, '/admin');
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/bookings') {
    handleBooking(request, response);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/login') {
    handleAdminLogin(request, response);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/admin/bookings') {
    handleAdminBookings(request, response);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/logout') {
    handleAdminLogout(request, response);
    return;
  }

  if (request.method === 'GET' || request.method === 'HEAD') {
    serveStatic(request, response);
    return;
  }

  response.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('Метод не поддерживается');
});

server.listen(PORT, () => {
  console.log(`MyRoom booking server is running at http://localhost:${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}/admin`);
});
