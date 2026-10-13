// Local headed repro of the stuck huntingtontoyota instance (uses VPS src copy + synced profile)
import { connectDB, getDB } from './src/db.js';
import { GoogleFxFlowTool } from './src/tools/googleFxFlow.js';

await connectDB();
const db = getDB();
const cols = (await db.listCollections().toArray()).map((c) => c.name);
console.log('collections:', cols.join(', '));
let job = null;
for (const c of cols) {
    job = await db.collection(c).findOne({ $or: [{ itemId: 'gen_66dee0919cc8' }, { jobId: 'gen_66dee0919cc8' }, { id: 'gen_66dee0919cc8' }] }).catch(() => null);
    if (job) { console.log('found job in', c, Object.keys(job)); break; }
}
const prompt = job?.prompt || process.env.TEST_PROMPT || 'A friendly car salesman says hello standing next to a 2024 Honda Odyssey.';
const tool = new GoogleFxFlowTool();
try {
    const res = await tool.execute({ itemId: 'local-test', prompt, type: 'avatar_video', avatarName: 'me', mediaUrl: job?.mediaUrl || null, settings: job?.settings || {} });
    console.log('RESULT', JSON.stringify(res).slice(0, 500));
} catch (e) {
    console.error('FAILED:', e.message);
}
await new Promise((r) => setTimeout(r, 600000));
