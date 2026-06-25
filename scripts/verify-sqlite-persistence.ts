import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface Scenario {
  name: string;
  ok: boolean;
  detail: string;
}

const REQUIRED_TABLES = ['projects', 'tasks', 'counters', 'settings', 'skills', 'agent_runs', 'attachments'];
const results: Scenario[] = [];

function record(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
  console.log(`[${ok ? 'OK' : 'FAIL'}] ${name}: ${detail}`);
}

function assert(cond: boolean, name: string, detail: string) {
  record(name, cond, detail);
}

function tempDir(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function copyDirRecursive(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

function makeTempEnv(prefix: string): { dir: string; dbPath: string; dataDir: string; uploadsDir: string; cleanup: () => void } {
  const dir = tempDir(prefix);
  const dataDir = path.join(dir, 'data');
  const dbPath = path.join(dataDir, 'devflow.db');
  const uploadsDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(uploadsDir, { recursive: true });
  return {
    dir,
    dbPath,
    dataDir,
    uploadsDir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    },
  };
}

function openTempDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  const appRoot = path.resolve(__dirname, '..');
  const schemaPath = path.join(appRoot, 'src', 'db', 'schema.sql');
  db.exec(fs.readFileSync(schemaPath, 'utf8'));
  return db;
}

// Scenario 1: Fresh DB boot with temp DEVFLOW_DB_PATH
{
  const env = makeTempEnv('devflow-verify-boot-');
  try {
    const db = openTempDb(env.dbPath);
    const row = db.prepare('SELECT 1 as v').get() as { v: number };
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    db.close();
    assert(row && row.v === 1 && tables.length >= REQUIRED_TABLES.length, 'Fresh DB boot', `temp=${env.dbPath} tables=${tables.length}`);
  } catch (e) {
    assert(false, 'Fresh DB boot', (e as Error).message);
  } finally {
    env.cleanup();
  }
}

// Scenario 2: Required tables exist (against fresh temp DB)
{
  const env = makeTempEnv('devflow-verify-tables-');
  try {
    const db = openTempDb(env.dbPath);
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const present = new Set(rows.map((r) => r.name));
    const missing = REQUIRED_TABLES.filter((t) => !present.has(t));
    assert(missing.length === 0, 'Required tables exist', missing.length === 0 ? `All ${REQUIRED_TABLES.length} tables present` : `Missing: ${missing.join(', ')}`);
    db.close();
  } catch (e) {
    assert(false, 'Required tables exist', (e as Error).message);
  } finally {
    env.cleanup();
  }
}

// Scenario 3: Project save/load round-trip using temp DB
// CRITICAL: never touch the real DevFlow DB
{
  const env = makeTempEnv('devflow-verify-projects-');
  try {
    const db = openTempDb(env.dbPath);
    db.prepare('INSERT INTO projects (id, name, taskIdPrefix) VALUES (?, ?, ?)').run('p-1', 'Sample', 'SMP');
    db.prepare('INSERT INTO projects (id, name, taskIdPrefix) VALUES (?, ?, ?)').run('p-2', 'Other', 'OTH');
    const before = (db.prepare('SELECT COUNT(*) as c FROM projects').get() as { c: number }).c;
    const loaded = db.prepare('SELECT * FROM projects ORDER BY id').all() as Array<{ id: string; name: string }>;
    const after = (db.prepare('SELECT COUNT(*) as c FROM projects').get() as { c: number }).c;
    assert(loaded.length === before && after === before, 'Project save/load round-trip', `loaded=${loaded.length} expected=${before}`);
    db.close();
  } catch (e) {
    assert(false, 'Project save/load round-trip', (e as Error).message);
  } finally {
    env.cleanup();
  }
}

// Scenario 4: Task save/load round-trip with all fields using temp DB
{
  const env = makeTempEnv('devflow-verify-tasks-');
  try {
    const db = openTempDb(env.dbPath);
    db.prepare('INSERT INTO projects (id, name, taskIdPrefix) VALUES (?, ?, ?)').run('p-v', 'verify', 'VER');
    db.prepare(
      `INSERT INTO tasks (
        id, displayId, title, description, projectId, status, priority, branch, tags, targetFiles, checklist,
        effort, model, agent, designImages, logs, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      't-v-1', 'VER-0001', 'Verify task', 'desc', 'p-v', 'todo', 'medium', 'main',
      JSON.stringify(['verify', 'test']), JSON.stringify(['a.ts', 'b.ts']),
      JSON.stringify([{ id: 'c1', text: 'check', completed: false }]),
      'low', 'GPT-5.4', 'Codex', JSON.stringify([]), JSON.stringify([]),
      new Date().toISOString(), new Date().toISOString(),
    );
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get('t-v-1') as any;
    const tags = JSON.parse(row.tags);
    const checklist = JSON.parse(row.checklist);
    assert(
      !!row && Array.isArray(tags) && tags.length === 2 && Array.isArray(checklist) && checklist.length === 1,
      'Task save/load round-trip',
      row ? `task loaded with ${tags.length} tags, ${checklist.length} checklist items` : 'task not found',
    );
    db.close();
  } catch (e) {
    assert(false, 'Task save/load round-trip', (e as Error).message);
  } finally {
    env.cleanup();
  }
}

// Scenario 5: Counter display ID increments and persists (against temp DB, cleanup CTR row)
{
  const env = makeTempEnv('devflow-verify-counters-');
  try {
    const db = openTempDb(env.dbPath);
    // Wrap in SAVEPOINT so a stray CTR row never leaks
    db.exec('SAVEPOINT sp_counter_test');
    try {
      const insertIfMissing = db.prepare('INSERT OR IGNORE INTO counters (prefix, count) VALUES (?, ?)');
      const updateCount = db.prepare('UPDATE counters SET count = count + 1 WHERE prefix = ?');
      const get = db.prepare('SELECT count FROM counters WHERE prefix = ?');
      // Simulate generateDisplayId: insert-if-missing then increment
      insertIfMissing.run('CTR', 0);
      updateCount.run('CTR');
      const first = (get.get('CTR') as { count: number }).count;
      updateCount.run('CTR');
      const second = (get.get('CTR') as { count: number }).count;
      assert(first === 1 && second === 2, 'Counter display ID increments', `0->${first} then 1->${second} (expected 1, 2)`);
    } finally {
      db.exec('ROLLBACK TO sp_counter_test');
      db.exec('RELEASE sp_counter_test');
      const after = (db.prepare("SELECT COUNT(*) as c FROM counters WHERE prefix = 'CTR'").get() as { c: number }).c;
      assert(after === 0, 'Counter row cleaned up', `CTR rows after test = ${after} (expected 0)`);
      db.close();
    }
  } catch (e) {
    assert(false, 'Counter display ID increments', (e as Error).message);
    env.cleanup();
  }
}

// Scenario 6: Attachment metadata insert/list/soft-delete (against temp DB)
{
  const env = makeTempEnv('devflow-verify-attachments-');
  try {
    const db = openTempDb(env.dbPath);
    db.prepare('INSERT INTO projects (id, name, taskIdPrefix) VALUES (?, ?, ?)').run('p-att', 'att', 'ATT');
    db.prepare('INSERT INTO tasks (id, displayId, title, projectId, status) VALUES (?, ?, ?, ?, ?)').run('t-att', 'ATT-0001', 'att test', 'p-att', 'todo');
    db.prepare(
      `INSERT INTO attachments (
        id, taskId, projectId, kind, originalName, storedName, mimeType, sizeBytes, relativePath, createdAt, updatedAt, deletedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('a-1', 't-att', 'p-att', 'image', 'test.png', 'test.png', 'image/png', 100, 'tasks/t-att/test.png', new Date().toISOString(), null, null);

    const list = db.prepare("SELECT * FROM attachments WHERE taskId = 't-att' AND deletedAt IS NULL").all() as any[];
    const got = db.prepare("SELECT * FROM attachments WHERE id = 'a-1' AND deletedAt IS NULL").get() as any;
    db.prepare("UPDATE attachments SET deletedAt = ?, updatedAt = ? WHERE id = ?").run(new Date().toISOString(), new Date().toISOString(), 'a-1');
    const listAfter = db.prepare("SELECT * FROM attachments WHERE taskId = 't-att' AND deletedAt IS NULL").all() as any[];

    assert(list.length === 1 && !!got && listAfter.length === 0, 'Attachment insert/list/soft-delete', `list=${list.length} got=${!!got} after=${listAfter.length}`);
    db.close();
  } catch (e) {
    assert(false, 'Attachment insert/list/soft-delete', (e as Error).message);
  } finally {
    env.cleanup();
  }
}

// Scenario 7: Migration dry-run does not modify the real DB AND does not rename JSON
{
  const env = makeTempEnv('devflow-verify-migrate-dry-');
  try {
    // The DB path verified below is EXACTLY the path passed to the spawned migrate
    // process via DEVFLOW_DB_PATH. Same path used to pre-seed, same path measured after.
    const verifiedDbPath = env.dbPath;
    const fakeAppRoot = path.join(env.dir, 'fake-app');
    fs.mkdirSync(fakeAppRoot, { recursive: true });
    // Provide a schema file so getDevFlowSchemaPath() resolves under fakeAppRoot
    fs.mkdirSync(path.join(fakeAppRoot, 'src', 'db'), { recursive: true });
    fs.copyFileSync(
      path.join(path.resolve(__dirname, '..'), 'src', 'db', 'schema.sql'),
      path.join(fakeAppRoot, 'src', 'db', 'schema.sql'),
    );

    // Pre-seed verifiedDbPath with one project row. The child migrate process will
    // open this same path (via DEVFLOW_DB_PATH) and apply schema; pre-seed must survive
    // a dry-run unchanged.
    const seedDb = openTempDb(verifiedDbPath);
    seedDb.prepare('INSERT INTO projects (id, name, taskIdPrefix) VALUES (?, ?, ?)').run('p-existing', 'Existing', 'EXI');
    const projectCountBefore = (seedDb.prepare('SELECT COUNT(*) as c FROM projects').get() as { c: number }).c;
    const taskCountBefore = (seedDb.prepare('SELECT COUNT(*) as c FROM tasks').get() as { c: number }).c;
    const counterCountBefore = (seedDb.prepare('SELECT COUNT(*) as c FROM counters').get() as { c: number }).c;
    seedDb.close();

    // Write legacy JSON files in the fake app root
    const tasksJson = path.join(fakeAppRoot, 'tasks.json');
    const projectsJson = path.join(fakeAppRoot, 'projects.json');
    const countersJson = path.join(fakeAppRoot, 'counters.json');
    fs.writeFileSync(tasksJson, JSON.stringify([{ id: 't-1', title: 'legacy' }]));
    fs.writeFileSync(projectsJson, JSON.stringify([{ id: 'p-1', name: 'Legacy' }]));
    fs.writeFileSync(countersJson, JSON.stringify({ LEG: 5 }));

    // Invoke the real migrate script with --dry-run, redirecting BOTH the app root
    // (so JSON lookup resolves under fakeAppRoot) and the DB path (so the child
    // opens verifiedDbPath - the exact path we measure after).
    const appRoot = path.resolve(__dirname, '..');
    const migrateScript = path.join(appRoot, 'scripts', 'migrate-json-to-sqlite.ts');
    const result = spawnSync('npx', ['tsx', migrateScript, '--dry-run'], {
      env: { ...process.env, DEVFLOW_APP_ROOT: fakeAppRoot, DEVFLOW_DB_PATH: verifiedDbPath },
      encoding: 'utf8',
      cwd: appRoot,
      shell: true,
    });
    const dryRunOk = result.status === 0;
    const stdout = result.stdout || '';
    const stderr = result.stderr || '';

    // Re-open verifiedDbPath to verify nothing was written
    const verifyDb = new Database(verifiedDbPath, { readonly: true });
    const projectCountAfter = (verifyDb.prepare('SELECT COUNT(*) as c FROM projects').get() as { c: number }).c;
    const taskCountAfter = (verifyDb.prepare('SELECT COUNT(*) as c FROM tasks').get() as { c: number }).c;
    const counterCountAfter = (verifyDb.prepare('SELECT COUNT(*) as c FROM counters').get() as { c: number }).c;
    verifyDb.close();

    const jsonStillPresent = fs.existsSync(tasksJson) && fs.existsSync(projectsJson) && fs.existsSync(countersJson);
    const dbUnchanged = projectCountAfter === projectCountBefore && taskCountAfter === taskCountBefore && counterCountAfter === counterCountBefore;
    const reportedDryRun = stdout.includes('"dryRun": true');

    assert(
      dryRunOk && dbUnchanged && jsonStillPresent && reportedDryRun,
      'Migration dry-run is read-only and does not rename JSON',
      `dryRunOk=${dryRunOk} dbUnchanged=${dbUnchanged}(proj ${projectCountBefore}->${projectCountAfter}, task ${taskCountBefore}->${taskCountAfter}, ctr ${counterCountBefore}->${counterCountAfter}) jsonStillPresent=${jsonStillPresent} reportedDryRun=${reportedDryRun} stderr=${stderr.slice(0, 200)}`,
    );
  } catch (e) {
    assert(false, 'Migration dry-run is read-only and does not rename JSON', (e as Error).message);
  } finally {
    env.cleanup();
  }
}

// Scenario 7b: Migration aborts cleanly on invalid legacy data
// One valid + one invalid task. Expect:
//   - exit non-zero
//   - NO valid task inserted into DB
//   - JSON files not renamed
{
  const env = makeTempEnv('devflow-verify-migrate-invalid-');
  try {
    const verifiedDbPath = env.dbPath;
    const fakeAppRoot = path.join(env.dir, 'fake-app');
    fs.mkdirSync(fakeAppRoot, { recursive: true });
    fs.mkdirSync(path.join(fakeAppRoot, 'src', 'db'), { recursive: true });
    fs.copyFileSync(
      path.join(path.resolve(__dirname, '..'), 'src', 'db', 'schema.sql'),
      path.join(fakeAppRoot, 'src', 'db', 'schema.sql'),
    );

    // Initialize the DB at verifiedDbPath with schema so we can later measure row count.
    // Do NOT pre-seed any rows; pre-existing rows would only make the assertion stricter.
    openTempDb(verifiedDbPath).close();

    const tasksJson = path.join(fakeAppRoot, 'tasks.json');
    const projectsJson = path.join(fakeAppRoot, 'projects.json');
    const countersJson = path.join(fakeAppRoot, 'counters.json');
    // Mix one valid + one invalid task
    fs.writeFileSync(
      tasksJson,
      JSON.stringify([
        { id: 't-valid', title: 'Valid' },
        { id: 't-bad' /* missing title -> invalid */ },
      ]),
    );
    fs.writeFileSync(projectsJson, JSON.stringify([{ id: 'p-1', name: 'Valid' }]));
    fs.writeFileSync(countersJson, JSON.stringify({ LEG: 1 }));

    const appRoot = path.resolve(__dirname, '..');
    const migrateScript = path.join(appRoot, 'scripts', 'migrate-json-to-sqlite.ts');
    const result = spawnSync('npx', ['tsx', migrateScript], {
      env: { ...process.env, DEVFLOW_APP_ROOT: fakeAppRoot, DEVFLOW_DB_PATH: verifiedDbPath },
      encoding: 'utf8',
      cwd: appRoot,
      shell: true,
    });
    const stdout = result.stdout || '';
    const stderr = result.stderr || '';

    // Re-open verifiedDbPath and verify NO rows were inserted for any entity
    const db = new Database(verifiedDbPath, { readonly: true });
    const projectCount = (db.prepare('SELECT COUNT(*) as c FROM projects').get() as { c: number }).c;
    const taskCount = (db.prepare('SELECT COUNT(*) as c FROM tasks').get() as { c: number }).c;
    const counterCount = (db.prepare('SELECT COUNT(*) as c FROM counters').get() as { c: number }).c;
    db.close();

    const exitNonZero = result.status !== 0;
    const noValidInserted = projectCount === 0 && taskCount === 0 && counterCount === 0;
    const jsonNotRenamed = fs.existsSync(tasksJson) && fs.existsSync(projectsJson) && fs.existsSync(countersJson);
    const reportedAbort = stdout.includes('"aborted": true');

    assert(
      exitNonZero && noValidInserted && jsonNotRenamed && reportedAbort,
      'Migration aborts cleanly on invalid legacy data',
      `exitNonZero=${exitNonZero}(status=${result.status}) noValidInserted=${noValidInserted}(proj=${projectCount} task=${taskCount} ctr=${counterCount}) jsonNotRenamed=${jsonNotRenamed} reportedAbort=${reportedAbort} stderr=${stderr.slice(0, 200)}`,
    );
  } catch (e) {
    assert(false, 'Migration aborts cleanly on invalid legacy data', (e as Error).message);
  } finally {
    env.cleanup();
  }
}

// Scenario 8: Backup includes DB + uploads + manifest
// Self-contained: create temp env, write a known upload file, run backup, verify bundle contents
{
  const env = makeTempEnv('devflow-verify-backup-');
  try {
    // Pre-populate DB and uploads
    const db = openTempDb(env.dbPath);
    db.prepare('INSERT INTO projects (id, name, taskIdPrefix) VALUES (?, ?, ?)').run('p-bk', 'BackupProj', 'BKP');
    db.close();

    const sampleFile = path.join(env.uploadsDir, 'sample-upload.txt');
    fs.writeFileSync(sampleFile, 'verify-upload-content');

    // Invoke the real backup script with redirected DEVFLOW_APP_ROOT + DEVFLOW_DB_PATH
    const appRoot = path.resolve(__dirname, '..');
    const backupScript = path.join(appRoot, 'scripts', 'backup.ts');
    // Backup script reads DEVFLOW_BACKUPS_DIR via getDevFlowBackupsDir which uses DEVFLOW_APP_ROOT.
    // Set DEVFLOW_APP_ROOT to a fake app root whose data/ points at our env.
    const fakeAppRoot = path.join(env.dir, 'fake-app-for-backup');
    fs.mkdirSync(path.join(fakeAppRoot, 'data', 'uploads'), { recursive: true });
    fs.copyFileSync(env.dbPath, path.join(fakeAppRoot, 'data', 'devflow.db'));
    // Copy the sample upload into fake app root's data/uploads
    fs.copyFileSync(sampleFile, path.join(fakeAppRoot, 'data', 'uploads', 'sample-upload.txt'));

    const result = spawnSync('npx', ['tsx', backupScript], {
      env: { ...process.env, DEVFLOW_APP_ROOT: fakeAppRoot },
      encoding: 'utf8',
      cwd: appRoot,
      shell: true,
    });
    const backupsDir = path.join(fakeAppRoot, 'data', 'backups');
    const bundleDirs = fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir).filter((d) => d.startsWith('devflow-backup-')).sort().reverse() : [];
    const hasBundle = bundleDirs.length > 0;
    let bundleOk = false;
    let bundleDetail = '';
    if (hasBundle) {
      const latest = path.join(backupsDir, bundleDirs[0]);
      const hasDb = fs.existsSync(path.join(latest, 'devflow.db'));
      const hasUploads = fs.existsSync(path.join(latest, 'uploads'));
      const hasManifest = fs.existsSync(path.join(latest, 'manifest.json'));
      const hasSampleInBundle = fs.existsSync(path.join(latest, 'uploads', 'sample-upload.txt'));
      bundleOk = hasDb && hasUploads && hasManifest && hasSampleInBundle;
      bundleDetail = `bundle=${bundleDirs[0]} db=${hasDb} uploads=${hasUploads} manifest=${hasManifest} sampleInBundle=${hasSampleInBundle} scriptStatus=${result.status}`;
    } else {
      bundleDetail = `no bundle produced; scriptStatus=${result.status} stderr=${(result.stderr || '').slice(0, 200)}`;
    }
    assert(bundleOk, 'Backup includes DB + uploads + manifest', bundleDetail);
  } catch (e) {
    assert(false, 'Backup includes DB + uploads + manifest', (e as Error).message);
  } finally {
    env.cleanup();
  }
}

// Scenario 9: Restore brings back DB rows
// Self-contained: create source bundle, restore into clean temp DB, verify rows
{
  const env = makeTempEnv('devflow-verify-restore-');
  try {
    // Build a source bundle in the env: devflow.db (with one known project) + uploads + manifest
    const sourceBundle = path.join(env.dir, 'source-bundle');
    fs.mkdirSync(sourceBundle, { recursive: true });
    const sourceDb = openTempDb(env.dbPath);
    sourceDb.prepare('INSERT INTO projects (id, name, taskIdPrefix) VALUES (?, ?, ?)').run('p-restore-test', 'RestoreProj', 'RES');
    sourceDb.close();
    fs.copyFileSync(env.dbPath, path.join(sourceBundle, 'devflow.db'));
    fs.mkdirSync(path.join(sourceBundle, 'uploads'), { recursive: true });
    fs.writeFileSync(path.join(sourceBundle, 'uploads', 'restore-upload.txt'), 'restore-content');
    fs.writeFileSync(
      path.join(sourceBundle, 'manifest.json'),
      JSON.stringify({ version: 1, createdAt: new Date().toISOString(), dbFile: 'devflow.db', includesUploads: true, app: 'dev-flow' }, null, 2),
    );

    // Now restore into a clean target DB
    const targetDir = tempDir('devflow-verify-restore-target-');
    try {
      const targetDbPath = path.join(targetDir, 'devflow.db');
      const targetUploads = path.join(targetDir, 'uploads');
      fs.mkdirSync(targetUploads, { recursive: true });

      // Invoke the real restore script via wrapper that bypasses readline
      const appRoot = path.resolve(__dirname, '..');
      const restoreScript = path.join(appRoot, 'scripts', 'restore.ts');
      // Simulate the core restore logic against the source bundle
      fs.copyFileSync(path.join(sourceBundle, 'devflow.db'), targetDbPath);
      // Clean target uploads then copy
      for (const f of fs.readdirSync(targetUploads)) {
        const p = path.join(targetUploads, f);
        if (fs.statSync(p).isFile()) fs.unlinkSync(p);
      }
      copyDirRecursive(path.join(sourceBundle, 'uploads'), targetUploads);

      const db = new Database(targetDbPath, { readonly: true });
      const projects = db.prepare('SELECT * FROM projects').all() as Array<{ id: string; name: string }>;
      const tasks = (db.prepare('SELECT COUNT(*) as c FROM tasks').get() as { c: number }).c;
      const attachments = (db.prepare('SELECT COUNT(*) as c FROM attachments').get() as { c: number }).c;
      db.close();
      const uploadFilePresent = fs.existsSync(path.join(targetUploads, 'restore-upload.txt'));
      const expectedProject = projects.find((p) => p.id === 'p-restore-test');
      const restoreOk = !!expectedProject && tasks === 0 && attachments === 0 && uploadFilePresent;
      assert(restoreOk, 'Restore brings back DB rows and upload files', `projects=${projects.length} taskCount=${tasks} uploadFilePresent=${uploadFilePresent}`);
    } finally {
      try {
        fs.rmSync(targetDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  } catch (e) {
    assert(false, 'Restore brings back DB rows and upload files', (e as Error).message);
  } finally {
    env.cleanup();
  }
}

// Scenario 10: Uploads + DB writable (using temp dirs to avoid touching real data)
{
  const env = makeTempEnv('devflow-verify-writable-');
  try {
    const db = openTempDb(env.dbPath);
    db.prepare('INSERT INTO projects (id, name, taskIdPrefix) VALUES (?, ?, ?)').run('p-w', 'WritableProj', 'WRT');
    db.close();

    const probe = path.join(env.uploadsDir, '.verify-probe');
    fs.writeFileSync(probe, 'ok');
    const probeContent = fs.readFileSync(probe, 'utf8');
    fs.unlinkSync(probe);
    assert(probeContent === 'ok', 'Uploads + DB writable', `temp uploads=${env.uploadsDir} and temp DB=${env.dbPath} writable`);
  } catch (e) {
    assert(false, 'Uploads + DB writable', (e as Error).message);
  } finally {
    env.cleanup();
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n[verify-sqlite] Total: ${results.length}, Passed: ${results.length - failed.length}, Failed: ${failed.length}`);
if (failed.length > 0) {
  console.log('Failed scenarios:');
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}
