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
            novelContentEl.style.display = 'block';
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

    charactersViewEl.innerHTML = currentAssets.characters.map((char, index) => {
        // 기본 감정 설정
        const defaultEmotion = char.images.find(img => img.emotion === 'DEFAULT') || char.images[0];
        const emotionTags = char.images.map(img => `
            <button class="emotion-btn ${img.emotion === 'DEFAULT' ? 'active' : ''}" 
                    onclick="switchEmotion('${char.id}', '${img.emotion}', this)">
                ${img.emotion}
            </button>
        `).join('');

        return `
            <div class="asset-card character-card" id="card-${char.id}">
                <div class="card-image-wrap">
                    <div class="nobg-toggle" onclick="toggleNobg('${char.id}')" id="nobg-btn-${char.id}">NOBG OFF</div>
                    <img id="img-${char.id}" src="${defaultEmotion?.url || ''}" alt="${char.name}" onerror="this.style.opacity='0'">
                    <div id="placeholder-${char.id}" class="nobg-placeholder" style="display: none;">
                        배경 제거(NOBG) 이미지가<br>아직 생성되지 않았습니다.
                    </div>
                </div>
                <div class="card-info">
                    <h3>${char.name}</h3>
                    <p class="card-description">${char.look}</p>
                    <div class="emotion-selector">
                        ${emotionTags}
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
            <div class="card-info">
                <h3>${bg.name}</h3>
                <p class="card-description" style="-webkit-line-clamp: 4;">${bg.description}</p>
            </div>
        </div>
    `).join('');
}

// Global scope functions for onclick handlers
window.switchEmotion = (charId, emotion, btn) => {
    const char = currentAssets.characters.find(c => c.id === charId);
    const imgData = char.images.find(i => i.emotion === emotion);
    const imgEl = document.getElementById(`img-${charId}`);
    const nobgBtn = document.getElementById(`nobg-btn-${charId}`);
    const placeholder = document.getElementById(`placeholder-${charId}`);

    // Update buttons
    const card = document.getElementById(`card-${charId}`);
    card.querySelectorAll('.emotion-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    // Update Image
    const isNobg = nobgBtn.classList.contains('active');
    updateCardImage(charId, imgData, isNobg);
};

window.toggleNobg = (charId) => {
    const btn = document.getElementById(`nobg-btn-${charId}`);
    const isActive = btn.classList.toggle('active');
    btn.textContent = isActive ? 'NOBG ON' : 'NOBG OFF';

    // Find current emotion
    const card = document.getElementById(`card-${charId}`);
    const activeBtn = card.querySelector('.emotion-btn.active');
    const emotion = activeBtn.textContent.trim();
    
    const char = currentAssets.characters.find(c => c.id === charId);
    const imgData = char.images.find(i => i.emotion === emotion);

    updateCardImage(charId, imgData, isActive);
};

function updateCardImage(charId, imgData, isNobg) {
    const imgEl = document.getElementById(`img-${charId}`);
    const placeholder = document.getElementById(`placeholder-${charId}`);

    if (isNobg) {
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
}

// Start the app
init();
