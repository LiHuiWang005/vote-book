const bookList = document.querySelector("#bookList");
const statusBar = document.querySelector("#status");
const authForm = document.querySelector("#authForm");
const usernameInput = document.querySelector("#username");
const emailInput = document.querySelector("#email");
const passwordInput = document.querySelector("#password");
const registerButton = document.querySelector("#registerButton");
const loginButton = document.querySelector("#loginButton");
const logoutButton = document.querySelector("#logoutButton");
const forgotPasswordLink = document.querySelector("#forgotPasswordLink");
const userCard = document.querySelector("#userCard");
const currentUsername = document.querySelector("#currentUsername");
const currentRole = document.querySelector("#currentRole");
const currentEmail = document.querySelector("#currentEmail");
const voteQuota = document.querySelector("#voteQuota");
const adminPanel = document.querySelector("#adminPanel");
const adminBookList = document.querySelector("#adminBookList");
const resetVotesButton = document.querySelector("#resetVotesButton");
const leaderboard = document.querySelector("#leaderboard");
const emailPromptPanel = document.querySelector("#emailPromptPanel");
const emailPromptForm = document.querySelector("#emailPromptForm");
const emailPromptInput = document.querySelector("#emailPromptInput");
const emailPromptSubmitButton = document.querySelector("#emailPromptSubmit");
const emailPromptSkipButton = document.querySelector("#emailPromptSkip");
const resetPasswordPanel = document.querySelector("#resetPasswordPanel");
const resetPasswordForm = document.querySelector("#resetPasswordForm");
const resetPasswordInput = document.querySelector("#resetPasswordInput");
const resetPasswordConfirm = document.querySelector("#resetPasswordConfirm");
const resetSubmitButton = document.querySelector("#resetSubmitButton");
const resetCancelButton = document.querySelector("#resetCancelButton");
const newBookToggle = document.querySelector("#newBookToggle");
const newBookForm = document.querySelector("#newBookForm");
const newBookTitle = document.querySelector("#newBookTitle");
const newBookAuthor = document.querySelector("#newBookAuthor");
const newBookDescription = document.querySelector("#newBookDescription");
const newBookCoverSource = document.querySelector("#newBookCoverSource");
const newBookCoverPreview = document.querySelector("#newBookCoverPreview");
const newBookCoverPlaceholder = document.querySelector("#newBookCoverPlaceholder");
const newBookEnrichButton = document.querySelector("#newBookEnrichButton");
const newBookCancelButton = document.querySelector("#newBookCancelButton");
const newBookSaveButton = document.querySelector("#newBookSaveButton");
const newBookEnrichStatus = document.querySelector("#newBookEnrichStatus");

const state = {
  books: [],
  currentUser: null,
  suggestionTimers: new Map(),
  resetToken: "",
  emailPromptDismissed: false
};

function getBookById(bookId) {
  return state.books.find((book) => book.id === bookId) || null;
}

function setStatus(message, type = "info") {
  statusBar.textContent = message;
  statusBar.classList.toggle("is-success", type === "success");
  statusBar.classList.toggle("is-error", type === "error");
}

function getTopVoteMessage() {
  if (!state.books.length) {
    return "暂无候选图书。";
  }

  const maxVotes = state.books.reduce((max, book) => Math.max(max, Number(book.votes) || 0), 0);
  if (maxVotes <= 0) {
    return "当前还没有图书获得投票。";
  }

  const leaders = state.books.filter((book) => (Number(book.votes) || 0) === maxVotes);
  const leaderNames = leaders.map((book) => `《${book.title}》`).join("、");
  return `当前最高票：${leaderNames}，${maxVotes} 票。`;
}

function getVoteSnapshot() {
  const totalVotes = state.books.reduce((total, book) => total + (Number(book.votes) || 0), 0);
  const rankedBooks = state.books
    .map((book, index) => ({
      book,
      votes: Number(book.votes) || 0,
      originalIndex: index
    }))
    .sort((a, b) => {
      if (b.votes !== a.votes) {
        return b.votes - a.votes;
      }

      return a.originalIndex - b.originalIndex;
    });

  const rankByBookId = new Map();

  if (totalVotes > 0) {
    rankedBooks.slice(0, 3).forEach((item, index) => {
      if (item.votes > 0) {
        rankByBookId.set(item.book.id, index + 1);
      }
    });
  }

  return {
    totalVotes,
    rankedBooks,
    rankByBookId
  };
}

function getVotePercent(votes, totalVotes) {
  return totalVotes > 0 ? Math.round((votes / totalVotes) * 100) : 0;
}

function renderLeaderboard(voteSnapshot = getVoteSnapshot()) {
  if (!leaderboard) {
    return;
  }

  const { totalVotes, rankedBooks } = voteSnapshot;

  if (!state.books.length) {
    leaderboard.innerHTML = `
      <div class="leaderboard-heading">
        <div>
          <p class="eyebrow">Leaderboard</p>
          <h2>排行榜 Top 3</h2>
        </div>
        <span class="leaderboard-total">0 票</span>
      </div>
      <p class="leaderboard-empty">暂无候选图书。</p>
    `;
    return;
  }

  if (totalVotes <= 0) {
    leaderboard.innerHTML = `
      <div class="leaderboard-heading">
        <div>
          <p class="eyebrow">Leaderboard</p>
          <h2>排行榜 Top 3</h2>
        </div>
        <span class="leaderboard-total">0 票</span>
      </div>
      <p class="leaderboard-empty">暂无投票，成为第一个投票的人</p>
    `;
    return;
  }

  const topBooks = rankedBooks.slice(0, 3);

  leaderboard.innerHTML = `
    <div class="leaderboard-heading">
      <div>
        <p class="eyebrow">Leaderboard</p>
        <h2>排行榜 Top 3</h2>
      </div>
      <span class="leaderboard-total">总票数 ${totalVotes}</span>
    </div>
    <div class="leaderboard-list">
      ${topBooks.map((item, index) => {
        const rank = index + 1;
        const votePercent = getVotePercent(item.votes, totalVotes);
        const percentLabel = `${votePercent}%`;

        return `
          <article class="leaderboard-item rank-${rank}">
            <span class="leaderboard-rank">#${rank}</span>
            <div class="leaderboard-book">
              <strong>${escapeHtml(item.book.title)}</strong>
              <span>${escapeHtml(item.book.author || "未知作者")}</span>
            </div>
            <div class="leaderboard-score">
              <span><strong>${item.votes}</strong> 票</span>
              <span>${percentLabel}</span>
            </div>
          </article>
        `;
      }).join("")}
    </div>
  `;
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

function getRemainingVotes() {
  if (!state.currentUser) {
    return 0;
  }

  return Math.max(Number(state.currentUser.remainingVotes) || 0, 0);
}

function getVoteQuotaLabel() {
  if (!state.currentUser) {
    return "";
  }

  const remainingVotes = getRemainingVotes();
  const maxVotes = Number(state.currentUser.maxVotesPerUser) || 3;
  const usedVotes = Math.max(Number(state.currentUser.voteTotal) || 0, 0);
  return `剩余 ${remainingVotes} 票 / 共 ${maxVotes} 票，已投 ${usedVotes} 票`;
}

function renderAuth() {
  const isLoggedIn = Boolean(state.currentUser);
  authForm.hidden = isLoggedIn;
  userCard.hidden = !isLoggedIn;
  currentUsername.textContent = isLoggedIn ? state.currentUser.username : "";
  currentRole.textContent = isLoggedIn ? (state.currentUser.role === "admin" ? "管理员" : "普通用户") : "";
  currentEmail.textContent = isLoggedIn && state.currentUser.email ? state.currentUser.email : "";
  voteQuota.textContent = getVoteQuotaLabel();
  renderAdminPanel();
  renderEmailPrompt();
}

function renderEmailPrompt() {
  if (!emailPromptPanel) {
    return;
  }
  const needs = Boolean(state.currentUser) && !state.currentUser.email && !state.emailPromptDismissed;
  emailPromptPanel.hidden = !needs;
  if (needs) {
    emailPromptInput.value = "";
  }
}

function renderAdminPanel() {
  const canManageBooks = state.currentUser?.role === "admin";
  adminPanel.hidden = !canManageBooks;
  state.suggestionTimers.forEach((timer) => clearTimeout(timer));
  state.suggestionTimers.clear();

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
        <div>
          <strong>${escapeHtml(book.title)}</strong>
          <span>${escapeHtml(book.id)}</span>
        </div>
        <button class="secondary-button" type="submit">保存</button>
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
        <input name="coverUrl" type="text" value="${escapeHtml(book.coverUrl || "")}">
      </label>
      <p class="suggestion-status" data-suggestion-status aria-live="polite"></p>
    </form>
  `).join("");
}

function renderBooks() {
  const voteSnapshot = getVoteSnapshot();
  renderLeaderboard(voteSnapshot);

  if (!state.books.length) {
    bookList.innerHTML = '<p class="empty-state">暂无候选图书。</p>';
    return;
  }

  const { totalVotes, rankByBookId } = voteSnapshot;
  const maxVotes = state.books.reduce((max, book) => Math.max(max, Number(book.votes) || 0), 0);

  bookList.innerHTML = state.books.map((book) => {
    const cover = book.coverUrl || "/covers/cover-missing.jpg";
    const isVoteLimitReached = Boolean(state.currentUser) && getRemainingVotes() <= 0;
    const buttonLabel = state.currentUser ? (isVoteLimitReached ? "已达上限" : "投票") : "登录后投票";
    const votes = Number(book.votes) || 0;
    const votePercent = totalVotes > 0 ? Math.round((votes / totalVotes) * 100) : 0;
    const voteLabel = `${votes} 票`;
    const percentLabel = `${votePercent}%`;
    const voteStatus = state.currentUser ? (isVoteLimitReached ? "投票已用完" : `剩余 ${getRemainingVotes()} 票`) : "需要登录";
    const rank = rankByBookId.get(book.id);
    const rankLabel = rank ? `<span class="book-rank-badge">#${rank}</span>` : "";
    return `
      <article class="book-list-item" data-book-id="${escapeHtml(book.id)}">
        <div class="book-cover-cell">
          <img class="book-cover" src="${escapeHtml(cover)}" alt="${escapeHtml(book.title)}封面">
        </div>
        <div class="book-content">
          <div class="book-title-row">
            <h2 class="book-title">${escapeHtml(book.title)}</h2>
            ${rankLabel}
            <span class="book-id-badge">${escapeHtml(book.id)}</span>
          </div>
          <p class="book-author">作者：${escapeHtml(book.author || "未知作者")}</p>
          <p class="book-description">${escapeHtml(book.description || "暂无简介。")}</p>
          <div class="book-meta-row">
            <span class="book-meta-pill">候选图书</span>
            <span class="book-meta-pill">${voteStatus}</span>
            ${votes > 0 && votes === maxVotes ? '<span class="book-meta-pill leader-pill">当前领先</span>' : ""}
          </div>
        </div>
        <div class="book-action-cell">
          <div class="vote-summary">
            <span class="vote-count" aria-label="${escapeHtml(voteLabel)}"><strong>${votes}</strong> 票</span>
            <span class="vote-percent">${percentLabel}</span>
          </div>
          <div class="vote-progress" aria-label="投票占比 ${percentLabel}" role="img">
            <span class="vote-progress-bar" style="width: ${votePercent}%"></span>
          </div>
          <button class="vote-button" type="button" data-vote="${escapeHtml(book.id)}">${buttonLabel}</button>
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
    const error = new Error(payload.message || "请求失败");
    error.data = payload.data;
    throw error;
  }

  return payload;
}

async function refreshCurrentUser() {
  const response = await fetch("/api/me");
  const payload = await parseApiResponse(response);
  state.currentUser = payload.data;
  renderAuth();
  renderBooks();
  return state.currentUser;
}

async function loadBooks() {
  setStatus("正在加载图书...");

  try {
    state.books = await fetchBooks();
    renderBooks();
    renderAdminPanel();
    setStatus(getTopVoteMessage(), "success");
  } catch (error) {
    bookList.innerHTML = '<p class="empty-state">图书加载失败。</p>';
    setStatus(error.message || "图书加载失败，请稍后重试。", "error");
  }
}

async function fetchBooks() {
  const response = await fetch("/api/books");
  const payload = await parseApiResponse(response);
  return payload.data;
}

async function loadCurrentUser() {
  try {
    await refreshCurrentUser();
  } catch (error) {
    state.currentUser = null;
    renderAuth();
    setStatus(error.message || "登录状态加载失败。", "error");
  }
}

async function submitAuth(endpoint, successPrefix) {
  const username = usernameInput.value.trim();
  const password = passwordInput.value;
  const email = emailInput.value.trim();

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

  if (endpoint === "/api/register" && !email) {
    setStatus("注册时邮箱不能为空。", "error");
    emailInput.focus();
    return;
  }

  setAuthLoading(true);
  setStatus(`${successPrefix}中...`);

  try {
    const body = endpoint === "/api/register"
      ? { username, password, email }
      : { username, password };
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const payload = await parseApiResponse(response);
    setStatus(payload.message || `${successPrefix}成功。`, "success");

    if (endpoint === "/api/login") {
      state.emailPromptDismissed = false;
      state.currentUser = payload.data;
      passwordInput.value = "";
      emailInput.value = "";
      renderAuth();
      renderBooks();
    } else if (endpoint === "/api/register") {
      passwordInput.value = "";
    }
  } catch (error) {
    setStatus(error.message || `${successPrefix}失败。`, "error");
  } finally {
    setAuthLoading(false);
  }
}

async function requestPasswordReset() {
  const email = emailInput.value.trim();

  if (!email) {
    setStatus("请先在邮箱框中输入要找回的邮箱，再点击此链接。", "error");
    emailInput.focus();
    return;
  }

  setAuthLoading(true);
  setStatus("正在请求重置链接...");

  try {
    const response = await fetch("/api/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email })
    });
    const payload = await parseApiResponse(response);
    setStatus(payload.message || "如该邮箱已绑定账号，重置链接已发送。", "success");
  } catch (error) {
    setStatus(error.message || "请求重置链接失败。", "error");
  } finally {
    setAuthLoading(false);
  }
}

function showResetPanel() {
  if (!resetPasswordPanel) {
    return;
  }
  resetPasswordPanel.hidden = false;
  resetPasswordInput.value = "";
  resetPasswordConfirm.value = "";
  resetPasswordInput.focus();
}

function hideResetPanel() {
  if (!resetPasswordPanel) {
    return;
  }
  resetPasswordPanel.hidden = true;
  state.resetToken = "";
  const url = new URL(window.location.href);
  url.searchParams.delete("reset");
  window.history.replaceState({}, document.title, url.pathname + (url.search ? `?${url.searchParams.toString()}` : "") + url.hash);
}

async function submitNewPassword() {
  if (!state.resetToken) {
    setStatus("重置令牌缺失，请重新通过邮件链接进入。", "error");
    return;
  }

  const password = resetPasswordInput.value;
  const confirm = resetPasswordConfirm.value;

  if (!password || password.length < 6) {
    setStatus("新密码至少 6 位。", "error");
    resetPasswordInput.focus();
    return;
  }

  if (password !== confirm) {
    setStatus("两次输入的新密码不一致。", "error");
    resetPasswordConfirm.focus();
    return;
  }

  resetSubmitButton.disabled = true;
  resetCancelButton.disabled = true;
  setStatus("正在提交新密码...");

  try {
    const response = await fetch("/api/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: state.resetToken, password })
    });
    const payload = await parseApiResponse(response);
    setStatus(payload.message || "密码已重置，请使用新密码登录。", "success");
    hideResetPanel();
    usernameInput.focus();
  } catch (error) {
    setStatus(error.message || "密码重置失败。", "error");
  } finally {
    resetSubmitButton.disabled = false;
    resetCancelButton.disabled = false;
  }
}

async function submitEmailPrompt() {
  const value = emailPromptInput.value.trim();
  if (!value) {
    setStatus("邮箱不能为空。", "error");
    emailPromptInput.focus();
    return;
  }

  emailPromptSubmitButton.disabled = true;
  setStatus("正在保存邮箱...");

  try {
    const response = await fetch("/api/me/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: value })
    });
    const payload = await parseApiResponse(response);
    state.currentUser = payload.data;
    setStatus(payload.message || "邮箱已保存。", "success");
    renderAuth();
  } catch (error) {
    setStatus(error.message || "邮箱保存失败。", "error");
  } finally {
    emailPromptSubmitButton.disabled = false;
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
    state.books = await fetchBooks();
    renderBooks();
    renderAdminPanel();
    setStatus(result.message || "图书信息已更新。", "success");
  } catch (error) {
    setStatus(error.message || "图书信息保存失败。", "error");
    submitButton.disabled = false;
  }
}

function setSuggestionStatus(form, message, type = "info") {
  const status = form.querySelector("[data-suggestion-status]");
  if (!status) {
    return;
  }

  status.textContent = message;
  status.classList.toggle("is-success", type === "success");
  status.classList.toggle("is-error", type === "error");
}

async function applyBookSuggestion(form) {
  const titleInput = form.elements.title;
  const authorInput = form.elements.author;
  const descriptionInput = form.elements.description;
  const coverUrlInput = form.elements.coverUrl;
  const title = titleInput.value.trim();
  const originalBook = getBookById(form.dataset.adminBook);
  const originalTitle = originalBook?.title || "";

  if (!title) {
    setSuggestionStatus(form, "");
    return;
  }

  if (title === originalTitle) {
    setSuggestionStatus(form, "");
    return;
  }

  setSuggestionStatus(form, "正在查找书目信息...");

  try {
    const response = await fetch(`/api/book-suggestions?title=${encodeURIComponent(title)}`);
    const payload = await parseApiResponse(response);

    if (!payload.data) {
      setSuggestionStatus(form, payload.message || "未找到匹配书目。");
      return;
    }

    if (authorInput.value.trim() === (originalBook?.author || "").trim()) {
      authorInput.value = payload.data.author || "";
    }

    if (descriptionInput.value.trim() === (originalBook?.description || "").trim()) {
      descriptionInput.value = payload.data.description || "";
    }

    if (coverUrlInput.value.trim() === (originalBook?.coverUrl || "").trim()) {
      coverUrlInput.value = payload.data.coverUrl || "";
    }

    setSuggestionStatus(form, `已补齐《${payload.data.title}》的信息。`, "success");
  } catch (error) {
    setSuggestionStatus(form, error.message || "书目信息补齐失败。", "error");
  }
}

function scheduleBookSuggestion(form) {
  const bookId = form.dataset.adminBook;
  const currentTimer = state.suggestionTimers.get(bookId);

  if (currentTimer) {
    clearTimeout(currentTimer);
  }

  const nextTimer = setTimeout(() => {
    state.suggestionTimers.delete(bookId);
    applyBookSuggestion(form);
  }, 450);

  state.suggestionTimers.set(bookId, nextTimer);
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
    if (getRemainingVotes() <= 0) {
      setStatus("正在确认剩余投票次数...");
      await refreshCurrentUser();

      if (!state.currentUser) {
        setStatus("请先登录后再投票。", "error");
        return;
      }

      if (getRemainingVotes() <= 0) {
        setStatus("已达到投票上限。", "error");
        return;
      }
    }

    const response = await fetch("/api/votes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ bookId })
    });
    const payload = await parseApiResponse(response);
    book.votes = payload.data.count;
    state.currentUser = {
      ...state.currentUser,
      voteTotal: payload.data.voteTotal,
      remainingVotes: payload.data.remainingVotes,
      maxVotesPerUser: payload.data.maxVotesPerUser
    };
    renderAuth();
    renderBooks();
    setStatus(getTopVoteMessage(), "success");
  } catch (error) {
    if (error.data && state.currentUser) {
      state.currentUser = {
        ...state.currentUser,
        voteTotal: error.data.voteTotal,
        remainingVotes: error.data.remainingVotes,
        maxVotesPerUser: error.data.maxVotesPerUser
      };
      renderAuth();
      renderBooks();
    }

    setStatus(error.message || "投票失败，请稍后重试。", "error");
  } finally {
    button.disabled = false;
    button.textContent = getRemainingVotes() <= 0 ? "已达上限" : "投票";
  }
}

function setNewBookEnrichStatus(message, type = "info") {
  if (!newBookEnrichStatus) {
    return;
  }
  newBookEnrichStatus.textContent = message;
  newBookEnrichStatus.classList.toggle("is-success", type === "success");
  newBookEnrichStatus.classList.toggle("is-error", type === "error");
}

function resetNewBookForm() {
  if (!newBookForm) {
    return;
  }
  newBookTitle.value = "";
  newBookAuthor.value = "";
  newBookDescription.value = "";
  newBookCoverSource.value = "";
  newBookCoverPreview.hidden = true;
  newBookCoverPreview.removeAttribute("src");
  newBookCoverPlaceholder.hidden = false;
  setNewBookEnrichStatus("");
}

function toggleNewBookForm(force) {
  if (!newBookForm) {
    return;
  }
  const willShow = typeof force === "boolean" ? force : newBookForm.hidden;
  newBookForm.hidden = !willShow;
  if (willShow) {
    resetNewBookForm();
    newBookTitle.focus();
  }
}

async function enrichNewBook() {
  const title = newBookTitle.value.trim();
  const author = newBookAuthor.value.trim();

  if (!title || !author) {
    setNewBookEnrichStatus("请先填写书名和作者。", "error");
    return;
  }

  newBookEnrichButton.disabled = true;
  setNewBookEnrichStatus("正在从 Google Books 抓取...");

  try {
    const response = await fetch("/api/book-enrich", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, author })
    });
    const payload = await parseApiResponse(response);

    if (!payload.data) {
      setNewBookEnrichStatus(payload.message || "未匹配到对应书目，建议手动填写。", "error");
      return;
    }

    if (payload.data.description && !newBookDescription.value.trim()) {
      newBookDescription.value = payload.data.description;
    }

    if (payload.data.coverSourceUrl) {
      newBookCoverSource.value = payload.data.coverSourceUrl;
      newBookCoverPreview.src = payload.data.coverSourceUrl;
      newBookCoverPreview.hidden = false;
      newBookCoverPlaceholder.hidden = true;
    }

    setNewBookEnrichStatus(`已抓取《${payload.data.title || title}》的信息，可继续编辑。`, "success");
  } catch (error) {
    setNewBookEnrichStatus(error.message || "抓取失败，请稍后重试或手动填写。", "error");
  } finally {
    newBookEnrichButton.disabled = false;
  }
}

async function saveNewBook(event) {
  event.preventDefault();

  const title = newBookTitle.value.trim();
  const author = newBookAuthor.value.trim();
  const description = newBookDescription.value.trim();
  const coverSourceUrl = newBookCoverSource.value.trim();

  if (!title) {
    setNewBookEnrichStatus("书名不能为空。", "error");
    newBookTitle.focus();
    return;
  }

  if (!author) {
    setNewBookEnrichStatus("作者不能为空。", "error");
    newBookAuthor.focus();
    return;
  }

  if (!description) {
    setNewBookEnrichStatus("简介不能为空，请填写或先自动抓取。", "error");
    newBookDescription.focus();
    return;
  }

  newBookSaveButton.disabled = true;
  setStatus("正在创建新图书...");

  try {
    const response = await fetch("/api/books", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, author, description, coverSourceUrl })
    });
    const payload = await parseApiResponse(response);
    setStatus(payload.message || "图书已创建。", "success");
    toggleNewBookForm(false);
    state.books = await fetchBooks();
    renderBooks();
    renderAdminPanel();
  } catch (error) {
    setNewBookEnrichStatus(error.message || "创建图书失败。", "error");
    setStatus(error.message || "创建图书失败。", "error");
  } finally {
    newBookSaveButton.disabled = false;
  }
}

async function resetVotes() {
  if (!state.currentUser || state.currentUser.role !== "admin") {
    setStatus("无管理员权限。", "error");
    return;
  }

  const confirmed = window.confirm("确认将所有图书票数归零吗？该操作会清空所有用户投票记录。");
  if (!confirmed) {
    return;
  }

  resetVotesButton.disabled = true;
  setStatus("正在重置所有票数...");

  try {
    const response = await fetch("/api/votes/reset", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ confirm: true })
    });
    const payload = await parseApiResponse(response);

    if (Array.isArray(payload.data?.books)) {
      state.books = payload.data.books;
    } else {
      state.books = state.books.map((book) => ({
        ...book,
        votes: 0
      }));
    }

    if (state.currentUser) {
      state.currentUser = {
        ...state.currentUser,
        voteTotal: 0,
        remainingVotes: payload.data?.maxVotesPerUser || 3,
        maxVotesPerUser: payload.data?.maxVotesPerUser || 3
      };
    }

    renderAuth();
    renderBooks();
    setStatus(payload.message || "所有票数已重置。", "success");
  } catch (error) {
    setStatus(error.message || "重置票数失败。", "error");
  } finally {
    resetVotesButton.disabled = false;
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

adminBookList.addEventListener("input", (event) => {
  const input = event.target.closest('input[name="title"]');
  if (!input) {
    return;
  }

  const form = input.closest("[data-admin-book]");
  if (!form) {
    return;
  }

  scheduleBookSuggestion(form);
});

authForm.addEventListener("submit", (event) => {
  event.preventDefault();
  submitAuth("/api/login", "登录");
});

registerButton.addEventListener("click", () => {
  submitAuth("/api/register", "注册");
});

logoutButton.addEventListener("click", logout);
resetVotesButton.addEventListener("click", resetVotes);

if (forgotPasswordLink) {
  forgotPasswordLink.addEventListener("click", (event) => {
    event.preventDefault();
    requestPasswordReset();
  });
}

if (emailPromptForm) {
  emailPromptForm.addEventListener("submit", (event) => {
    event.preventDefault();
    submitEmailPrompt();
  });
}

if (emailPromptSkipButton) {
  emailPromptSkipButton.addEventListener("click", () => {
    state.emailPromptDismissed = true;
    renderEmailPrompt();
  });
}

if (resetPasswordForm) {
  resetPasswordForm.addEventListener("submit", (event) => {
    event.preventDefault();
    submitNewPassword();
  });
}

if (resetCancelButton) {
  resetCancelButton.addEventListener("click", () => {
    hideResetPanel();
    setStatus("已取消密码重置。");
  });
}

if (newBookToggle) {
  newBookToggle.addEventListener("click", () => {
    toggleNewBookForm();
  });
}

if (newBookCancelButton) {
  newBookCancelButton.addEventListener("click", () => {
    toggleNewBookForm(false);
  });
}

if (newBookEnrichButton) {
  newBookEnrichButton.addEventListener("click", () => {
    enrichNewBook();
  });
}

if (newBookForm) {
  newBookForm.addEventListener("submit", saveNewBook);
}

function consumeResetTokenFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("reset");
  if (token) {
    state.resetToken = token;
    showResetPanel();
    setStatus("请设置新密码完成重置。");
    return true;
  }
  return false;
}

async function init() {
  await loadCurrentUser();
  await loadBooks();
  consumeResetTokenFromUrl();
}

init();
