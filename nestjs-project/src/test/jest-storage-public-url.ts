/**
 * Points the "public" storage endpoint at the Compose service name for tests.
 *
 * Runs after `dotenv/config`, so it rewrites what the config factory reads.
 *
 * Why this is needed: client-facing URLs are presigned against
 * `STORAGE_PUBLIC_URL`, which in local development is `http://localhost:9000`
 * so a browser on the host can use them. The suites, however, run *inside* a
 * container, where `localhost` is the container itself — so a URL signed for
 * the host is unfetchable here, and SigV4 covers the `Host` header, which
 * makes rewriting it afterwards impossible.
 *
 * Overriding the value keeps the specs able to exercise the URLs they sign.
 * What it deliberately does NOT do is prove that signing uses the public
 * endpoint rather than the internal one — in this environment the two
 * coincide. That property is guarded by a unit test that configures them
 * differently (`storage.service.spec.ts`).
 */
process.env.STORAGE_PUBLIC_URL =
  process.env.STORAGE_TEST_PUBLIC_URL ?? 'http://minio:9000';
