import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { PrismaClient } from "@prisma/client";

process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??=
  "pk_test_dGVzdC10ZXN0LXRlc3QudGVzdC50ZXN0LWlu";
process.env.CLERK_SECRET_KEY ??= "sk_test_dGVzdC10ZXN0LXRlc3QtdGVzdA";

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
  currentUser: vi.fn(),
}));

const headerStore: { current: Headers } = { current: new Headers() };
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => headerStore.current),
}));

import { auth } from "@clerk/nextjs/server";
import { prisma } from "../../src/lib/db/client";
import { uploadSchoolLogo } from "../../src/app/s/[schoolSlug]/onboarding/profile/_actions/uploadSchoolLogo";
import { __setStorageClientForTesting } from "../../src/lib/storage/client";

const admin = new PrismaClient({
  datasources: { db: { url: process.env.ADMIN_DATABASE_URL! } },
});

const RIVERSIDE_ID = "11111111-1111-1111-1111-111111111111";
const COASTAL_ID = "22222222-2222-2222-2222-222222222222";
const SOLO_USER = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const SOLO_CLERK = "user_solo_test";

type UploadCall = {
  bucket: string;
  path: string;
  contentType?: string;
  upsert?: boolean;
};

let uploadCalls: UploadCall[] = [];

function makeMockStorage() {
  return {
    storage: {
      from(bucket: string) {
        return {
          async upload(
            path: string,
            _file: unknown,
            opts: { contentType?: string; upsert?: boolean } = {},
          ) {
            uploadCalls.push({
              bucket,
              path,
              contentType: opts.contentType,
              upsert: opts.upsert,
            });
            return { data: { path }, error: null };
          },
          async createSignedUrl(path: string, _ttl: number) {
            return {
              data: { signedUrl: `https://signed.example.test/${path}` },
              error: null,
            };
          },
          async remove(_paths: string[]) {
            return { data: null, error: null };
          },
        };
      },
    },
  };
}

async function seed() {
  await admin.$executeRawUnsafe(
    `TRUNCATE schools, users, memberships, locations RESTART IDENTITY CASCADE`,
  );
  await admin.$executeRaw`
    INSERT INTO users (id, clerk_id, email, name, updated_at) VALUES
      (${SOLO_USER}::uuid, ${SOLO_CLERK}, 'solo@example.com', 'Solo User', now())
  `;
  await admin.$executeRaw`
    INSERT INTO schools (id, slug, name, timezone, currency, created_by, updated_by, updated_at) VALUES
      (${RIVERSIDE_ID}::uuid, 'riverside', 'Riverside Swim School', 'Australia/Sydney', 'AUD', ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now()),
      (${COASTAL_ID}::uuid,   'coastal',   'Coastal Swim School',   'Australia/Sydney', 'AUD', ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now())
  `;
  await admin.$executeRaw`
    INSERT INTO memberships (id, school_id, user_id, role, created_by, updated_by, updated_at) VALUES
      (gen_random_uuid(), ${RIVERSIDE_ID}::uuid, ${SOLO_USER}::uuid, 'owner', ${SOLO_USER}::uuid, ${SOLO_USER}::uuid, now())
  `;
}

beforeAll(async () => {
  await seed();
});

beforeEach(() => {
  vi.mocked(auth).mockReset();
  headerStore.current = new Headers();
  uploadCalls = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  __setStorageClientForTesting(makeMockStorage() as any);
});

afterAll(async () => {
  __setStorageClientForTesting(null);
  await admin.$disconnect();
  await prisma.$disconnect();
});

function mockAuth(clerkId: string | null) {
  vi.mocked(auth).mockResolvedValue({ userId: clerkId } as never);
}

function setSlug(slug: string) {
  headerStore.current = new Headers({ "x-school-slug": slug });
}

function makeFormData(file: File): FormData {
  const fd = new FormData();
  fd.append("file", file);
  return fd;
}

describe("uploadSchoolLogo", () => {
  test("happy path: PNG under limit returns <school_id>/logo/<uuid>.png path", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "logo.png", {
      type: "image/png",
    });
    const result = await uploadSchoolLogo(makeFormData(file));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.path).toMatch(
      new RegExp(`^${RIVERSIDE_ID}/logo/[0-9a-f-]+\\.png$`),
    );
    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0].bucket).toBe("school-assets");
    expect(uploadCalls[0].path).toBe(result.data.path);
    expect(uploadCalls[0].contentType).toBe("image/png");
    expect(uploadCalls[0].upsert).toBe(false);
  });

  test("rejects content-type outside the allow-list (e.g. SVG)", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const file = new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" });
    const result = await uploadSchoolLogo(makeFormData(file));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toMatch(/PNG|JPEG|WEBP/i);
    expect(uploadCalls).toHaveLength(0);
  });

  test("rejects files larger than 2MB", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const big = new Uint8Array(2 * 1024 * 1024 + 1).fill(0);
    const file = new File([big], "logo.png", { type: "image/png" });
    const result = await uploadSchoolLogo(makeFormData(file));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toMatch(/2MB/i);
    expect(uploadCalls).toHaveLength(0);
  });

  test("rejects empty files", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const file = new File([], "empty.png", { type: "image/png" });
    const result = await uploadSchoolLogo(makeFormData(file));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(uploadCalls).toHaveLength(0);
  });

  test("rejects requests with no file field", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("riverside");

    const fd = new FormData();
    const result = await uploadSchoolLogo(fd);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(uploadCalls).toHaveLength(0);
  });

  test("cross-tenant: SOLO_USER posting to coastal slug 404s before Storage is touched", async () => {
    mockAuth(SOLO_CLERK);
    setSlug("coastal");

    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "logo.png", {
      type: "image/png",
    });

    await expect(uploadSchoolLogo(makeFormData(file))).rejects.toMatchObject({
      digest: expect.stringMatching(/NEXT_HTTP_ERROR_FALLBACK;404/),
    });
    expect(uploadCalls).toHaveLength(0);
  });
});
