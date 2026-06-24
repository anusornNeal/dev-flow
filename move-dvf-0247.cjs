const db = require('better-sqlite3')('data/devflow.db');
db.prepare("UPDATE tasks SET status = 'done', updatedAt = CURRENT_TIMESTAMP WHERE displayId = 'DVF-0247'").run();
console.log(db.prepare('SELECT id, displayId, title, status FROM tasks WHERE displayId = ?').get('DVF-0247'));
