const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const { promises: fs } = require("node:fs");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const DATA_DIR = path.join(ROOT_DIR, "data");
const BOOK_FILE = path.join(DATA_DIR, "book.json");
const VOTE_FILE = path.join(DATA_DIR, "vote.json");
const USER_FILE = path.join(DATA_DIR, "user.json");
const SESSION_COOKIE_NAME = "book_vote_session";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

let voteWriteQueue = Promise.resolve();
let userWriteQueue = Promise.resolve();
let bookWriteQueue = Promise.resolve();
const sessions = new Map();

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  res.end(JSON.stringify(payload));
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, {
    success: false,
    message
  });
}

async function readJsonFile(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      error.statusCode = 500;
      error.publicMessage = `${path.basename(filePath)} 不存在`;
    } else if (error instanceof SyntaxError) {
      error.statusCode = 500;
      error.publicMessage = `${path.basename(filePath)} 格式错误`;
    }
    throw error;
  }
}

async function writeJsonFile(filePath, data) {
  const content = `${JSON.stringify(data, null, 2)}\n`;
  await fs.writeFile(filePath, content, "utf8");
}

async function ensureJsonFile(filePath, defaultValue) {
  try {
    return await readJsonFile(filePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      await writeJsonFile(filePath, defaultValue);
      return defaultValue;
    }
    throw error;
  }
}

function isValidBookList(books) {
  return Array.isArray(books) && books.every((book) => {
    return book && typeof book.id === "string" && typeof book.title === "string";
  });
}

function normalizeVotes(votes, books) {
  const normalized = votes && typeof votes === "object" && !Array.isArray(votes) ? votes : {};

  for (const book of books) {
    const current = normalized[book.id];
    if (!current || typeof current.count !== "number") {
      normalized[book.id] = {
        bookId: book.id,
        count: 0
      };
    }
  }

  return normalized;
}

function isValidUserList(users) {
  return Array.isArray(users) && users.every((user) => {
    return user
      && typeof user.id === "string"
      && typeof user.username === "string"
      && typeof user.passwordHash === "string"
      && typeof user.salt === "string"
      && typeof user.createdAt === "string"
      && (user.role === undefined || user.role === "user" || user.role === "admin");
  });
}

function getCookie(req, name) {
  const cookieHeader = req.headers.cookie || "";
  const cookies = cookieHeader.split(";").map((item) => item.trim()).filter(Boolean);

  for (const cookie of cookies) {
    const [rawKey, ...rawValue] = cookie.split("=");
    if (rawKey === name) {
      return decodeURIComponent(rawValue.join("="));
    }
  }

  return "";
}

function createSession(user) {
  const sessionId = crypto.randomBytes(32).toString("hex");
  sessions.set(sessionId, {
    userId: user.id,
    username: user.username,
    role: user.role || "user",
    createdAt: new Date().toISOString()
  });
  return sessionId;
}

function getCurrentUser(req) {
  const sessionId = getCookie(req, SESSION_COOKIE_NAME);
  const session = sessionId ? sessions.get(sessionId) : null;

  if (!session) {
    return null;
  }

  return {
    id: session.userId,
    username: session.username,
    role: session.role || "user"
  };
}

function isAdmin(req) {
  return getCurrentUser(req)?.role === "admin";
}

function clearSession(req) {
  const sessionId = getCookie(req, SESSION_COOKIE_NAME);
  if (sessionId) {
    sessions.delete(sessionId);
  }
}

function buildSessionCookie(sessionId) {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Lax; Path=/`;
}

function buildClearSessionCookie() {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function createPasswordRecord(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return {
    salt,
    passwordHash: hashPassword(password, salt)
  };
}

function verifyPassword(password, user) {
  const expected = Buffer.from(user.passwordHash, "hex");
  const actual = Buffer.from(hashPassword(password, user.salt), "hex");

  if (expected.length !== actual.length) {
    return false;
  }

  return crypto.timingSafeEqual(expected, actual);
}

async function loadBooks() {
  const books = await readJsonFile(BOOK_FILE);
  if (!isValidBookList(books)) {
    const error = new Error("book.json 数据结构错误");
    error.statusCode = 500;
    error.publicMessage = "book.json 数据结构错误";
    throw error;
  }
  return books;
}

async function loadVotes(books) {
  try {
    const votes = await readJsonFile(VOTE_FILE);
    return normalizeVotes(votes, books);
  } catch (error) {
    if (error.code === "ENOENT") {
      const emptyVotes = normalizeVotes({}, books);
      await writeJsonFile(VOTE_FILE, emptyVotes);
      return emptyVotes;
    }
    throw error;
  }
}

async function loadUsers() {
  const users = await ensureJsonFile(USER_FILE, []);

  if (!isValidUserList(users)) {
    const error = new Error("user.json 数据结构错误");
    error.statusCode = 500;
    error.publicMessage = "user.json 数据结构错误";
    throw error;
  }

  return users;
}

function mergeBooksWithVotes(books, votes) {
  return books.map((book) => ({
    ...book,
    votes: votes[book.id]?.count ?? 0
  }));
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(Object.assign(new Error("请求体过大"), {
          statusCode: 413,
          publicMessage: "请求体过大"
        }));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(Object.assign(error, {
          statusCode: 400,
          publicMessage: "请求体必须是有效 JSON"
        }));
      }
    });

    req.on("error", reject);
  });
}

async function handleGetBooks(res) {
  const books = await loadBooks();
  const votes = await loadVotes(books);
  sendJson(res, 200, {
    success: true,
    data: mergeBooksWithVotes(books, votes)
  });
}

async function handleGetVotes(res) {
  const books = await loadBooks();
  const votes = await loadVotes(books);
  sendJson(res, 200, {
    success: true,
    data: votes
  });
}

async function handleRegister(req, res) {
  const payload = await readRequestBody(req);
  const username = typeof payload.username === "string" ? payload.username.trim() : "";
  const password = typeof payload.password === "string" ? payload.password : "";

  if (!username) {
    sendError(res, 400, "用户名不能为空");
    return;
  }

  if (!password) {
    sendError(res, 400, "密码不能为空");
    return;
  }

  const registerTask = userWriteQueue.then(async () => {
    const users = await loadUsers();
    const exists = users.some((user) => user.username === username);

    if (exists) {
      sendError(res, 409, "用户名已存在");
      return;
    }

    const passwordRecord = createPasswordRecord(password);
    const user = {
      id: `user-${crypto.randomUUID()}`,
      username,
      passwordHash: passwordRecord.passwordHash,
      salt: passwordRecord.salt,
      createdAt: new Date().toISOString(),
      role: "user"
    };

    users.push(user);
    await writeJsonFile(USER_FILE, users);

    sendJson(res, 201, {
      success: true,
      data: {
        id: user.id,
        username: user.username,
        role: user.role
      },
      message: "注册成功"
    });
  });

  userWriteQueue = registerTask.catch(() => {});
  await registerTask;
}

async function handleLogin(req, res) {
  const payload = await readRequestBody(req);
  const username = typeof payload.username === "string" ? payload.username.trim() : "";
  const password = typeof payload.password === "string" ? payload.password : "";

  if (!username) {
    sendError(res, 400, "用户名不能为空");
    return;
  }

  if (!password) {
    sendError(res, 400, "密码不能为空");
    return;
  }

  const users = await loadUsers();
  const user = users.find((item) => item.username === username);

  if (!user || !verifyPassword(password, user)) {
    sendError(res, 401, "用户名或密码错误");
    return;
  }

  const sessionId = createSession(user);
  sendJson(res, 200, {
    success: true,
    data: {
      id: user.id,
      username: user.username,
      role: user.role || "user"
    },
    message: "登录成功"
  }, {
    "Set-Cookie": buildSessionCookie(sessionId)
  });
}

async function handleLogout(req, res) {
  clearSession(req);
  sendJson(res, 200, {
    success: true,
    message: "退出登录成功"
  }, {
    "Set-Cookie": buildClearSessionCookie()
  });
}

function handleGetMe(req, res) {
  sendJson(res, 200, {
    success: true,
    data: getCurrentUser(req)
  });
}

async function handlePostVote(req, res) {
  const currentUser = getCurrentUser(req);
  if (!currentUser) {
    sendError(res, 401, "请先登录后再投票");
    return;
  }

  const payload = await readRequestBody(req);
  const bookId = typeof payload.bookId === "string" ? payload.bookId.trim() : "";

  if (!bookId) {
    sendError(res, 400, "bookId 不能为空");
    return;
  }

  const updateTask = voteWriteQueue.then(async () => {
    const books = await loadBooks();
    const exists = books.some((book) => book.id === bookId);

    if (!exists) {
      sendError(res, 404, "图书不存在");
      return;
    }

    const votes = await loadVotes(books);
    const current = votes[bookId] || { bookId, count: 0 };
    const nextVote = {
      bookId,
      count: current.count + 1
    };

    votes[bookId] = nextVote;
    await writeJsonFile(VOTE_FILE, votes);

    sendJson(res, 200, {
      success: true,
      data: nextVote,
      message: "投票成功"
    });
  });

  voteWriteQueue = updateTask.catch(() => {});
  await updateTask;
}

function validateBookPayload(payload) {
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  const author = typeof payload.author === "string" ? payload.author.trim() : "";
  const description = typeof payload.description === "string" ? payload.description.trim() : "";
  const coverUrl = typeof payload.coverUrl === "string" ? payload.coverUrl.trim() : "";

  if (!title) {
    return { error: "书名不能为空" };
  }

  if (!author) {
    return { error: "作者不能为空" };
  }

  if (!description) {
    return { error: "简介不能为空" };
  }

  return {
    data: {
      title,
      author,
      description,
      coverUrl
    }
  };
}

async function handleUpdateBook(req, res, bookId) {
  const currentUser = getCurrentUser(req);

  if (!currentUser) {
    sendError(res, 401, "请先登录");
    return;
  }

  if (!isAdmin(req)) {
    sendError(res, 403, "无管理员权限");
    return;
  }

  if (!bookId) {
    sendError(res, 400, "bookId 不能为空");
    return;
  }

  const payload = await readRequestBody(req);
  const validation = validateBookPayload(payload);

  if (validation.error) {
    sendError(res, 400, validation.error);
    return;
  }

  const updateTask = bookWriteQueue.then(async () => {
    const books = await loadBooks();
    const index = books.findIndex((book) => book.id === bookId);

    if (index === -1) {
      sendError(res, 404, "图书不存在");
      return;
    }

    const updatedBook = {
      ...books[index],
      ...validation.data
    };

    books[index] = updatedBook;
    await writeJsonFile(BOOK_FILE, books);

    sendJson(res, 200, {
      success: true,
      data: updatedBook,
      message: "图书信息已更新"
    });
  });

  bookWriteQueue = updateTask.catch(() => {});
  await updateTask;
}

async function serveStatic(req, res, url) {
  const requestedPath = decodeURIComponent(url.pathname);
  const relativePath = requestedPath === "/" ? "index.html" : requestedPath.slice(1);
  const filePath = path.join(PUBLIC_DIR, relativePath);
  const normalizedPath = path.normalize(filePath);

  if (!normalizedPath.startsWith(PUBLIC_DIR)) {
    sendError(res, 403, "禁止访问该路径");
    return;
  }

  try {
    const content = await fs.readFile(normalizedPath);
    const ext = path.extname(normalizedPath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream"
    });
    res.end(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      res.writeHead(404, {
        "Content-Type": "text/html; charset=utf-8"
      });
      res.end("<h1>404</h1><p>页面不存在</p>");
      return;
    }
    throw error;
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === "GET" && url.pathname === "/api/books") {
      await handleGetBooks(res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/votes") {
      await handleGetVotes(res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/me") {
      handleGetMe(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/register") {
      await handleRegister(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/login") {
      await handleLogin(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/logout") {
      await handleLogout(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/votes") {
      await handlePostVote(req, res);
      return;
    }

    const bookUpdateMatch = url.pathname.match(/^\/api\/books\/([^/]+)$/);
    if (req.method === "PUT" && bookUpdateMatch) {
      await handleUpdateBook(req, res, decodeURIComponent(bookUpdateMatch[1]));
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      sendError(res, 404, "接口不存在");
      return;
    }

    if (req.method !== "GET") {
      sendError(res, 405, "请求方法不支持");
      return;
    }

    await serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    sendError(res, error.statusCode || 500, error.publicMessage || "服务器内部错误");
  }
}

const server = http.createServer(handleRequest);

server.listen(PORT, HOST, () => {
  console.log(`Book voting app is running at http://${HOST}:${PORT}`);
});
