import { readFile } from 'node:fs/promises';
import { parseConfig, stripJsonComments } from '../src/config/load.js';

const exampleRaw = await readFile(new URL('../config.example.jsonc', import.meta.url), 'utf8');
const normalizedExample = stripJsonComments(exampleRaw).replace(/,\s*(?=[}\]])/g, '');
const exampleObject = JSON.parse(normalizedExample) as Record<string, unknown>;
if (exampleObject.sandbox && typeof exampleObject.sandbox === 'object') {
  delete (exampleObject.sandbox as Record<string, unknown>).warmPoolSize;
}
const example = parseConfig(JSON.stringify(exampleObject));
if (example.deploymentMode !== 'standalone' || example.auth?.provider !== 'local') {
  throw new Error('Standalone example must parse as deploymentMode=standalone and auth.provider=local');
}

const aiosManifest = await readFile(new URL('../deploy/aiop/configmap-aios-integrated.yaml', import.meta.url), 'utf8');
const block = aiosManifest.match(/config\.jsonc: \|\n([\s\S]*)/)?.[1];
if (!block) throw new Error('AIOS integrated manifest is missing config.jsonc');
const rawConfig = block.split('\n').map((line) => line.replace(/^    /, '')).join('\n');
const integrated = parseConfig(rawConfig, {
  AIOP_MODEL_BASE_URL: 'https://model.example/v1', OPENAI_API_KEY: 'test',
  AIOS_USERINFO_URL: 'https://aios.example/userinfo', AIOS_SYSTEM_ID: '1',
});
if (
  integrated.deploymentMode !== 'aios-integrated'
  || integrated.auth?.provider !== 'aios'
  || integrated.auth.aios?.verify !== 'userinfo'
  || integrated.auth.aios.adminRoles.length === 0
) throw new Error('AIOS integrated manifest parsed contract is invalid');

console.log('dual deployment configuration contracts ok');
