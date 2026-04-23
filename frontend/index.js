let allSeries = [];
let currentTab = 'all';

// ── Init ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  try { await Auth.updateHeader(); } catch { /* 인증 실패해도 목록은 표시 */ }
  await loadSeriesList();
  setupTabs();
});

// ── Data ──────────────────────────────────────────────
async function loadSeriesList() {
  try {
    const res  = await fetch(`${BASE_URL}/series`);
    const json = await res.json();
    allSeries  = json.data || [];
    renderGrid(getSortedFiltered(allSeries, currentTab));
  } catch {
    document.getElementById('series-grid').innerHTML =
      '<p class="empty-msg">서버에 연결할 수 없습니다.</p>';
  }
}

// ── 읽기 이력 (localStorage) ──────────────────────────
function getReadHistory() {
  try { return JSON.parse(localStorage.getItem('n2vn_read_history') || '{}'); }
  catch { return {}; }
}

// ── 정렬 + 필터 ───────────────────────────────────────
function getSortedFiltered(list, tab) {
  const history = getReadHistory();

  if (tab === 'read') {
    return [...list]
      .filter((s) => history[s.id])
      .sort((a, b) => (history[b.id]?.lastReadAt ?? 0) - (history[a.id]?.lastReadAt ?? 0));
  }

  if (tab === 'recent') {
    return [...list].sort(
      (a, b) => new Date(b.latestEpisodeAt ?? 0).getTime() - new Date(a.latestEpisodeAt ?? 0).getTime(),
    );
  }

  // 'all': 최근 읽은 작품 상위 → latestEpisodeAt DESC
  return [...list].sort((a, b) => {
    const aRead = history[a.id]?.lastReadAt ?? 0;
    const bRead = history[b.id]?.lastReadAt ?? 0;
    if (aRead !== bRead) return bRead - aRead;
    return new Date(b.latestEpisodeAt ?? 0).getTime() - new Date(a.latestEpisodeAt ?? 0).getTime();
  });
}

// ── Tabs ──────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentTab = btn.dataset.tab;
      renderGrid(getSortedFiltered(allSeries, currentTab));
    });
  });
}

// ── Render ────────────────────────────────────────────
function renderGrid(list) {
  const grid = document.getElementById('series-grid');
  if (list.length === 0) {
    grid.innerHTML = '<p class="empty-msg">표시할 작품이 없습니다.</p>';
    return;
  }
  grid.innerHTML = list.map(renderSeriesCard).join('');
}

function renderSeriesCard(s) {
  const thumb = s.thumbnailUrl
    ? `<img src="${s.thumbnailUrl}" alt="${s.title}" loading="lazy">`
    : `<div class="thumb-placeholder">📖</div>`;

  const history   = getReadHistory();
  const isRead    = !!history[s.id];
  const latestStr = s.latestEpisodeAt ? formatDate(s.latestEpisodeAt) : '—';

  return `
    <div class="series-card ${isRead ? 'read' : ''}" onclick="location.href='/series.html?id=${s.id}'">
      <div class="card-thumb">${thumb}</div>
      <div class="card-info">
        <h3 class="card-title">${escapeHtml(s.title)}</h3>
        <span class="card-author">${escapeHtml(s.authorNickname)}</span>
        <div class="card-meta">
          <span>총 ${s.episodeCount}화</span>
          <span>${latestStr}</span>
        </div>
      </div>
    </div>
  `;
}

// ── Utils ─────────────────────────────────────────────
function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
