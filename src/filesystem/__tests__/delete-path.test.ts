// Protocol-level tests for the fork's delete_path tool. Every operation is
// confined to fresh OS temporary directories: the suite covers workspace-local
// trash moves, collision handling and explicit permanent deletion, while
// proving that allowed roots, non-empty directories without opt-in and paths
// outside the sandbox survive.

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
  it("is listed after create_directory with destructive annotations and permanent opt-in", async () => {
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
    expect(tool?.inputSchema).toMatchObject({
      properties: {
        recursive: { type: "boolean", default: false },
        permanent: { type: "boolean", default: false },
      },
    });
  });

  it("moves a regular file into .mcp-trash by default", async () => {
    const target = path.join(dir, "delete-me.txt");
    const trashed = path.join(dir, ".mcp-trash", "delete-me.txt");
    await fs.writeFile(target, "temporary test data");

    const result = await call(client, "delete_path", { path: target });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe(`Successfully moved ${target} to ${trashed}`);
    expect(result.structuredContent).toEqual({ content: textOf(result) });
    expect(fsSync.existsSync(target)).toBe(false);
    expect(await fs.readFile(trashed, "utf8")).toBe("temporary test data");
  });

  it("preserves the target's path relative to its workspace", async () => {
    const target = path.join(dir, "nested", "deeper", "delete-me.txt");
    const trashed = path.join(
      dir,
      ".mcp-trash",
      "nested",
      "deeper",
      "delete-me.txt",
    );
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "nested data");

    const result = await call(client, "delete_path", { path: target });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe(`Successfully moved ${target} to ${trashed}`);
    expect(await fs.readFile(trashed, "utf8")).toBe("nested data");
  });

  it("moves an empty directory without recursive", async () => {
    const target = path.join(dir, "empty-directory");
    const trashed = path.join(dir, ".mcp-trash", "empty-directory");
    await fs.mkdir(target);

    const result = await call(client, "delete_path", {
      path: target,
      permanent: false,
    });

    expect(result.isError).toBeFalsy();
    expect(fsSync.existsSync(target)).toBe(false);
    expect((await fs.stat(trashed)).isDirectory()).toBe(true);
  });

  it("refuses a non-empty directory unless recursive is true", async () => {
    const target = path.join(dir, "non-empty-directory");
    const child = path.join(target, "keep.txt");
    await fs.mkdir(target);
    await fs.writeFile(child, "must survive the refused call");

    const result = await call(client, "delete_path", { path: target });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Directory is not empty");
    expect(fsSync.existsSync(target)).toBe(true);
    expect(await fs.readFile(child, "utf8")).toBe(
      "must survive the refused call",
    );
    expect(fsSync.existsSync(path.join(dir, ".mcp-trash"))).toBe(false);
  });

  it("moves a non-empty directory and its contents when recursive is true", async () => {
    const target = path.join(dir, "recursive-directory");
    const child = path.join(target, "nested", "delete-me.txt");
    const trashedChild = path.join(
      dir,
      ".mcp-trash",
      "recursive-directory",
      "nested",
      "delete-me.txt",
    );
    await fs.mkdir(path.dirname(child), { recursive: true });
    await fs.writeFile(child, "test");

    const result = await call(client, "delete_path", {
      path: target,
      recursive: true,
    });

    expect(result.isError).toBeFalsy();
    expect(fsSync.existsSync(target)).toBe(false);
    expect(await fs.readFile(trashedChild, "utf8")).toBe("test");
  });

  it("never overwrites an existing trash entry with the same relative path", async () => {
    const target = path.join(dir, "duplicate.txt");
    const existing = path.join(dir, ".mcp-trash", "duplicate.txt");
    await fs.mkdir(path.dirname(existing), { recursive: true });
    await fs.writeFile(existing, "older trash entry");
    await fs.writeFile(target, "new trash entry");

    const result = await call(client, "delete_path", { path: target });

    expect(result.isError).toBeFalsy();
    const prefix = `Successfully moved ${target} to `;
    const destination = textOf(result).slice(prefix.length);
    expect(path.dirname(destination)).toBe(path.dirname(existing));
    expect(path.basename(destination)).toMatch(/^duplicate-.+\.txt$/);
    expect(await fs.readFile(existing, "utf8")).toBe("older trash entry");
    expect(await fs.readFile(destination, "utf8")).toBe("new trash entry");
    expect(fsSync.existsSync(target)).toBe(false);
  });

  it("keeps a collision-suffixed entry in trash when the original name is a symlink", async () => {
    const target = path.join(dir, "duplicate.txt");
    const existing = path.join(dir, ".mcp-trash", "duplicate.txt");
    const linked = path.join(dir, "linked.txt");
    await fs.mkdir(path.dirname(existing), { recursive: true });
    await fs.writeFile(linked, "link target must survive");
    await fs.symlink(linked, existing);
    await fs.writeFile(target, "new trash entry");

    const result = await call(client, "delete_path", { path: target });

    expect(result.isError).toBeFalsy();
    const destination = textOf(result).slice(
      `Successfully moved ${target} to `.length,
    );
    expect(path.dirname(destination)).toBe(path.dirname(existing));
    expect(await fs.readFile(linked, "utf8")).toBe("link target must survive");
    expect(await fs.readFile(existing, "utf8")).toBe(
      "link target must survive",
    );
    expect(await fs.readFile(destination, "utf8")).toBe("new trash entry");
  });

  it("refuses a trash directory symlink that leaves the workspace", async () => {
    const outside = await makeTempDir("mcp-fs-delete-trash-outside-");
    try {
      const target = path.join(dir, "keep.txt");
      await fs.writeFile(target, "must stay in place");
      await fs.symlink(outside, path.join(dir, ".mcp-trash"));

      const result = await call(client, "delete_path", { path: target });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("symlink target outside allowed");
      expect(await fs.readFile(target, "utf8")).toBe("must stay in place");
      expect(await fs.readdir(outside)).toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("uses the trash in the containing allowed directory", async () => {
    const other = await makeTempDir("mcp-fs-delete-other-");
    const otherConn = await connect([dir, other]);
    try {
      const target = path.join(other, "other.txt");
      const trashed = path.join(other, ".mcp-trash", "other.txt");
      await fs.writeFile(target, "other workspace");

      const result = await call(otherConn.client, "delete_path", {
        path: target,
      });

      expect(result.isError).toBeFalsy();
      expect(await fs.readFile(trashed, "utf8")).toBe("other workspace");
      expect(fsSync.existsSync(path.join(dir, ".mcp-trash"))).toBe(false);
    } finally {
      await otherConn.close();
      await fs.rm(other, { recursive: true, force: true });
    }
  });

  it("uses the most specific workspace when allowed directories are nested", async () => {
    const nested = path.join(dir, "nested-workspace");
    await fs.mkdir(nested);
    const nestedConn = await connect([dir, nested]);
    try {
      const target = path.join(nested, "nested.txt");
      const trashed = path.join(nested, ".mcp-trash", "nested.txt");
      await fs.writeFile(target, "nested workspace");

      const result = await call(nestedConn.client, "delete_path", {
        path: target,
      });

      expect(result.isError).toBeFalsy();
      expect(await fs.readFile(trashed, "utf8")).toBe("nested workspace");
    } finally {
      await nestedConn.close();
    }
  });

  it("permanently deletes a regular file only when permanent is true", async () => {
    const target = path.join(dir, "permanent.txt");
    await fs.writeFile(target, "cannot be recovered");

    const result = await call(client, "delete_path", {
      path: target,
      permanent: true,
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe(`Successfully permanently deleted ${target}`);
    expect(fsSync.existsSync(target)).toBe(false);
    expect(fsSync.existsSync(path.join(dir, ".mcp-trash"))).toBe(false);
  });

  it("permanently deletes an empty directory without recursive", async () => {
    const target = path.join(dir, "permanent-empty-directory");
    await fs.mkdir(target);

    const result = await call(client, "delete_path", {
      path: target,
      permanent: true,
    });

    expect(result.isError).toBeFalsy();
    expect(fsSync.existsSync(target)).toBe(false);
    expect(fsSync.existsSync(path.join(dir, ".mcp-trash"))).toBe(false);
  });

  it("permanently deletes a non-empty directory with both explicit options", async () => {
    const target = path.join(dir, "permanent-directory");
    await fs.mkdir(path.join(target, "nested"), { recursive: true });
    await fs.writeFile(path.join(target, "nested", "delete-me.txt"), "test");

    const result = await call(client, "delete_path", {
      path: target,
      recursive: true,
      permanent: true,
    });

    expect(result.isError).toBeFalsy();
    expect(fsSync.existsSync(target)).toBe(false);
    expect(fsSync.existsSync(path.join(dir, ".mcp-trash"))).toBe(false);
  });

  it("refuses to move the trash directory or its contents into trash again", async () => {
    const target = path.join(dir, ".mcp-trash", "already-trashed.txt");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "already in trash");

    const result = await call(client, "delete_path", { path: target });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(
      "Refusing to move the trash directory or its contents into trash",
    );
    expect(await fs.readFile(target, "utf8")).toBe("already in trash");
  });

  it.skipIf(process.platform === "win32")(
    "refuses entries that are not regular files or directories",
    async () => {
      const target = path.join(dir, "fifo");
      const { execFileSync } = await import("child_process");
      execFileSync("mkfifo", [target]);

      const result = await call(client, "delete_path", {
        path: target,
        permanent: true,
      });

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
      permanent: true,
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

      const result = await call(client, "delete_path", {
        path: target,
        permanent: true,
      });

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
