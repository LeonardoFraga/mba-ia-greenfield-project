import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

/** 10GB — the phase ceiling, and the value that overflows `integer`. */
const TEN_GB = '10737418240';

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const suffix = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_user_${suffix}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${suffix}`,
        nickname: `vid_chan_${suffix}`,
        user_id: user.id,
      }),
    );
  }

  function newVideo(channel: Channel, overrides: Partial<Video> = {}): Video {
    return videoRepository.create({
      channel_id: channel.id,
      title: 'Um vídeo',
      public_id: `pub_${++counter}`,
      ...overrides,
    });
  }

  it('should default status to draft when it is omitted', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(newVideo(channel));
    const reloaded = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(reloaded.status).toBe(VideoStatus.DRAFT);
  });

  it('should enforce the unique constraint on public_id', async () => {
    const channel = await createChannel();
    await videoRepository.save(newVideo(channel, { public_id: 'collide' }));

    await expect(
      videoRepository.save(newVideo(channel, { public_id: 'collide' })),
    ).rejects.toThrow();
  });

  it('should reject a video whose channel does not exist', async () => {
    const orphan = videoRepository.create({
      channel_id: '00000000-0000-0000-0000-000000000000',
      title: 'Órfão',
      public_id: `pub_orphan_${++counter}`,
    });

    await expect(videoRepository.save(orphan)).rejects.toThrow();
  });

  it('should accept every value of the status enum', async () => {
    const channel = await createChannel();

    for (const status of Object.values(VideoStatus)) {
      const saved = await videoRepository.save(newVideo(channel, { status }));
      const reloaded = await videoRepository.findOneByOrFail({ id: saved.id });
      expect(reloaded.status).toBe(status);
    }
  });

  it('should round-trip a 10GB size without overflowing', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(
      newVideo(channel, {
        declared_size_bytes: TEN_GB,
        size_bytes: TEN_GB,
      }),
    );
    const reloaded = await videoRepository.findOneByOrFail({ id: saved.id });

    // `bigint` maps to string in JS, which is why callers must not do
    // arithmetic on the raw column value.
    expect(reloaded.size_bytes).toBe(TEN_GB);
    expect(reloaded.declared_size_bytes).toBe(TEN_GB);
    expect(Number(reloaded.size_bytes)).toBeGreaterThan(2 ** 31);
  });

  it('should round-trip the ffprobe long tail through the jsonb column', async () => {
    const channel = await createChannel();
    const metadata = {
      container: 'mov,mp4,m4a,3gp,3g2,mj2',
      video_codec: 'h264',
      audio_codec: 'aac',
      bitrate: 1_200_000,
      framerate: '30000/1001',
    };

    const saved = await videoRepository.save(
      newVideo(channel, { metadata, duration_seconds: '12.480' }),
    );
    const reloaded = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(reloaded.metadata).toEqual(metadata);
    expect(reloaded.duration_seconds).toBe('12.480');
  });

  it('should leave every processing field null on a fresh draft', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(newVideo(channel));
    const reloaded = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(reloaded.storage_key).toBeNull();
    expect(reloaded.thumbnail_key).toBeNull();
    expect(reloaded.upload_id).toBeNull();
    expect(reloaded.size_bytes).toBeNull();
    expect(reloaded.duration_seconds).toBeNull();
    expect(reloaded.width).toBeNull();
    expect(reloaded.height).toBeNull();
    expect(reloaded.metadata).toBeNull();
    expect(reloaded.processing_error).toBeNull();
  });

  it('should delete a channel videos in cascade', async () => {
    const channel = await createChannel();
    await videoRepository.save(newVideo(channel));
    await videoRepository.save(newVideo(channel));

    await channelRepository.delete({ id: channel.id });

    await expect(
      videoRepository.countBy({ channel_id: channel.id }),
    ).resolves.toBe(0);
  });

  it('should load the related channel via the ManyToOne relation', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(newVideo(channel));

    const reloaded = await videoRepository.findOneOrFail({
      where: { id: saved.id },
      relations: ['channel'],
    });

    expect(reloaded.channel.id).toBe(channel.id);
    expect(reloaded.channel.nickname).toBe(channel.nickname);
  });
});
