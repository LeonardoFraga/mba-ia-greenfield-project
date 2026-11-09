import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StorageService } from '../../storage/storage.service';
import { Video, VideoStatus } from '../entities/video.entity';
import { FfmpegError, extractThumbnail, probeVideo } from './ffmpeg.util';
import { VideoProcessingProcessor } from './video-processing.processor';

jest.mock('./ffmpeg.util', () => {
  const actual =
    jest.requireActual<typeof import('./ffmpeg.util')>('./ffmpeg.util');
  return {
    ...actual,
    probeVideo: jest.fn(),
    extractThumbnail: jest.fn(),
  };
});

const mockedProbeVideo = probeVideo as jest.MockedFunction<typeof probeVideo>;
const mockedExtractThumbnail = extractThumbnail as jest.MockedFunction<
  typeof extractThumbnail
>;

const VIDEO_ID = '11111111-1111-4111-8111-111111111111';
const STORAGE_KEY = `${VIDEO_ID}/source`;
const SIGNED_URL = 'http://minio:9000/videos/signed?X-Amz-Signature=abc';

const probeResult = {
  durationSeconds: 120.5,
  width: 1920,
  height: 1080,
  sizeBytes: 683249,
  metadata: {
    container: 'mov,mp4,m4a,3gp,3g2,mj2',
    videoCodec: 'h264',
    audioCodec: null,
    bitrate: 165618,
    framerate: '15/1',
  },
};

describe('VideoProcessingProcessor', () => {
  let module: TestingModule;
  let processor: VideoProcessingProcessor;
  let videos: jest.Mocked<Pick<Repository<Video>, 'findOne' | 'update'>>;
  let storage: jest.Mocked<Pick<StorageService, 'signGetObject' | 'putObject'>>;

  beforeEach(async () => {
    videos = {
      findOne: jest.fn().mockResolvedValue({
        id: VIDEO_ID,
        status: VideoStatus.PROCESSING,
      } as Video),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    storage = {
      signGetObject: jest
        .fn()
        .mockResolvedValue({ url: SIGNED_URL, expiresIn: 900 }),
      putObject: jest.fn().mockResolvedValue(undefined),
    };

    mockedProbeVideo.mockResolvedValue(probeResult);
    mockedExtractThumbnail.mockResolvedValue(Buffer.from('jpeg-bytes'));

    module = await Test.createTestingModule({
      providers: [
        VideoProcessingProcessor,
        { provide: getRepositoryToken(Video), useValue: videos },
        { provide: StorageService, useValue: storage },
      ],
    }).compile();

    processor = module.get(VideoProcessingProcessor);
  });

  afterEach(async () => {
    jest.clearAllMocks();
    await module.close();
  });

  describe('success path', () => {
    it('should probe the signed URL, store the thumbnail and move the row to ready', async () => {
      await processor.process(
        { videoId: VIDEO_ID, storageKey: STORAGE_KEY },
        false,
      );

      expect(storage.signGetObject).toHaveBeenCalledWith(STORAGE_KEY);
      // The URL goes to FFmpeg as an HTTP input — nothing is downloaded first.
      expect(mockedProbeVideo).toHaveBeenCalledWith(SIGNED_URL);
      expect(storage.putObject).toHaveBeenCalledWith(
        `${VIDEO_ID}/thumbnail.jpg`,
        expect.any(Buffer),
        'image/jpeg',
        'thumbnails',
      );
      expect(videos.update).toHaveBeenCalledWith(
        { id: VIDEO_ID },
        expect.objectContaining({
          status: VideoStatus.READY,
          width: 1920,
          height: 1080,
          duration_seconds: '120.500',
          thumbnail_key: `${VIDEO_ID}/thumbnail.jpg`,
          processing_error: null,
          metadata: probeResult.metadata,
        }),
      );
    });

    it('should seek the frame at 10% of the reported duration', async () => {
      await processor.process(
        { videoId: VIDEO_ID, storageKey: STORAGE_KEY },
        false,
      );

      expect(mockedExtractThumbnail).toHaveBeenCalledWith(
        SIGNED_URL,
        12.05,
        expect.objectContaining({ width: 1280, height: 720 }),
      );
    });

    it('should seek the first frame when the duration is unknown', async () => {
      mockedProbeVideo.mockResolvedValue({
        ...probeResult,
        durationSeconds: null,
      });

      await processor.process(
        { videoId: VIDEO_ID, storageKey: STORAGE_KEY },
        false,
      );

      expect(mockedExtractThumbnail).toHaveBeenCalledWith(
        SIGNED_URL,
        0,
        expect.anything(),
      );
      expect(videos.update).toHaveBeenCalledWith(
        { id: VIDEO_ID },
        expect.objectContaining({ duration_seconds: null }),
      );
    });

    it('should not write size_bytes, which complete already set from HeadObject', async () => {
      await processor.process(
        { videoId: VIDEO_ID, storageKey: STORAGE_KEY },
        false,
      );

      const [, patch] = videos.update.mock.calls[0];
      expect(patch).not.toHaveProperty('size_bytes');
    });
  });

  describe('unprocessable file', () => {
    const ffmpegError = new FfmpegError(
      'ffprobe',
      1,
      'Invalid data found when processing input',
    );

    beforeEach(() => {
      mockedProbeVideo.mockRejectedValue(ffmpegError);
    });

    it('should leave the row in processing and rethrow while retries remain', async () => {
      await expect(
        processor.process(
          { videoId: VIDEO_ID, storageKey: STORAGE_KEY },
          false,
        ),
      ).rejects.toThrow(ffmpegError);

      // The queue absorbs transient faults; the user must see no failure yet.
      expect(videos.update).not.toHaveBeenCalled();
    });

    it('should move the row to failed with the reason on the final attempt', async () => {
      await expect(
        processor.process({ videoId: VIDEO_ID, storageKey: STORAGE_KEY }, true),
      ).rejects.toThrow(ffmpegError);

      expect(videos.update).toHaveBeenCalledWith(
        { id: VIDEO_ID },
        {
          status: VideoStatus.FAILED,
          processing_error: expect.stringContaining(
            'Invalid data found when processing input',
          ) as string,
        },
      );
      expect(storage.putObject).not.toHaveBeenCalled();
    });

    it('should not leave a thumbnail behind when the frame extraction fails', async () => {
      mockedProbeVideo.mockResolvedValue(probeResult);
      mockedExtractThumbnail.mockRejectedValue(
        new FfmpegError('ffmpeg', 0, 'produced an empty thumbnail'),
      );

      await expect(
        processor.process({ videoId: VIDEO_ID, storageKey: STORAGE_KEY }, true),
      ).rejects.toThrow(FfmpegError);

      expect(storage.putObject).not.toHaveBeenCalled();
      expect(videos.update).toHaveBeenCalledWith(
        { id: VIDEO_ID },
        expect.objectContaining({ status: VideoStatus.FAILED }),
      );
    });
  });

  describe('idempotency', () => {
    it('should converge to the same row and the same thumbnail key when run twice', async () => {
      const data = { videoId: VIDEO_ID, storageKey: STORAGE_KEY };

      await processor.process(data, false);
      await processor.process(data, false);

      const [firstKey] = storage.putObject.mock.calls[0];
      const [secondKey] = storage.putObject.mock.calls[1];
      expect(secondKey).toBe(firstKey);

      const [, firstPatch] = videos.update.mock.calls[0];
      const [, secondPatch] = videos.update.mock.calls[1];
      expect(secondPatch).toEqual(firstPatch);
    });
  });

  describe('deleted video', () => {
    it('should succeed as a no-op when the row no longer exists', async () => {
      videos.findOne.mockResolvedValue(null);

      await expect(
        processor.process(
          { videoId: VIDEO_ID, storageKey: STORAGE_KEY },
          false,
        ),
      ).resolves.toBeUndefined();

      // Retrying cannot make a deleted row exist, so this must not throw.
      expect(storage.signGetObject).not.toHaveBeenCalled();
      expect(videos.update).not.toHaveBeenCalled();
    });
  });
});
