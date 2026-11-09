import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { UploadReaperService } from './upload-reaper.service';

const CUTOFF_HOURS = 24;

function abandoned(id: string, overrides: Partial<Video> = {}): Video {
  return {
    id,
    status: VideoStatus.UPLOADING,
    storage_key: `${id}/source`,
    upload_id: `upload-${id}`,
    ...overrides,
  } as Video;
}

describe('UploadReaperService', () => {
  let module: TestingModule;
  let service: UploadReaperService;
  let videos: jest.Mocked<Pick<Repository<Video>, 'find' | 'delete'>>;
  let storage: jest.Mocked<Pick<StorageService, 'abortMultipartUpload'>>;

  beforeEach(async () => {
    videos = {
      find: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    storage = { abortMultipartUpload: jest.fn().mockResolvedValue(undefined) };

    module = await Test.createTestingModule({
      providers: [
        UploadReaperService,
        { provide: getRepositoryToken(Video), useValue: videos },
        { provide: StorageService, useValue: storage },
        {
          provide: storageConfig.KEY,
          useValue: { abandonedUploadCutoffHours: CUTOFF_HOURS },
        },
      ],
    }).compile();

    service = module.get(UploadReaperService);
  });

  afterEach(async () => {
    jest.clearAllMocks();
    await module.close();
  });

  describe('selection', () => {
    it('should query only uploading rows older than the configured cutoff', async () => {
      const before = Date.now();

      await service.reapAbandonedUploads();

      expect(videos.find).toHaveBeenCalledTimes(1);
      const [options] = videos.find.mock.calls[0];
      const where = options?.where as {
        status: VideoStatus;
        updated_at: ReturnType<typeof LessThan>;
      };

      // The status filter is the guarantee that `processing`, `ready` and
      // `failed` are never candidates in the first place.
      expect(where.status).toBe(VideoStatus.UPLOADING);

      const cutoff = where.updated_at.value as Date;
      const expected = before - CUTOFF_HOURS * 60 * 60 * 1000;
      expect(cutoff.getTime()).toBeGreaterThanOrEqual(expected - 5000);
      expect(cutoff.getTime()).toBeLessThanOrEqual(expected + 5000);
    });

    it('should do nothing when no upload is abandoned', async () => {
      const result = await service.reapAbandonedUploads();

      expect(result).toEqual({ reaped: 0, abortFailures: 0 });
      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
      expect(videos.delete).not.toHaveBeenCalled();
    });
  });

  describe('reaping', () => {
    it('should abort the multipart and remove the row for each abandoned upload', async () => {
      videos.find.mockResolvedValue([abandoned('a'), abandoned('b')]);

      const result = await service.reapAbandonedUploads();

      expect(result).toEqual({ reaped: 2, abortFailures: 0 });
      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        'a/source',
        'upload-a',
      );
      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        'b/source',
        'upload-b',
      );
      expect(videos.delete).toHaveBeenCalledWith({ id: 'a' });
      expect(videos.delete).toHaveBeenCalledWith({ id: 'b' });
    });

    it('should remove a draft that never opened a multipart', async () => {
      videos.find.mockResolvedValue([
        abandoned('c', { storage_key: null, upload_id: null }),
      ]);

      const result = await service.reapAbandonedUploads();

      expect(result.reaped).toBe(1);
      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
      expect(videos.delete).toHaveBeenCalledWith({ id: 'c' });
    });

    it('should still remove the row and keep sweeping when an abort fails', async () => {
      videos.find.mockResolvedValue([
        abandoned('d'),
        abandoned('e'),
        abandoned('f'),
      ]);
      storage.abortMultipartUpload.mockImplementation((key: string) =>
        key === 'e/source'
          ? Promise.reject(new Error('NoSuchUpload'))
          : Promise.resolve(undefined),
      );

      const result = await service.reapAbandonedUploads();

      // One bad row must not strand the rest of the sweep.
      expect(result).toEqual({ reaped: 3, abortFailures: 1 });
      expect(videos.delete).toHaveBeenCalledTimes(3);
      expect(videos.delete).toHaveBeenCalledWith({ id: 'f' });
    });
  });
});
