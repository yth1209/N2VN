# Development: 이미지 생성 엔진 전환 및 상태 관리 고도화

> plan.md 기반 작성 | 2026-05-25

---

## 변경 파일 목록

| 파일 | 변경 유형 | 내용 요약 |
|---|---|---|
| `backend/.env` | 수정 | `IMAGE_PROVIDER`, `GEMINI_IMAGE_MODEL` 추가 |
| `backend/src/common/gen-ai-helper.service.ts` | 수정 | `geminiGenerateImage()` 메서드 추가 |
| `backend/src/image/image.service.ts` | 수정 | provider 분기 처리 + status 갱신 완성 |
| `backend/src/image/prompt/prompt.ts` | 수정 | Gemini용 투명 배경 프롬프트 분기 |
| `backend/src/parsing/parsing.service.ts` | 수정 | 플레이스홀더 생성 시 `status = PENDING` 명시 |

---

## 1. 환경 변수 (`.env`)

```dotenv
# 이미지 생성 엔진 선택: leonardo | gemini
IMAGE_PROVIDER=gemini

# Gemini 이미지 생성 모델 (nano banana pro)
GEMINI_IMAGE_MODEL=gemini-3-pro-image-preview
```

---

## 2. `gen-ai-helper.service.ts` — Gemini 이미지 생성 메서드 추가

### 추가할 필드 (생성자)

```typescript
private readonly geminiImageAI:   GoogleGenAI;
private readonly geminiImageModel: string;

// 생성자 내
this.geminiImageAI    = new GoogleGenAI({ apiKey: geminiApiKey });
this.geminiImageModel = this.configService.get<string>('GEMINI_IMAGE_MODEL')
  ?? 'gemini-3-pro-image-preview';
```

> `lyriaAI`와 동일한 `GoogleGenAI` 인스턴스를 재사용해도 무방하나, 역할 명확성을 위해 별도 필드로 분리.

### 추가할 메서드 `geminiGenerateImage`

```typescript
/**
 * Gemini 이미지 생성.
 * initImageBuffer가 있으면 image-to-image (감정 이미지), 없으면 text-to-image.
 * 응답은 base64 inlineData로 수신 → Buffer 변환 후 반환.
 */
async geminiGenerateImage(
  prompt:           string,
  initImageBuffer?: Buffer,
  aspectRatio:      string = '1:1',
  imageSize:        string = '1K',
): Promise<{ buffer: Buffer }> {
  const parts: any[] = [{ text: prompt }];

  if (initImageBuffer) {
    parts.push({
      inlineData: {
        mimeType: 'image/png',
        data:     initImageBuffer.toString('base64'),
      },
    });
  }

  const response = await this.geminiImageAI.models.generateContent({
    model:    this.geminiImageModel,
    contents: [{ role: 'user', parts }],
    config:   {
      responseModalities: ['IMAGE', 'TEXT'],
      responseFormat: {
        image: {
          aspectRatio,
          imageSize,
        },
      },
    } as any,
  });

  const inlineData = response.candidates?.[0]?.content?.parts
    ?.find((p: any) => p.inlineData)?.inlineData;

  if (!inlineData?.data) throw new Error('Gemini: image data 없음');

  return { buffer: Buffer.from(inlineData.data, 'base64') };
}
```

---

## 3. `image/prompt/prompt.ts` — 투명 배경 프롬프트 분기

### 변경 사항

`getCharacterPrompt`에 `provider` 파라미터 추가. Gemini는 `transparent background` 지시어로, Leonardo는 기존 `solid white background`로 분기.

```typescript
// 변경 전
const BACKGROUND_BLOCK = 'isolated on a simple solid white background, no background';

// 변경 후
const BACKGROUND_BLOCK_LEONARDO = 'isolated on a simple solid white background, no background';
const BACKGROUND_BLOCK_GEMINI   = 'transparent background, RGBA transparent PNG, no background elements, alpha channel';

export function getCharacterPrompt(
  style:    string,
  look:     string,
  emotion:  Emotion,
  provider: 'leonardo' | 'gemini' = 'leonardo',
): string {
  const bgBlock = provider === 'gemini' ? BACKGROUND_BLOCK_GEMINI : BACKGROUND_BLOCK_LEONARDO;
  // ... 기존 조합 로직 동일
}
```

---

## 4. `image/image.service.ts` — provider 분기 + status 갱신

### 4.1 생성자 변경

```typescript
private readonly imageProvider: 'leonardo' | 'gemini';

constructor(
  private readonly s3HelperService: S3HelperService,
  private readonly genAI:           GenAIHelperService,
  private readonly repo:            RepositoryProvider,
  private readonly eventEmitter:    EventEmitter2,
  private readonly configService:   ConfigService,
) {
  this.imageProvider =
    this.configService.get<string>('IMAGE_PROVIDER') === 'gemini' ? 'gemini' : 'leonardo';
}
```

### 4.2 `generateBackgroundImages` — status 갱신 추가 + provider 분기

```typescript
await Promise.all(
  backgrounds.map(async (bg) => {
    bg.status = GenStatus.PROCESSING;
    await this.repo.background.save(bg);

    try {
      const prompt = `(${globalBgArtStyle}:1.2), ${actualStyleKey} art style rendering, ${bg.description}, masterpiece, empty scenery, highly detailed landscape, no characters`;
      let buffer: Buffer;

      if (this.imageProvider === 'gemini') {
        // 배경: 가로 16:9, 2K 해상도
        ({ buffer } = await this.genAI.geminiGenerateImage(prompt, undefined, '16:9', '2K'));
      } else {
        ({ buffer, imageId: bg.genId } = await this.genAI.leonardoGenerateImage(
          prompt, undefined, selectedStyleUUID, 1280, 720,
        ));
      }

      await this.s3HelperService.uploadImage(
        `series/${seriesId}/backgrounds/${bg.id}.png`, buffer, 'image/png',
      );
      bg.status = GenStatus.DONE;
      await this.repo.background.save(bg);
    } catch (err: any) {
      bg.status = GenStatus.FAILED;
      await this.repo.background.save(bg);
      this.logger.error(`[${bg.id}] 배경 이미지 실패: ${err.message}`);
    }
  }),
);
```

### 4.3 `processCharacter` — DEFAULT 이미지 생성 분기

DEFAULT 이미지 생성 후 buffer를 메모리에 유지해 감정 이미지 생성 시 Gemini image-to-image 입력으로 재사용.

```typescript
private async processCharacter(
  seriesId:       string,
  pendingCharImgs: CharacterImg[],
  globalArtStyle:  string,
  selectedStyleUUID: string,
): Promise<void> {
  let defaultImg = pendingCharImgs.find((pci) => pci.emotion === Emotion.DEFAULT);
  if (!defaultImg) throw new HttpException('DEFAULT image entry not found', HttpStatus.BAD_REQUEST);

  const charId   = defaultImg.characterId;
  const charInfo = defaultImg._characterFk;

  // DEFAULT 이미지가 아직 생성되지 않은 경우 (PENDING or FAILED)
  let defaultBuffer: Buffer | undefined;

  if (defaultImg.status !== GenStatus.DONE) {
    this.logger.log(`[${charId}] DEFAULT 이미지 생성 중...`);
    const defaultPrompt = getCharacterPrompt(
      globalArtStyle, charInfo.look, Emotion.DEFAULT, this.imageProvider,
    );

    defaultImg.status = GenStatus.PROCESSING;
    await this.repo.characterImg.save(defaultImg);

    try {
      if (this.imageProvider === 'gemini') {
        // 캐릭터: 세로 9:16, 1K 해상도
        ({ buffer: defaultBuffer } = await this.genAI.geminiGenerateImage(defaultPrompt, undefined, '9:16', '1K'));
      } else {
        const { buffer, imageId } = await this.genAI.leonardoGenerateImage(
          defaultPrompt, undefined, selectedStyleUUID,
        );
        defaultBuffer  = buffer;
        defaultImg.genId = imageId;
        defaultImg.nobgGenId = await this.extractAndSaveNobg(seriesId, defaultImg);
      }

      await this.s3HelperService.uploadImage(
        `series/${seriesId}/characters/${charId}/DEFAULT.png`, defaultBuffer, 'image/png',
      );
      defaultImg.status = GenStatus.DONE;
      await this.repo.characterImg.save(defaultImg);
      this.logger.log(`[${charId}] DEFAULT 생성 완료`);
    } catch (err: any) {
      defaultImg.status = GenStatus.FAILED;
      await this.repo.characterImg.save(defaultImg);
      throw err;
    }
  }

  // 감정 이미지 (DEFAULT 이미지가 DONE인 경우만 진행)
  const remaining = pendingCharImgs.filter((pci) => pci.emotion !== Emotion.DEFAULT);
  if (remaining.length === 0) return;

  // Gemini image-to-image에서 DEFAULT buffer가 필요한 경우 S3에서 다운로드
  if (this.imageProvider === 'gemini' && !defaultBuffer) {
    const s3Key = `series/${seriesId}/characters/${charId}/DEFAULT.png`;
    defaultBuffer = await this.s3HelperService.downloadImage(s3Key);
  }

  const emotionPromises = remaining.map((pci) =>
    this.generateEmotion(
      seriesId, pci, globalArtStyle, selectedStyleUUID, defaultBuffer,
    ).catch((err) =>
      this.logger.error(`[${charId}] ${pci.emotion} 생성 실패: ${err.message}`),
    ),
  );

  await Promise.all(emotionPromises);
}
```

### 4.4 `generateEmotion` — provider 분기

```typescript
private async generateEmotion(
  seriesId:      string,
  cimg:          CharacterImg,
  globalArtStyle: string,
  styleUUID:     string,
  defaultBuffer?: Buffer,
): Promise<void> {
  const charId = cimg.characterId;
  const prompt = getCharacterPrompt(
    globalArtStyle, cimg._characterFk.look, cimg.emotion, this.imageProvider,
  );

  cimg.status = GenStatus.PROCESSING;
  await this.repo.characterImg.save(cimg);

  try {
    let buffer: Buffer;

    if (this.imageProvider === 'gemini') {
      // DEFAULT 이미지를 입력으로 넣어 표정만 변경 (image-to-image), 캐릭터: 9:16 1K
      ({ buffer } = await this.genAI.geminiGenerateImage(prompt, defaultBuffer, '9:16', '1K'));
    } else {
      const result = await this.genAI.leonardoGenerateImage(
        prompt, cimg.genId ?? undefined, styleUUID,
      );
      buffer       = result.buffer;
      cimg.genId   = result.imageId;
      cimg.nobgGenId = await this.extractAndSaveNobg(seriesId, cimg);
    }

    await this.s3HelperService.uploadImage(
      `series/${seriesId}/characters/${charId}/${cimg.emotion}.png`, buffer, 'image/png',
    );
    cimg.status = GenStatus.DONE;
    await this.repo.characterImg.save(cimg);
  } catch (err: any) {
    cimg.status = GenStatus.FAILED;
    await this.repo.characterImg.save(cimg);
    throw err;
  }
}
```

---

## 5. `s3-helper.service.ts` — `downloadImage` 메서드 추가

Gemini image-to-image 시 DEFAULT 이미지 buffer가 메모리에 없는 경우 S3에서 다운로드.

```typescript
async downloadImage(key: string): Promise<Buffer> {
  const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
  const response = await this.s3Client.send(command);
  const stream = response.Body as Readable;
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
```

---

## 6. `parsing.service.ts` — 플레이스홀더 생성 시 status 명시

씬 파싱 후 `character_img` 플레이스홀더 생성 시 `status = PENDING` 명시적으로 설정.

```typescript
// 변경 전
await this.repo.characterImg.save({ characterId, emotion });

// 변경 후
await this.repo.characterImg.save({
  characterId,
  emotion,
  status: GenStatus.PENDING,
});
```

---

## 7. status 흐름 정리

```
[씬 파싱 완료 시]
character_img 플레이스홀더 생성 → status = PENDING

[이미지 생성 시작]
→ status = PROCESSING  (재진입/중복 생성 방지)

[이미지 생성 성공]
→ S3 업로드 완료
→ status = DONE

[이미지 생성 실패]
→ status = FAILED
→ 다음 실행 시 FAILED 레코드도 재시도 대상에 포함됨
```

기존 `status in (PENDING, FAILED)` 조회 조건은 이미 적용되어 있으므로 변경 불필요.

---

## 8. 작업 순서 (구현 체크리스트)

1. `.env`에 `IMAGE_PROVIDER`, `GEMINI_IMAGE_MODEL` 추가
2. `gen-ai-helper.service.ts`: `geminiImageModel` 필드 + `geminiGenerateImage()` 추가
3. `image/prompt/prompt.ts`: `getCharacterPrompt`에 `provider` 파라미터 추가
4. `s3-helper.service.ts`: `downloadImage()` 추가
5. `image/image.service.ts`:
   - 생성자에 `imageProvider` 필드 추가
   - `generateBackgroundImages` status 갱신 + provider 분기
   - `processCharacter` DEFAULT buffer 유지 + provider 분기
   - `generateEmotion` provider 분기 + status 갱신
6. `parsing.service.ts`: 플레이스홀더 생성 시 `status = PENDING` 추가

---

## 9. 주의사항

- **Gemini NOBG**: `extractAndSaveNobg`는 Gemini provider 시 호출하지 않음. 투명 배경은 생성 프롬프트로 처리.
- **`initImageId` vs `initImageBuffer`**: Leonardo는 서버에 업로드된 이미지 ID(`genId`)를 참조. Gemini는 이미지 bytes를 직접 전달. 메서드 시그니처가 다름.
- **DEFAULT buffer 유실**: `processCharacter` 실행 도중 DEFAULT가 이미 DONE인 경우 buffer 없이 진입. S3 `downloadImage`로 보완 (구현 항목 4 참조).
- **`configService` 주입**: `ImageService`의 기존 생성자에 `ConfigService` 의존성 추가 필요. `image.module.ts`에서 `ConfigModule` import 여부 확인.
