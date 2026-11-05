import { DEFAULT_CONTENT, DEFAULT_PROJECTS } from '../defaults';
import { discoveryForNetwork, projectsForNetwork } from '../networkDiscovery';
import { discoveryModules } from '../modules';
import { parseAppContent, parseAppProjects } from '../validation';

const project = DEFAULT_PROJECTS[0];
const item = { id: 'app', enabled: true, sortOrder: 0, title: { en: 'App' }, description: {}, color: '#123456', hot: false };

test('legacy catalogs belong to Vaulta, with no mainnet fallback in Jungle4', () => {
  expect(projectsForNetwork(DEFAULT_PROJECTS, 'vaulta')).toEqual(DEFAULT_PROJECTS);
  const jungle = discoveryForNetwork(DEFAULT_CONTENT, DEFAULT_PROJECTS, 'jungle4');
  expect(jungle.projects).toEqual([]);
  expect(jungle.content.banners).toEqual([]);
  expect(jungle.content.promos).toEqual([]);
  expect(jungle.content.earnItems).toEqual([]);
  expect(discoveryModules(jungle.content, jungle.projects, 'en')).toEqual([]);
});

test('explicit deployments resolve network URLs and never fall back to appUrl', () => {
  const shared = { ...project, networkUrls: { vaulta: 'https://main.example', jungle4: 'https://test.example' } };
  expect(projectsForNetwork([shared], 'vaulta')[0].appUrl).toBe('https://main.example');
  expect(projectsForNetwork([shared], 'jungle4')[0].appUrl).toBe('https://test.example');
  expect(projectsForNetwork([{ ...shared, networkUrls: { vaulta: 'https://main.example' } }], 'jungle4')).toEqual([]);
  expect(projectsForNetwork([{ ...shared, networkUrls: {} }], 'vaulta')).toEqual([]);
  expect(projectsForNetwork([{ ...shared, networkIds: [] }], 'vaulta')).toEqual([]);
  expect(projectsForNetwork([{ ...shared, networkIds: ['vaulta'] }], 'jungle4')).toEqual([]);
  expect(shared.appUrl).toBe(project.appUrl);
});

test('module children inherit their parent scope and project references resolve the selected deployment', () => {
  const content = { ...DEFAULT_CONTENT, modules: [{ id: 'module', enabled: true, sortOrder: 0,
    title: { en: 'Module' }, description: {}, networkIds: ['jungle4' as const], items: [
      { ...item, projectId: project.id }, { ...item, id: 'hidden', networkIds: ['vaulta' as const] },
    ] }] };
  const scoped = discoveryForNetwork(content, [{ ...project, networkUrls: { jungle4: 'https://test.example' } }], 'jungle4');
  expect(scoped.content.modules[0].items.map(entry => entry.id)).toEqual(['app']);
  expect(discoveryModules(scoped.content, scoped.projects, 'en')[0].items[0].url).toBe('https://test.example');
  expect(discoveryForNetwork(content, [], 'vaulta').content.modules).toEqual([]);
  expect(discoveryForNetwork({ ...content, modules: [] }, [], 'jungle4').content.modules).toEqual([]);
});

test('network metadata survives validation including deliberately empty scopes', () => {
  const parsed = parseAppProjects([{ ...project, networkIds: [], networkUrls: { jungle4: 'https://test.example' } }])[0];
  expect(parsed.networkIds).toEqual([]);
  expect(parsed.networkUrls).toEqual({ jungle4: 'https://test.example' });
  const content = parseAppContent({ ...DEFAULT_CONTENT, banners: [{ id: 'test', enabled: true, sortOrder: 0, networkIds: ['jungle4'] }] });
  expect(content.banners[0].networkIds).toEqual(['jungle4']);
});

test.each([['unknown'], ['vaulta', 'vaulta'], 'jungle4', null])('rejects malformed network scopes: %p', networkIds => {
  expect(() => parseAppProjects([{ ...project, networkIds }])).toThrow();
});

test.each([{ unknown: 'https://test.example' }, { jungle4: 'javascript:alert(1)' }, { jungle4: 'https://user:secret@test.example' }, null])
  ('rejects unknown networks and unsafe deployment URLs: %p', networkUrls => {
    expect(() => parseAppProjects([{ ...project, networkUrls }])).toThrow();
  });
