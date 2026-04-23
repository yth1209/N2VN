const seriesId = new URLSearchParams(location.search).get('id');

let currentEpisodeNumber = null;
let seriesData = null;

// ── Init ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  if (!seriesId) { location.href = '/'; return; }
  await Auth.updateHeader();
  await loadSeriesDetail();
});

// ── Data ──────────────────────────────────────────────
async function loadSeriesDetail() {
  try {
    const res  = await fetch(`${BASE_URL}/series/${seriesId}`);
    const json = await res.json();
    if (!json.success) throw new Error();
    seriesData = json.data;
    renderSeriesHeader(seriesData);
    renderEpisodeList(seriesData.episodes);
  } catch {
    document.querySelector('.series-detail-page').innerHTML =
      '<p class="empty-msg" style="text-align:center;margin-top:4rem;">작품을 불러올 수 없습니다.</p>';
  }
}

// ── Render: Header ────────────────────────────────────
function renderSeriesHeader(data) {
  document.title = `N2VN — ${data.title}`;
  document.getElementById('series-title').textContent       = data.title;
  document.getElementById('series-author').textContent      = data.authorNickname;
  document.getElementById('series-description').textContent = data.description || '';
  document.getElementById('series-latest').textContent      =
    data.latestEpisodeAt ? `최신 업데이트: ${formatDate(data.latestEpisodeAt)}` : '';
}

// ── Render: Episode List ──────────────────────────────
function renderEpisodeList(episodes) {
  const ul = document.getElementById('episode-ul');
  if (!episodes || episodes.length === 0) {
    ul.innerHTML = '<li class="empty-msg">등록된 회차가 없습니다.</li>';
    return;
  }

  ul.innerHTML = episodes.map((ep) => {
    const isRead       = isEpisodeRead(seriesId, ep.episodeNumber);
    const isProcessing = ep.status === 'PROCESSING';
    const isFailed     = ep.status === 'FAILED';
    const isDone       = ep.status === 'DONE';

    const clickable = isDone;
    return `
      <li class="episode-item ${isRead ? 'read' : ''} ${isProcessing ? 'processing' : ''} ${isFailed ? 'failed' : ''}"
          onclick="${clickable ? `openVnPlayer(${ep.episodeNumber})` : ''}">
        <div class="ep-left">
          <span class="ep-num">${ep.episodeNumber}화</span>
          <span class="ep-title">${escapeHtml(ep.title)}</span>
        </div>
        <div class="ep-right">
          <span class="ep-date">${formatDate(ep.createdAt)}</span>
          ${isProcessing ? '<span class="badge processing">생성 중...</span>' : ''}
          ${isFailed     ? '<span class="badge failed">생성 실패</span>'    : ''}
          ${isRead       ? '<span class="badge read-badge">읽음</span>'     : ''}
        </div>
      </li>
    `;
  }).join('');
}

// ── VN Player Modal ───────────────────────────────────
function openVnPlayer(episodeNumber) {
  currentEpisodeNumber = episodeNumber;
  const modal = document.getElementById('vn-modal');
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  const iframe = document.getElementById('vn-iframe');
  iframe.src = 'player.html';
  iframe.onload = () => {
    iframe.contentWindow.postMessage({ seriesId, episodeNumber }, window.location.origin);
    iframe.onload = null;
  };
}

function closeVnPlayer() {
  document.getElementById('vn-modal').classList.add('hidden');
  document.body.style.overflow = '';
  if (currentEpisodeNumber !== null) {
    markEpisodeAsRead(seriesId, currentEpisodeNumber);
    renderEpisodeList(seriesData?.episodes ?? []);
  }
  currentEpisodeNumber = null;
}

// ESC 키로 플레이어 닫기
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !document.getElementById('vn-modal').classList.contains('hidden')) {
    closeVnPlayer();
  }
});

// ── 읽기 이력 ─────────────────────────────────────────
function getReadHistory() {
  try { return JSON.parse(localStorage.getItem('n2vn_read_history') || '{}'); }
  catch { return {}; }
}

function isEpisodeRead(sId, epNum) {
  const h = getReadHistory();
  return !!(h[sId]?.readEpisodes?.includes(epNum));
}

function markEpisodeAsRead(sId, epNum) {
  const h = getReadHistory();
  if (!h[sId]) h[sId] = { lastReadAt: 0, readEpisodes: [] };
  h[sId].lastReadAt = Date.now();
  if (!h[sId].readEpisodes.includes(epNum)) h[sId].readEpisodes.push(epNum);
  localStorage.setItem('n2vn_read_history', JSON.stringify(h));
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
