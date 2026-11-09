/**
 * Moves the test suites onto their own queue namespace.
 *
 * Runs after `dotenv/config`, so it rewrites the name the config factory will
 * read. Without it the suites share a Redis namespace with the running
 * `video-worker` container, which drains jobs the producer specs are about to
 * assert on — the specs then fail for a reason that has nothing to do with the
 * code: a real consumer got there first. Isolating the namespace keeps a live
 * worker and a test run from competing for the same jobs.
 */
const base = process.env.QUEUE_VIDEO_PROCESSING_NAME ?? 'video-processing';
process.env.QUEUE_VIDEO_PROCESSING_NAME = `${base}-test`;
