import mysql from 'mysql2/promise';
const deadline = Date.now() + 120000;
let connection: Awaited<ReturnType<typeof mysql.createConnection>>;
for (;;) {
  try { connection = await mysql.createConnection(process.env.DATABASE_URL!); break; }
  catch (error) { if (Date.now() > deadline) throw error; await Bun.sleep(1000); }
}
try {
  const schema = await Bun.file('examples/realworld-papp/baseapp/public-schema.sql').text();
  // CREATE IF NOT EXISTS preserves repeated fixture starts; existing foreign
  // key constraints are checked independently on restart.
  for (const statement of schema.split(';').map(s => s.trim()).filter(Boolean)) {
    try { await connection.query(statement); }
    catch (error: any) { if (error.code !== 'ER_FK_DUP_NAME') throw error; }
  }
} finally { await connection.end(); }
