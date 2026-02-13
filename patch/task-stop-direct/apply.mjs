import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cliPath = join(__dirname, '../../node_modules/@anthropic-ai/claude-agent-sdk/cli.js');

console.log('Reading cli.js...');
let code = readFileSync(cliPath, 'utf8');

// Check if already patched
if (code.includes('/*PATCHED:task-stop-direct*/')) {
  console.log('✓ Patch already applied');
  process.exit(0);
}

console.log('Applying task-stop-direct patch...');

const V = '[\\w$]+'; // Minified variable pattern (can include $)

// Find a unique anchor point: the end of mcp_toggle handler right before 'continue'
// Pattern: mcp_toggle block ending with T1(W1,k1) followed by } } } then 'continue'
const anchorPattern = new RegExp(
  `(else if\\(${V}\\.request\\.subtype==="mcp_toggle"\\){[\\s\\S]{1,3000}?T1\\(${V},${V}\\)\\s*}\\s*}\\s*}\\s*)(continue)`,
  'm'
);

const anchorMatch = code.match(anchorPattern);

if (!anchorMatch) {
  console.error('❌ Could not find injection point (mcp_toggle anchor)');
  process.exit(1);
}

console.log('Found injection point after mcp_toggle handler');

// Extract variable names by looking at nearby patterns
// 1. Find message variable (W1) - it's the parameter in mcp_toggle check
const msgVarPattern = /else if\(([\w$]+)\.request\.subtype==="mcp_toggle"\)/;
const msgVarMatch = code.match(msgVarPattern);

if (!msgVarMatch) {
  console.error('❌ Could not find message variable');
  process.exit(1);
}

const W1 = msgVarMatch[1]; // Message variable (e.g., W1)

// 2. Find J1 (success function) - look for )),J1(W1) pattern in mcp_toggle
const successPattern = new RegExp(`\\)\\),(${V})\\(${W1}\\)\\}`, 'm');
const successMatch = code.match(successPattern);

if (!successMatch) {
  console.error('❌ Could not find success response function');
  process.exit(1);
}

const J1 = successMatch[1]; // Success function

// 3. Find T1 (error function) - look for T1(W1, in mcp_toggle section
const errorPattern = new RegExp(`if\\(!\\$1\\)(${V})\\(${W1},`, 'm');
const errorMatch = code.match(errorPattern);

if (!errorMatch) {
  console.error('❌ Could not find error response function');
  process.exit(1);
}

const T1 = errorMatch[1]; // Error function

// 4. Find DXz function and extract parameter names
// DXz signature is: function DXz(A,q,K,Y,z,w,H,$,O,_,J)
// Y (4th) = tools, $ (8th) = getAppState, O (9th) = setAppState, Z (10th) = abortController
const dxzFunctionPattern = /function\s+([\w$]+)\(([\w$]+),([\w$]+),([\w$]+),([\w$]+),([\w$]+),([\w$]+),([\w$]+),([\w$]+),([\w$]+),([\w$]+),([\w$]+)/;
const dxzMatch = code.match(dxzFunctionPattern);

if (!dxzMatch) {
  console.error('❌ Could not find DXz function signature with all 11 parameters');
  process.exit(1);
}

const q1 = dxzMatch[5]; // 4th parameter (Y) is the tools array
console.log(`Found DXz function: ${dxzMatch[1]}(${dxzMatch[2]},${dxzMatch[3]},${dxzMatch[4]},${dxzMatch[5]},${dxzMatch[6]},${dxzMatch[7]},${dxzMatch[8]},${dxzMatch[9]},${dxzMatch[10]},${dxzMatch[11]})`);
console.log(`Using ${q1} as tools array`);

// 5. getAppState is the 8th parameter of DXz function
const $ = dxzMatch[8] || 'getAppStateNotFound'; // 8th parameter
console.log(`Using ${$} as getAppState`);

// 6. abortController is a parameter or variable - try to find it from context
// For now, let's use a more robust search that looks near the canUseTool definition
const abortPattern = /abortController:([\w$]+)/;
const abortMatch = code.match(abortPattern);

if (!abortMatch) {
  console.error('❌ Could not find abortController variable');
  process.exit(1);
}

const M = abortMatch[1]; // abortController

console.log(`Detected variables: W1=${W1}, J1=${J1}, T1=${T1}, q1=${q1}, $=${$}, M=${M}`);

// 7. setAppState is the 9th parameter of DXz function
const O = dxzMatch[10]; // 9th parameter
console.log(`Using ${O} as setAppState`);

// Create the stop_task handler
// Uses fresh local variable names (a, b, c, etc.) to avoid conflicts
const stopTaskHandler = `/*PATCHED:task-stop-direct*/else if(${W1}.request.subtype==="stop_task"){
let taskId=${W1}.request.task_id;
if(!taskId){${T1}(${W1},"task_id is required");continue}
try{
await BW6.call({task_id:taskId},{getAppState:$,setAppState:O,abortController:M},null);
${J1}(${W1},{success:true})
}catch(err){
${T1}(${W1},err instanceof Error?err.message:String(err))
}
}`;

// Inject the handler before 'continue'
const patched = code.replace(anchorPattern, `$1${stopTaskHandler}$2`);

// Verify the patch was applied
if (!patched.includes('/*PATCHED:task-stop-direct*/')) {
  console.error('❌ Patch injection failed');
  process.exit(1);
}

// Write back
console.log('Writing patched cli.js...');
writeFileSync(cliPath, patched, 'utf8');

// Verify
const verify = readFileSync(cliPath, 'utf8');
if (!verify.includes('/*PATCHED:task-stop-direct*/') || !verify.includes('stop_task')) {
  console.error('❌ Verification failed');
  process.exit(1);
}

console.log('✓ task-stop-direct patch applied successfully');
