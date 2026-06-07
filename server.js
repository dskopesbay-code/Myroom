const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname;
const DATA_DIR = path.join(__dirname, 'data');
const BOOKINGS_FILE = path.join(DATA_DIR, 'bookings.jsonl');

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

function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const requestedPath = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requestedPath));

  if (!filePath.startsWith(PUBLIC_DIR) || filePath.includes(`${path.sep}data${path.sep}`)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

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

const server = http.createServer((request, response) => {
  if (request.method === 'POST' && request.url === '/api/bookings') {
    handleBooking(request, response);
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
});
