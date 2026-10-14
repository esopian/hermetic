import { expect, test } from "bun:test";
import { createUploadPort } from "../src/upload-port.ts";

const ID = "up_00000000-0000-0000-0000-000000000001";

test("an upload URL takes one body and refuses unknown, reused, or revoked IDs", async () => {
  const port = createUploadPort();
  const received: string[] = [];
  try {
    const url = port.url(ID, async (body) => {
      received.push(await new Response(body).text());
    });
    expect((await fetch(url.replace(ID, "up_00000000-0000-0000-0000-000000000002"))).status).toBe(404);
    expect((await fetch(url, { method: "PUT", body: "FIXTURE bytes" })).status).toBe(200);
    expect(received).toEqual(["FIXTURE bytes"]);
    expect((await fetch(url, { method: "PUT", body: "again" })).status).toBe(404);
    port.url(ID, async () => {
      throw new Error("revoked route was called");
    });
    port.forget(ID);
    expect((await fetch(url, { method: "PUT", body: "revoked" })).status).toBe(404);
  } finally {
    port.stop();
  }
});

test("upload URL checks Host and expires without another upload", async () => {
  const port = createUploadPort({ routeTtlMs: 25 });
  try {
    const url = port.url(ID, async () => undefined);
    expect((await fetch(url, { headers: { host: "elsewhere.invalid" } })).status).toBe(403);
    await Bun.sleep(40);
    expect((await fetch(url, { method: "PUT", body: "late" })).status).toBe(404);
  } finally {
    port.stop();
  }
});
