
// ── State ──────────────────────────────────────────
let vnScript   = [];
let scriptIndex = 0;
let characters  = {};   // { charId: { name, sprites: { emotion: url } } }
let scenes      = {};   // { bgId: url }
let onScreen    = {};   // { charId: { emotion, position } }

let isTyping   = false;
let typeTimer  = null;
let fullText   = '';

// ── DOM ────────────────────────────────────────────
const loadingEl     = document.getElementById('loading-overlay');
const loadingTextEl = document.getElementById('loading-text');
const bgLayer       = document.getElementById('bg-layer');
const charSlots     = {
  left:   document.getElementById('char-left'),
  center: document.getElementById('char-center'),
  right:  document.getElementById('char-right'),
};
const dialogueBox = document.getElementById('dialogue-box');
const speakerEl   = document.getElementById('speaker-name');
const textEl      = document.getElementById('dialogue-text');
const advanceHint = document.getElementById('advance-hint');
const endScreen   = document.getElementById('end-screen');

// ── Entry ──────────────────────────────────────────
window.addEventListener('message', async (event) => {
  const { seriesId, episodeNumber } = event.data ?? {};
  if (!seriesId || !episodeNumber) return;
  await loadScript(seriesId, episodeNumber);
});

async function loadScript(seriesId, episodeNumber) {
  loadingEl.classList.remove('hidden');
  loadingTextEl.textContent = `${episodeNumber}화 데이터를 불러오는 중...`;

  try {
    const res    = await fetch(`${BASE_URL}/series/${seriesId}/episodes/${episodeNumber}/vn-script`);
    const result = await res.json();

    if (!result.success) {
      loadingTextEl.textContent = '로드 실패: ' + (result.message ?? '알 수 없는 오류');
      return;
    }

    characters  = result.data.characters;
    scenes      = result.data.scenes;
    vnScript    = result.data.script;
    scriptIndex = 0;
    onScreen    = {};

    loadingEl.classList.add('hidden');
    setupInput();
    processNext(); // 자동 시작
  } catch (err) {
    loadingTextEl.textContent = `서버 연결 실패: ${err.message}`;
  }
}

// ── Input ──────────────────────────────────────────
function setupInput() {
  document.getElementById('vn-container').addEventListener('click', onAdvance);
  document.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      onAdvance();
    }
  });
}

function onAdvance() {
  if (isTyping) {
    // 타이핑 중이면 즉시 완성
    clearTimeout(typeTimer);
    textEl.textContent = fullText;
    isTyping = false;
    showAdvanceHint();
    return;
  }
  processNext();
}

// ── Script Runner ──────────────────────────────────
// non-interactive 명령(bg/char 조작)은 루프로 연속 처리하고,
// dialogue/narration에서만 멈춰 사용자 입력을 기다린다.
function processNext() {
  while (scriptIndex < vnScript.length) {
    const cmd = vnScript[scriptIndex++];
    const shouldPause = executeCommand(cmd);
    if (shouldPause) break;
  }
}

// returns true → pause and wait for click
function executeCommand(cmd) {
  if (typeof cmd === 'string') {
    if (cmd === 'end') { showEnd(); return false; }

    // show scene {bgId} [with fade]
    const bgMatch = cmd.match(/^show scene (\S+)/);
    if (bgMatch) {
      changeBg(bgMatch[1], cmd.includes('with fade'));
      return false;
    }

    // show character {charId} {emotion} {position}
    const showMatch = cmd.match(/^show character (\S+) (\S+) (\S+)/);
    if (showMatch) {
      showCharacter(showMatch[1], showMatch[2], showMatch[3]);
      return false;
    }

    // hide character {charId}
    const hideMatch = cmd.match(/^hide character (\S+)/);
    if (hideMatch) {
      hideCharacter(hideMatch[1]);
      return false;
    }

    // narrator (plain string)
    showDialogue('', cmd);
    return true;
  }

  if (typeof cmd === 'object' && cmd !== null) {
    const [speaker, text] = Object.entries(cmd)[0];
    showDialogue(speaker, String(text));
    return true;
  }

  return false;
}

// ── Background ─────────────────────────────────────
function changeBg(bgId, fade) {
  const url = scenes[bgId];
  if (!url) return;

  if (fade) {
    bgLayer.style.opacity = '0';
    setTimeout(() => {
      bgLayer.style.backgroundImage = `url("${url}")`;
      bgLayer.style.opacity = '1';
    }, 450);
  } else {
    bgLayer.style.backgroundImage = `url("${url}")`;
  }
}

// ── Characters ─────────────────────────────────────
function showCharacter(charId, emotion, position) {
  const charData = characters[charId];
  if (!charData) return;

  const url = charData.sprites[emotion] || charData.sprites['DEFAULT'];
  if (!url) return;

  const slot = charSlots[position] || charSlots['center'];

  // 같은 슬롯에 있던 다른 캐릭터 제거
  for (const [existId, info] of Object.entries(onScreen)) {
    if (info.position === position && existId !== charId) {
      delete onScreen[existId];
    }
  }

  // 이 캐릭터가 다른 슬롯에 있었다면 그 슬롯 비우기
  if (onScreen[charId] && onScreen[charId].position !== position) {
    const oldSlot = charSlots[onScreen[charId].position];
    if (oldSlot) oldSlot.innerHTML = '';
  }

  slot.innerHTML = `<img src="${url}" alt="${charData.name}" data-char-id="${charId}">`;
  onScreen[charId] = { emotion, position };
}

function hideCharacter(charId) {
  const info = onScreen[charId];
  if (!info) return;

  const slot = charSlots[info.position];
  if (slot) {
    const img = slot.querySelector(`img[data-char-id="${charId}"]`);
    if (img) img.remove();
  }
  delete onScreen[charId];
}

function highlightSpeaker(speakerName) {
  for (const [charId, info] of Object.entries(onScreen)) {
    const img = charSlots[info.position]?.querySelector('img');
    if (!img) continue;

    const isSpeaker = characters[charId]?.name === speakerName;
    img.classList.toggle('speaking', isSpeaker);
    img.classList.toggle('silent',   !isSpeaker);
  }
}

function clearHighlights() {
  for (const info of Object.values(onScreen)) {
    const img = charSlots[info.position]?.querySelector('img');
    if (img) img.classList.remove('speaking', 'silent');
  }
}

// ── Dialogue ───────────────────────────────────────
function showDialogue(speaker, text) {
  dialogueBox.style.display = 'block';
  advanceHint.style.opacity = '0';

  if (speaker) {
    speakerEl.textContent    = speaker;
    speakerEl.style.display  = 'block';
    highlightSpeaker(speaker);
  } else {
    speakerEl.style.display = 'none';
    clearHighlights();
  }

  // 타이프라이터
  fullText         = text;
  textEl.textContent = '';
  isTyping         = true;
  let i = 0;

  function type() {
    if (i < fullText.length) {
      textEl.textContent += fullText[i++];
      typeTimer = setTimeout(type, 25);
    } else {
      isTyping = false;
      showAdvanceHint();
    }
  }
  type();
}

function showAdvanceHint() {
  advanceHint.style.opacity = '1';
}

// ── End ────────────────────────────────────────────
function showEnd() {
  dialogueBox.style.display = 'none';
  clearHighlights();
  endScreen.style.display = 'flex';
}
