const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const crypto = require("node:crypto");
const { promises: fs } = require("node:fs");

const PORT = Number(process.env.PORT) || 3002;
const HOST = process.env.HOST || "127.0.0.1";
const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const COVERS_DIR = path.join(PUBLIC_DIR, "covers");
const DATA_DIR = path.join(ROOT_DIR, "data");
const BOOK_FILE = path.join(DATA_DIR, "book.json");
const VOTE_FILE = path.join(DATA_DIR, "vote.json");
const USER_VOTE_FILE = path.join(DATA_DIR, "userVote.json");
const USER_FILE = path.join(DATA_DIR, "user.json");
const BOOK_CATALOG_FILE = path.join(DATA_DIR, "bookCatalog.json");
const PASSWORD_RESET_FILE = path.join(DATA_DIR, "passwordReset.json");
const SESSION_COOKIE_NAME = "book_vote_session";
const MAX_VOTES_PER_USER = 3;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;
const PASSWORD_RESET_RETENTION_MS = 24 * 60 * 60 * 1000;
const HTTPS_FETCH_TIMEOUT_MS = 30 * 1000;
const HTTPS_MAX_BYTES = 5 * 1024 * 1024;
const APP_BASE_URL = process.env.APP_BASE_URL || `http://${HOST}:${PORT}`;

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
let passwordResetWriteQueue = Promise.resolve();
const sessions = new Map();
let cachedMailer = null;

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

function isValidBookCatalog(catalog) {
  return Array.isArray(catalog) && catalog.every((item) => {
    return item
      && typeof item.title === "string"
      && typeof item.author === "string"
      && typeof item.description === "string"
      && (item.bookId === undefined || typeof item.bookId === "string")
      && (item.coverUrl === undefined || typeof item.coverUrl === "string")
      && (item.coverSource === undefined || typeof item.coverSource === "string")
      && (item.aliases === undefined || (Array.isArray(item.aliases) && item.aliases.every((alias) => typeof alias === "string")));
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

function normalizeUserVotes(userVotes) {
  const normalized = userVotes && typeof userVotes === "object" && !Array.isArray(userVotes) ? userVotes : {};

  for (const [userId, record] of Object.entries(normalized)) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      delete normalized[userId];
      continue;
    }

    const votes = Array.isArray(record.votes)
      ? record.votes.filter((vote) => vote && typeof vote.bookId === "string")
      : [];

    normalized[userId] = {
      userId,
      total: votes.length,
      votes: votes.map((vote) => ({
        bookId: vote.bookId,
        createdAt: typeof vote.createdAt === "string" ? vote.createdAt : new Date().toISOString()
      }))
    };
  }

  return normalized;
}

function getUserVoteRecord(userVotes, userId) {
  const record = userVotes[userId];
  const votes = record && Array.isArray(record.votes)
    ? record.votes.filter((vote) => vote && typeof vote.bookId === "string")
    : [];

  return {
    userId,
    total: votes.length,
    votes
  };
}

function getVoteQuota(userVotes, userId) {
  const record = getUserVoteRecord(userVotes, userId);
  const voteTotal = record.total;

  return {
    voteTotal,
    remainingVotes: Math.max(MAX_VOTES_PER_USER - voteTotal, 0),
    maxVotesPerUser: MAX_VOTES_PER_USER
  };
}

function isValidUserList(users) {
  return Array.isArray(users) && users.every((user) => {
    return user
      && typeof user.id === "string"
      && typeof user.username === "string"
      && typeof user.passwordHash === "string"
      && typeof user.salt === "string"
      && typeof user.createdAt === "string"
      && (user.role === undefined || user.role === "user" || user.role === "admin")
      && (user.email === undefined || typeof user.email === "string");
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

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function validateEmail(value) {
  const email = normalizeEmail(value);
  if (!email) {
    return { error: "邮箱不能为空" };
  }

  if (email.length > 254 || !EMAIL_REGEX.test(email)) {
    return { error: "邮箱格式不正确" };
  }

  return { email };
}

function findUserByEmail(users, email) {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    return null;
  }

  return users.find((user) => normalizeEmail(user.email) === normalized) || null;
}

function hashResetToken(token) {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function pruneExpiredResets(resets) {
  if (!Array.isArray(resets)) {
    return [];
  }

  const now = Date.now();
  return resets.filter((entry) => {
    if (!entry || typeof entry !== "object") {
      return false;
    }

    const expiresAt = Date.parse(entry.expiresAt || "");
    if (Number.isNaN(expiresAt)) {
      return false;
    }

    if (entry.usedAt) {
      const usedAt = Date.parse(entry.usedAt);
      if (Number.isNaN(usedAt)) {
        return false;
      }
      return now - usedAt < PASSWORD_RESET_RETENTION_MS;
    }

    return expiresAt > now;
  });
}

async function loadPasswordResets() {
  const resets = await ensureJsonFile(PASSWORD_RESET_FILE, []);
  return pruneExpiredResets(resets);
}

function httpsRequest(targetUrl, { maxBytes = HTTPS_MAX_BYTES, timeout = HTTPS_FETCH_TIMEOUT_MS, redirects = 4 } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (error) {
      reject(new Error("链接格式不正确"));
      return;
    }

    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      reject(new Error("仅支持 http/https 链接"));
      return;
    }

    const transport = parsed.protocol === "https:" ? https : require("node:http");
    const req = transport.get(parsed, {
      headers: {
        "User-Agent": "vote-book/1.0 (+local)",
        "Accept": "application/json, image/*;q=0.9, */*;q=0.5"
      },
      timeout
    }, (res) => {
      const { statusCode = 0, headers = {} } = res;

      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume();
        if (redirects <= 0) {
          reject(new Error("重定向次数过多"));
          return;
        }
        const nextUrl = new URL(headers.location, parsed).toString();
        httpsRequest(nextUrl, { maxBytes, timeout, redirects: redirects - 1 }).then(resolve, reject);
        return;
      }

      if (statusCode < 200 || statusCode >= 300) {
        res.resume();
        reject(new Error(`远程响应 ${statusCode}`));
        return;
      }

      const chunks = [];
      let total = 0;

      res.on("data", (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          req.destroy();
          reject(new Error("远程内容超过大小限制"));
          return;
        }
        chunks.push(chunk);
      });

      res.on("end", () => {
        resolve({
          statusCode,
          headers,
          body: Buffer.concat(chunks)
        });
      });

      res.on("error", reject);
    });

    req.on("timeout", () => {
      req.destroy(new Error("远程请求超时"));
    });

    req.on("error", reject);
  });
}

async function httpsGetJson(targetUrl) {
  const result = await httpsRequest(targetUrl);
  const contentType = String(result.headers["content-type"] || "");
  if (!contentType.includes("json")) {
    throw new Error("远程响应不是 JSON");
  }
  try {
    return JSON.parse(result.body.toString("utf8"));
  } catch (error) {
    throw new Error("远程 JSON 解析失败");
  }
}

async function httpsDownloadImage(targetUrl, destPath) {
  const result = await httpsRequest(targetUrl);
  const contentType = String(result.headers["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("image/")) {
    throw new Error("封面链接返回的不是图片");
  }
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await fs.writeFile(destPath, result.body);
  return {
    bytes: result.body.length,
    contentType
  };
}

function getMailer() {
  if (cachedMailer !== null) {
    return cachedMailer;
  }

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || user;

  if (!host || !port || !user || !pass || !from) {
    cachedMailer = { transport: null, from: from || "" };
    return cachedMailer;
  }

  try {
    const nodemailer = require("nodemailer");
    const secure = String(process.env.SMTP_SECURE || "").toLowerCase() === "true" || port === 465;
    const transport = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass }
    });
    cachedMailer = { transport, from };
  } catch (error) {
    console.error("[mail] 加载 nodemailer 失败：", error.message);
    cachedMailer = { transport: null, from: from || "" };
  }

  return cachedMailer;
}

async function sendPasswordResetEmail(email, resetUrl) {
  const mailer = getMailer();

  if (!mailer.transport) {
    console.warn(`[mail] SMTP 未配置，跳过邮件发送。重置链接（请手动转发给 ${email}）：${resetUrl}`);
    return { delivered: false, fallback: true };
  }

  try {
    const info = await mailer.transport.sendMail({
      from: mailer.from,
      to: email,
      subject: "图书投票应用 - 密码重置",
      text: [
        "你好，",
        "",
        "我们收到了你的密码重置请求。如果是你本人发起，请点击下方链接在 30 分钟内完成重置：",
        resetUrl,
        "",
        "如果你没有发起此请求，可以忽略本邮件，密码不会变化。",
        "",
        "—— 图书投票应用"
      ].join("\n")
    });
    return { delivered: true, messageId: info?.messageId };
  } catch (error) {
    console.error(`[mail] 发送重置邮件失败（${email}）：${error.message}；重置链接：${resetUrl}`);
    return { delivered: false, fallback: true };
  }
}

function getNextBookId(books) {
  let max = 0;
  for (const book of books) {
    const match = /^book-(\d+)$/.exec(String(book.id));
    if (match) {
      const value = Number.parseInt(match[1], 10);
      if (Number.isFinite(value) && value > max) {
        max = value;
      }
    }
  }
  return `book-${String(max + 1).padStart(3, "0")}`;
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

async function loadBookCatalog() {
  const catalog = await ensureJsonFile(BOOK_CATALOG_FILE, []);

  if (!isValidBookCatalog(catalog)) {
    const error = new Error("bookCatalog.json 数据结构错误");
    error.statusCode = 500;
    error.publicMessage = "bookCatalog.json 数据结构错误";
    throw error;
  }

  return catalog;
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

async function loadUserVotes() {
  try {
    const userVotes = await ensureJsonFile(USER_VOTE_FILE, {});
    return normalizeUserVotes(userVotes);
  } catch (error) {
    if (error.code === "ENOENT") {
      await writeJsonFile(USER_VOTE_FILE, {});
      return {};
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

async function serializeCurrentUser(user) {
  if (!user) {
    return null;
  }

  const userVotes = await loadUserVotes();
  const users = await loadUsers();
  const record = users.find((item) => item.id === user.id);

  return {
    ...user,
    email: record?.email || "",
    ...getVoteQuota(userVotes, user.id)
  };
}

function mergeBooksWithVotes(books, votes) {
  return books.map((book) => ({
    ...book,
    votes: votes[book.id]?.count ?? 0
  }));
}

function normalizeTitleForMatch(value) {
  return String(value || "").trim();
}

function normalizeAliasForMatch(value) {
  return normalizeTitleForMatch(value).toLowerCase();
}

function findBookSuggestion(catalog, title) {
  const normalizedTitle = normalizeTitleForMatch(title);
  const normalizedAlias = normalizeAliasForMatch(title);

  const byTitle = catalog.find((item) => normalizeTitleForMatch(item.title) === normalizedTitle);
  if (byTitle) {
    return {
      item: byTitle,
      matchedBy: "title"
    };
  }

  const byAlias = catalog.find((item) => {
    return Array.isArray(item.aliases)
      && item.aliases.some((alias) => normalizeAliasForMatch(alias) === normalizedAlias);
  });

  if (byAlias) {
    return {
      item: byAlias,
      matchedBy: "alias"
    };
  }

  return null;
}

function serializeBookSuggestion(match) {
  return {
    bookId: match.item.bookId || "",
    title: match.item.title,
    author: match.item.author,
    description: match.item.description,
    coverUrl: match.item.coverUrl || "",
    coverSource: match.item.coverSource || "",
    matchedBy: match.matchedBy
  };
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
  const emailValidation = validateEmail(payload.email);

  if (!username) {
    sendError(res, 400, "用户名不能为空");
    return;
  }

  if (!password) {
    sendError(res, 400, "密码不能为空");
    return;
  }

  if (emailValidation.error) {
    sendError(res, 400, emailValidation.error);
    return;
  }

  const registerTask = userWriteQueue.then(async () => {
    const users = await loadUsers();
    const exists = users.some((user) => user.username === username);

    if (exists) {
      sendError(res, 409, "用户名已存在");
      return;
    }

    if (findUserByEmail(users, emailValidation.email)) {
      sendError(res, 409, "邮箱已被使用");
      return;
    }

    const passwordRecord = createPasswordRecord(password);
    const user = {
      id: `user-${crypto.randomUUID()}`,
      username,
      email: emailValidation.email,
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
        email: user.email,
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
  const serializedUser = await serializeCurrentUser({
    id: user.id,
    username: user.username,
    role: user.role || "user"
  });

  sendJson(res, 200, {
    success: true,
    data: serializedUser,
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

async function handleGetMe(req, res) {
  const currentUser = getCurrentUser(req);

  sendJson(res, 200, {
    success: true,
    data: await serializeCurrentUser(currentUser)
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

    const userVotes = await loadUserVotes();
    const userRecord = getUserVoteRecord(userVotes, currentUser.id);

    if (userRecord.total >= MAX_VOTES_PER_USER) {
      sendJson(res, 403, {
        success: false,
        data: {
          ...getVoteQuota(userVotes, currentUser.id)
        },
        message: "已达到投票上限"
      });
      return;
    }

    const votes = await loadVotes(books);
    const current = votes[bookId] || { bookId, count: 0 };
    const nextVote = {
      bookId,
      count: current.count + 1
    };

    votes[bookId] = nextVote;
    const nextUserRecord = {
      userId: currentUser.id,
      votes: [
        ...userRecord.votes,
        {
          bookId,
          createdAt: new Date().toISOString()
        }
      ]
    };
    nextUserRecord.total = nextUserRecord.votes.length;
    userVotes[currentUser.id] = nextUserRecord;

    await writeJsonFile(VOTE_FILE, votes);
    await writeJsonFile(USER_VOTE_FILE, userVotes);

    sendJson(res, 200, {
      success: true,
      data: {
        ...nextVote,
        ...getVoteQuota(userVotes, currentUser.id)
      },
      message: "投票成功"
    });
  });

  voteWriteQueue = updateTask.catch(() => {});
  await updateTask;
}

async function handleResetVotes(req, res) {
  const currentUser = getCurrentUser(req);

  if (!currentUser) {
    sendError(res, 401, "请先登录");
    return;
  }

  if (!isAdmin(req)) {
    sendError(res, 403, "无管理员权限");
    return;
  }

  const payload = await readRequestBody(req);
  if (payload.confirm !== true) {
    sendError(res, 400, "请确认重置票数");
    return;
  }

  const resetTask = voteWriteQueue.then(async () => {
    const books = await loadBooks();
    const resetVotes = {};

    for (const book of books) {
      resetVotes[book.id] = {
        bookId: book.id,
        count: 0
      };
    }

    await writeJsonFile(VOTE_FILE, resetVotes);
    await writeJsonFile(USER_VOTE_FILE, {});

    sendJson(res, 200, {
      success: true,
      data: {
        reset: true,
        votes: resetVotes,
        books: mergeBooksWithVotes(books, resetVotes),
        maxVotesPerUser: MAX_VOTES_PER_USER
      },
      message: "所有票数已重置"
    });
  });

  voteWriteQueue = resetTask.catch(() => {});
  await resetTask;
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

async function handleBookSuggestion(req, res, title) {
  const currentUser = getCurrentUser(req);

  if (!currentUser) {
    sendError(res, 401, "请先登录");
    return;
  }

  if (!isAdmin(req)) {
    sendError(res, 403, "无管理员权限");
    return;
  }

  const normalizedTitle = normalizeTitleForMatch(title);
  if (!normalizedTitle) {
    sendError(res, 400, "书名不能为空");
    return;
  }

  const catalog = await loadBookCatalog();
  const match = findBookSuggestion(catalog, normalizedTitle);

  if (!match) {
    sendJson(res, 200, {
      success: true,
      data: null,
      message: "未找到匹配书目信息"
    });
    return;
  }

  sendJson(res, 200, {
    success: true,
    data: serializeBookSuggestion(match)
  });
}

function buildGoogleBooksQuery(title, author, options = {}) {
  const params = new URLSearchParams();
  const q = `intitle:${title} inauthor:${author}`;
  params.set("q", q);
  params.set("maxResults", "5");
  params.set("printType", "books");
  if (options.langRestrict) {
    params.set("langRestrict", options.langRestrict);
  }
  return `https://www.googleapis.com/books/v1/volumes?${params.toString()}`;
}

function pickGoogleBooksItem(payload) {
  if (!payload || !Array.isArray(payload.items)) {
    return null;
  }

  const ranked = payload.items
    .map((item) => item && item.volumeInfo ? item.volumeInfo : null)
    .filter(Boolean)
    .sort((a, b) => {
      const score = (info) => (info.description ? 2 : 0) + (info.imageLinks?.thumbnail || info.imageLinks?.smallThumbnail ? 1 : 0);
      return score(b) - score(a);
    });

  return ranked[0] || null;
}

function upgradeBooksHttpToHttps(url) {
  if (typeof url !== "string") {
    return "";
  }
  return url.replace(/^http:\/\/books\.google\.com/i, "https://books.google.com");
}

async function handleEnrichBook(req, res) {
  const currentUser = getCurrentUser(req);

  if (!currentUser) {
    sendError(res, 401, "请先登录");
    return;
  }

  if (!isAdmin(req)) {
    sendError(res, 403, "无管理员权限");
    return;
  }

  const payload = await readRequestBody(req);
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  const author = typeof payload.author === "string" ? payload.author.trim() : "";

  if (!title) {
    sendError(res, 400, "书名不能为空");
    return;
  }

  if (!author) {
    sendError(res, 400, "作者不能为空");
    return;
  }

  try {
    let result = null;
    for (const langRestrict of ["zh", null]) {
      const url = buildGoogleBooksQuery(title, author, langRestrict ? { langRestrict } : {});
      const data = await httpsGetJson(url);
      const item = pickGoogleBooksItem(data);
      if (item) {
        result = item;
        break;
      }
    }

    if (!result) {
      sendJson(res, 200, {
        success: true,
        data: null,
        message: "未匹配到对应书目，建议手动填写"
      });
      return;
    }

    const description = typeof result.description === "string" ? result.description.trim() : "";
    const coverSourceUrl = upgradeBooksHttpToHttps(result.imageLinks?.thumbnail || result.imageLinks?.smallThumbnail || "");

    sendJson(res, 200, {
      success: true,
      data: {
        title: typeof result.title === "string" ? result.title : title,
        author: Array.isArray(result.authors) && result.authors.length > 0 ? result.authors.join("、") : author,
        description,
        coverSourceUrl,
        source: "google-books"
      }
    });
  } catch (error) {
    console.error("[enrich] Google Books 抓取失败：", error.message);
    sendError(res, 502, "书目抓取失败，请稍后重试或手动填写");
  }
}

function validateNewBookPayload(payload) {
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  const author = typeof payload.author === "string" ? payload.author.trim() : "";
  const description = typeof payload.description === "string" ? payload.description.trim() : "";
  const coverSourceUrl = typeof payload.coverSourceUrl === "string" ? payload.coverSourceUrl.trim() : "";

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
      coverSourceUrl
    }
  };
}

async function handleCreateBook(req, res) {
  const currentUser = getCurrentUser(req);

  if (!currentUser) {
    sendError(res, 401, "请先登录");
    return;
  }

  if (!isAdmin(req)) {
    sendError(res, 403, "无管理员权限");
    return;
  }

  const payload = await readRequestBody(req);
  const validation = validateNewBookPayload(payload);

  if (validation.error) {
    sendError(res, 400, validation.error);
    return;
  }

  const createTask = bookWriteQueue.then(async () => {
    const books = await loadBooks();
    const nextBookId = getNextBookId(books);
    let coverUrl = "/covers/cover-missing.jpg";
    const sourceUrl = validation.data.coverSourceUrl;

    if (sourceUrl) {
      if (/^https?:\/\//i.test(sourceUrl)) {
        const localFile = `${nextBookId}.jpg`;
        const destPath = path.join(COVERS_DIR, localFile);
        try {
          await httpsDownloadImage(sourceUrl, destPath);
          coverUrl = `/covers/${localFile}`;
        } catch (error) {
          console.error(`[create-book] 下载封面失败（${sourceUrl}）：${error.message}`);
          sendError(res, 502, `封面下载失败：${error.message}`);
          return;
        }
      } else if (sourceUrl.startsWith("/covers/")) {
        coverUrl = sourceUrl;
      } else {
        sendError(res, 400, "封面来源必须是 http(s):// 或 /covers/ 路径");
        return;
      }
    }

    const newBook = {
      id: nextBookId,
      title: validation.data.title,
      author: validation.data.author,
      description: validation.data.description,
      coverUrl
    };

    books.push(newBook);
    await writeJsonFile(BOOK_FILE, books);

    const votes = await loadVotes(books);
    votes[nextBookId] = { bookId: nextBookId, count: 0 };
    await writeJsonFile(VOTE_FILE, votes);

    sendJson(res, 201, {
      success: true,
      data: {
        ...newBook,
        votes: 0
      },
      message: "图书已创建"
    });
  });

  bookWriteQueue = createTask.catch(() => {});
  await createTask;
}

async function handleSetEmail(req, res) {
  const currentUser = getCurrentUser(req);

  if (!currentUser) {
    sendError(res, 401, "请先登录");
    return;
  }

  const payload = await readRequestBody(req);
  const validation = validateEmail(payload.email);

  if (validation.error) {
    sendError(res, 400, validation.error);
    return;
  }

  const updateTask = userWriteQueue.then(async () => {
    const users = await loadUsers();
    const index = users.findIndex((user) => user.id === currentUser.id);

    if (index === -1) {
      sendError(res, 404, "用户不存在");
      return;
    }

    const existing = findUserByEmail(users, validation.email);
    if (existing && existing.id !== currentUser.id) {
      sendError(res, 409, "邮箱已被其他账号使用");
      return;
    }

    users[index] = {
      ...users[index],
      email: validation.email
    };

    await writeJsonFile(USER_FILE, users);

    const serialized = await serializeCurrentUser(currentUser);
    sendJson(res, 200, {
      success: true,
      data: serialized,
      message: "邮箱已保存"
    });
  });

  userWriteQueue = updateTask.catch(() => {});
  await updateTask;
}

async function handleForgotPassword(req, res) {
  const payload = await readRequestBody(req);
  const validation = validateEmail(payload.email);

  if (validation.error) {
    sendError(res, 400, validation.error);
    return;
  }

  const genericMessage = "如该邮箱已绑定账号，重置链接已发送，请在 30 分钟内完成重置。";

  const forgotTask = passwordResetWriteQueue.then(async () => {
    const users = await loadUsers();
    const user = findUserByEmail(users, validation.email);

    if (!user) {
      console.warn(`[forgot] 邮箱未注册或未绑定：${validation.email}`);
      sendJson(res, 200, { success: true, message: genericMessage });
      return;
    }

    const resets = await loadPasswordResets();
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashResetToken(token);
    const now = Date.now();

    resets.push({
      tokenHash,
      userId: user.id,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + PASSWORD_RESET_TTL_MS).toISOString(),
      usedAt: null
    });

    await writeJsonFile(PASSWORD_RESET_FILE, resets);

    const resetUrl = `${APP_BASE_URL}/?reset=${token}`;
    await sendPasswordResetEmail(validation.email, resetUrl);

    sendJson(res, 200, { success: true, message: genericMessage });
  });

  passwordResetWriteQueue = forgotTask.catch(() => {});
  await forgotTask;
}

async function handleResetPassword(req, res) {
  const payload = await readRequestBody(req);
  const token = typeof payload.token === "string" ? payload.token.trim() : "";
  const password = typeof payload.password === "string" ? payload.password : "";

  if (!token) {
    sendError(res, 400, "重置令牌不能为空");
    return;
  }

  if (!password) {
    sendError(res, 400, "新密码不能为空");
    return;
  }

  if (password.length < 6) {
    sendError(res, 400, "新密码长度不少于 6 位");
    return;
  }

  const tokenHash = hashResetToken(token);

  const resetTask = passwordResetWriteQueue.then(async () => {
    const resets = await loadPasswordResets();
    const now = Date.now();
    const entry = resets.find((item) => item.tokenHash === tokenHash && !item.usedAt && Date.parse(item.expiresAt) > now);

    if (!entry) {
      sendError(res, 400, "重置链接无效或已过期");
      return;
    }

    const passUsers = userWriteQueue.then(async () => {
      const users = await loadUsers();
      const index = users.findIndex((user) => user.id === entry.userId);

      if (index === -1) {
        sendError(res, 400, "用户不存在");
        return;
      }

      const passwordRecord = createPasswordRecord(password);
      users[index] = {
        ...users[index],
        passwordHash: passwordRecord.passwordHash,
        salt: passwordRecord.salt
      };
      await writeJsonFile(USER_FILE, users);
    });

    userWriteQueue = passUsers.catch(() => {});
    await passUsers;

    if (res.headersSent) {
      return;
    }

    const updatedResets = resets.map((item) => {
      if (item.userId === entry.userId && !item.usedAt) {
        return {
          ...item,
          usedAt: new Date(now).toISOString()
        };
      }
      return item;
    });

    await writeJsonFile(PASSWORD_RESET_FILE, updatedResets);

    sendJson(res, 200, {
      success: true,
      message: "密码已重置，请使用新密码登录。"
    });
  });

  passwordResetWriteQueue = resetTask.catch(() => {});
  await resetTask;
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
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      res.writeHead(404, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
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
      await handleGetMe(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/book-suggestions") {
      await handleBookSuggestion(req, res, url.searchParams.get("title"));
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

    if (req.method === "POST" && url.pathname === "/api/votes/reset") {
      await handleResetVotes(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/books") {
      await handleCreateBook(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/book-enrich") {
      await handleEnrichBook(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/forgot-password") {
      await handleForgotPassword(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/reset-password") {
      await handleResetPassword(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/me/email") {
      await handleSetEmail(req, res);
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
