const BASE_URL = 'http://localhost:3000';
let currentNovelId = null;
let currentAssets = null;
let activeTab = 'characters';

// DOM Elements
const novelListEl = document.getElementById('novel-list');
const noNovelEl = document.getElementById('no-novel-selected');
const novelContentEl = document.getElementById('novel-content');
const novelTitleEl = document.getElementById('selected-novel-title');
const charactersViewEl = document.getElementById('characters-view');
const backgroundsViewEl = document.getElementById('backgrounds-view');
const tabs = document.querySelectorAll('.tab');

// Initialization
async function init() {
    await fetchNovels();
    setupEventListeners();
}

async function fetchNovels() {
    try {
        const response = await fetch(`${BASE_URL}/novels`);
        const result = await response.json();
        
        if (result.success) {
            renderNovelList(result.data);
        }
    } catch (err) {
        console.error('Failed to fetch novels:', err);
        novelListEl.innerHTML = '<li class="novel-item">서버 연결 실패</li>';
    }
}

function renderNovelList(novels) {
    if (novels.length === 0) {
        novelListEl.innerHTML = '<li class="novel-item">생성된 소설이 없습니다.</li>';
        return;
    }

    novelListEl.innerHTML = novels.map(novel => `
        <li class="novel-item" onclick="selectNovel(${novel.id}, this)">
            ${novel.novelTitle}
        </li>
    `).join('');
}

async function selectNovel(id, element) {
    // UI Update
    document.querySelectorAll('.novel-item').forEach(el => el.classList.remove('active'));
    element.classList.add('active');

    currentNovelId = id;
    
    try {
        const response = await fetch(`${BASE_URL}/novels/${id}/assets`);
        const result = await response.json();

        if (result.success) {
            currentAssets = result.data;
            renderAssets();
            noNovelEl.style.display = 'none';
            novelContentEl.style.display = 'flex';
            novelTitleEl.textContent = currentAssets.novel.novelTitle;
        }
    } catch (err) {
        console.error('Failed to fetch assets:', err);
        alert('데이터를 불러오는데 실패했습니다.');
    }
}

function setupEventListeners() {
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            activeTab = tab.dataset.tab;
            
            if (activeTab === 'characters') {
                charactersViewEl.style.display = 'grid';
                backgroundsViewEl.style.display = 'none';
            } else {
                charactersViewEl.style.display = 'none';
                backgroundsViewEl.style.display = 'grid';
            }
        });
    });
}

function renderAssets() {
    renderCharacters();
    renderBackgrounds();
}

function renderCharacters() {
    if (!currentAssets.characters || currentAssets.characters.length === 0) {
        charactersViewEl.innerHTML = '<div class="empty-state">캐릭터 데이터가 없습니다.</div>';
        return;
    }

    charactersViewEl.style.display = 'block'; // Change from grid to block for rows
    charactersViewEl.innerHTML = currentAssets.characters.map(char => {
        const emotionCards = char.images.map(img => `
            <div class="emotion-card" id="emotion-card-${char.id}-${img.emotion}">
                <div class="card-image-wrap">
                    <img id="img-${char.id}-${img.emotion}" src="${img.url || ''}" alt="${char.name} ${img.emotion}" onerror="this.style.opacity='0'">
                    <div id="placeholder-${char.id}-${img.emotion}" class="nobg-placeholder" style="display: none;">
                        NOBG 준비 중
                    </div>
                </div>
                <div class="card-info">
                    <span class="emotion-label">${img.emotion}</span>
                </div>
            </div>
        `).join('');

        return `
            <div class="character-row" id="row-${char.id}">
                <div class="character-info-panel">
                    <div class="char-header">
                        <span class="char-tag">${char.sex || 'Unknown'}</span>
                        <h2>${char.name}</h2>
                    </div>
                    <div class="char-look">
                        ${char.look || '설명이 없습니다.'}
                    </div>
                </div>
                <div class="emotion-bar-container">
                    <div class="emotion-bar-header">
                        <div class="emotion-title">Emotion Gallery</div>
                        <div class="nobg-toggle" onclick="toggleNobgRow('${char.id}')" id="nobg-btn-${char.id}">NOBG OFF</div>
                    </div>
                    <div class="emotion-bar" id="bar-${char.id}">
                        ${emotionCards}
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

function renderBackgrounds() {
    if (!currentAssets.backgrounds || currentAssets.backgrounds.length === 0) {
        backgroundsViewEl.innerHTML = '<div class="empty-state">배경 데이터가 없습니다.</div>';
        return;
    }

    backgroundsViewEl.innerHTML = currentAssets.backgrounds.map(bg => `
        <div class="asset-card bg-card">
            <div class="card-image-wrap">
                <img src="${bg.url || ''}" alt="${bg.name}" onerror="this.style.display='none'">
                ${!bg.url ? '<div class="nobg-placeholder">이미지 생성 중...</div>' : ''}
            </div>
            <div class="card-info" style="padding: 20px; text-align: left;">
                <h3 style="font-family: 'Outfit', sans-serif; font-size: 1.15rem; font-weight: 600; margin-bottom: 8px;">${bg.name}</h3>
                <p class="card-description" style="font-size: 0.85rem; color: var(--text-dim); line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden;">${bg.description}</p>
            </div>
        </div>
    `).join('');
}

// Global scope functions for onclick handlers
window.toggleNobgRow = (charId) => {
    const btn = document.getElementById(`nobg-btn-${charId}`);
    const isActive = btn.classList.toggle('active');
    btn.textContent = isActive ? 'NOBG ON' : 'NOBG OFF';

    const char = currentAssets.characters.find(c => c.id === charId);
    
    char.images.forEach(imgData => {
        const imgEl = document.getElementById(`img-${charId}-${imgData.emotion}`);
        const placeholder = document.getElementById(`placeholder-${charId}-${imgData.emotion}`);

        if (isActive) {
            if (imgData.nobgUrl) {
                imgEl.src = imgData.nobgUrl;
                imgEl.style.display = 'block';
                placeholder.style.display = 'none';
            } else {
                imgEl.style.display = 'none';
                placeholder.style.display = 'flex';
            }
        } else {
            imgEl.src = imgData.url || '';
            imgEl.style.display = 'block';
            placeholder.style.display = 'none';
        }
    });
};

// Start the app
init();
