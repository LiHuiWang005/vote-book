const bookList = document.querySelector("#bookList");
const statusBar = document.querySelector("#status");
const authForm = document.querySelector("#authForm");
const usernameInput = document.querySelector("#username");
const passwordInput = document.querySelector("#password");
const registerButton = document.querySelector("#registerButton");
const loginButton = document.querySelector("#loginButton");
const logoutButton = document.querySelector("#logoutButton");
const userCard = document.querySelector("#userCard");
const currentUsername = document.querySelector("#currentUsername");
const currentRole = document.querySelector("#currentRole");
const adminPanel = document.querySelector("#adminPanel");
const adminBookList = document.querySelector("#adminBookList");

const state = {
  books: [],
  currentUser: null
};

function setStatus(message, type = "info") {
  statusBar.textContent = message;
  statusBar.classList.toggle("is-success", type === "success");
  statusBar.classList.toggle("is-error", type === "error");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setAuthLoading(isLoading) {
  registerButton.disabled = isLoading;
  loginButton.disabled = isLoading;
  logoutButton.disabled = isLoading;
}

function renderAuth() {
  const isLoggedIn = Boolean(state.currentUser);
  authForm.hidden = isLoggedIn;
  userCard.hidden = !isLoggedIn;
  currentUsername.textContent = isLoggedIn ? state.currentUser.username : "";
  currentRole.textContent = isLoggedIn ? (state.currentUser.role === "admin" ? "管理员" : "普通用户") : "";
  renderAdminPanel();
}

function renderAdminPanel() {
  const canManageBooks = state.currentUser?.role === "admin";
  adminPanel.hidden = !canManageBooks;

  if (!canManageBooks) {
    adminBookList.innerHTML = "";
    return;
  }

  if (!state.books.length) {
    adminBookList.innerHTML = '<p class="empty-state">暂无可管理图书。</p>';
    return;
  }

  adminBookList.innerHTML = state.books.map((book) => `
    <form class="admin-book-form" data-admin-book="${escapeHtml(book.id)}">
      <div class="admin-form-title">
        <strong>${escapeHtml(book.title)}</strong>
        <span>${escapeHtml(book.id)}</span>
      </div>
      <label class="field">
        <span>书名</span>
        <input name="title" type="text" value="${escapeHtml(book.title)}">
      </label>
      <label class="field">
        <span>作者</span>
        <input name="author" type="text" value="${escapeHtml(book.author || "")}">
      </label>
      <label class="field admin-field-wide">
        <span>简介</span>
        <textarea name="description" rows="3">${escapeHtml(book.description || "")}</textarea>
      </label>
      <label class="field admin-field-wide">
        <span>封面地址</span>
        <input name="coverUrl" type="url" value="${escapeHtml(book.coverUrl || "")}">
      </label>
      <button class="secondary-button" type="submit">保存</button>
    </form>
  `).join("");
}

function renderBooks() {
  if (!state.books.length) {
    bookList.innerHTML = '<p class="empty-state">暂无候选图书。</p>';
    return;
  }

  bookList.innerHTML = state.books.map((book) => {
    const cover = book.coverUrl || "https://images.unsplash.com/photo-1495446815901-a7297e633e8d?auto=format&fit=crop&w=600&q=80";
    const buttonLabel = state.currentUser ? "投票" : "登录后投票";

    return `
      <article class="book-card" data-book-id="${escapeHtml(book.id)}">
        <div class="cover-wrap">
          <img class="book-cover" src="${escapeHtml(cover)}" alt="${escapeHtml(book.title)}封面">
        </div>
        <div class="book-content">
          <h2 class="book-title">${escapeHtml(book.title)}</h2>
          <p class="book-author">${escapeHtml(book.author || "未知作者")}</p>
          <p class="book-description">${escapeHtml(book.description || "暂无简介。")}</p>
          <div class="book-footer">
            <span class="vote-count"><strong>${Number(book.votes) || 0}</strong> 票</span>
            <button class="vote-button" type="button" data-vote="${escapeHtml(book.id)}">${buttonLabel}</button>
          </div>
        </div>
      </article>
    `;
  }).join("");
}

async function parseApiResponse(response) {
  let payload;

  try {
    payload = await response.json();
  } catch {
    throw new Error("服务器响应格式错误");
  }

  if (!response.ok || !payload.success) {
    throw new Error(payload.message || "请求失败");
  }

  return payload;
}

async function loadBooks() {
  setStatus("正在加载图书...");

  try {
    const response = await fetch("/api/books");
    const payload = await parseApiResponse(response);
    state.books = payload.data;
    renderBooks();
    renderAdminPanel();
    setStatus("图书已加载，可以开始投票。", "success");
  } catch (error) {
    bookList.innerHTML = '<p class="empty-state">图书加载失败。</p>';
    setStatus(error.message || "图书加载失败，请稍后重试。", "error");
  }
}

async function loadCurrentUser() {
  try {
    const response = await fetch("/api/me");
    const payload = await parseApiResponse(response);
    state.currentUser = payload.data;
    renderAuth();
  } catch (error) {
    state.currentUser = null;
    renderAuth();
    setStatus(error.message || "登录状态加载失败。", "error");
  }
}

async function submitAuth(endpoint, successPrefix) {
  const username = usernameInput.value.trim();
  const password = passwordInput.value;

  if (!username) {
    setStatus("用户名不能为空。", "error");
    usernameInput.focus();
    return;
  }

  if (!password) {
    setStatus("密码不能为空。", "error");
    passwordInput.focus();
    return;
  }

  setAuthLoading(true);
  setStatus(`${successPrefix}中...`);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ username, password })
    });
    const payload = await parseApiResponse(response);
    setStatus(payload.message || `${successPrefix}成功。`, "success");

    if (endpoint === "/api/login") {
      state.currentUser = payload.data;
      passwordInput.value = "";
      renderAuth();
      renderBooks();
    }
  } catch (error) {
    setStatus(error.message || `${successPrefix}失败。`, "error");
  } finally {
    setAuthLoading(false);
  }
}

async function logout() {
  setAuthLoading(true);
  setStatus("正在退出登录...");

  try {
    const response = await fetch("/api/logout", {
      method: "POST"
    });
    const payload = await parseApiResponse(response);
    state.currentUser = null;
    renderAuth();
    renderBooks();
    setStatus(payload.message || "退出登录成功。", "success");
  } catch (error) {
    setStatus(error.message || "退出登录失败。", "error");
  } finally {
    setAuthLoading(false);
  }
}

async function updateBook(bookId, form) {
  const formData = new FormData(form);
  const payload = {
    title: String(formData.get("title") || ""),
    author: String(formData.get("author") || ""),
    description: String(formData.get("description") || ""),
    coverUrl: String(formData.get("coverUrl") || "")
  };
  const submitButton = form.querySelector("button[type='submit']");

  submitButton.disabled = true;
  setStatus("正在保存图书信息...");

  try {
    const response = await fetch(`/api/books/${encodeURIComponent(bookId)}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    const result = await parseApiResponse(response);
    const index = state.books.findIndex((book) => book.id === bookId);

    if (index !== -1) {
      state.books[index] = {
        ...state.books[index],
        ...result.data
      };
    }

    renderBooks();
    renderAdminPanel();
    setStatus(result.message || "图书信息已更新。", "success");
  } catch (error) {
    setStatus(error.message || "图书信息保存失败。", "error");
    submitButton.disabled = false;
  }
}

async function voteForBook(bookId, button) {
  const book = state.books.find((item) => item.id === bookId);
  if (!book) {
    setStatus("图书不存在。", "error");
    return;
  }

  if (!state.currentUser) {
    setStatus("请先登录后再投票。", "error");
    usernameInput.focus();
    return;
  }

  button.disabled = true;
  button.textContent = "投票中";
  setStatus(`正在为《${book.title}》投票...`);

  try {
    const response = await fetch("/api/votes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ bookId })
    });
    const payload = await parseApiResponse(response);
    book.votes = payload.data.count;
    renderBooks();
    setStatus(`《${book.title}》投票成功，当前 ${book.votes} 票。`, "success");
  } catch (error) {
    setStatus(error.message || "投票失败，请稍后重试。", "error");
    button.disabled = false;
    button.textContent = "投票";
  }
}

bookList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-vote]");
  if (!button) {
    return;
  }

  voteForBook(button.dataset.vote, button);
});

adminBookList.addEventListener("submit", (event) => {
  const form = event.target.closest("[data-admin-book]");
  if (!form) {
    return;
  }

  event.preventDefault();
  updateBook(form.dataset.adminBook, form);
});

authForm.addEventListener("submit", (event) => {
  event.preventDefault();
  submitAuth("/api/login", "登录");
});

registerButton.addEventListener("click", () => {
  submitAuth("/api/register", "注册");
});

logoutButton.addEventListener("click", logout);

async function init() {
  await loadCurrentUser();
  await loadBooks();
}

init();
