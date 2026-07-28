import { describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => vi.fn());

vi.mock('@aiop/pi-runtime', () => ({
  loadAvailableSkills: boundary,
}));

import { SkillProductService } from '../src/skill/service.js';
import type { SkillProductRecord } from '../src/skill/product.js';

describe('SkillProductService pi-runtime boundary', () => {
  it('delegates product governance, Pi loading, and prompt formatting to loadAvailableSkills', async () => {
    const record: SkillProductRecord = {
      id: 'demo', name: 'demo', path: '/skills/demo', version: '1',
      tenantId: 'tenant-a', visibility: 'public', enabled: true, reviewed: true,
    };
    boundary.mockResolvedValue({ skills: [], loaded: [], prompt: '<available_skills />', diagnostics: [] });
    const service = new SkillProductService({} as never);

    await expect(service.prompt([record], {
      tenantId: 'tenant-a', userId: 'user-a', role: 'user',
    })).resolves.toBe('<available_skills />');

    expect(boundary).toHaveBeenCalledWith(
      expect.anything(),
      [record],
      { tenantId: 'tenant-a', userId: 'user-a', role: 'user' },
      { loader: undefined },
    );
  });
});
