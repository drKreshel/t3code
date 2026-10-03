import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
const databases = ["state.sqlite", "statev2.sqlite", "fork.sqlite"];
let root: string;
let data: string;
let backup: string;
let functions: string;

beforeEach(() => {
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-stable-backup-"));
  data = NodePath.join(root, "data");
  backup = NodePath.join(root, "backups");
  NodeFS.mkdirSync(data);
  const script = NodeFS.readFileSync(new URL("./stable-app.sh", import.meta.url), "utf8");
  functions = NodePath.join(root, "functions.sh");
  // Source the real command functions without invoking the CLI entry point.
  NodeFS.writeFileSync(functions, script.slice(0, script.indexOf('\ncase "${1:-}" in\n')));
});

afterEach(() => {
  NodeFS.chmodSync(data, 0o755);
  NodeFS.rmSync(root, { recursive: true, force: true });
});

function run(command: string, running: boolean) {
  return NodeChildProcess.execFileSync(
    "bash",
    [
      "-c",
      [
        `source ${quote(functions)}`,
        `DATA_DIR=${quote(data)}`,
        `BACKUP_ROOT=${quote(backup)}`,
        `PROFILE_DIR=${quote(NodePath.join(root, "profile"))}`,
        `LEGACY_PROFILE_DIR=${quote(NodePath.join(root, "legacy-profile"))}`,
        `APP_PATH=${quote(NodePath.join(root, "app"))}`,
        `PREVIOUS_APP_DIR=${quote(NodePath.join(root, "previous-app"))}`,
        `stable_app_running() { return ${running ? 0 : 1}; }`,
        command,
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );
}

function createDatabase(file: string) {
  const db = new NodeSqlite.DatabaseSync(NodePath.join(data, file));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE payload (value TEXT)");
  db.prepare("INSERT INTO payload VALUES (?)").run(file);
  return db;
}

function savedBackup() {
  return NodePath.join(backup, NodeFS.readdirSync(backup)[0]!);
}

function assertPayload(directory: string, file: string) {
  const db = new NodeSqlite.DatabaseSync(NodePath.join(directory, file), { readOnly: true });
  try {
    expect(db.prepare("SELECT value FROM payload").get()?.value).toBe(file);
  } finally {
    db.close();
  }
}

describe("stable app backups", () => {
  it("backs up closed WAL databases without creating files beside the sources", () => {
    for (const file of databases) createDatabase(file).close();
    const storage = NodePath.join(root, "profile", "Local Storage", "leveldb");
    NodeFS.mkdirSync(storage, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(storage, "layout.log"), "folder assignments");
    NodeFS.chmodSync(data, 0o555);

    run("cmd_backup", false);

    const saved = savedBackup();
    for (const file of databases) {
      assertPayload(saved, file);
      expect(NodeFS.existsSync(NodePath.join(data, `${file}-wal`))).toBe(false);
      expect(NodeFS.existsSync(NodePath.join(data, `${file}-shm`))).toBe(false);
    }
    expect(
      NodeFS.readFileSync(NodePath.join(saved, "Local Storage", "leveldb", "layout.log"), "utf8"),
    ).toBe("folder assignments");
  });

  it("includes committed WAL rows while the app is running", () => {
    const connections = databases.map(createDatabase);
    try {
      expect(databases.every((file) => NodeFS.existsSync(NodePath.join(data, `${file}-wal`)))).toBe(
        true,
      );
      run("cmd_backup", true);
      for (const file of databases) assertPayload(savedBackup(), file);
      expect(NodeFS.existsSync(NodePath.join(savedBackup(), "Local Storage"))).toBe(false);
    } finally {
      for (const db of connections) db.close();
    }
  });

  it("keeps the install failure in the notification if reopening also fails", () => {
    const output = run(
      [
        "T3_STABLE_DETACHED=1",
        "RESTART_DELAY=0",
        "latest_zip() { echo prepared.zip; }",
        "cmd_install() { return 1; }",
        "reopen_app() { return 1; }",
        'notify() { echo "notification: $1"; }',
        "cmd_restart",
      ].join("\n"),
      false,
    );
    expect(output).toContain("Update failed; the previous app was kept.");
    expect(output).not.toContain("Installed, but T3 Code did not reopen.");
  });
});
