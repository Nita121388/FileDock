import { afterEach, describe, expect, it, vi } from "vitest";

import {
  apiGetJson,
  apiGetUint8Array,
  getHealth,
  putManifest,
  type SnapshotManifest
} from "./client";
import type { Conn } from "../model/transfers";

const settings: Conn = {
  serverBaseUrl: "http://127.0.0.1:8787/",
  token: "  server-token  ",
  deviceId: "dev-1",
  deviceToken: "device-token"
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("api client", () => {
  it("builds GET requests with trimmed auth headers", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "ok", version: "0.2.3" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    const result = await getHealth(settings);
    expect(result).toEqual({ status: "ok", version: "0.2.3" });

    const [url, init] = fetchMock.mock.calls[0] || [];
    expect(String(url)).toBe("http://127.0.0.1:8787/health");
    expect(init).toMatchObject({ method: "GET" });
    expect(init?.headers).toEqual({
      "content-type": "application/json",
      "x-filedock-token": "server-token",
      "x-filedock-device-id": "dev-1",
      "x-filedock-device-token": "device-token"
    });
  });

  it("includes query parameters and compacts HTTP errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("  upstream\nservice\tfailed  ", {
        status: 502,
        headers: { "content-type": "text/plain" }
      })
    );

    await expect(apiGetJson(settings, "/v1/snapshots", { path: "nested/file.txt" })).rejects.toThrow(
      "GET /v1/snapshots failed: 502 upstream service failed"
    );
  });

  it("streams uint8 arrays while reporting progress", async () => {
    const progress: Array<[number, number | null]> = [];
    const chunks: Array<[number, number, number | null]> = [];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(Uint8Array.from([1, 2]));
            controller.enqueue(Uint8Array.from([3, 4, 5]));
            controller.close();
          }
        }),
        {
          status: 200,
          headers: { "content-length": "5" }
        }
      )
    );

    const out = await apiGetUint8Array(
      settings,
      "/v1/chunks/hash",
      undefined,
      (done, total) => progress.push([done, total]),
      undefined,
      async (chunkBytes, done, total) => {
        chunks.push([chunkBytes, done, total]);
      }
    );

    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5]);
    expect(progress).toEqual([
      [2, 5],
      [5, 5]
    ]);
    expect(chunks).toEqual([
      [2, 2, 5],
      [3, 5, 5]
    ]);
  });

  it("uploads manifests using PUT", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const manifest: SnapshotManifest = {
      snapshot_id: "snap-1",
      created_unix: 123,
      files: []
    };

    await putManifest(settings, "snap-1", manifest);

    const [url, init] = fetchMock.mock.calls[0] || [];
    expect(String(url)).toBe("http://127.0.0.1:8787/v1/snapshots/snap-1/manifest");
    expect(init).toMatchObject({
      method: "PUT",
      body: JSON.stringify(manifest)
    });
  });
});
