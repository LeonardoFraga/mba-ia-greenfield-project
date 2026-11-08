import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  ChannelNotFoundException,
  UnsupportedMediaTypeException,
  UploadNotInProgressException,
  UploadSizeExceededException,
  VideoNotFoundException,
  VideoNotOwnedException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { PUBLIC_ID_LENGTH } from './videos.constants';
import { VideosService } from './videos.service';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024;
const PART_SIZE = 50 * 1024 * 1024;

const OWNER_ID = 'user-owner';
const OTHER_ID = 'user-other';
const CHANNEL = { id: 'channel-1', user_id: OWNER_ID };

function uniqueViolation(column: string): QueryFailedError {
  const err = new QueryFailedError('INSERT', [], new Error('duplicate'));
  (err as unknown as { driverError: unknown }).driverError = {
    code: '23505',
    detail: `Key (${column})=(abc) already exists.`,
  };
  return err;
}

function validDto(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    title: 'Meu vídeo',
    size: 1024,
    contentType: 'video/mp4',
    ...overrides,
  } as { title: string; size: number; contentType: string };
}

describe('VideosService', () => {
  let service: VideosService;
  let repository: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    delete: jest.Mock;
  };
  let channels: { findByUserId: jest.Mock };
  let storage: {
    createMultipartUpload: jest.Mock;
    signUploadPart: jest.Mock;
    abortMultipartUpload: jest.Mock;
  };

  beforeEach(async () => {
    repository = {
      create: jest.fn((data: Partial<Video>) => ({ id: 'video-1', ...data })),
      save: jest.fn((video: Video) => Promise.resolve(video)),
      findOne: jest.fn(),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    channels = { findByUserId: jest.fn().mockResolvedValue(CHANNEL) };
    storage = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-abc'),
      signUploadPart: jest
        .fn()
        .mockImplementation((_key: string, _id: string, part: number) =>
          Promise.resolve({
            url: `https://storage/part/${part}`,
            expiresIn: 900,
          }),
        ),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: repository },
        { provide: ChannelsService, useValue: channels },
        { provide: StorageService, useValue: storage },
        {
          provide: storageConfig.KEY,
          useValue: {
            maxUploadBytes: MAX_UPLOAD_BYTES,
            uploadPartSizeBytes: PART_SIZE,
          },
        },
      ],
    }).compile();

    service = module.get(VideosService);
  });

  describe('initiateUpload', () => {
    it('should reject a size above the ceiling without creating anything', async () => {
      await expect(
        service.initiateUpload(
          OWNER_ID,
          validDto({ size: MAX_UPLOAD_BYTES + 1 }),
        ),
      ).rejects.toBeInstanceOf(UploadSizeExceededException);

      expect(repository.save).not.toHaveBeenCalled();
      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('should accept a size exactly at the ceiling', async () => {
      await expect(
        service.initiateUpload(OWNER_ID, validDto({ size: MAX_UPLOAD_BYTES })),
      ).resolves.toMatchObject({ status: VideoStatus.UPLOADING });
    });

    it('should reject a content type outside the allowlist without creating anything', async () => {
      await expect(
        service.initiateUpload(
          OWNER_ID,
          validDto({ contentType: 'application/zip' }),
        ),
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);

      expect(repository.save).not.toHaveBeenCalled();
      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('should reject when the user has no channel', async () => {
      channels.findByUserId.mockResolvedValue(null);

      await expect(
        service.initiateUpload(OWNER_ID, validDto()),
      ).rejects.toBeInstanceOf(ChannelNotFoundException);

      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('should create the row as draft before opening the multipart upload', async () => {
      await service.initiateUpload(OWNER_ID, validDto());

      // The "pré-cadastro como rascunho" the phase asks for: the row is born
      // `draft` and only becomes `uploading` once the handshake succeeds.
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ status: VideoStatus.DRAFT }),
      );
      const saveCalls = repository.save.mock.calls as [Video][];
      const saved = saveCalls.at(-1)?.[0] as Video;
      expect(saved.status).toBe(VideoStatus.UPLOADING);
      expect(saved.upload_id).toBe('upload-abc');
      expect(saved.storage_key).toBe('video-1/source');
    });

    it('should generate an 11-char URL-safe public id', async () => {
      const result = await service.initiateUpload(OWNER_ID, validDto());

      expect(result.publicId).toHaveLength(PUBLIC_ID_LENGTH);
      expect(result.publicId).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('should compute partCount from the declared size and the configured part size', async () => {
      const result = await service.initiateUpload(
        OWNER_ID,
        validDto({ size: PART_SIZE * 3 + 1 }),
      );

      expect(result.partSize).toBe(PART_SIZE);
      expect(result.partCount).toBe(4);
    });

    it('should retry with a new public id on a unique violation', async () => {
      repository.save
        .mockRejectedValueOnce(uniqueViolation('public_id'))
        .mockImplementation((video: Video) => Promise.resolve(video));

      const result = await service.initiateUpload(OWNER_ID, validDto());

      expect(result.publicId).toHaveLength(PUBLIC_ID_LENGTH);
      // Two insert attempts, each with a freshly generated id.
      const createCalls = repository.create.mock.calls as [Partial<Video>][];
      const attempted = createCalls.map((call) => call[0].public_id);
      expect(attempted).toHaveLength(2);
      expect(attempted[0]).not.toBe(attempted[1]);
    });

    it('should not retry on a unique violation for a different column', async () => {
      repository.save.mockRejectedValueOnce(uniqueViolation('some_other_col'));

      await expect(
        service.initiateUpload(OWNER_ID, validDto()),
      ).rejects.toBeInstanceOf(QueryFailedError);
    });

    it('should delete the draft when opening the multipart upload fails', async () => {
      storage.createMultipartUpload.mockRejectedValue(
        new Error('storage down'),
      );

      await expect(
        service.initiateUpload(OWNER_ID, validDto()),
      ).rejects.toThrow('storage down');

      expect(repository.delete).toHaveBeenCalledWith({ id: 'video-1' });
    });
  });

  describe('signParts', () => {
    const uploadingVideo = {
      id: 'video-1',
      status: VideoStatus.UPLOADING,
      storage_key: 'video-1/source',
      upload_id: 'upload-abc',
      channel: CHANNEL,
    };

    it('should sign every requested part', async () => {
      repository.findOne.mockResolvedValue(uploadingVideo);

      const parts = await service.signParts(OWNER_ID, 'video-1', {
        partNumbers: [1, 2, 3],
      });

      expect(parts.map((p) => p.partNumber)).toEqual([1, 2, 3]);
      expect(storage.signUploadPart).toHaveBeenCalledTimes(3);
      expect(storage.signUploadPart).toHaveBeenCalledWith(
        'video-1/source',
        'upload-abc',
        1,
      );
    });

    it('should reject a video that does not exist', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(
        service.signParts(OWNER_ID, 'missing', { partNumbers: [1] }),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('should reject a caller who does not own the channel', async () => {
      repository.findOne.mockResolvedValue(uploadingVideo);

      await expect(
        service.signParts(OTHER_ID, 'video-1', { partNumbers: [1] }),
      ).rejects.toBeInstanceOf(VideoNotOwnedException);

      expect(storage.signUploadPart).not.toHaveBeenCalled();
    });

    it.each([
      VideoStatus.DRAFT,
      VideoStatus.PROCESSING,
      VideoStatus.READY,
      VideoStatus.FAILED,
    ])('should reject signing while status is %s', async (status) => {
      repository.findOne.mockResolvedValue({ ...uploadingVideo, status });

      await expect(
        service.signParts(OWNER_ID, 'video-1', { partNumbers: [1] }),
      ).rejects.toBeInstanceOf(UploadNotInProgressException);
    });

    it('should reject when the row has no upload in storage', async () => {
      repository.findOne.mockResolvedValue({
        ...uploadingVideo,
        upload_id: null,
      });

      await expect(
        service.signParts(OWNER_ID, 'video-1', { partNumbers: [1] }),
      ).rejects.toBeInstanceOf(UploadNotInProgressException);
    });
  });

  describe('abortUpload', () => {
    it('should abort the multipart upload and delete the row', async () => {
      repository.findOne.mockResolvedValue({
        id: 'video-1',
        status: VideoStatus.UPLOADING,
        storage_key: 'video-1/source',
        upload_id: 'upload-abc',
        channel: CHANNEL,
      });

      await service.abortUpload(OWNER_ID, 'video-1');

      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        'video-1/source',
        'upload-abc',
      );
      expect(repository.delete).toHaveBeenCalledWith({ id: 'video-1' });
    });

    it('should delete a draft that never opened an upload', async () => {
      repository.findOne.mockResolvedValue({
        id: 'video-1',
        status: VideoStatus.DRAFT,
        storage_key: null,
        upload_id: null,
        channel: CHANNEL,
      });

      await service.abortUpload(OWNER_ID, 'video-1');

      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
      expect(repository.delete).toHaveBeenCalledWith({ id: 'video-1' });
    });

    it('should reject a caller who does not own the channel', async () => {
      repository.findOne.mockResolvedValue({
        id: 'video-1',
        status: VideoStatus.UPLOADING,
        storage_key: 'k',
        upload_id: 'u',
        channel: CHANNEL,
      });

      await expect(
        service.abortUpload(OTHER_ID, 'video-1'),
      ).rejects.toBeInstanceOf(VideoNotOwnedException);

      expect(repository.delete).not.toHaveBeenCalled();
    });
  });
});
