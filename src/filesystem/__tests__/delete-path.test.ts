// Protocol-level tests for the fork's delete_path tool. Every deletion is
// confined to a fresh OS temporary directory: the suite checks file, empty
// directory and explicit recursive deletion, while proving that allowed roots,
// non-empty directories without opt-in and paths outside the sandbox survive.

import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import {
  call,
  connect,
  makeTempDir,
  quietStderr,
  textOf,
  type Connected,
} from "./helpers.js";

let dir: string;
let conn: Connected;
let client: Client;

beforeEach(async () => {
  quietStderr();
  dir = await makeTempDir("mcp-fs-delete-");
  conn = await connect([dir]);
  client = conn.client;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await conn.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("delete_path", () => {
  it("is listed after create_directory with destructive annotations", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names.indexOf("delete_path")).toBe(
      names.indexOf("create_directory") + 1,
    );
    const tool = tools.find((candidate) => candidate.name === "delete_path");
    expect(tool?.title).toBe("Delete File or Directory");
    expect(tool?.annotations).toEqual({
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: true,
      openWorldHint: false,
    });
  });

  it("deletes a regular file", async () => {
    const target = path.join(dir, "delete-me.txt");
    await fs.writeFile(target, "temporary test data");

    const result = await call(client, "delete_path", { path: target });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe(`Successfully deleted ${target}`);
    expect(result.structuredContent).toEqual({ content: textOf(result) });
    expect(fsSync.existsSync(target)).toBe(false);
  });

  it("deletes an empty directory without recursive", async () => {
    const target = path.join(dir, "empty-directory");
    await fs.mkdir(target);

    const result = await call(client, "delete_path", { path: target });

    expect(result.isError).toBeFalsy();
    expect(fsSync.existsSync(target)).toBe(false);
  });

  it("refuses a non-empty directory unless recursive is true", async () => {
    const target = path.join(dir, "non-empty-directory");
    const child = path.join(target, "keep.txt");
    await fs.mkdir(target);
    await fs.writeFile(child, "must survive the refused call");

    const result = await call(client, "delete_path", { path: target });

    expect(result.isError).toBe(true);
    expect(fsSync.existsSync(target)).toBe(true);
    expect(await fs.readFile(child, "utf8")).toBe(
      "must survive the refused call",
    );
  });

  it("recursively deletes a non-empty directory only when requested", async () => {
    const target = path.join(dir, "recursive-directory");
    await fs.mkdir(path.join(target, "nested"), { recursive: true });
    await fs.writeFile(path.join(target, "nested", "delete-me.txt"), "test");

    const result = await call(client, "delete_path", {
      path: target,
      recursive: true,
    });

    expect(result.isError).toBeFalsy();
    expect(fsSync.existsSync(target)).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "refuses entries that are not regular files or directories",
    async () => {
      const target = path.join(dir, "fifo");
      const { execFileSync } = await import("child_process");
      execFileSync("mkfifo", [target]);

      const result = await call(client, "delete_path", { path: target });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(
        "Refusing to delete: not a regular file or directory",
      );
      expect(fsSync.existsSync(target)).toBe(true);
    },
  );

  it("refuses to delete an allowed root directory", async () => {
    const child = path.join(dir, "keep.txt");
    await fs.writeFile(child, "root must survive");

    const result = await call(client, "delete_path", {
      path: dir,
      recursive: true,
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(
      "Refusing to delete an allowed root directory",
    );
    expect(await fs.readFile(child, "utf8")).toBe("root must survive");
  });

  it("refuses to delete outside the allowed directories", async () => {
    const outside = await makeTempDir("mcp-fs-delete-outside-");
    try {
      const target = path.join(outside, "keep.txt");
      await fs.writeFile(target, "outside data must survive");

      const result = await call(client, "delete_path", { path: target });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/^Access denied/);
      expect(await fs.readFile(target, "utf8")).toBe(
        "outside data must survive",
      );
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
