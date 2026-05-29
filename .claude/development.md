# Development Plan: Gemini Image Generation 배치 요청 전환

## 1. AS-IS 비용 구조 분석

### 현재 Gemini 이미지 생성 호출 패턴

```typescript
// gen-ai-helper.service.ts
async geminiGenerateImage(prompt, initImageBuffer?, aspectRatio?, imageSize?) {
  await this.geminiImageAI.models.generateContent({ ... }); // 1회 = 이미지 1장
}
```

**캐릭터 5명 × 감정 10개 + 배경 10개 기준:**

```
DEFAULT 생성:  generateContent() × 5   (캐릭터당 1회)
감정 생성:     generateContent() × 45  (캐릭터당 9회 × 5명)
배경 생성:     generateContent() × 10

합계: generateContent() 60회 개별 호출
```

각 호출이 독립적인 HTTP 요청이므로 연결 오버헤드가 60배 발생하고, API 요금 체계상 개별 호출보다 배치 제출이 비용 효율적이다.

---

## 2. TO-BE 설계

### 2.1 Gemini Batch API 구조

`@google/genai` v2.6.0에서 `batches` 모듈이 제공된다.

```typescript
// 요청 제출
const job: BatchJob = await ai.batches.create({
  model: 'gemini-3-pro-image-preview',
  src: InlinedRequest[],   // 여러 요청을 배열로 한 번에 제출
});

// 완료 폴링
const done = await ai.batches.get({ name: job.name });
// done.state === 'JOB_STATE_SUCCEEDED'

// 결과 추출
const responses: InlinedResponse[] = done.dest.inlinedResponses;
// responses[i].response → GenerateContentResponse (이미지 포함)
// responses[i].error    → 실패한 경우
```

**핵심 타입:**
```typescript
interface InlinedRequest {
  model?:    string;
  contents?: ContentListUnion;  // 프롬프트 텍스트 + initImage (optional)
  config?:   GenerateContentConfig;
}

class InlinedResponse {
  response?: GenerateContentResponse; // 이미지 데이터 포함
  error?:    JobError;
}
```

### 2.2 배치 처리 단계 설계

캐릭터 감정 이미지는 DEFAULT 이미지(initImageBuffer)를 레퍼런스로 사용하므로, **2단계 배치**로 나눈다.

```
Phase 1 — DEFAULT 배치
  InlinedRequest[] = [ charA_DEFAULT, charB_DEFAULT, charC_DEFAULT, ... ]
  batches.create() → 폴링 → 완료
  → defaultBuffers Map<charId, Buffer> 구성

Phase 2 — 감정 + 배경 배치 (동시)
  charEmotionRequests[]   = [ (charA, SMILE, defaultBuffer_A), ... ]  각 요청에 initImage 포함
  bgRequests[]            = [ bg_1, bg_2, ... ]

  Promise.all([
    batches.create(charEmotionRequests),   // 감정 이미지 배치
    batches.create(bgRequests),            // 배경 이미지 배치
  ]) → 각각 폴링 → 완료
```

---

## 3. 구현 계획

### 3.1 `gen-ai-helper.service.ts` — 신규 메서드 추가

```typescript
async geminiBatchGenerateImages(
  requests: Array<{
    prompt:           string;
    initImageBuffer?: Buffer;
    aspectRatio?:     string;
    imageSize?:       string;
    metadata?:        Record<string, string>;  // 결과 매핑용 식별자
  }>,
): Promise<Array<{ buffer: Buffer; metadata?: Record<string, string> }>>
```

**내부 구현:**

1. `requests`를 `InlinedRequest[]`로 변환
   - `contents`: `[{ text: prompt }]` + initImageBuffer가 있으면 `inlineData` 추가
   - `config`: `{ responseModalities: ['IMAGE', 'TEXT'], responseFormat: { image: { aspectRatio, imageSize } } }`

2. `this.geminiImageAI.batches.create({ model: this.geminiImageModel, src: inlinedRequests })` 호출
   → `BatchJob` 핸들만 즉시 반환 (결과 아님)

3. **배치 전용 폴링** — `batches.get({ name })` 반복 호출, `state === JOB_STATE_SUCCEEDED` 대기
   - `batches.create()`는 일반 `generateContent()`와 달리 `await`으로 결과가 바로 오지 않음
   - 기존 `poll()`(최대 180s)은 사용 불가 — Batch API 공식 문서 기준 최대 24시간 소요 가능
   - 배치 전용 폴링: interval 30s, 최대 대기 시간 별도 설정(예: 2시간) 권장

4. `job.dest.inlinedResponses` 순회 → 각 항목의 `response.candidates[0].content.parts`에서 `inlineData` 추출 → Buffer 변환, `error` 유무도 함께 반환

5. 입력 순서와 동일한 순서로 `{ buffer?, error?, metadata? }[]` 반환

### 3.2 `image.service.ts` — `generateCharacterImages()` 리팩터링

> **Phase 2-B(배경 이미지)는 별도 API**(`POST /images/backgrounds` → `generateBackgroundImages()`)에서 처리한다.
> `generateCharacterImages()`는 캐릭터 이미지만 담당하며, 배경 배치는 아래 3.3절에서 독립적으로 기술한다.

**변경 전:**
```
캐릭터별 processCharacter() 병렬 실행
  → DEFAULT generateContent() → NOBG → 업로드
  → 감정별 generateContent() 병렬 → NOBG → 업로드
```

**변경 후 (Gemini 경로 한정):**
```typescript
const defaultBufferMap = new Map<string, Buffer>();

// ── Phase 1: DEFAULT 배치 ─────────────────────────────────────────────────
// DEFAULT가 이미 DONE인 캐릭터는 pendingImages 쿼리에서 걸러지므로
// charGroups에 DEFAULT 엔트리가 없다 → 재생성하면 안 됨
const charsNeedingDefault = [...charGroups.entries()]
  .filter(([, pis]) => pis.some(pi => pi.emotion === Emotion.DEFAULT));

if (charsNeedingDefault.length > 0) {
  // 배치 제출 전: 대상 전체를 PROCESSING으로 마킹
  for (const [, pis] of charsNeedingDefault) {
    const defaultImg = pis.find(pi => pi.emotion === Emotion.DEFAULT);
    defaultImg.status = GenStatus.PROCESSING;
    await this.repo.characterImg.save(defaultImg);
  }

  const defaultRequests = charsNeedingDefault.map(([charId, pis]) => ({
    prompt:      getCharacterPrompt(globalArtStyle, pis[0]._characterFk.look, Emotion.DEFAULT, 'gemini'),
    metadata:    { charId },
    aspectRatio: '9:16', imageSize: '1K',
  }));
  const defaultResults = await this.genAI.geminiBatchGenerateImages(defaultRequests);

  for (let i = 0; i < defaultResults.length; i++) {
    const result = defaultResults[i];
    const charId = result.metadata!.charId;
    const defaultImg = charsNeedingDefault[i][1].find(pi => pi.emotion === Emotion.DEFAULT);

    if (result.error) {
      // 배치 내 개별 항목 실패
      defaultImg.status = GenStatus.FAILED;
      await this.repo.characterImg.save(defaultImg);
      this.logger.error(`[${charId}] DEFAULT 배치 생성 실패: ${result.error.message}`);
      continue;
    }

    const nobgBuffer = await this.genAI.removeImageBackground(result.buffer);
    await this.s3HelperService.uploadImage(`series/${seriesId}/characters/${charId}/DEFAULT.png`, result.buffer, 'image/png');
    await this.s3HelperService.uploadImage(`series/${seriesId}/characters/${charId}/DEFAULT_NOBG.png`, nobgBuffer, 'image/png');
    defaultImg.status = GenStatus.DONE;
    await this.repo.characterImg.save(defaultImg);
    defaultBufferMap.set(charId, result.buffer);
  }
}

// DEFAULT가 이미 DONE인 캐릭터는 S3에서 다운로드하여 defaultBufferMap 채우기
const charsNeedingS3Download = [...charGroups.keys()]
  .filter(charId => !defaultBufferMap.has(charId));

await Promise.all(
  charsNeedingS3Download.map(async (charId) => {
    const buf = await this.s3HelperService.downloadImage(
      `series/${seriesId}/characters/${charId}/DEFAULT.png`,
    );
    defaultBufferMap.set(charId, buf);
  }),
);

// ── Phase 2: 감정 배치 ────────────────────────────────────────────────────
const pendingEmotions = [...charGroups.values()]
  .flat()
  .filter(pi => pi.emotion !== Emotion.DEFAULT);

if (pendingEmotions.length > 0) {
  // 배치 제출 전: 대상 전체를 PROCESSING으로 마킹
  for (const cimg of pendingEmotions) {
    cimg.status = GenStatus.PROCESSING;
    await this.repo.characterImg.save(cimg);
  }

  const emotionRequests = pendingEmotions.map(cimg => ({
    prompt:          getCharacterEmotionPrompt(globalArtStyle, cimg._characterFk.look, cimg.emotion, 'gemini'),
    initImageBuffer: defaultBufferMap.get(cimg.characterId),
    metadata:        { charId: cimg.characterId, emotion: cimg.emotion },
    aspectRatio: '9:16', imageSize: '1K',
  }));
  const emotionResults = await this.genAI.geminiBatchGenerateImages(emotionRequests);

  for (let i = 0; i < emotionResults.length; i++) {
    const result = emotionResults[i];
    const cimg = pendingEmotions[i];

    if (result.error) {
      cimg.status = GenStatus.FAILED;
      await this.repo.characterImg.save(cimg);
      this.logger.error(`[${cimg.characterId}] ${cimg.emotion} 배치 생성 실패: ${result.error.message}`);
      continue;
    }

    const nobgBuffer = await this.genAI.removeImageBackground(result.buffer);
    await this.s3HelperService.uploadImage(`series/${seriesId}/characters/${cimg.characterId}/${cimg.emotion}.png`, result.buffer, 'image/png');
    await this.s3HelperService.uploadImage(`series/${seriesId}/characters/${cimg.characterId}/${cimg.emotion}_NOBG.png`, nobgBuffer, 'image/png');
    cimg.status = GenStatus.DONE;
    await this.repo.characterImg.save(cimg);
  }
}
```

### 3.3 `image.service.ts` — `generateBackgroundImages()` 리팩터링

배경 이미지는 `generateCharacterImages()`와 독립된 별도 API(`POST /images/backgrounds`)에서 처리한다.
기존 `Promise.all` 개별 호출을 단일 배치로 대체한다.

```typescript
// 배치 제출 전: 대상 전체를 PROCESSING으로 마킹
for (const bg of backgrounds) {
  bg.status = GenStatus.PROCESSING;
  await this.repo.background.save(bg);
}

const bgRequests = backgrounds.map(bg => ({
  prompt:      `(${globalBgArtStyle}:1.2), ${actualStyleKey} art style rendering, ${bg.description}, masterpiece, empty scenery, highly detailed landscape, no characters`,
  metadata:    { bgId: bg.id },
  aspectRatio: '16:9', imageSize: '2K',
}));
const bgResults = await this.genAI.geminiBatchGenerateImages(bgRequests);

for (let i = 0; i < bgResults.length; i++) {
  const result = bgResults[i];
  const bg = backgrounds[i];

  if (result.error) {
    bg.status = GenStatus.FAILED;
    await this.repo.background.save(bg);
    this.logger.error(`[${bg.id}] 배경 배치 생성 실패: ${result.error.message}`);
    continue;
  }

  await this.s3HelperService.uploadImage(`series/${seriesId}/backgrounds/${bg.id}.png`, result.buffer, 'image/png');
  bg.status = GenStatus.DONE;
  await this.repo.background.save(bg);
}
```

### 3.4 Leonardo 경로 유지

`IMAGE_PROVIDER !== 'gemini'`인 경우 기존 `leonardoGenerateImage()` 흐름을 그대로 유지한다.
배치 API 전환 대상은 **Gemini 경로만**이다.

---

## 4. 부가 변경 사항 (추가 개선)

> 주요 변경(배치 전환)과 별개로 진행 가능.

**Leonardo NOBG → 로컬 처리 전환**

Leonardo 경로에서 `extractAndSaveNobg()` (Leonardo NOBG API 호출, 크레딧 추가 소모)를
Gemini 경로와 동일하게 `removeImageBackground()` (로컬 처리, 무료)로 대체한다.

변경 파일: `image.service.ts`의 `extractAndSaveNobg()` 제거, `gen-ai-helper.service.ts`의 `leonardoNobg()` 제거.

---

## 5. 변경 파일 목록

| 파일 | 변경 내용 |
|---|---|
| `backend/src/common/gen-ai-helper.service.ts` | `geminiBatchGenerateImages()` 신규 추가 |
| `backend/src/image/image.service.ts` | `generateCharacterImages()`, `generateBackgroundImages()` 배치 호출로 전환 (Gemini 경로) |

---

## 6. 예상 효과

| 구분 | 변경 전 | 변경 후 |
|---|---|---|
| Gemini generateContent 호출 횟수 | 60회 개별 | Phase1: 1회, Phase2-A: 1회, Phase2-B: 1회 → **3회 배치** |
| HTTP 연결 오버헤드 | 60배 | 3배 |
| 처리 구조 | 순차/병렬 혼합 | 단계별 배치 → 병렬 배치 |
| 코드 복잡도 | 캐릭터별 분산 처리 | 단계별 일괄 처리로 단순화 |

> **주의:** Gemini Batch API는 비동기 잡(async job) 방식으로 결과 수신까지 수 분이 소요될 수 있다. 현재 파이프라인의 fire-and-forget 구조(이벤트 에미터 기반)와는 잘 맞지만, 개별 이미지 완료 시점의 DB 업데이트가 배치 완료 시점으로 지연된다는 점을 고려해야 한다.
