const Auth = {
  getToken: () => localStorage.getItem('n2vn_token'),
  setToken: (t) => localStorage.setItem('n2vn_token', t),
  removeToken: () => localStorage.removeItem('n2vn_token'),
  isLoggedIn: () => !!localStorage.getItem('n2vn_token'),

  authFetch: (url, options = {}) => {
    const headers = { ...options.headers };
    if (!(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }
    headers['Authorization'] = `Bearer ${Auth.getToken()}`;
    return fetch(`${BASE_URL}${url}`, { ...options, headers });
  },

  updateHeader: async () => {
    const area = document.getElementById('auth-area');
    if (!area) return;

    if (!Auth.isLoggedIn()) {
      area.innerHTML = `
        <button class="btn-outline" onclick="Auth.showLoginModal()">로그인</button>
        <button class="btn-primary" onclick="Auth.showRegisterModal()">회원가입</button>
      `;
      return;
    }

    try {
      const res = await Auth.authFetch('/auth/me');
      if (res.status === 401 || res.status === 403) {
        // 토큰이 만료되었거나 유효하지 않은 경우에만 삭제
        Auth.removeToken();
        await Auth.updateHeader();
        return false;
      }
      const json = await res.json();
      if (!json.success || !json.data) {
        // 예상치 못한 서버 응답 — 토큰은 유지, 비로그인 UI만 표시
        area.innerHTML = `
          <button class="btn-outline" onclick="Auth.showLoginModal()">로그인</button>
          <button class="btn-primary" onclick="Auth.showRegisterModal()">회원가입</button>
        `;
        return false;
      }
      const me = json.data;
      area.innerHTML = `
        <span class="nickname-badge">${me.nickname}</span>
        <a href="/mine.html" class="btn-outline">내 작품</a>
        <button class="btn-outline" onclick="Auth.logout()">로그아웃</button>
      `;
      return true;
    } catch {
      // 네트워크 오류 — 토큰 유지, 비로그인 UI만 표시
      area.innerHTML = `
        <button class="btn-outline" onclick="Auth.showLoginModal()">로그인</button>
        <button class="btn-primary" onclick="Auth.showRegisterModal()">회원가입</button>
      `;
      return false;
    }
  },

  logout: () => {
    Auth.removeToken();
    location.reload();
  },

  showLoginModal: () => {
    const modal = document.getElementById('login-modal');
    if (modal) {
      modal.classList.remove('hidden');
      document.getElementById('login-error')?.textContent && (document.getElementById('login-error').textContent = '');
    }
  },

  hideLoginModal: () => {
    const modal = document.getElementById('login-modal');
    if (modal) modal.classList.add('hidden');
  },

  showRegisterModal: () => {
    const modal = document.getElementById('register-modal');
    if (modal) {
      modal.classList.remove('hidden');
      document.getElementById('register-error')?.textContent && (document.getElementById('register-error').textContent = '');
    }
  },

  hideRegisterModal: () => {
    const modal = document.getElementById('register-modal');
    if (modal) modal.classList.add('hidden');
  },

  submitLogin: async () => {
    const loginId  = document.getElementById('login-id')?.value?.trim();
    const password = document.getElementById('login-password')?.value;
    const errorEl  = document.getElementById('login-error');

    if (!loginId || !password) {
      if (errorEl) errorEl.textContent = '아이디와 비밀번호를 입력해주세요.';
      return;
    }

    try {
      const res = await fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginId, password }),
      });
      const json = await res.json();
      if (!json.success) {
        if (errorEl) errorEl.textContent = json.message || '로그인 실패';
        return;
      }
      Auth.setToken(json.data.accessToken);
      Auth.hideLoginModal();
      await Auth.updateHeader();
      if (typeof onLoginSuccess === 'function') onLoginSuccess();
    } catch (e) {
      if (errorEl) errorEl.textContent = '서버 연결 실패';
    }
  },

  submitRegister: async () => {
    const loginId  = document.getElementById('reg-login-id')?.value?.trim();
    const email    = document.getElementById('reg-email')?.value?.trim();
    const password = document.getElementById('reg-password')?.value;
    const nickname = document.getElementById('reg-nickname')?.value?.trim();
    const errorEl  = document.getElementById('register-error');

    if (!loginId || !email || !password || !nickname) {
      if (errorEl) errorEl.textContent = '모든 항목을 입력해주세요.';
      return;
    }

    try {
      const res = await fetch(`${BASE_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginId, email, password, nickname }),
      });
      const json = await res.json();
      if (!json.success) {
        if (errorEl) errorEl.textContent = json.message || '회원가입 실패';
        return;
      }
      // 자동 로그인
      const loginRes = await fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginId, password }),
      });
      const loginJson = await loginRes.json();
      if (loginJson.success) {
        Auth.setToken(loginJson.data.accessToken);
      }
      Auth.hideRegisterModal();
      await Auth.updateHeader();
      if (typeof onLoginSuccess === 'function') onLoginSuccess();
    } catch (e) {
      if (errorEl) errorEl.textContent = '서버 연결 실패';
    }
  },
};

// 모달 외부 클릭 시 닫기
document.addEventListener('click', (e) => {
  if (e.target.id === 'login-modal')    Auth.hideLoginModal();
  if (e.target.id === 'register-modal') Auth.hideRegisterModal();
});

// ESC 키로 모달 닫기
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    Auth.hideLoginModal();
    Auth.hideRegisterModal();
  }
});

// onLoginSuccess는 각 페이지에서 정의 (선택적)
if (typeof onLoginSuccess === 'undefined') {
  var onLoginSuccess = null;
}
