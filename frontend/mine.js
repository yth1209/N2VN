
let currentSeriesId   = null;
let currentSeriesData = null;
let pollingTimer      = null;
let assetsLoaded      = false;
let currentDetailTab  = 'episodes';

const STEP_LABELS = {
  parseCharacters:          '캐릭터 분석',
  parseScenes:              '씬·배경 분석',
  generateCharacterImages:  '캐릭터 이미지 생성',
  generateBackgroundImages: '배경 이미지 생성',
  generateBgm:              'BGM 생성',
};

const STEP_ICONS = { PENDING: '○', PROCESSING: '⟳', DONE: '✓', FAILED: '✕' };

const STEP_ENDPOINTS = {
  parseCharacters:          '/parsing/characters',
  parseScenes:              '/parsing/scenes',
  generateCharacterImages:  '/images/characters',
  generateBackgroundImages: '/images/backgrounds',
};

// ── Init ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // onLoginSuccess 정의: 로그인 후 내 작품 로드
  window.onLoginSuccess = async () => {
    show('mine-content');
    hide('login-prompt');
    await loadMySeries();
  };


  const loggedIn = await Auth.updateHeader();
  if (!loggedIn) {
    show('login-prompt');
  } else {
    show('mine-content');
    await loadMySeries();
  }
});

// ── Load My Series ────────────────────────────────────
async function loadMySeries() {
  try {
    const res  = await Auth.authFetch('/series/mine');
    const json = await res.json();
    renderMineGrid(json.data || []);
  } catch {
    document.getElementById('mine-grid').innerHTML = '<p class="empty-msg">불러오기 실패</p>';
  }
}

function renderMineGrid(list) {
  const grid = document.getElementById('mine-grid');
  if (list.length === 0) {
    grid.innerHTML = `<p class="empty-msg">아직 작품이 없습니다.<br>새 작품을 만들어보세요!</p>`;
    return;
  }
  grid.innerHTML = list.map((s) => `
    <div class="series-card mine-card" onclick="openSeriesDetail('${s.id}')">
      <div class="card-thumb">
        ${s.thumbnailUrl
          ? `<img src="${s.thumbnailUrl}" alt="${escapeHtml(s.title)}" loading="lazy">`
          : `<div class="thumb-placeholder">📖</div>`}
      </div>
      <div class="card-info">
        <h3 class="card-title">${escapeHtml(s.title)}</h3>
        <div class="card-meta">
          <span>총 ${s.episodeCount}화</span>
          <span>${s.latestEpisodeAt ? formatDate(s.latestEpisodeAt) : '—'}</span>
        </div>
      </div>
    </div>
  `).join('');
}

// ── New Series ────────────────────────────────────────
function showNewSeriesModal() {
  document.getElementById('ns-title').value = '';
  document.getElementById('ns-desc').value  = '';
  document.getElementById('ns-error').textContent = '';
  openModal('new-series-modal');
}

async function submitNewSeries() {
  const title = document.getElementById('ns-title').value.trim();
  const desc  = document.getElementById('ns-desc').value.trim();
  const errorEl = document.getElementById('ns-error');

  if (!title) { errorEl.textContent = '작품 제목을 입력해주세요.'; return; }

  try {
    const res  = await Auth.authFetch('/series', {
      method: 'POST',
      body:   JSON.stringify({ title, description: desc }),
    });
    const json = await res.json();
    if (!json.success) { errorEl.textContent = json.message || '생성 실패'; return; }
    closeModal('new-series-modal');
    await loadMySeries();
  } catch { errorEl.textContent = '서버 오류'; }
}

// ── Series Detail ─────────────────────────────────────
async function openSeriesDetail(seriesId) {
  currentSeriesId = seriesId;
  assetsLoaded    = false;
  currentDetailTab = 'episodes';

  // 탭 초기화
  document.querySelectorAll('#series-detail-modal .tab-btn').forEach((b) => b.classList.remove('active'));
  document.querySelector('#series-detail-modal .tab-btn[data-tab="episodes"]')?.classList.add('active');
  show('detail-ep-tab');
  hide('detail-assets-tab');
  document.getElementById('assets-content').innerHTML = '<p class="empty-msg">로딩 중...</p>';

  openModal('series-detail-modal');

  await refreshSeriesDetail();
}

async function refreshSeriesDetail() {
  try {
    const res  = await fetch(`${BASE_URL}/series/${currentSeriesId}`);
    const json = await res.json();
    if (!json.success) return;
    currentSeriesData = json.data;

    document.getElementById('detail-title').textContent = currentSeriesData.title;
    renderDetailEpisodeList(currentSeriesData.id, currentSeriesData.episodes);
    updateAddEpisodeBtn(currentSeriesData.episodes);
  } catch {}
}

function renderDetailEpisodeList(seriesId, episodes) {
  const ul = document.getElementById('detail-ep-list');
  if (!episodes || episodes.length === 0) {
    ul.innerHTML = '<li class="empty-msg">등록된 회차가 없습니다.</li>';
    return;
  }
  ul.innerHTML = episodes.map((ep) => {
    const isProcessing = ep.status === 'PROCESSING';
    const isFailed     = ep.status === 'FAILED';
    const isDone       = ep.status === 'DONE';

    const stepsHtml = (isProcessing || isFailed) ? renderPipelineSteps(seriesId, ep) : '';

    return `
      <li class="episode-item manage-ep ${isProcessing ? 'processing' : ''} ${isFailed ? 'failed' : ''}">
        <div class="ep-row">
          <div class="ep-left">
            <span class="ep-num">${ep.episodeNumber}화</span>
            <span class="ep-title">${escapeHtml(ep.title)}</span>
          </div>
          <div class="ep-right">
            ${isProcessing ? '<span class="badge processing">생성 중...</span>' : ''}
            ${isFailed     ? '<span class="badge failed">생성 실패</span>'    : ''}
            ${isDone       ? '<span class="badge done">완료</span>'           : ''}
            <button class="btn-danger-sm" onclick="deleteEpisode(${ep.episodeNumber})">삭제</button>
          </div>
        </div>
        ${stepsHtml}
      </li>
    `;
  }).join('');
}

function renderPipelineSteps(seriesId, episode) {
  const steps = episode.pipelineSteps || [];
  const stepsMap = {};
  for (const s of steps) stepsMap[s.stepKey] = s;

  const items = Object.entries(STEP_LABELS).map(([key, label]) => {
    const step   = stepsMap[key];
    const status = step?.status ?? 'PENDING';
    const icon   = STEP_ICONS[status] ?? '○';
    const failed = status === 'FAILED';
    console.log(`retryStep('${seriesId}', ${episode.episodeNumber}, '${key}')`);
    return `
      <li class="pipeline-step ${status.toLowerCase()}">
        <span class="step-icon">${icon}</span>
        <span class="step-label">${label}</span>
        ${failed ? `<button class="btn-retry" onclick="retryStep('${seriesId}', ${episode.episodeNumber}, '${key}')">재실행</button>` : ''}
      </li>
    `;
  }).join('');

  return `<ul class="pipeline-steps">${items}</ul>`;
}

function updateAddEpisodeBtn(episodes) {
  const btn = document.getElementById('add-episode-btn');
  const isProcessing = (episodes || []).some((e) => e.status === 'PROCESSING');
  btn.disabled = isProcessing;
  btn.title    = isProcessing ? '처리 중인 회차가 완료된 후 추가할 수 있습니다.' : '';
}

// ── Detail Tab Switch ─────────────────────────────────
async function switchDetailTab(tab) {
  currentDetailTab = tab;
  document.querySelectorAll('#series-detail-modal .tab-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });

  if (tab === 'episodes') {
    show('detail-ep-tab');
    hide('detail-assets-tab');
  } else {
    hide('detail-ep-tab');
    show('detail-assets-tab');
    if (!assetsLoaded) await loadAssetsGallery();
  }
}

async function loadAssetsGallery() {
  const contentEl = document.getElementById('assets-content');
  contentEl.innerHTML = '<p class="empty-msg">에셋 로딩 중...</p>';
  try {
    const res  = await fetch(`${BASE_URL}/series/${currentSeriesId}/assets`);
    const json = await res.json();
    if (!json.success) { contentEl.innerHTML = '<p class="empty-msg">에셋 로드 실패</p>'; return; }
    assetsLoaded = true;
    renderAssetsGallery(json.data);
  } catch { contentEl.innerHTML = '<p class="empty-msg">서버 오류</p>'; }
}

function renderAssetsGallery(data) {
  const contentEl = document.getElementById('assets-content');
  const charHtml = (data.characters || []).map((char) => `
    <div class="asset-char-card">
      <h4>${escapeHtml(char.name)}</h4>
      <div class="emotion-grid">
        ${(char.images || []).map((img) => `
          <div class="emotion-item">
            ${img.nobgUrl || img.url
              ? `<img src="${img.nobgUrl || img.url}" alt="${img.emotion}" loading="lazy">`
              : `<div class="img-placeholder">미생성</div>`}
            <span>${img.emotion}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');

  const bgHtml = (data.backgrounds || []).map((bg) => `
    <div class="asset-bg-card">
      ${bg.url
        ? `<img src="${bg.url}" alt="${escapeHtml(bg.name)}" loading="lazy">`
        : `<div class="img-placeholder bg-placeholder">미생성</div>`}
      <p>${escapeHtml(bg.name)}</p>
    </div>
  `).join('');

  contentEl.innerHTML = `
    <section class="assets-section">
      <h4>캐릭터 이미지</h4>
      ${charHtml || '<p class="empty-msg">캐릭터가 없습니다.</p>'}
    </section>
    <section class="assets-section">
      <h4>배경 이미지</h4>
      <div class="bg-grid">${bgHtml || '<p class="empty-msg">배경이 없습니다.</p>'}</div>
    </section>
  `;
}

// ── Add Episode ───────────────────────────────────────
function showAddEpisodeModal() {
  document.getElementById('ep-title').value = '';
  document.getElementById('ep-file').value  = '';
  document.getElementById('ep-error').textContent = '';
  document.getElementById('file-label-text').textContent = '소설 텍스트 파일 선택 (.txt)';
  openModal('add-episode-modal');
}

function updateFileLabel(input) {
  const name = input.files[0]?.name || '소설 텍스트 파일 선택 (.txt)';
  document.getElementById('file-label-text').textContent = name;
}

async function submitAddEpisode() {
  const title   = document.getElementById('ep-title').value.trim();
  const fileEl  = document.getElementById('ep-file');
  const file    = fileEl.files[0];
  const errorEl = document.getElementById('ep-error');

  if (!title) { errorEl.textContent = '회차 제목을 입력해주세요.'; return; }
  if (!file)  { errorEl.textContent = '텍스트 파일을 선택해주세요.'; return; }
  if (!file.name.endsWith('.txt')) { errorEl.textContent = '.txt 파일만 허용됩니다.'; return; }

  const formData = new FormData();
  formData.append('title', title);
  formData.append('file', file);

  try {
    const res  = await Auth.authFetch(`/series/${currentSeriesId}/episodes`, {
      method:  'POST',
      headers: {},  // Content-Type은 FormData가 자동 설정
      body:    formData,
    });
    const json = await res.json();
    if (!json.success) { errorEl.textContent = json.message || '업로드 실패'; return; }
    closeModal('add-episode-modal');
    await refreshSeriesDetail();
    startPolling(currentSeriesId);
  } catch { errorEl.textContent = '서버 오류'; }
}

// ── Delete Episode ────────────────────────────────────
async function deleteEpisode(episodeNumber) {
  if (!confirm(`${episodeNumber}화를 삭제하시겠습니까?`)) return;
  try {
    await Auth.authFetch(`/series/${currentSeriesId}/episodes/${episodeNumber}`, { method: 'DELETE' });
    await refreshSeriesDetail();
    await loadMySeries();
  } catch { alert('삭제 실패'); }
}

// ── Retry Step ────────────────────────────────────────
async function retryStep(sId, episodeNumber, stepKey) {
  const url = STEP_ENDPOINTS[stepKey];
  if (!url) return;
  try {
    console.log(`Real retryStep('${sId}', ${episodeNumber}, '${stepKey}')`);
    await Auth.authFetch(url, {
      method: 'POST',
      body:   JSON.stringify({ seriesId: sId, episodeNumber }),
    });
    startPolling(sId);
  } catch { alert('재실행 요청 실패'); }
}

// ── Polling ───────────────────────────────────────────
function startPolling(seriesId) {
  if (pollingTimer) clearInterval(pollingTimer);
  pollingTimer = setInterval(async () => {
    try {
      const res  = await fetch(`${BASE_URL}/series/${seriesId}`);
      const json = await res.json();
      if (!json.success) return;
      currentSeriesData = json.data;
      renderDetailEpisodeList(currentSeriesData.episodes);
      updateAddEpisodeBtn(currentSeriesData.episodes);

      const stillProcessing = currentSeriesData.episodes.some((e) => e.status === 'PROCESSING');
      if (!stillProcessing) {
        clearInterval(pollingTimer);
        pollingTimer = null;
        await loadMySeries();
        // 에셋 탭이 열려있으면 갱신
        if (currentDetailTab === 'assets') {
          assetsLoaded = false;
          await loadAssetsGallery();
        }
      }
    } catch {}
  }, 3000);
}

// ── Modal Utils ───────────────────────────────────────
function openModal(id)  { document.getElementById(id)?.classList.remove('hidden'); }
function closeModal(id) {
  document.getElementById(id)?.classList.add('hidden');
  if (id === 'series-detail-modal' && pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
}

document.addEventListener('click', (e) => {
  ['new-series-modal', 'series-detail-modal', 'add-episode-modal', 'login-modal', 'register-modal'].forEach((id) => {
    if (e.target.id === id) closeModal(id);
  });
});

// ── Helper ────────────────────────────────────────────
function show(id) { document.getElementById(id)?.classList.remove('hidden'); }
function hide(id) { document.getElementById(id)?.classList.add('hidden'); }

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
