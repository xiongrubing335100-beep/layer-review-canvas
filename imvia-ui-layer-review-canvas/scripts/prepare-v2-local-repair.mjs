import { prepareScopedNativeRepair } from '../src/v2/scoped-native-repair.js';
const [manifestPath,rawPath,reportPath]=process.argv.slice(2);
try { console.log(JSON.stringify(await prepareScopedNativeRepair({manifestPath,rawPath,reportPath}))); }
catch(e) { console.error(e.message); process.exitCode=1; }
