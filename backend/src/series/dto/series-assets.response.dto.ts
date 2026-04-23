export class CharacterImageDto {
  emotion: string;
  url: string | null;
  nobgUrl: string | null;
}

export class CharacterAssetDto {
  id: string;
  name: string;
  sex: string;
  look: string;
  images: CharacterImageDto[];
}

export class BackgroundAssetDto {
  id: string;
  name: string;
  description: string;
  url: string | null;
}

export class SeriesAssetsResponseDto {
  characters: CharacterAssetDto[];
  backgrounds: BackgroundAssetDto[];
}
