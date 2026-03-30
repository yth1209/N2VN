import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

@Injectable()
export class S3HelperService {
  private readonly logger = new Logger(S3HelperService.name);
  private readonly s3Client: S3Client;
  private readonly bucketName: string;

  constructor(private readonly configService: ConfigService) {
    this.bucketName = this.configService.get<string>('AWS_S3_BUCKET_NAME') || '';
    const region = this.configService.get<string>('AWS_REGION') || 'ap-northeast-2';
    const accessKeyId = this.configService.get<string>('AWS_ACCESS_KEY_ID') || '';
    const secretAccessKey = this.configService.get<string>('AWS_SECRET_ACCESS_KEY') || '';

    this.s3Client = new S3Client({
      region,
      ...(accessKeyId && secretAccessKey
        ? {
            credentials: {
              accessKeyId,
              secretAccessKey,
            },
          }
        : {}),
    });
  }

  /**
   * S3 버킷에 JSON 데이터를 저장하는 공통 헬퍼 메서드 (SSE-S3 적용)
   */
  async uploadJson(objectKey: string, data: any): Promise<void> {
    try {
      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: objectKey,
        Body: JSON.stringify(data, null, 2),
        ContentType: 'application/json',
        ServerSideEncryption: 'AES256',
      });
      await this.s3Client.send(command);
      this.logger.log(`Saved JSON to S3 bucket ${this.bucketName} at key: ${objectKey}`);
    } catch (error) {
      this.logger.error(`S3 JSON 파일 업로드 실패: ${objectKey}`, error);
      throw new HttpException(`Failed to upload ${objectKey} to S3`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /**
   * S3 폴더에서 소설 텍스트 등을 문자열로 읽어오는 공통 헬퍼 메서드
   */
  async readText(objectKey: string): Promise<string> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: objectKey,
      });
      const response = await this.s3Client.send(command);
      
      if (response.Body) {
        return await response.Body.transformToString();
      }
      throw new Error("Response body is empty");
    } catch (error) {
      this.logger.error(`S3 텍스트 읽기 실패: ${objectKey}`, error);
      throw new HttpException(`Failed to read text from S3: ${objectKey}`, HttpStatus.BAD_REQUEST);
    }
  }

  /**
   * S3 폴더에서 JSON 데이터를 읽어보는 공통 헬퍼 메서드
   */
  async readJson(objectKey: string): Promise<any> {
    const textData = await this.readText(objectKey);
    return JSON.parse(textData);
  }

  /**
   * S3 버킷에 이미지(Buffer)를 업로드하는 헬퍼 메서드 (SSE-S3 적용)
   */
  async uploadImage(objectKey: string, buffer: Buffer, mimeType: string = 'image/png'): Promise<void> {
    try {
      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: objectKey,
        Body: buffer,
        ContentType: mimeType,
        ServerSideEncryption: 'AES256',
      });
      await this.s3Client.send(command);
      this.logger.log(`Saved Image to S3 bucket ${this.bucketName} at key: ${objectKey}`);
    } catch (error) {
      this.logger.error(`S3 Image 파일 업로드 실패: ${objectKey}`, error);
      throw new HttpException(`Failed to upload image ${objectKey} to S3`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}
